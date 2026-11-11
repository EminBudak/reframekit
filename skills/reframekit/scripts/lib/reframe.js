"use strict";

// The whole run: read the video, find its shots and where things move,
// plan a window per shot and shape, draw the sheet, render each place's
// file with its cover, check them, and write the reports.
//
// Everything is put together in a hidden folder and moved into the output
// folder only when the run succeeds (folder.js), so a failed run leaves
// the folder as it was.

const fs = require("node:fs");
const path = require("node:path");
const { checkTools, probe, measureLength, pickEncoder, stopAll, unindexed, readableCopy, gapsOf, ratesOf } = require("./ffmpeg");
const { analyze } = require("./analyze");
const { shotsOf, planWindows, coverTime, cropJson, readCrop, shapesFor } = require("./plan");
const { parseCuts, timelineFor, stepsFor, readSteps, brandColor, normHex } = require("./hints");
const { outputRate, rateText, rateValue, jobsFor, encodeJob, measureLoudness, loudnessOf } = require("./render");
const { drawSheets } = require("./sheet");
const { checkFile, layoutOf } = require("./check");
const { cutText } = require("./mp4");
const { formatsJson, formatsMarkdown, planMarkdown, nextCommand, madeBefore, resizedText } = require("./report");
const { parsePlaces, placeFor, PLACES, NAMES } = require("./places");
const { slug, defaultOut, digestOf, handMade, claim, openStage, finishStage, drop, turn, printOf, printOfBytes, sizeOf, folded, pathFrom, SHEET, WHY } = require("./folder");
const version = require("./version");

const r3 = (x) => Math.round(x * 1000) / 1000;
const MEDIA = /\.mp4$|-cover\.jpg$/;

// The cuts to plan with: --cuts alone when given (they replace the rest);
// else launch-film's timeline, whose clips are a film's shots, as
// launch-film's own check takes them: a title that comes in or a light
// that changes inside a clip is no cut. Else easyscreenshotkit's page
// starts and the cuts found in the picture, together.
function cutsFrom({ given, timeline, steps, found, dissolves = [] }) {
  if (given) return given;
  const out = [...((timeline && timeline.cuts) || []), ...((steps && steps.cuts) || [])];
  if (timeline) return out;
  for (const c of found) if (!out.some((o) => Math.abs(o.at - c.at) < 0.3)) out.push({ at: c.at, span: 0, from: "picture" });
  // A dissolve's middle, found in the picture: the window glides through
  // it from one shot's place to the next.
  for (const c of dissolves) if (!out.some((o) => Math.abs(o.at + (o.span || 0) / 2 - c.at) < 0.6)) out.push({ at: Math.max(0, c.at - 0.2), span: 0.4, from: "dissolve" });
  return out;
}

// The cuts given with --cuts that a video of `duration` seconds takes:
// those inside it, and a note on those at or past its end, which make no
// shot. A cut at its very start is its start. None inside while some fall
// past the end are cuts of another video, or frames given as seconds, and
// the run stops before any work.
function givenCuts(cuts, duration) {
  const inside = cuts.filter((c) => c.at > 0.05 && c.at < duration - 0.05);
  const late = cuts.filter((c) => c.at >= duration - 0.05);
  if (!late.length) return { cuts: inside, note: null };
  const times = late.map((c) => `${Number(c.at.toFixed(3))} s`);
  const listed = times.length > 1 ? `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}` : times[0];
  const length = `${duration.toFixed(2)} s`;
  if (!inside.length && late.some((c) => c.at > duration)) throw new Error(`--cuts gives no cut inside the video, which is ${length} long (${listed} ${late.length === 1 ? "is" : "are"} at or past its end). Give the seconds of this video's shot changes, or frames in a JSON file with their rate, as { "fps": 30, "cuts": [96, 225] }.`);
  return { cuts: inside, note: `--cuts gave ${listed}, at or past the end of the ${length} video; ${late.length === 1 ? "it was" : "they were"} left out.` };
}

// The shapes no shot of a crop.json has a window of.
const lackedBy = (raw, shapes) => {
  const shots = raw && Array.isArray(raw.shots) ? raw.shots : [];
  return Object.fromEntries(Object.entries(shapes).filter(([key]) => !shots.some((s) => s && s.windows && typeof s.windows === "object" && s.windows[key])));
};

