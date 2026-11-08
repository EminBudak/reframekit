"use strict";

// The check: a finished file measured against a place's limits, the ones
// in places.js with the page and the day each was read. Shape, size,
// frame rate, length, file size, codecs, and how the MP4 is laid out
// (whole, its index before its media, no edit lists). With an ASS caption
// file, whether its text stays inside the place's safe area. Loudness,
// black, still and silent stretches are launch-film's check_video's job.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { probe, measureLength } = require("./ffmpeg");
const { SOURCES, placeFor, NAMES, PLACES, shapeOf, safeAreaFor } = require("./places");
const { readCaptions, boxesFor } = require("./captions");
const { slug, readJson, marked, pathFrom, real, unwritable, reportWritten, firstMissing, removeCreated, turn, WHY } = require("./folder");
const { layoutOf, cutText, strayText, MOST } = require("./mp4");

// ─── the checks ────────────────────────────────────────────────────────────

// A thousand bytes to a KB and a million to a MB, as the limits are read.
const size = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
const secs = (t) => `${Number(t).toFixed(2)} s`;
const ratio = (w, h) => shapeOf(w, h);

// One file against one place. Returns [{ name, status, expected, found,
// source }], status being pass, fail, warn or info.
function checkFile(file, place, { info = null, layout = null } = {}) {
  const i = info || probe(file);
  const lay = layout || layoutOf(file);
  const L = place.limits || {};
  const rows = [];
  const add = (name, status, expected, found, rule) => rows.push({ name, status, expected, found, source: rule && rule.source ? rule.source : null });
  const level = (rule) => (rule && rule.hard ? "fail" : "warn");
  const v = i.video;
  if (!/mp4|mov/.test(i.formatName)) add("container", "fail", "MP4", i.formatName || "unknown");
  else add("container", "pass", "MP4", "MP4");
  // A copy or a recording that stopped part way: its index can still be
  // whole and read, while the media it lists runs past the end, or is not
  // there at all. One of more boxes than the walk reads (mp4.js MOST) is
  // said to be read only so far.
  if (lay && lay.cut) add("file", "fail", "the whole file", cutText(lay.cut), null);
  // Bytes after the last box of a whole file, as the line break an upload
  // can leave, which ffmpeg passes over.
  if (lay && lay.stray) add("file", "warn", "nothing after its last box", strayText(lay.stray), null);
  if (lay && lay.partial) add("MP4 layout", "warn", "every box read", `read as far as its first ${MOST.toLocaleString("en-US")} boxes, so a cut after them is not seen`, null);
  if (!v) {
    add("picture", "fail", "a video stream", "none");
    return rows;
  }
  const w = v.displayWidth;
  const h = v.displayHeight;
  const aspect = w / h;

  // Shape and size.
  if (L.shape) {
    const ok = (L.shape.minAspect === undefined || aspect >= L.shape.minAspect - 0.005) && (L.shape.maxAspect === undefined || aspect <= L.shape.maxAspect + 0.005);
    add("shape", ok ? "pass" : level(L.shape), L.shape.what, ratio(w, h), L.shape);
  } else if (!place.custom) {
    const want = place.width / place.height;
    const ok = Math.abs(aspect - want) / want < 0.01;
    add("shape", ok ? "pass" : "warn", ratio(place.width, place.height), ratio(w, h), null);
  }
  if (L.side) {
    const ok = Math.min(w, h) >= L.side.min && Math.max(w, h) <= L.side.max;
    add("size", ok ? "pass" : level(L.side), `each side ${L.side.min} to ${L.side.max} px`, `${w}x${h}`, L.side);
  }
  if (L.size) {
    const ok = w >= L.size.minWidth && h >= L.size.minHeight && w <= L.size.maxWidth && h <= L.size.maxHeight;
    add("size", ok ? "pass" : level(L.size), `${L.size.minWidth}x${L.size.minHeight} to ${L.size.maxWidth}x${L.size.maxHeight}`, `${w}x${h}`, L.size);
  }
  if (L.width) add("width", w <= L.width.max ? "pass" : level(L.width), `${L.width.max} px at most`, `${w} px`, L.width);
  if (place.custom) add("size", w === place.width && h === place.height ? "pass" : "warn", `${place.width}x${place.height}`, `${w}x${h}`, null);
  else if (!L.side && !L.size && !L.width) add("size", w >= place.width * 0.66 || h >= place.height * 0.66 ? "pass" : "warn", `about ${place.width}x${place.height}`, `${w}x${h}`, null);
  if (v.sar !== "1:1") add("square pixels", "warn", "1:1", v.sar, null);
  if (v.rotation) add("rotation", "warn", "none: the picture stored upright", `${v.rotation} degrees in the metadata`, null);

  // Frame rate.
  const fps = Math.round(v.fps * 1000) / 1000;
  if (L.fps) add("frame rate", fps >= L.fps.min - 0.01 && fps <= L.fps.max + 0.01 ? "pass" : level(L.fps), `${L.fps.min} to ${L.fps.max} fps`, `${fps} fps`, L.fps);
  else add("frame rate", fps <= 60.01 ? "pass" : "warn", "60 fps at most", `${fps} fps`, null);
  if (v.variable) add("steady frame rate", "warn", "one frame rate throughout", `${Math.round(v.baseFps * 100) / 100} at most, ${fps} on average`, null);

  // Length and file size.
  const d = i.duration;
  if (L.seconds) {
    const ok = (L.seconds.min === undefined || d >= L.seconds.min) && (L.seconds.max === undefined || d <= L.seconds.max);
    const want = L.seconds.min !== undefined && L.seconds.max !== undefined ? `${L.seconds.min} to ${L.seconds.max} s` : L.seconds.max !== undefined ? `${L.seconds.max} s at most` : `${L.seconds.min} s at least`;
    add("length", ok ? "pass" : level(L.seconds), want, secs(d), L.seconds);
  } else add("length", "info", "", secs(d), null);
  if (L.bytes) {
    const ok = (L.bytes.min === undefined || i.bytes >= L.bytes.min) && (L.bytes.max === undefined || i.bytes <= L.bytes.max);
    const limit = (n) => (n >= 1e9 ? `${Math.round(n / 1e7) / 100} GB` : n >= 1e6 ? `${Math.round(n / 1e4) / 100} MB` : `${Math.round(n / 10) / 100} KB`);
    const want = L.bytes.min !== undefined ? `${limit(L.bytes.min)} to ${limit(L.bytes.max)}` : `${limit(L.bytes.max)} at most`;
    add("file size", ok ? "pass" : level(L.bytes), want, size(i.bytes), L.bytes);
  } else add("file size", "info", "", size(i.bytes), null);

  // Codecs and layout.
  const vc = L.videoCodec || { allowed: ["h264"] };
  add("video codec", vc.allowed.includes(v.codec) ? "pass" : L.videoCodec ? level(vc) : "warn", vc.allowed.map((c) => (c === "h264" ? "H.264" : c === "hevc" ? "HEVC" : c.toUpperCase())).join(" or "), v.codec || "unknown", L.videoCodec);
  const pf = L.pixFmt || { allowed: ["yuv420p", "yuvj420p"] };
  add("chroma", pf.allowed.includes(v.pixFmt) ? "pass" : L.pixFmt ? level(pf) : "warn", "4:2:0 (yuv420p)", v.pixFmt || "unknown", L.pixFmt);
  if (v.fieldOrder && !/^(progressive|unknown)$/.test(v.fieldOrder)) add("progressive", L.progressive ? level(L.progressive) : "warn", "progressive", v.fieldOrder, L.progressive);
  if (L.videoBitrate) {
    const bits = v.bitRate || Math.max(0, i.bitRate - (i.audio ? i.audio.bitRate : 0));
    add("video bit rate", bits <= L.videoBitrate.max ? "pass" : level(L.videoBitrate), `${L.videoBitrate.max / 1e6} Mb/s at most`, `${(bits / 1e6).toFixed(1)} Mb/s`, L.videoBitrate);
  }
  if (!lay) add("MP4 layout", "warn", "boxes that can be read", "could not be read, so the index and edit lists were not checked", null);
  if (lay && lay.faststart !== null) add("index first", lay.faststart ? "pass" : L.faststart ? level(L.faststart) : "warn", "moov before mdat (fast start)", lay.faststart ? "moov first" : "mdat first", L.faststart);
  if (lay) add("edit lists", lay.shiftingEdits ? (L.editList ? level(L.editList) : "warn") : "pass", "none that skip or delay", lay.shiftingEdits ? `${lay.shiftingEdits} track${lay.shiftingEdits > 1 ? "s" : ""} with one` : lay.editLists ? "only ones that play the whole track" : "none", L.editList);

  // Sound.
  const a = i.audio;
  if (!a) add("sound", "info", "", "no sound track", null);
  else {
    const ac = L.audioCodec || { allowed: ["aac"] };
    add("audio codec", ac.allowed.includes(a.codec) ? "pass" : L.audioCodec ? level(ac) : "warn", ac.allowed.map((c) => c.toUpperCase()).join(" or "), a.codec || "unknown", L.audioCodec);
    if (L.sampleRate && L.sampleRate.max) add("sample rate", a.sampleRate <= L.sampleRate.max ? "pass" : level(L.sampleRate), `${L.sampleRate.max / 1000} kHz at most`, `${a.sampleRate / 1000} kHz`, L.sampleRate);
    else add("sample rate", a.sampleRate === 48000 ? "pass" : "warn", "48 kHz", `${a.sampleRate / 1000} kHz`, L.sampleRate || null);
    if (L.channels) add("channels", a.channels <= L.channels.max ? "pass" : level(L.channels), `${L.channels.max} at most`, `${a.channels}`, L.channels);
  }
  return rows;
}

