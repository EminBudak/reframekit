#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const version = require("./lib/version");
const { PLACES, NAMES, parsePlaces, shapeOf } = require("./lib/places");
const { SECONDS_LIST, normHex } = require("./lib/hints");

const USAGE = `Usage: reframekit <video> [options]
       reframekit <video> --plan [options]
       reframekit check <folder|formats.json|file.mp4> [options]

Turns one finished video into the version each place takes: 9:16 for
TikTok, Reels and Shorts, 4:5 for the feeds, 1:1, and 16:9 for YouTube, X
and LinkedIn. The crop follows what moves in each shot (not faces), and a
shot whose action is too wide for the crop is padded instead. Each file is
cut at a shot change to the place's length, kept under its file size limit
and set to -14 LUFS. Writes one MP4 and a cover per place, crop.json (a
window per shot and shape, to edit), sheet.png (every window on its
frames), formats.json and FORMATS.md.

Options:
  --for <places>     any of tiktok, reels, shorts, youtube, x, linkedin,
                     feed, square, all, or a size such as 1080x1350, comma
                     separated, 12 at most (default: all)
  --mode <mode>      follow (default), center, pad (the whole picture on a
                     blurred copy or a color) or fit (keep the picture's
                     shape, only fit each place's limits)
  --pad <what>       behind a padded picture: blur (default), black, white,
                     a color like '#0f172a' (quoted, or the shell drops it)
                     or 0f172a, or brand (needs --brand)
  --brand <path>     an easybrandkit folder, its brand.json or _brand.yml:
                     padded pictures sit on the page's background color
  --crop <file>      render the windows of an edited crop.json; those of a
                     shape it has none of are planned for its shots
  --cuts <list|file> the shot changes, as seconds (3.2,7.5) or a JSON file:
                     seconds, { "fps", "cuts" }, a launch-film timeline or
                     easyscreenshotkit's steps.json; they replace the cuts
                     found, so give them all (default: found)
  --steps <file>     easyscreenshotkit's steps.json, for a demo whose
                     steps.json is not next to it
  --seconds <time>   keep at most this long in every file, cut at a shot
                     change, e.g. 30 or 1:30
  --no-trim          never cut a file to a place's length; say it is over
  --lufs <n>         loudness target, -40 to -5 (default: -14)
  --fps <n>          frame rate of the files, 10 to 60 (default: the
                     video's, kept between 23 and 60)
  --cover <time>     the moment the covers show (default: picked)
  --out <dir>        where to save (default: ./reframekit-<video name>). A
                     folder of an earlier run of the same video is used
                     again: the files this run makes are replaced, the
                     other places' files kept, and a crop.json edited by
                     hand is only rendered with --crop, never planned over
  --plan             only plan: crop.json, sheet.png and FORMATS.md, no MP4
  --json             print formats.json (or crop.json, or check.json)
  --dry-run          check the arguments and the folder, and say what would
                     be made or why the run would stop, without reading
                     the video or starting ffmpeg
  -h, --help         show this help
  -v, --version      show the version

Check options:
  --for <places>     the places to check a lone MP4 against (default: the
                     places of its shape); with a folder, only these
  --captions <file>  an ASS, SRT or WebVTT file burned into the video: its
                     timing is checked, and an ASS file's text against
                     each 9:16 place's safe area
  --out <dir>        where CHECK.md and check.json go (default: the folder
                     checked, or reframekit-check-<name> next to an MP4)
  --json, --dry-run  as for a run: print check.json, or say where CHECK.md
                     would go, or why the check would stop, measuring nothing
  It exits with 1 when a file fails a place's limits.

Needs Node 22 or newer and ffmpeg 4.4 or newer; set FFMPEG_PATH and
FFPROBE_PATH to pick them.`;

const VALUED = new Set(["--for", "--mode", "--pad", "--brand", "--crop", "--cuts", "--steps", "--seconds", "--lufs", "--fps", "--cover", "--out", "--captions"]);
const MODES = ["follow", "center", "pad", "fit"];