// The crop.json given with --crop, read once: JSON that reframekit wrote,
// and the print of the bytes read (folder.js), which the run's folder
// keeps for it, so a crop.json saved again after this read stops the move
// at the end rather than being replaced by windows it no longer holds.
// Returns { raw, print }.
function cropFile(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.code === "ENOENT" ? "no such file" : err.code === "EISDIR" ? "it is a folder" : WHY[err.code] || err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new Error(`${file} is not JSON: ${err.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("reframekit" in raw)) throw new Error(`${file} is not a crop.json reframekit wrote`);
  return { raw, print: printOfBytes(bytes) };
}

// What goes behind a padded picture: a blurred copy, or a color, the
// brand's background read from --brand when the run uses it.
function padFor(options) {
  if (options.pad && options.pad !== "blur") {
    if (options.pad === "brand") {
      if (!options.brand) throw new Error("--pad brand needs --brand, an easybrandkit folder");
      const b = brandColor(options.brand);
      return { kind: "color", hex: b.hex, from: b.from };
    }
    if (options.pad === "black") return { kind: "color", hex: "#000000" };
    if (options.pad === "white") return { kind: "color", hex: "#ffffff" };
    return { kind: "color", hex: normHex(options.pad) };
  }
  if (options.brand && !options.pad) {
    const b = brandColor(options.brand);
    return { kind: "color", hex: b.hex, from: b.from };
  }
  return { kind: "blur" };
}

// The files the arguments name, read before the video, so the dry run,
// which reads no video, stops on each of them with the run's own words:
// the video itself, crop.json, steps.json, the brand kit and the cuts.
// Each is read once, and what it held kept, so one given through a pipe,
// as <(...) gives it, which a second read finds empty, is what the run
// uses. Returns { crop (crop.json's contents), cropPrint (what it held),
// steps (steps.json's contents), pad, cuts }.
function readArguments(video, options) {
  if (!fs.existsSync(video)) throw new Error(`Cannot read ${video}: no such file`);
  if (fs.statSync(video).isDirectory()) throw new Error(`${video} is a folder; give a video file`);
  const read = options.crop ? cropFile(options.crop) : null;
  const steps = options.steps ? readSteps(options.steps) : null;
  const pad = padFor(options);
  const cuts = options.cuts ? parseCuts(options.cuts) : null;
  return { crop: read && read.raw, cropPrint: read && read.print, steps, pad, cuts };
}

// A crop.json given with --crop, checked against the video before
// anything is made. A shape asked for that no shot of it has a window of
// is left to plan (`lacking`), as for a place of another shape added to
// an edited plan.
function givenCrop(file, raw, info, shapes) {
  const v = info.video;
  const lacking = lackedBy(raw, shapes);
  const has = Object.fromEntries(Object.entries(shapes).filter(([key]) => !Object.hasOwn(lacking, key)));
  return { file: path.resolve(file), raw, lacking, ...readCrop(raw, { width: v.displayWidth, height: v.displayHeight, duration: info.duration, shapes: has }) };
}

// What the arguments come to against the video's size and length: the
// crop.json given and the cuts given, checked, and what a note says of
// them. Returns { given, cuts, cutsNote, notes }.
function fitArguments(args, info, shapes, options) {
  const v = info.video;
  const given = args.crop ? givenCrop(options.crop, args.crop, info, shapes) : null;
  const { cuts, note: cutsNote } = args.cuts ? givenCuts(args.cuts, info.duration) : { cuts: null, note: null };
  // The windows of a crop.json given for shapes this run does not render
  // are kept as they are; when a run that renders them would refuse them,
  // it is said now. A shape it has no window of at all a run would plan.
  const notes = [];
  if (given) {
    const other = {};
    for (const [key, s] of shapeEntries(given.raw.shapes)) {
      if (!Object.hasOwn(shapes, key) && s && Number(s.width) > 0 && Number(s.height) > 0) other[key] = { width: Number(s.width), height: Number(s.height), places: [] };
    }
    for (const key of Object.keys(lackedBy(given.raw, other))) delete other[key];
    try {
      if (Object.keys(other).length) readCrop(given.raw, { width: v.displayWidth, height: v.displayHeight, duration: info.duration, shapes: other });
    } catch (err) {
      notes.push(`crop.json's ${Object.keys(other).join(" and ")} windows are kept as they are, though a run that renders them would refuse them: ${err.message.replace(/^crop\.json: /, "").split(". ")[0]}.`);
    }
  }
  return { given, cuts, cutsNote, notes };
}

// The rate the files run at, when it is not the video's own and --fps did
// not ask for it: a note that says why.
function rateNote(v, given) {
  const own = v.baseFps || v.fps;
  if (given || v.variable || !(own > 0)) return null;
  const out = rateValue(outputRate(v));
  if (Math.abs(out - own) < 0.01) return null;
  const n = (x) => `${Math.round(x * 100) / 100}`;
  const why = own < 23 ? "as TikTok and Instagram take 23 fps at least" : own > 60.5 ? "as TikTok and Instagram take 60 fps at most" : "the common rate nearest to it";
  return `The video runs at ${n(own)} fps; the files run at ${n(out)}, ${why}.`;
}

// The note for a video whose frames do not come at one steady rate: its
// average rate, and its fastest where the files' rate comes from that one
// (outputRate()), which a rate over 120 fps is not: ffprobe gives such a
// rate for frames at odd times, as a timebase's.
function variableNote(v, given) {
  const n = (x) => Math.round(x * 100) / 100;
  const out = Math.round(rateValue(outputRate(v, given)) * 1000) / 1000;
  if (v.baseFps >= 1 && v.baseFps <= 120) return `The video's frames do not come at one steady rate (${n(v.fps)} fps on average, ${n(v.baseFps)} at its fastest); the files run at a steady ${out} fps.`;
  return `The video's frames come at uneven times (${n(v.fps)} fps on average); the files run at a steady ${out} fps.`;
}

// The notes for the stretches where the video has no picture or no sound
// (gapsOf()), up to five of each kind named.
function gapNotes({ picture, sound }, name) {
  const meets = (x, y) => x[0] < y[1] && y[0] < x[1];
  const spans = (list) => {
    const said = list.slice(0, 5).map(([a, b]) => `from ${a.toFixed(2)} s to ${b.toFixed(2)} s`);
    if (list.length > 5) said.push(`${list.length - 5} more times`);
    return said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}` : said[0];
  };
  // A stretch of both, from where the first of them starts to where the
  // last ends.
  const both = picture.filter((p) => sound.some((x) => meets(p, x))).map((p) => {
    const met = sound.filter((x) => meets(p, x));
    return [Math.min(p[0], ...met.map((x) => x[0])), Math.max(p[1], ...met.map((x) => x[1]))];
  });
  const pictureOnly = picture.filter((p) => !sound.some((x) => meets(p, x)));
  const soundOnly = sound.filter((x) => !picture.some((p) => meets(p, x)));
  const notes = [];
  if (both.length) notes.push(`${name} has no picture or sound ${spans(both)}, as where two recordings were joined: the files hold the picture there and are silent.`);
  if (pictureOnly.length) notes.push(`${name} has no picture ${spans(pictureOnly)}: the files hold the picture there.`);
  if (soundOnly.length) notes.push(`${name} has no sound ${spans(soundOnly)}: the files are silent there.`);
  return notes;
}

// Where the picture ends, when it ends more than half a second before the
// sound: { from, to }, in seconds from the origin, `to` where the sound
// ends or the video does, the earlier; else null. The picture's end and
// the sound's are as the file states the length of each (probe(),
// measureLength()), the picture's else where the reading found its last
// frame; one neither tells is not taken to end early.
function heldPicture(info, data = null) {
  const origin = Number.isFinite(info.origin) ? info.origin : 0;
  const v = info.video;
  const a = info.audio;
  let picture = v.duration > 0 ? v.startTime + v.duration - origin : null;
  if (picture === null && data && data.scores > 0 && Number.isFinite(data.lastFrameTime)) picture = data.lastFrameTime + (v.fps > 0 ? 1 / v.fps : 0);
  const sound = a && a.duration > 0 ? a.startTime + a.duration - origin : null;
  if (picture === null || sound === null) return null;
  const to = Math.min(sound, info.duration);
  return picture < to - 0.5 ? { from: r3(picture), to: r3(to) } : null;
}

// The note for a picture that ends before its sound (`held`, from
// heldPicture()) of the video `name`. A plan says what a file that runs
// that far does. A render names the files that hold the picture's last
// frame, those of each job (render.js jobsFor()) whose hold is more than
// 0, every file when all of them do, and gives no note when every file
// ends before the picture does, as with --seconds or a place's length.
function heldNote(name, held, jobs = null) {
  const at = `${held.from.toFixed(2)} s`;
  const said = `The picture of ${name} ends at ${at} and its sound at ${held.to.toFixed(2)} s`;
  if (!jobs) return `${said}: a file that runs past ${at} holds the picture's last frame from there.`;
  const files = jobs.filter((j) => j.hold > 0).flatMap((j) => j.places.map((p) => `${p.name}.mp4`));
  if (!files.length) return null;
  const listed = files.length > 1 ? `${files.slice(0, -1).join(", ")} and ${files[files.length - 1]}` : files[0];
  const who = files.length > 1 && jobs.every((j) => j.hold > 0) ? "every file holds" : `${listed} ${files.length > 1 ? "hold" : "holds"}`;
  return `${said}: from ${at} on, ${who} the picture's last frame.`;
}