// Captions against a place's safe area: each cue's box, from an ASS file,
// in shares of the frame, for a file `frame` = { width, height } in size.
function checkCaptions(captions, place, duration, frame = null) {
  const rows = [];
  const late = captions.cues.filter((c) => c.start >= duration - 0.01);
  const over = captions.cues.filter((c) => c.end > duration + 0.05 && c.start < duration);
  if (late.length || over.length) rows.push({ name: "captions in time", status: "warn", expected: `every caption inside the file's ${secs(duration)}`, found: `${late.length ? `${late.length} start after the end` : ""}${late.length && over.length ? ", " : ""}${over.length ? `${over.length} run past it` : ""}`, source: null });
  else rows.push({ name: "captions in time", status: "pass", expected: `every caption inside the file's ${secs(duration)}`, found: `${captions.cues.length} captions`, source: null });
  const safe = safeAreaFor(place);
  if (!safe) return { rows, outside: [] };
  if (!captions.placed) {
    rows.push({ name: "captions in the safe area", status: "info", expected: "", found: `${captions.kind === "srt" ? "an SRT" : "a WebVTT"} file does not say where its text sits; give the ASS file to check it`, source: null });
    return { rows, outside: [] };
  }
  const outside = [];
  const cues = frame ? boxesFor(captions, frame.width, frame.height) : captions.cues;
  for (const c of cues) {
    if (c.start >= duration) continue;
    const b = c.box;
    const sides = [];
    if (b.y < safe.top - 0.002) sides.push("top");
    if (b.y + b.h > 1 - safe.bottom + 0.002) sides.push("bottom");
    if (b.x < safe.left - 0.002) sides.push("left");
    if (b.x + b.w > 1 - safe.right + 0.002) sides.push("right");
    if (sides.length) outside.push({ start: c.start, end: c.end, text: c.text, sides });
  }
  const area = `clear of the top ${Math.round(safe.top * 100)}%, bottom ${Math.round(safe.bottom * 100)}% and sides ${Math.round(safe.left * 100)}%${safe.standIn ? ` (Meta's margins for Reels, standing in: ${place.label} publishes none)` : ""}`;
  rows.push({ name: "captions in the safe area", status: outside.length ? "fail" : "pass", expected: area, found: outside.length ? `${outside.length} of ${captions.cues.length} reach into the ${[...new Set(outside.flatMap((o) => o.sides))].join(", ")} margin, by an estimate from the ASS styles that errs wide` : `all ${captions.cues.length}, by an estimate from the ASS styles`, source: safe.source });
  return { rows, outside };
}

// The places a lone file is checked against when --for is not given: the
// named ones whose shape it has.
function placesForShape(w, h) {
  return NAMES.filter((name) => {
    const p = PLACES[name];
    return Math.abs(w / h - p.width / p.height) / (p.width / p.height) < 0.01;
  }).map(placeFor);
}

// Where a check's reports go: `out` when given; for a reframekit folder
// or its formats.json, that folder; for one MP4, a folder of its own next
// to it, reframekit-check-<name>, so the reports never land among the
// files around it. When that folder holds the check of another file of
// the same name (clip.mov after clip.mp4), reframekit-check-<name>-2 and
// on.
function reportFolder(target, out) {
  if (out) return path.resolve(out);
  const folder = fs.statSync(target).isDirectory();
  if (folder) return path.resolve(target);
  if (/formats\.json$/i.test(target)) return path.resolve(path.dirname(target));
  const base = path.resolve(path.dirname(target), `reframekit-check-${slug(target)}`);
  for (let n = 1; n <= 50; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    const before = readJson(path.join(dir, "check.json"));
    if (!marked(before) || checkOf(before, dir, target)) return dir;
  }
  throw new Error(`${base} and the 49 folders after it hold checks of other files named like ${path.basename(target)}. Give --out a folder for this one.`);
}

// Why a check of `target` may not write in `dir`, when the check.json
// there is reframekit's and of another file; else null. `out` is the
// folder as given with --out.
function otherCheck(dir, target, out = null) {
  const earlier = readJson(path.join(dir, "check.json"));
  if (!marked(earlier) || checkOf(earlier, dir, target)) return null;
  const shown = (file) => path.relative(process.cwd(), file) || file;
  const was = typeof earlier.checked === "string" ? shown(path.resolve(real(dir), earlier.checked)) : String((Array.isArray(earlier.results) && earlier.results[0] && earlier.results[0].file) || "another file");
  return `${out || shown(dir)} holds the check of ${was}, not of ${shown(path.resolve(target))}. Give --out another folder.`;
}

// Whether a check.json reframekit wrote in `dir` is of `target`: by where
// that file is from the folder, or for a check that left that out, by its
// name.
function checkOf(report, dir, target) {
  if (typeof report.checked === "string") return report.checked === pathFrom(dir, target);
  const files = Array.isArray(report.results) ? report.results.map((r) => r && r.file) : [];
  return files.every((f) => f === path.basename(target));
}

// The report in `dir` a check would replace that reframekit did not
// write, CHECK.md or check.json, as the refusal names it, or null: either
// is reframekit's only when check.json says so, and CHECK.md only as the
// check.json there says it was written. `shown` names the folder as it was
// given, or as found next to the file given.
function theirReport(dir, shown = dir) {
  const at = (name) => path.join(dir, name);
  const stat = (name) => {
    try {
      return fs.lstatSync(at(name));
    } catch {
      return null;
    }
  };
  const before = stat("check.json") && stat("check.json").isFile() ? readJson(at("check.json")) : null;
  const ours = { "check.json": marked(before), "CHECK.md": marked(before) && Boolean(stat("CHECK.md")) && stat("CHECK.md").isFile() && reportWritten(dir, before) };
  const name = ["CHECK.md", "check.json"].find((n) => stat(n) && !ours[n]);
  return name ? `${path.join(shown, name)} is not a report reframekit wrote, and the check would replace it. Move it, or give --out another folder.` : null;
}

// Before anything is measured, reading only: where a check of `target`
// writes its reports (`dir`, and `shown`, the folder as given or as found
// next to the file given, as the summary names it), and why it may not,
// or null (`refused`), so that the check and its dry run stop on the same
// things. `out` is the folder given with --out.
function checkPlan(target, out = null) {
  if (!fs.existsSync(target)) return { dir: null, formats: null, refused: `Cannot read ${target}: no such file` };
  const folder = fs.statSync(target).isDirectory();
  const formats = folder ? path.join(target, "formats.json") : /formats\.json$/i.test(target) ? target : null;
  if (formats && !fs.existsSync(formats)) return { dir: null, formats, refused: `${target} holds no formats.json: give a reframekit folder or an MP4` };
  let dir;
  try {
    dir = reportFolder(target, out);
  } catch (err) {
    return { dir: null, formats, refused: err.message };
  }
  const shown = out || (folder ? target : formats ? path.dirname(target) : path.join(path.dirname(target), path.basename(dir)));
  // A camera card or a share that takes no files is told so.
  const why = unwritable(dir);
  if (why) return { dir, shown, formats, refused: `Cannot write the check to ${shown}: ${why}; give --out a folder that takes files` };
  // A folder that holds the check of another file is never written over,
  // as with --out a folder of another video's run is not: the check of
  // clip.mov stops instead of replacing that of clip.mp4.
  return { dir, shown, formats, refused: otherCheck(dir, formats || target, out) || theirReport(dir, shown) };
}

// Writes the reports in `dir`: check.json, which says reframekit wrote it,
// the file it checked (where it is from the folder) and the size and hash
// of the CHECK.md written with it, and CHECK.md. Either is replaced only
// when the one there is reframekit's; any other file of those names stops
// the check before it writes. Both reports are written under passing
// names first and only then renamed over the old ones, which replaces a
// link of that name rather than the file it points at: a disk that fills
// up while they are written leaves neither, nor the folders the check
// made for them, while they are empty. Returns what check.json holds.
function writeReports(dir, report, md, target, shown = dir) {
  const at = (name) => path.join(dir, name);
  const hash = crypto.createHash("sha256").update(md).digest("hex").slice(0, 16);
  const json = { ...report, checked: pathFrom(dir, target), written: { "CHECK.md": Buffer.byteLength(md) }, hashes: { "CHECK.md": hash } };
  const reports = { "CHECK.md": md, "check.json": JSON.stringify(json, null, 2) + "\n" };
  const created = firstMissing(dir);
  const passing = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    const theirs = theirReport(dir, shown);
    if (theirs) throw new Error(theirs);
    for (const [name, text] of Object.entries(reports)) {
      const file = at(`.${name}-${crypto.randomBytes(4).toString("hex")}`);
      // Noted once it is made, before the write, which can fail after.
      const fd = fs.openSync(file, "wx");
      passing.push([file, name]);
      try {
        fs.writeFileSync(fd, text);
      } finally {
        fs.closeSync(fd);
      }
    }
    for (const [file, name] of passing) fs.renameSync(file, at(name));
  } catch (err) {
    for (const [file] of passing) fs.rmSync(file, { force: true });
    removeCreated(dir, created);
    throw err;
  }
  return json;
}