// Seconds from "32", "32.5s", "1:05.5" or "1:02:03", to the millisecond,
// so 1:59.99 is 119.99 and not the sum's 119.99000000000001. The seconds
// after a colon, and the minutes between two, are under 60: 1:99 is a
// time mistyped, not 2:39.
function parseTime(name, value) {
  const text = String(value).trim();
  let t = NaN;
  let m;
  const under60 = (field) => (Number(field) < 60 ? Number(field) : NaN);
  if ((m = /^(\d+(?:\.\d+)?)s?$/i.exec(text))) t = Number(m[1]);
  else if ((m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(text))) t = Number(m[1]) * 60 + under60(m[2]);
  else if ((m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(text))) t = Number(m[1]) * 3600 + under60(m[2]) * 60 + under60(m[3]);
  if (!Number.isFinite(t)) throw new Error(`${name} takes a time such as 30, 30.5s or 1:05, not ${value}`);
  return Math.round(t * 1000) / 1000;
}

function parse(argv) {
  const raw = {};
  const flags = { help: false, version: false, plan: false, json: false, dryRun: false, trim: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (arg === "-h" || arg === "--help") flags.help = true;
    else if (arg === "-v" || arg === "--version") flags.version = true;
    else if (arg === "--plan") flags.plan = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--no-trim") flags.trim = false;
    else if (VALUED.has(name)) {
      const value = name !== arg ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (name === arg && /^--[a-z]/.test(value))) throw new Error(`${name} needs a value`);
      if (name.slice(2) in raw) throw new Error(`${name} is given twice`);
      raw[name.slice(2)] = value;
    } else if (arg.startsWith("-") && arg.length > 1) throw new Error(`Unknown option: ${arg}`);
    else rest.push(arg);
  }
  if (flags.help || flags.version) return { ...flags };
  const check = rest[0] === "check";
  const positional = check ? rest.slice(1) : rest;
  if (check) {
    if (positional.length !== 1) throw new Error("Give one folder or file to check, for example: reframekit check reframekit-film");
    for (const key of Object.keys(raw)) if (!["for", "captions", "out"].includes(key)) throw new Error(`--${key} is not a check option`);
    if (flags.plan || !flags.trim) throw new Error(`${flags.plan ? "--plan" : "--no-trim"} is not a check option`);
    const options = { ...flags, command: "check", target: positional[0] };
    if (raw.for !== undefined) options.places = parsePlaces(raw.for);
    if (raw.captions !== undefined) options.captions = raw.captions;
    if (raw.out !== undefined) options.out = raw.out;
    return options;
  }
  if (positional.length !== 1) throw new Error("Give one video, for example: reframekit film.mp4 --for tiktok,square");
  if ("captions" in raw) throw new Error("--captions is a check option: reframekit check <folder> --captions captions.ass");
  const options = { ...flags, command: "reframe", video: positional[0], places: parsePlaces(raw.for || "all"), mode: "follow" };
  if (raw.mode !== undefined) {
    options.mode = raw.mode.toLowerCase();
    if (!MODES.includes(options.mode)) throw new Error(`--mode takes ${MODES.join(", ")}`);
  }
  if (raw.pad !== undefined) {
    const p = raw.pad.trim().toLowerCase();
    if (["blur", "black", "white", "brand"].includes(p)) options.pad = p;
    else if (normHex(p) && (/^#/.test(p) || /^[0-9a-f]{6}$/.test(p))) options.pad = normHex(p);
    else throw new Error(`--pad takes blur, black, white, brand or a color like '#0f172a' or 0f172a, not ${raw.pad}`);
    if (options.pad === "brand" && raw.brand === undefined) throw new Error("--pad brand needs --brand, an easybrandkit folder");
  }
  for (const key of ["brand", "crop", "steps", "out"]) if (raw[key] !== undefined) options[key] = raw[key];
  if (raw.cuts !== undefined) {
    if (!SECONDS_LIST.test(raw.cuts) && !/\.json$/i.test(raw.cuts)) throw new Error(`--cuts takes seconds such as 3.2,7.5 or a JSON file, not ${raw.cuts}`);
    options.cuts = raw.cuts;
  }
  if (options.crop && raw.mode !== undefined && options.mode !== "fit") throw new Error("--crop already says each window's mode; leave out --mode, or give --mode fit to keep the picture's shape");
  if (options.crop && (options.cuts || options.steps)) throw new Error("--crop already holds the shots; leave out --cuts and --steps");
  if (raw.seconds !== undefined) {
    options.seconds = parseTime("--seconds", raw.seconds);
    if (!(options.seconds >= 1 && options.seconds <= 43200)) throw new Error("--seconds takes 1 second to 12 hours");
  }
  if (raw.lufs !== undefined) {
    options.lufs = Number(raw.lufs);
    if (!(options.lufs >= -40 && options.lufs <= -5)) throw new Error("--lufs takes -40 to -5, for example -14 or -16");
  }
  if (raw.fps !== undefined) {
    const m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(raw.fps.trim());
    options.fps = m ? Number(m[1]) / (m[2] ? Number(m[2]) : 1) : NaN;
    if (!(options.fps >= 10 && options.fps <= 60)) throw new Error("--fps takes 10 to 60, such as 30, 29.97 or 30000/1001");
  }
  if (raw.cover !== undefined) {
    options.cover = parseTime("--cover", raw.cover);
    if (options.cover > 43200) throw new Error("--cover takes a moment of the video, in seconds");
  }
  return options;
}

const { size: bytes, limitSize, madeBefore, quote } = require("./lib/report");
const sec = (t) => `${Number(t).toFixed(2)} s`;

// What a run would make and where, from the arguments and the output
// folder, reading no video and starting no ffmpeg. The files the
// arguments name are read as the run reads them first (the video there,
// crop.json, steps.json, the brand kit, the cuts; for a check its
// formats.json and the captions), and the folder is picked as the run
// picks it and looked at as the run looks at it before any work, writing
// nothing: past one that holds another video's run or another file's
// check. `refused` is the first reason the run would stop for: a file
// given that is not there or not what it should be, someone's files in
// the folder, a crop.json edited by hand, a file named like one it
// writes, a folder that takes no files, a run going on there.
function dryRunPlan(options) {
  const { slug, wouldClaim } = require("./lib/folder");
  if (options.command === "check") {
    const t = options.target;
    let out = options.out || (fs.existsSync(t) && fs.statSync(t).isDirectory() ? t : /formats\.json$/i.test(t) ? path.dirname(t) : path.join(path.dirname(t), `reframekit-check-${slug(t)}`));
    const { checkPlan, listedFiles } = require("./lib/check");
    const plan = checkPlan(t, options.out || null);
    let refused = plan.refused;
    if (!options.out && plan.shown) out = plan.shown;
    try {
      if (!refused && plan.formats) listedFiles(plan.formats, options.places || null);
      if (!refused && options.captions) require("./lib/captions").readCaptions(options.captions);
    } catch (err) {
      refused = err.message;
    }
    return { ok: !refused, dryRun: true, command: "check", target: options.target, exists: fs.existsSync(options.target), places: options.places ? options.places.map((p) => p.name) : null, captions: options.captions || null, out, refused };
  }
  const { pickFolder, readArguments } = require("./lib/reframe");
  let out;
  let refused = null;
  let args = null;
  try {
    args = readArguments(options.video, options);
  } catch (err) {
    refused = err.message;
  }
  try {
    out = pickFolder(options.video, options, options.places, wouldClaim, args).dir;
  } catch (err) {
    out = err.dir || options.out;
    refused = refused || err.message;
  }
  return {
    ok: !refused,
    dryRun: true,
    command: options.plan ? "plan" : "reframe",
    video: options.video,
    exists: fs.existsSync(options.video),
    out,
    refused,
    mode: options.mode,
    pad: options.pad || (options.brand ? "brand" : "blur"),
    places: options.places.map((p) => ({ name: p.name, width: p.width, height: p.height, seconds: p.limits && p.limits.seconds ? p.limits.seconds.max || null : null, bytes: p.limits && p.limits.bytes ? p.limits.bytes.max || null : null })),
    seconds: options.seconds ?? null,
    trim: options.trim,
    lufs: options.lufs ?? -14,
    fps: options.fps ?? null,
    cover: options.cover ?? null,
    crop: options.crop || null,
    cuts: options.cuts || null,
    steps: options.steps || null,
    brand: options.brand || null,
  };
}

function dryRunText(d) {
  const lines = [];
  if (d.command === "check") {
    lines.push(`reframekit would check ${d.target}${d.places ? ` against ${d.places.join(", ")}` : ""}${d.captions ? `, with ${d.captions}` : ""}, and write CHECK.md to ${d.out}.`);
  } else {
    lines.push(`reframekit would ${d.command === "plan" ? "plan" : "reframe"} ${d.video} in ${d.out}${d.command === "plan" ? " (crop.json, sheet.png and FORMATS.md)" : ""}:`);
    for (const p of d.places) {
      const limits = [p.seconds ? `${p.seconds} s` : "", p.bytes ? limitSize(p.bytes) : ""].filter(Boolean).join(" and ");
      lines.push(`  ${p.name.padEnd(10)} ${`${p.width}x${p.height}`}${limits ? `, at most ${limits}` : ""}`);
    }
    const behind = d.pad === "blur" ? "a blurred copy" : d.pad === "brand" ? "the brand's background" : d.pad;
    lines.push(`  mode ${d.mode}, padded shots on ${behind}, loudness ${d.lufs} LUFS${d.seconds ? `, at most ${d.seconds} s` : ""}${d.trim ? "" : ", no cutting to length"}`);
  }
  if (d.refused) lines.push(`  The ${d.command === "check" ? "check" : "run"} would stop: ${d.refused}`);
  lines.push(`${d.command === "check" ? "No file was measured" : "The video was not read"} and nothing was written (--dry-run).`);
  return lines.join("\n");
}

// Shot numbers by what one shape's window does in them, in runs:
// "1 to 3 follow, 4 holds, 5 to 900 pad", at most 24 runs.
// The windows may be a crop.json's own for shapes the run did not render,
// as someone left them: a window without a path holds, as a run that
// renders it takes it.
function shotRuns(shots, key) {
  const word = (s) => {
    const w = s.windows && s.windows[key];
    if (!w || typeof w !== "object") return "";
    const mode = String(w.mode || "follow");
    if (mode !== "follow") return mode;
    const p = Array.isArray(w.path) ? w.path.filter(Array.isArray) : [];
    const moves = p.length > 1 && p.some((k) => k[1] !== p[0][1] || k[2] !== p[0][2]);
    return moves ? "follows" : "holds";
  };
  const runs = [];
  for (const s of shots) {
    const w = word(s);
    const last = runs[runs.length - 1];
    if (last && last.word === w) last.to = s.n;
    else runs.push({ from: s.n, to: s.n, word: w });
  }
  const text = runs.slice(0, 24).map((r) => `${r.from === r.to ? r.from : `${r.from} to ${r.to}`} ${r.word === "follows" && r.from !== r.to ? "follow" : r.word === "holds" && r.from !== r.to ? "hold" : r.word}`);
  if (runs.length > 24) text.push(`and ${shots.length - runs[23].to} more shots (FORMATS.md)`);
  return `${runs[0].from === runs[0].to ? "shot" : "shots"} ${text.join(", ")}`;
}

function summary(result) {
  const lines = [];
  if (result.plan) {
    const c = result.crop;
    lines.push(`Planned ${c.video} (${c.width}x${c.height}, ${sec(c.duration)}, ${c.shots.length} ${c.shots.length === 1 ? "shot" : "shots"}) in ${result.dir}`);
    for (const key of Object.keys(c.shapes)) if (c.shots.every((s) => s.windows[key])) lines.push(`  ${key.padEnd(5)} ${shotRuns(c.shots, key)}`);
    if (c.mode === "fit") lines.push("  With --mode fit the windows are not used: every file keeps the picture's shape.");
    for (const n of c.notes) lines.push(`  Note: ${n}`);
    if (result.sheetNote) lines.push(`  Note: ${result.sheetNote}`);
    if (result.kept.length) lines.push(`  Kept from an earlier render in the folder: ${result.kept.join(", ")}`);
    if (result.keptBefore.length) lines.push(`  Made before ${c.video} changed: ${result.keptBefore.join(", ")}`);
    if (result.removed.length) lines.push(`  Removed from the earlier run: ${result.removed.join(", ")}`);
    lines.push("", `Look at ${result.sheets.map((s) => path.join(result.dir, s)).join(", ")}, then render with:`, `  ${result.next}`);
    return lines.join("\n");
  }
  const f = result.formats;
  const made = f.files.filter((x) => !x.earlier);
  lines.push(`Reframed ${f.video} (${f.source.width}x${f.source.height}, ${sec(f.source.seconds)}, ${f.shots.length} ${f.shots.length === 1 ? "shot" : "shots"}) into ${result.dir}`);
  const width = Math.max(...f.files.map((x) => x.file.length)) + 2;
  for (const x of f.files) {
    const fails = x.pass ? "" : `, fails ${x.checks.filter((c) => c.status === "fail").map((c) => c.name).join(", ")}`;
    if (x.earlier) {
      lines.push(`  ${x.file.padEnd(width)}kept from an earlier run${madeBefore(x, f) ? `, made before ${f.video} changed` : ""}${fails}`);
      continue;
    }
    if (x.sameAs) {
      lines.push(`  ${x.file.padEnd(width)}a copy of ${x.sameAs}${fails}`);
      continue;
    }
    const loud = x.lufs === null ? (f.source.sound ? "silent" : "no sound") : `${x.lufs.toFixed(1)} LUFS`;
    lines.push(`  ${x.file.padEnd(width)}${`${x.width}x${x.height}`.padEnd(11)}${sec(x.seconds).padStart(9)} ${bytes(x.bytes).padStart(9)}  ${loud}${x.trimmed ? `, cut at ${sec(x.trimmed.end)}` : ""}${fails}`);
  }
  // The padded shots of each shape that its files hold: those that start
  // before the end of the longest file of that shape.
  const ends = {};
  for (const x of made) {
    const key = shapeOf(x.width, x.height);
    ends[key] = Math.max(ends[key] ?? -Infinity, x.trimmed ? x.trimmed.end : Infinity);
  }
  // Those of crop.json's windows padded as it says, the others where a
  // crop would cut what matters.
  const padded = { crop: [], found: [] };
  for (const key of Object.keys(f.shots[0].windows)) {
    const shots = f.shots.filter((s) => s.windows[key].mode === "pad" && s.start < (ends[key] ?? Infinity) - 1e-6).map((s) => s.n);
    if (shots.length && f.mode !== "pad") padded[(result.fromCrop || []).includes(key) ? "crop" : "found"].push(`${key} shot${shots.length > 1 ? "s" : ""} ${shots.length > 12 ? `${shots.slice(0, 12).join(", ")} and ${shots.length - 12} more` : shots.join(", ")}`);
  }
  if (padded.crop.length && f.mode !== "fit") lines.push(`  Padded  ${padded.crop.join("; ")}, as crop.json says`);
  if (padded.found.length && f.mode !== "fit") lines.push(`  Padded  ${padded.found.join("; ")}: a crop would cut off part of what matters there`);
  for (const n of f.notes) lines.push(`  Note: ${n}`);
  if (result.removed.length) lines.push(`  Removed from the earlier run: ${result.removed.join(", ")}`);
  if (!made.length) lines.push("  Nothing was made.");
  lines.push("", `Read ${path.join(result.dir, "FORMATS.md")} and look at ${path.join(result.dir, "sheet.png")}. After editing ${path.join(result.dir, "crop.json")}, render it again with:`, `  ${result.next}`);
  return lines.join("\n");
}

// The program the way this run was started, for the command that renders
// a crop.json again: reframekit for a copy npm installed globally, npx
// with this version for one it put in another node_modules folder (npx's
// own, or a project's), node with this script for a skill folder or a
// checkout. A global copy runs from npm's global node_modules: on Windows,
// through npm's reframekit.cmd, from %APPDATA%\npm or the folder of
// node.exe; elsewhere through a link in PATH, or from lib/node_modules
// under node's prefix.
function program({ script = process.argv[1] || "", platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const globals = platform === "win32" ? [env.APPDATA ? p.join(env.APPDATA, "npm") : "", p.dirname(execPath), env.npm_config_prefix || ""].filter(Boolean).map((prefix) => p.join(prefix, "node_modules")) : [p.dirname(p.dirname(execPath)), env.npm_config_prefix || ""].filter(Boolean).map((prefix) => p.join(prefix, "lib", "node_modules"));
  const same = (a) => (platform === "win32" ? a.toLowerCase() : a);
  if (globals.some((g) => same(script).startsWith(same(p.join(g, "reframekit") + p.sep)))) return "reframekit";
  if (/[\\/]node_modules[\\/]/.test(script)) return `npx reframekit@${version}`;
  if (/\.js$/i.test(script)) return `node ${quote(script, platform)}`;
  return "reframekit";
}

function checkSummary(r) {
  const lines = [];
  const files = new Set(r.results.map((x) => x.file)).size;
  const warns = r.results.reduce((n, x) => n + x.checks.filter((c) => c.status === "warn").length, 0);
  lines.push(`${r.pass ? "PASS" : "FAIL"}: ${files} ${files === 1 ? "file" : "files"} against ${r.results.length} ${r.results.length === 1 ? "place" : "places"}${warns ? `, ${warns} ${warns === 1 ? "warning" : "warnings"}` : ""}`);
  for (const x of r.results) {
    for (const c of x.checks.filter((c) => c.status === "fail" || c.status === "warn")) lines.push(`  ${c.status.padEnd(5)} ${x.file} for ${x.label}: ${c.name} ${c.found}${c.expected ? ` (asked for ${c.expected})` : ""}`);
  }
  lines.push("", `Read ${path.join(r.shown || r.dir, "CHECK.md")}.`);
  return lines.join("\n");
}

// What a run or a check stopped by a signal says, a line for each run it
// stopped (folder.js drop()), or that nothing was written when none had
// begun writing, as a check, which writes only once it has measured.
function stoppedText(signal, stopped) {
  if (!stopped.length) return [`stopped by ${signal}, so nothing was written`];
  return stopped.map(({ shown, stage, gone }) => (gone ? `stopped by ${signal}, so ${shown} is as it was` : `stopped by ${signal}, so ${shown} is as it was but for ${path.join(shown, path.basename(stage))}, which could not be removed and which the next run there removes`));
}

// Written at once: a pipe can be asynchronous, and the process ends next.
function say(fd, text) {
  try {
    fs.writeSync(fd, text);
  } catch {
    // Nobody is reading.
  }
}

async function main() {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`reframekit: ${err.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (options.help) return void process.stdout.write(`${USAGE}\n`);
  if (options.version) return void process.stdout.write(`${version}\n`);
  if (options.dryRun) {
    const d = dryRunPlan(options);
    process.stdout.write(options.json ? JSON.stringify(d, null, 2) + "\n" : dryRunText(d) + "\n");
    return;
  }
  // A signal stops the run or the check, with its ffmpeg and ffprobe, and
  // takes away what the run was putting together (folder.js guard()); it
  // says so, on stdout too with --json, and ends by that signal. Once the
  // work is done and said, it ends by the signal without a word.
  let done = false;
  const { guard, turn } = require("./lib/folder");
  const { stopAll, stoppedLately } = require("./lib/ffmpeg");
  guard(stopAll, (signal, stopped) => {
    if (done) return;
    for (const message of stoppedText(signal, stopped)) {
      if (options.json) say(1, JSON.stringify({ ok: false, error: message }) + "\n");
      say(2, `reframekit: ${message}\n`);
    }
  });
  // When whatever reads stdout or stderr goes away (a pipe into head, a
  // closed terminal), the run goes on quietly to its end instead of
  // failing half way.
  let quiet = Boolean(options.json);
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (err) => {
      if (err.code !== "EPIPE") throw err;
      quiet = true;
    });
  }
  const log = (line) => {
    if (!quiet) process.stderr.write(`${line}\n`);
  };
  try {
    if (options.command === "check") {
      const { checkFormats } = require("./lib/check");
      const { checkTools } = require("./lib/ffmpeg");
      checkTools();
      const r = await checkFormats(options.target, { places: options.places || null, captions: options.captions || null, out: options.out || null, version });
      done = true;
      process.stdout.write(options.json ? JSON.stringify({ ...r, dir: undefined, shown: undefined }, null, 2) + "\n" : checkSummary(r) + "\n");
      if (!r.pass) process.exitCode = 1;
      return;
    }
    const { reframe } = require("./lib/reframe");
    const result = await reframe(options.video, { ...options, log, program: program(), mode: options.crop && options.mode !== "fit" ? undefined : options.mode });
    done = true;
    process.stdout.write(options.json ? JSON.stringify(result.plan ? result.crop : result.formats, null, 2) + "\n" : summary(result) + "\n");
  } catch (err) {
    // A signal that came while ffmpeg or ffprobe ran, a run spawnSync
    // made too, is heard first (turn()), and one that stopped ffmpeg or
    // ffprobe a moment before this process heard its own, as when the
    // whole process group is stopped, gets a second to come: the run then
    // says it was stopped and ends by that signal.
    await turn();
    if (stoppedLately()) await new Promise((resolve) => setTimeout(resolve, 1000));
    if (options.json) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
    process.stderr.write(`reframekit: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parse, parseTime, summary, dryRunPlan, program, stoppedText, USAGE, PLACES };