// The keys of a crop.json's shapes and windows, named as places.js names
// a shape ("9:16", "1.778:1"); any other key, such as toString or
// __proto__, names no shape and is left out.
const SHAPE_KEY = /^\d+(?:\.\d+)?:\d+$/;
const shapeEntries = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o).filter(([key]) => SHAPE_KEY.test(key)) : []);

// The crop.json a run writes: its own shapes, and the shapes and windows
// of a crop.json given that this run did not render, as they were.
function mergeGiven(crop, given) {
  if (!given) return crop;
  const shapes = { ...crop.shapes };
  for (const [key, s] of shapeEntries(given.raw.shapes)) {
    if (!Object.hasOwn(shapes, key)) shapes[key] = s;
    else if (s && Array.isArray(s.places)) shapes[key] = { ...shapes[key], places: [...new Set([...s.places, ...shapes[key].places])] };
  }
  const shots = crop.shots.map((shot, i) => {
    const before = given.raw.shots[i] && given.raw.shots[i].windows;
    const windows = { ...shot.windows };
    for (const [key, win] of shapeEntries(before)) if (!Object.hasOwn(windows, key)) windows[key] = win;
    return { ...shot, windows };
  });
  return { ...crop, shapes, shots };
}

// A file of the earlier run that this run keeps, as its formats.json
// lists it. The file is in the folder, so it is measured again against
// its place, and its other fields are taken only when they have the type
// a run writes them with; its loudness and true peak, when they are not
// both numbers or both null, are measured again too. So a formats.json
// edited by hand can neither say a file passed nor stop the run once its
// own files are made. One that cannot be measured, as one ffprobe cannot
// read, crashes on or is killed on, or one with no picture, stays listed
// with what formats.json gave of it, failing, the check's row for it
// saying why, so a check fails it and the next run measures it again. One
// for no place reframekit makes is left out of formats.json, though not
// out of the folder. A note says either (`note`). An ffprobe that says
// nothing of the file stops the run, as it stops a check (check.js): one
// stopped by Ctrl-C or another signal that stops a run, one the system
// could not start, as when it starts no more processes for now, and one
// that gave no answer in time. `shown` is the folder as it was given,
// which the errors name the file in. Returns { file, place, note }, the
// file and its place null for one left out, which is named (`name`).
async function keptEntry(f, dir, work, shown = dir) {
  const file = path.basename(f.file);
  const name = typeof f.place === "string" ? f.place : "";
  let place = null;
  if (Object.hasOwn(PLACES, name)) place = placeFor(name);
  else if (/^\d{2,5}x\d{2,5}$/.test(name)) {
    try {
      place = parsePlaces(name)[0];
    } catch {
      place = null;
    }
  }
  if (!place) return { file: null, place: null, name: file, note: `${file}, kept from an earlier run, is left out of this report: formats.json gives it ${name ? `the place ${name}, which reframekit does not make` : "no place"}.` };
  const full = path.join(dir, file);
  let info = null;
  let why = null;
  try {
    info = probe(full, path.join(shown, file));
  } catch (err) {
    if (!err.why) throw err;
    why = String(err.why).replace(/\.$/, "");
  }
  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const text = (x) => (typeof x === "string" ? x : null);
  const measured = Boolean(info && info.video);
  const checks = info ? checkFile(full, place, { info, layout: layoutOf(full) }) : [{ name: "file", status: "fail", expected: "the file", found: `cannot be read: ${why}`, source: null }];
  let lufs = num(f.lufs);
  let truePeak = num(f.truePeak);
  if (!(f.lufs === null && f.truePeak === null) && (lufs === null || truePeak === null)) {
    const l = measured && info.audio ? await loudnessOf(full, work, file) : { integrated: null };
    lufs = l.integrated !== null ? Math.round(l.integrated * 10) / 10 : null;
    truePeak = l.integrated !== null && l.truePeak !== null ? Math.round(l.truePeak * 10) / 10 : null;
  }
  const loud = lufs !== null && truePeak !== null;
  const t = f.trimmed;
  const trimmed = t && typeof t === "object" && num(t.end) !== null && num(t.limit) !== null && (t.why === "place" || t.why === "asked") ? { end: t.end, atCut: t.atCut === true, ...(num(t.before) !== null ? { before: t.before } : {}), why: t.why, limit: t.limit } : null;
  const rate = (x) => (x && typeof x === "object" && num(x.bitrate) !== null ? { bitrate: x.bitrate, ...Object.fromEntries(["rounds", "passes", "firstBytes", "limit"].filter((k) => num(x[k]) !== null).map((k) => [k, x[k]])), ...Object.fromEntries(["place", "by"].filter((k) => text(x[k]) !== null).map((k) => [k, x[k]])) } : null);
  // A file that cannot be measured as a video is said to be so, and given
  // as formats.json gave it.
  const note = measured ? null : `${file}, kept from an earlier run, could not be measured: ${why || "it has no video stream"}. It is listed as before and fails until a run measures it; give ${place.name} in --for to make it again.`;
  return {
    place,
    note,
    file: {
      place: place.name,
      label: place.label,
      file,
      cover: typeof f.cover === "string" ? path.basename(f.cover) : null,
      width: measured ? info.video.displayWidth : num(f.width),
      height: measured ? info.video.displayHeight : num(f.height),
      fps: measured ? Math.round(info.video.fps * 1000) / 1000 : num(f.fps),
      seconds: measured ? r3(info.duration) : num(f.seconds),
      bytes: info ? info.bytes : Math.max(0, sizeOf(full)),
      lufs: loud ? lufs : null,
      truePeak: loud ? truePeak : null,
      normalization: text(f.normalization),
      ceiling: num(f.ceiling),
      aimed: num(f.aimed),
      firstTry: f.firstTry && typeof f.firstTry === "object" && num(f.firstTry.lufs) !== null ? { lufs: f.firstTry.lufs, normalization: text(f.firstTry.normalization) } : null,
      heldByPeak: f.heldByPeak === true,
      twoPass: rate(f.twoPass),
      raised: rate(f.raised),
      trimmed,
      coverAt: num(f.coverAt),
      short: num(f.short),
      sameAs: typeof f.sameAs === "string" ? path.basename(f.sameAs) : null,
      videoBytes: num(f.videoBytes),
      pass: measured && !checks.some((c) => c.status === "fail"),
      checks,
      earlier: true,
    },
  };
}