// The files a formats.json lists, each with the place to check it for
// ([{ file, place }]), only those of `places` when given, or why they
// cannot be read. Reads no video, so the dry run stops where the check
// would.
function listedFiles(formats, places = null) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(formats, "utf8"));
  } catch (err) {
    throw new Error(`${formats} is not reframekit's formats.json: ${err.message}`);
  }
  if (!raw || !Array.isArray(raw.files)) throw new Error(`${formats} is not reframekit's formats.json`);
  const base = path.dirname(formats);
  const files = [];
  for (const [i, f] of raw.files.entries()) {
    // A file's name only, so a formats.json names files in its own folder
    // and no other.
    if (!f || typeof f.file !== "string" || !f.file) throw new Error(`${formats}: file ${i + 1} has no file name`);
    if (places && !places.some((p) => p.name === f.place)) continue;
    const place = places ? places.find((p) => p.name === f.place) : Object.hasOwn(PLACES, f.place) ? placeFor(f.place) : { name: String(f.place), label: String(f.label || f.place), width: f.width, height: f.height, limits: {}, custom: true };
    files.push({ file: path.join(base, path.basename(f.file)), place });
  }
  if (!files.length) throw new Error(`${formats} lists no file for ${places ? places.map((p) => p.name).join(", ") : "any place"}`);
  return files;
}