// crop.json with the folder's files, their sizes and hashes, and its
// digest.
function sealed(crop, { written, hashes }) {
  const out = { ...crop, written, hashes };
  out.digest = digestOf(out);
  return JSON.stringify(out, null, 2) + "\n";
}

// What a run asks of its folder (folder.js claim()): the names it writes,
// as a disk that ignores letter case compares them (a file there in other
// letters is the same file), every file given, and the crop.json given
// with what it held when readArguments() read it (`args`).
function folderRules(video, options, places, args = null) {
  const inputs = [video, options.crop, options.steps, options.brand, options.cuts && fs.existsSync(options.cuts) ? options.cuts : null].filter(Boolean);
  const runNames = new Map(["crop.json", "FORMATS.md", ...(options.plan ? [] : ["formats.json", ...places.flatMap((p) => [`${p.name}.mp4`, `${p.name}-cover.jpg`])])].map((n) => [folded(n), n]));
  const writes = (name) => runNames.get(folded(name)) || (SHEET.test(folded(name)) ? folded(name) : null);
  return { video, writes, crop: options.crop || null, cropPrint: (args && args.cropPrint) || null, inputs };
}

// A write the disk refused in the run's folder, named with the folder as
// it was given: Node's own words name no file and no folder, and ffmpeg's
// none either. Every ffmpeg run of the kit writes in the run's hidden
// folder, so a full disk or quota an ffmpeg run met (`refused`, from
// ffmpeg.js) is that folder's too. Any other error as it is.
const WRITES = ["ENAMETOOLONG", "ENOSPC", "EDQUOT"];
const refusedWrite = (err, dir) => {
  const code = err ? (err.syscall ? err.code : err.refused) : null;
  return WRITES.includes(code) ? new Error(`Cannot write to ${dir}: ${WHY[code]}${code === "ENAMETOOLONG" ? "; pass a shorter folder with --out" : ""}`) : err;
};

// The folder a run takes, with what `take` (claim(), or wouldClaim() for a
// dry run) found in it: --out, or reframekit-<name>, where a folder that
// holds a run for another video of the same name (clip.mov after
// clip.mp4, or the film.mp4 of another folder) is left alone and the next
// free name taken. What `take` throws is thrown with the folder (`dir`).
function pickFolder(video, options, places, take, args = null) {
  const rules = folderRules(video, options, places, args);
  let dir = options.out || defaultOut(video);
  for (let n = 2; ; n++) {
    try {
      return { dir, folder: take(dir, rules) };
    } catch (err) {
      if (err.code !== "OTHER_VIDEO" || options.out || n > 50) throw Object.assign(err, { dir });
      dir = `${defaultOut(video)}-${n}`;
    }
  }
}