// The check command: a reframekit folder (or its formats.json), or one
// MP4. Writes CHECK.md and check.json. Returns what check.json holds, with
// the folder (`dir`, and `shown` as it was given). A file that does not
// state its length is measured (measureLength()). ffprobe reads each file
// in a run that spawnSync makes, so a signal that comes meanwhile is
// heard before the next file and before the reports are written (turn()),
// and the check then ends by it, having written nothing. An ffprobe that
// the same signal stopped, as when a whole process group is stopped,
// stops the check too: it says nothing of the file it read. One that
// crashed on a file, or that the system killed as it read one, as when
// memory runs out, fails that file's row (ffmpeg.js probe()).
async function checkFormats(target, { places = null, captions = null, out = null, version = "" } = {}) {
  let files = [];
  let base;
  // Where the reports go, and that they can go there, before anything is
  // measured.
  const { dir, shown, formats, refused } = checkPlan(target, out);
  if (refused) throw new Error(refused);
  const cannot = (why) => new Error(`Cannot write the check to ${shown}: ${why}; give --out a folder that takes files`);
  if (formats) {
    base = path.dirname(formats);
    files = listedFiles(formats, places);
  } else {
    base = path.dirname(target);
    // An absolute path, so ffprobe never reads take:2.mp4 as a protocol.
    const info = await measureLength(probe(path.resolve(target), target), target);
    if (!info.video) throw new Error(`${target} has no video stream`);
    const list = places || placesForShape(info.video.displayWidth, info.video.displayHeight);
    if (!list.length) files.push({ file: target, place: { name: "general", label: "General", width: info.video.displayWidth, height: info.video.displayHeight, limits: {}, custom: true } });
    for (const place of list) files.push({ file: target, place });
  }
  const cap = captions ? readCaptions(captions) : null;
  const results = [];
  const infos = new Map();
  // A file of the folder that is not there, or that ffprobe cannot read
  // (cut short by a copy that stopped, say), fails its row, and the other
  // files are measured all the same.
  const unread = (file, place, found) => results.push({ file: path.relative(base, file) || path.basename(file), place: place.name, label: place.label, pass: false, checks: [{ name: "file", status: "fail", expected: "the file", found, source: null }], outside: [] });
  for (const { file, place } of files) {
    await turn();
    if (!fs.existsSync(file)) {
      unread(file, place, "missing");
      continue;
    }
    if (!infos.has(file)) {
      try {
        infos.set(file, { info: await measureLength(probe(path.resolve(file), file), file), layout: layoutOf(file) });
      } catch (err) {
        if (!err.why) throw err;
        infos.set(file, { why: err.why });
      }
    }
    const { info, layout, why } = infos.get(file);
    if (why) {
      unread(file, place, `cannot be read: ${why}`);
      continue;
    }
    const checks = checkFile(file, place, { info, layout });
    let outside = [];
    if (cap) {
      const c = checkCaptions(cap, place, info.duration, info.video ? { width: info.video.displayWidth, height: info.video.displayHeight } : null);
      checks.push(...c.rows);
      outside = c.outside;
    }
    results.push({ file: path.relative(base, file) || path.basename(file), place: place.name, label: place.label, pass: !checks.some((c) => c.status === "fail"), checks, outside });
  }
  const pass = results.every((r) => r.pass);
  const used = [...new Set(results.flatMap((r) => r.checks.map((c) => c.source)).filter((k) => typeof k === "string" && Object.hasOwn(SOURCES, k)))];
  const report = { reframekit: version, pass, captions: captions ? path.basename(captions) : null, results, sources: Object.fromEntries(used.map((k) => [k, SOURCES[k]])) };
  await turn();
  let written;
  try {
    written = writeReports(dir, report, checkMarkdown(report), formats || target, shown);
  } catch (err) {
    throw Object.hasOwn(WHY, err.code || "") ? cannot(WHY[err.code]) : err;
  }
  return { ...written, dir, shown };
}

function checkMarkdown(r) {
  const lines = [];
  const failed = r.results.filter((x) => !x.pass);
  lines.push(`# ${r.pass ? "PASS" : `FAIL (${failed.map((x) => `${x.file} for ${x.label}`).join(", ")})`}`, "");
  // Captions are measured against a safe area only where the place has
  // one and the file says where its text sits (an ASS file); else only
  // their timing is checked.
  const placed = r.results.some((x) => x.checks.some((c) => c.name === "captions in the safe area" && c.status !== "info"));
  const captions = !r.captions ? "" : placed ? `, and ${r.captions} for its timing and, for each 9:16 place, against its safe area` : `, and the timing of ${r.captions}`;
  lines.push(`Each file was measured against its place's limits, as the place's own pages state them${captions}. Loudness, black, still and silent stretches are not checked here: launch-film's check measures them.`, "");
  for (const x of r.results) {
    const warned = x.checks.filter((c) => c.status === "warn").length;
    lines.push(`## ${x.file} for ${x.label}: ${x.pass ? `pass${warned ? ` with ${warned} warning${warned > 1 ? "s" : ""}` : ""}` : "fail"}`, "");
    lines.push("| Check | Result | Asked for | Found | Source |", "| --- | --- | --- | --- | --- |");
    for (const c of x.checks) lines.push(`| ${c.name} | ${c.status} | ${c.expected || ""} | ${c.found} | ${c.source && Object.hasOwn(SOURCES, c.source) ? `[${SOURCES[c.source].name}](${SOURCES[c.source].url})` : ""} |`);
    if (x.outside.length) {
      lines.push("", "Captions outside the safe area:", "");
      for (const o of x.outside.slice(0, 20)) lines.push(`- ${secs(o.start)} to ${secs(o.end)}, into the ${o.sides.join(" and ")} margin: ${o.text.slice(0, 80)}`);
      if (x.outside.length > 20) lines.push(`- and ${x.outside.length - 20} more`);
    }
    lines.push("");
  }
  const sources = Object.entries(r.sources);
  if (sources.length) {
    lines.push("## Sources", "");
    for (const [key, s] of sources) lines.push(`- ${key}: [${s.title}](${s.url}), read ${s.read}.`);
    lines.push("");
  }
  lines.push("A place can change its limits at any time; the date says when each page was read.");
  return lines.join("\n") + "\n";
}

module.exports = { layoutOf, checkFile, checkCaptions, checkFormats, checkPlan, listedFiles, placesForShape, reportFolder, otherCheck };