// options: { places, mode, pad, brand, crop, cuts, steps, seconds, trim,
// lufs, fps, cover, out, plan, log, program (the command it was started
// with, for the command FORMATS.md gives to render again) }
async function reframe(video, options = {}) {
  const log = options.log || (() => {});
  const tools = checkTools();
  if (!options.plan) pickEncoder();
  const args = readArguments(video, options);
  // An absolute path, so ffprobe never reads a name like take:2.mp4 as a
  // protocol.
  const source = path.resolve(video);
  const found = probe(source, video);
  const usable = (info) => {
    if (!info.video) throw new Error(`${video} has no video stream`);
    // A video that does not state its length is measured once the run has
    // its folder, and looked at again then.
    if (info.unstated) return;
    if (!(info.duration > 0.2) || (info.video.frames === 1 && /png|mjpeg|bmp|webp|tiff|gif/.test(info.video.codec))) throw new Error(`${video} is a still picture or shorter than a fifth of a second, not a video to reframe`);
    const v = info.video;
    // A picture of one frame, or of less than a fifth of a second, under a
    // longer sound, as ffmpeg makes of a picture and a sound without -loop
    // 1: the reading would get no frame of it. A container that states no
    // length of the picture's own, as a WebM, leaves it to the reading
    // (analyze.js briefPicture()), which says so as this does.
    const brief = v.duration > 0 ? v.duration < 0.2 : v.frames === 1;
    if (info.audio && brief) throw briefRefusal(v.frames, v.duration, info);
    if (v.displayWidth < 32 || v.displayHeight < 32) throw new Error(`${video} is ${v.displayWidth}x${v.displayHeight}, too small to reframe`);
  };
  // What to do with such a file: hold its picture for the length of the
  // sound, as ffmpeg's tpad filter does with the file as it is (-loop 1
  // takes only a picture's own file, SKILL.md).
  const briefRefusal = (frames, seconds, info) => new Error(`${video} holds ${frames === 1 ? "one picture" : `${seconds.toFixed(2)} s of picture`} under ${info.duration.toFixed(2)} s of sound, not a video to reframe: hold its picture as long as the sound first, as ffmpeg's tpad filter does`);
  // The reading of the picture, with a brief one refused in those words.
  const read = (info, work, dir) =>
    analyze(info.file, info, { work, log, name: path.basename(video), shown: dir }).catch((err) => {
      throw err.brief ? briefRefusal(err.brief.frames, err.brief.seconds, info) : err;
    });
  usable(found);
  // A video cut short, as a copy or a download that stopped part way, or a
  // recording that did, whose index ffprobe still reads while media it
  // lists runs past its end or is missing, is refused before any work, in
  // the check's words: its files would end where its media does, after a
  // shot that holds over seconds with nothing in them. One whose media is
  // all there goes on, as a fragmented MP4 cut only in the index of its
  // fragments at its end. ffmpeg's copy of the part that is there is a
  // whole file (SKILL.md), when the first frame of its picture is there
  // (mp4.js someMedia). Of one that stopped inside that frame, though
  // whole samples of its sound may come before it, or of one that holds
  // none of its media (mediaByte), as a copy that stopped where its index
  // ends, the copy holds nothing to reframe, and the refusal says which.
  const lay = layoutOf(source);
  if (lay && lay.cut && lay.cut.lost) {
    const what = lay.someMedia ? "Copy or download it again, or, for a recording that stopped part way, make a whole file of the part that is there with ffmpeg -c copy, and reframe that." : lay.mediaByte ? "Not even the first frame of its picture is whole in the file: copy or download it again." : "None of its media is in the file: copy or download it again.";
    throw new Error(`Cannot read ${video}: it is ${cutText(lay.cut)}. ${what}`);
  }

  const places = options.places || parsePlaces(NAMES.join(","));
  const shapes = shapesFor(places);
  // An MPEG-TS or MPEG-PS is read from a copy (ffmpeg.js), and a video
  // that does not state its length is measured, a run that a signal stops
  // with the rest: the crop.json and the cuts given are checked against
  // the length that comes to, once the run has its folder. Any other video
  // is checked now, before any work.
  const copied = unindexed(found);
  let fitted = copied || found.unstated ? null : fitArguments(args, found, shapes, options);

  const pad = args.pad;
  const notes = [];
  if (pad.from) notes.push(`Padded pictures sit on ${pad.hex}, from ${pad.from}.`);
  if (fitted) notes.push(...fitted.notes);

  // The folder, before any work.
  const { dir, folder } = pickFolder(video, options, places, claim, args);

  let stage;
  try {
    stage = openStage(folder.dir, { stop: stopAll, shown: dir });
  } catch (err) {
    throw refusedWrite(err, dir);
  }
  const work = stage.work;
  // The video as the folder's files record it: where it is from the folder,
  // and its size, which tells when it changed since a file was made.
  const sourceFile = pathFrom(folder.dir, source);
  const sourceBytes = fs.statSync(source).size;
  try {
    let info = found;
    if (copied) {
      log(`Copying ${path.basename(video)} into an MP4 to read it, as an MPEG-TS or MPEG-PS has no index to seek in`);
      const copy = await readableCopy(found, work, video);
      // The copy's streams, the video's own as the reports describe them:
      // its sound may be in the copy as ALAC, as a DVD's PCM is.
      info = { ...copy, audioTracks: found.audioTracks, audio: copy.audio && found.audio ? { ...copy.audio, codec: found.audio.codec, profile: found.audio.profile } : copy.audio };
      usable(info);
      // A jump ahead of ten seconds or less, which the copy keeps as a gap:
      // said where it is, and the picture's rate taken from its frames
      // outside it.
      const gaps = await gapsOf(info);
      if (gaps.fps) info.video = { ...info.video, ...ratesOf(gaps.fps.avg, gaps.fps.base) };
      notes.push(...gapNotes(gaps, path.basename(video)));
      fitted = fitArguments(args, info, shapes, options);
      notes.push(...fitted.notes);
      if (!found.unstated && Math.abs(found.duration - info.duration) > 1) notes.push(`${path.basename(video)} gives its length as ${found.duration.toFixed(2)} s, but its picture and sound last ${info.duration.toFixed(2)} s: its times jump, as where two recordings were joined, so the files hold its parts back to back.`);
    } else if (found.unstated) {
      log(`Measuring ${path.basename(video)}, which does not state its length`);
      info = await measureLength(found, video);
      usable(info);
      fitted = fitArguments(args, info, shapes, options);
      notes.push(...fitted.notes);
    }
    const v = info.video;
    const { given, cuts, cutsNote } = fitted;
    // A plan made with --mode fit is rendered in fit mode with --crop too.
    const mode = options.mode === "fit" || (given && given.mode === "fit") ? "fit" : given ? "follow" : options.mode || "follow";
    if (v.variable) notes.push(variableNote(v, options.fps));
    const rate = rateNote(v, options.fps);
    if (rate) notes.push(rate);
    if (v.rotation) notes.push(`The video is stored turned by ${v.rotation} degrees and shown upright; the files are stored upright.`);
    if (v.sar !== "1:1") notes.push(`The video's pixels are not square (${v.sar}); the files have square ones.`);
    if (info.measured) notes.push(`The video does not state its length, so it was measured: ${info.duration.toFixed(2)} s.`);
    if (info.audioTracks > 1) notes.push(`The video has ${info.audioTracks} sound tracks; only the first is in the files. To keep a voice recorded on another track, mix the tracks into one first.`);
    if (/smpte2084|arib-std-b67/.test(v.colorTransfer)) notes.push("The video is HDR. reframekit does not tone map, so the files' colors look flat; convert it to SDR first.");
    const timeline = given ? null : timelineFor(source, info.duration);
    if (timeline && timeline.ignored) notes.push(`${path.basename(timeline.file)} was left out: ${timeline.ignored}.`);
    const steps = given ? null : stepsFor(source, { given: options.steps || "", read: args.steps, duration: info.duration, width: v.displayWidth, height: v.displayHeight });
    if (steps && steps.ignored) notes.push(`${steps.name} was left out: ${steps.ignored}.`);
    if (steps && steps.notes) notes.push(...steps.notes);

    let picture;
    let shots;
    let cover;
    // The reading of the picture, when this run reads it.
    let data = null;
    if (given) {
      ({ picture, shots, cover } = given);
      if (options.cover !== undefined) cover = r3(Math.min(info.duration, options.cover));
      log(`Using ${path.basename(given.file)}: ${shots.length} ${shots.length === 1 ? "shot" : "shots"}`);
      // The windows of a shape crop.json has none of, planned for its
      // shots as a plan plans them; the windows it has are kept.
      const lacking = Object.keys(given.lacking);
      if (lacking.length) {
        log(`Reading ${path.basename(video)} to plan the ${lacking.join(" and ")} windows`);
        data = await read(info, work, dir);
        data.picture = picture;
        const planned = planWindows(data, shots, given.lacking, { mode: "follow" });
        shots = shots.map((s, i) => ({ ...s, windows: { ...s.windows, ...planned[i].windows } }));
        notes.push(`crop.json had no ${lacking.join(" or ")} windows, so this run planned them for its shots; look at them on the sheet before the files go out.`);
      }
    } else {
      log(`Reading ${path.basename(video)} (${v.displayWidth}x${v.displayHeight}, ${info.duration.toFixed(2)} s)`);
      data = await read(info, work, dir);
      picture = data.picture || { x: 0, y: 0, w: v.displayWidth, h: v.displayHeight };
      if (data.picture) notes.push(`Black bars were found around the picture; it is the ${picture.w}x${picture.h} inside them (crop.json's picture) that gets reframed.`);
      data.picture = picture;
      shots = shotsOf(info.duration, cutsFrom({ given: cuts, timeline: timeline && !timeline.ignored ? timeline : null, steps: steps && !steps.ignored ? steps : null, found: data.cuts, dissolves: data.dissolves }));
      if (cuts) notes.push("The shots start where --cuts says, and only there: the cuts found in the picture were not used.");
      if (cutsNote) notes.push(cutsNote);
      if (timeline && !timeline.ignored) notes.push(`The shots start where launch-film's ${path.basename(timeline.file)} says its clips do, and only there: a change inside a clip, as a title that comes in, is no cut.`);
      if (steps && !steps.ignored) notes.push(`${steps.name} gave ${steps.cuts.length + 1} ${steps.cuts.length ? "pages" : "page"} and ${steps.presses.length} ${steps.presses.length === 1 ? "press" : "presses"} for the windows to go to${steps.box ? ", and the page's box, which the windows stay inside" : ""}.`);
      if (data.flashes.length && !cuts && !(timeline && !timeline.ignored)) notes.push(`${data.flashes.length === 1 ? "A flash" : `${data.flashes.length} flashes`} (at ${data.flashes.map((t) => `${t.toFixed(2)} s`).join(", ")}), where the picture turns and comes back within a quarter second, ${data.flashes.length === 1 ? "was" : "were"} not taken for a cut.`);
      log(`${shots.length} ${shots.length === 1 ? "shot" : "shots"}`);
      shots = planWindows(data, shots, shapes, { mode: mode === "fit" ? "follow" : mode, presses: steps && !steps.ignored ? steps.presses : [], box: steps && !steps.ignored ? steps.box : null });
      cover = options.cover !== undefined ? r3(Math.min(info.duration, options.cover)) : coverTime(data, shots, info.duration);
    }
    // A picture that ends before the sound does: a file that runs that far
    // holds its last frame from there to the end of the sound (render.js),
    // as the files hold its first frame where the sound starts before it,
    // so each file has a picture all through. A plan says so now, a render
    // once it knows which files run that far (heldNote()).
    const held = heldPicture(info, data);
    if (held && options.plan) notes.push(heldNote(path.basename(video), held));
    // A --cover at or past the end, as frames given as seconds, is said.
    if (options.cover !== undefined && options.cover >= info.duration) notes.push(`--cover asked for ${options.cover} s, at or past the end of the ${info.duration.toFixed(2)} s video, so the covers are from near its end.`);

    // The shapes whose windows come from crop.json, as the reports say.
    const fromCrop = given ? Object.keys(shapes).filter((key) => !Object.hasOwn(given.lacking, key)) : [];
    const crop = mergeGiven(cropJson({ version, video: path.basename(video), source: { file: sourceFile, bytes: sourceBytes }, info, data: { width: v.displayWidth, height: v.displayHeight, picture }, shots, shapes, cover, mode, notes }), given);
    // Windows set by hand stay marked as such in the crop.json this run
    // writes, so no later run without --crop plans over them.
    if (given && handMade(given.raw)) crop.edited = true;
    log("Drawing sheet.png");
    const title = `REFRAMEKIT  ${path.basename(video)}  ${v.displayWidth}X${v.displayHeight}  ${info.duration.toFixed(2)} S  ${shots.length} SHOT${shots.length === 1 ? "" : "S"}`;
    const sheets = await drawSheets({ info, picture, shots, shapes, work, title, held: held ? held.from : null });
    for (const s of sheets.pages) fs.writeFileSync(path.join(stage.stage, s.file), s.png);
    const sheetFiles = sheets.pages.map((s) => s.file);
    const next = nextCommand({ program: options.program, video, dir, places: places.map((p) => p.name), pad: options.pad || null, brand: options.brand || null, seconds: options.seconds ?? null, trim: options.trim !== false, lufs: options.lufs ?? null, fps: options.fps ? rateText(outputRate(v, options.fps)) : null });

    // What the earlier run in the folder leaves: the files this run makes
    // again are replaced; its other sheet pages go, and so does a check of
    // its files when they are made again: the folder's CHECK.md, and a
    // reframekit-check-<name> folder in it of formats.json, which every
    // render writes anew, or of a file this run makes again. The rest stays
    // (a plan leaves the rendered files where they are, a render the files
    // of places it was not asked for).
    const own = folder.own;
    const staged = () => fs.readdirSync(stage.stage).filter((n) => n !== ".work" && n !== ".owner");
    const outdated = (n, made) => n === "CHECK.md" || n === "check.json" || (Object.hasOwn(folder.checks, n) && (folder.checks[n] === "formats.json" || made.includes(folder.checks[n])));
    const removeFor = (made) => [...own].filter((n) => !made.includes(n) && fs.existsSync(path.join(folder.dir, n)) && (SHEET.test(n) || (!options.plan && outdated(n, made))));
    const keptFor = (made, removed) => [...own].filter((n) => !made.includes(n) && !removed.includes(n) && fs.existsSync(path.join(folder.dir, n))).sort();

    // The folder's files after the run, with their sizes and hashes: this
    // run's, and those kept as claim() found them, so that one changed
    // meanwhile is someone's to every later run; crop.json and
    // formats.json left out (they speak for themselves).
    const writtenOf = (kept) => {
      const all = [...kept.map((n) => [n, folder.prints[n]]), ...staged().map((n) => [n, printOf(path.join(stage.stage, n))])].filter(([n, p]) => n !== "crop.json" && n !== "formats.json" && p && typeof p.bytes === "number");
      all.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return { written: Object.fromEntries(all.map(([n, p]) => [n, p.bytes])), hashes: Object.fromEntries(all.map(([n, p]) => [n, p.hash])) };
    };

    // The files of the earlier run as formats.json lists them, each with
    // the size of the video it was made from.
    const earlierFiles = ((folder.run && folder.run.formats && folder.run.formats.files) || [])
      .filter((f) => f && typeof f.file === "string")
      .map((f) => ({ ...f, videoBytes: typeof f.videoBytes === "number" ? f.videoBytes : !f.earlier && folder.run.formats.source && typeof folder.run.formats.source.bytes === "number" ? folder.run.formats.source.bytes : null }));

    if (options.plan) {
      const made = [...staged(), "crop.json", "FORMATS.md"];
      const removed = removeFor(made);
      const kept = keptFor(made, removed);
      const rendered = kept.filter((n) => MEDIA.test(n));
      // Those of them made before the video changed, with their covers.
      const stale = new Set(earlierFiles.filter((f) => madeBefore(f, { source: { bytes: sourceBytes } })).flatMap((f) => [path.basename(f.file), ...(typeof f.cover === "string" ? [path.basename(f.cover)] : [])]));
      const before = rendered.filter((n) => stale.has(n));
      fs.writeFileSync(path.join(stage.stage, "FORMATS.md"), planMarkdown({ video: path.basename(video), info, shots, shapes, cover, notes, mode, sheets, next, rendered, before, given: fromCrop }));
      fs.writeFileSync(path.join(stage.stage, "crop.json"), sealed(crop, writtenOf(kept)));
      // A signal that came while the end's own work held the event loop is
      // heard before the files move in (folder.js turn()).
      await turn();
      finishStage(stage, removed, folder);
      return { dir, plan: true, crop: JSON.parse(fs.readFileSync(path.join(folder.dir, "crop.json"), "utf8")), sheets: sheetFiles, sheetNote: sheets.note, next, kept: rendered, keptBefore: before, removed, given: Boolean(given) };
    }

    const fps = outputRate(v, options.fps);
    const lufs = options.lufs === undefined ? -14 : options.lufs;
    const ctx = { info, picture, shots, mode, pad, seconds: options.seconds, trim: options.trim !== false, lufs, fps, cover, work, log, version, held };
    const jobs = jobsFor(places, ctx);
    const holding = held ? heldNote(path.basename(video), held, jobs) : null;
    if (holding) notes.push(holding);
    // The sound measured once for each length the files are cut to.
    const measured = new Map();
    for (const job of jobs) {
      const end = job.trim ? job.trim.end : 0;
      if (!measured.has(end)) measured.set(end, await measureLoudness(info.file, info, { end, lufs, work }));
      job.measured = measured.get(end);
    }
    const files = [];
    // Why loudnorm set each file's sound dynamically, when it did, and its
    // first try, from what the run measured (render.js dynamicWhy()), for
    // FORMATS.md, with the loudness range measured: kept out of
    // formats.json.
    const loudnorm = {};
    for (const job of jobs) {
      const made = await encodeJob(job, ctx);
      // The copies for the other places this file serves.
      for (const [i, place] of job.places.entries()) {
        const file = `${place.name}.mp4`;
        const coverFile = `${place.name}-cover.jpg`;
        if (i > 0) {
          fs.copyFileSync(path.join(work, job.file), path.join(work, file));
          fs.copyFileSync(path.join(work, job.cover), path.join(work, coverFile));
        }
        const checks = checkFile(path.join(work, file), place, { info: { ...made.made, file: path.join(work, file) }, layout: layoutOf(path.join(work, file)) });
        loudnorm[file] = { why: made.dynamicWhy || null, first: (made.firstTry && made.firstTry.why) || null, lra: job.measured && Number.isFinite(job.measured.lra) ? job.measured.lra : null };
        const planned = job.trim ? job.trim.end : info.duration;
        const aimed = made.aim !== null && Math.abs(made.aim - lufs) > 0.05 ? Math.round(made.aim * 10) / 10 : null;
        files.push({
          place: place.name,
          label: place.label,
          file,
          cover: coverFile,
          width: made.made.video.displayWidth,
          height: made.made.video.displayHeight,
          fps: Math.round(made.made.video.fps * 1000) / 1000,
          seconds: r3(made.made.duration),
          bytes: made.size,
          lufs: made.loudness && made.loudness.integrated !== null ? Math.round(made.loudness.integrated * 10) / 10 : null,
          truePeak: made.loudness && made.loudness.truePeak !== null ? Math.round(made.loudness.truePeak * 10) / 10 : null,
          normalization: made.normalization,
          ceiling: made.ceiling,
          aimed,
          // What the first try at the target measured, when the sound was
          // set again asking for another loudness.
          firstTry: aimed !== null && made.firstTry ? { lufs: Math.round(made.firstTry.lufs * 10) / 10, normalization: made.firstTry.normalization } : null,
          // A try nearer the target was set aside: its true peak went over
          // -1 dBTP.
          heldByPeak: made.held,
          twoPass: made.twoPass,
          raised: made.raised,
          trimmed: job.trim,
          // When the cover was taken: the cover time, or near the file's
          // end for a file that ends before it.
          coverAt: made.coverAt,
          short: made.made.duration < planned - 1.5 / rateValue(fps) ? r3(planned) : null,
          sameAs: i > 0 ? job.file : null,
          videoBytes: sourceBytes,
          pass: !checks.some((c) => c.status === "fail"),
          checks,
        });
      }
    }
    // The files in the order the places were asked for.
    files.sort((a, b) => places.findIndex((p) => p.name === a.place) - places.findIndex((p) => p.name === b.place));
    for (const name of fs.readdirSync(work)) if (/\.(mp4|jpg)$/.test(name)) fs.renameSync(path.join(work, name), path.join(stage.stage, name));
    if (measured.size && [...measured.values()].every((m) => m && !(m.i > -70))) notes.push("The sound is silent, so its level was left as it is.");
    // Sound raised by more than 30 dB to reach the target, as a recording
    // of little but room tone is, quieter than -44 LUFS for -14: what it
    // measured and the gain, since its hiss is raised as much. The
    // quietest of the lengths the files are cut to gives the most gain.
    // Sound that quiet is over -70 LUFS only for a target over -40, so a
    // lower one can always be given.
    const quiet = [...measured.values()].filter((m) => m && m.i > -70).reduce((q, m) => (q && q.i <= m.i ? q : m), null);
    if (quiet && lufs - quiet.i > 30) notes.push(`The sound measured ${quiet.i.toFixed(1)} LUFS, so it was raised by about ${Math.round(lufs - quiet.i)} dB to reach ${lufs} LUFS, and any hiss or room tone in it was raised as much. A lower --lufs, down to -40, raises it less.`);
    const short = files.filter((f) => f.short && !f.sameAs);
    if (short.length) notes.push(`${short.map((f) => `${f.file} is ${f.seconds.toFixed(2)} s`).join(", ")}, shorter than the ${short[0].short.toFixed(2)} s planned: the video's picture or sound ends before the length its index states, so the files end there too.`);
    // A file encoded again for its place's file size limit: a lower bit
    // rate over the most it takes, a steady one under the least.
    for (const f of files) if (!f.sameAs && (f.twoPass || f.raised)) notes.push(resizedText(f));
    const misses = files.filter((f) => !f.sameAs && f.lufs !== null && Math.abs(f.lufs - lufs) > 0.5);
    if (misses.length) notes.push(`${misses.map((f) => `${f.file} came out at ${f.lufs.toFixed(1)} LUFS`).join(", ")}, more than half a unit from ${lufs} LUFS after every try to set it.`);

    // The files of places not asked this time, kept from the earlier run.
    const made = [...staged(), "formats.json", "FORMATS.md", "crop.json"];
    const removed = removeFor(made);
    const kept = keptFor(made, removed);
    const keptFiles = [];
    const keptPlaces = [];
    const left = [];
    for (const f of earlierFiles) {
      const file = path.basename(f.file);
      if (!kept.includes(file) || places.some((p) => p.name === f.place) || keptPlaces.some((p) => p.name === f.place)) continue;
      const entry = await keptEntry(f, folder.dir, work, dir);
      if (!entry.file) {
        left.push(entry);
        continue;
      }
      if (entry.note) notes.push(entry.note);
      keptFiles.push(entry.file);
      keptPlaces.push(entry.place);
    }
    // A file left out is said to be, once, unless formats.json lists it for
    // a place too.
    for (const entry of left) if (!keptFiles.some((g) => g.file === entry.name) && !notes.includes(entry.note)) notes.push(entry.note);
    for (const f of keptFiles) if (f.sameAs && !keptFiles.some((g) => g.file === f.sameAs)) f.sameAs = null;
    const formats = formatsJson({ version, video: path.basename(video), sourceFile, sourceBytes, info, picture, mode, pad, files: [...files, ...keptFiles], shots, cover, places: [...places, ...keptPlaces], notes, fps: rateText(fps), trim: ctx.trim, seconds: options.seconds ?? null, lufs });
    formats.ffmpeg = tools.version;
    fs.writeFileSync(path.join(stage.stage, "FORMATS.md"), formatsMarkdown({ ...formats, shotsFull: shots, loudnorm }, { modeNotes: mode === "pad" ? ["Every shot is padded (--mode pad)."] : mode === "center" ? ["Every window sits in the middle (--mode center)."] : [], next, removed, given: fromCrop, sheets: sheetFiles }));
    const written = writtenOf(kept);
    Object.assign(formats, written);
    fs.writeFileSync(path.join(stage.stage, "formats.json"), JSON.stringify(formats, null, 2) + "\n");
    fs.writeFileSync(path.join(stage.stage, "crop.json"), sealed(crop, written));
    // A signal that came while ffprobe read the files kept, or while the
    // end's own work held the event loop, is heard before the files move
    // in (folder.js turn()).
    await turn();
    finishStage(stage, removed, folder);
    return { dir, plan: false, formats, crop, sheets: sheetFiles, fps: rateValue(fps), next, removed, given: Boolean(given), fromCrop };
  } catch (err) {
    drop(stage);
    throw refusedWrite(err, dir);
  }
}

module.exports = { reframe, slug, defaultOut, cutsFrom, givenCuts, pickFolder, readArguments, variableNote, gapNotes, heldPicture, heldNote };
