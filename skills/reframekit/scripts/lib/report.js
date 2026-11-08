"use strict";

// formats.json for tools and FORMATS.md for people and coding agents:
// every file with its size, length and loudness, what was cut and why,
// the limits each file was checked against with the page and the day
// they were read, the command to render again, and last the shots and
// what each window does.

const { SOURCES } = require("./places");
const { windowLabel } = require("./sheet");

const r2 = (x) => Math.round(x * 100) / 100;
const secs = (t) => `${Number(t).toFixed(2)} s`;
// Sizes as the places' limits are read: a thousand bytes to a KB, a
// million to a MB.
const size = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
// A limit as its page gives it: 300 MB, 4 GB, 75 KB.
const limitSize = (bytes) => {
  const [unit, n] = bytes >= 1e9 ? ["GB", bytes / 1e9] : bytes >= 1e6 ? ["MB", bytes / 1e6] : ["KB", bytes / 1e3];
  return `${Math.round(n * 100) / 100} ${unit}`;
};
// At most this many shots in the table at the end of FORMATS.md.
const TABLE_ROWS = 200;

function shotsSummary(shots) {
  return shots.map((s) => ({
    n: s.n,
    start: s.start,
    end: s.end,
    cut: s.cut,
    windows: Object.fromEntries(Object.entries(s.windows).map(([key, w]) => [key, { mode: w.mode, keeps: w.keeps ?? null, moves: w.path ? w.path.length > 1 && w.path.some((k) => k[1] !== w.path[0][1] || k[2] !== w.path[0][2]) : false }])),
  }));
}

function limitsOf(places) {
  return Object.fromEntries(places.map((p) => [p.name, p.limits || {}]));
}

function sourcesOf(places, extra = []) {
  const keys = new Set(extra);
  for (const p of places) for (const rule of Object.values(p.limits || {})) if (rule && rule.source) keys.add(rule.source);
  return Object.fromEntries([...keys].filter((k) => Object.hasOwn(SOURCES, k)).map((k) => [k, SOURCES[k]]));
}

function formatsJson({ version, video, sourceFile = null, sourceBytes = null, info, picture, mode, pad, files, shots, cover, places, notes, fps, trim = true, seconds = null, lufs = -14, written = {}, hashes = {} }) {
  return {
    reframekit: version,
    video,
    source: {
      // Where the video is from this folder, and its size.
      file: sourceFile,
      bytes: sourceBytes,
      width: info.video.displayWidth,
      height: info.video.displayHeight,
      fps: r2(info.video.fps),
      seconds: r2(info.duration),
      rotation: info.video.rotation,
      sound: info.audio ? { codec: info.audio.codec, sampleRate: info.audio.sampleRate, channels: info.audio.channels } : null,
      picture: [picture.x, picture.y, picture.w, picture.h],
    },
    mode,
    pad: pad.kind === "color" ? pad.hex : "blur",
    fps,
    lufs,
    trim,
    seconds,
    cover,
    files,
    shots: shotsSummary(shots),
    limits: limitsOf(places),
    sources: sourcesOf(places),
    notes,
    written,
    hashes,
  };
}

// Whether a file of the folder was made from the video before it changed:
// the size it was made from is not the size the video has now.
const madeBefore = (f, r) => typeof f.videoBytes === "number" && typeof r.source.bytes === "number" && f.videoBytes !== r.source.bytes;

// A word for the shell the command is run in: as it is, or quoted. A
// POSIX shell takes single quotes. On Windows the command is run by cmd,
// by PowerShell (Codex and Cursor), or by Git Bash (Claude Code), and a
// word goes as it is only when it holds none of the signs any of them
// reads: a # starts a comment in PowerShell, a comma splits a word in cmd,
// a backslash escapes the next letter in Git Bash. Otherwise it goes in
// double quotes, which all three take, unless one of them would still
// read something inside them: a $ or a backtick, which PowerShell and Git
// Bash expand there, a double quote, straight or curly, which ends such a
// string, and a double or a last backslash, which Git Bash takes for an
// escape. Such a word goes in single quotes, which PowerShell and Git
// Bash take as they are, each single quote in it doubled as PowerShell
// reads it. Git Bash reads a doubled quote otherwise, so a name that also
// holds one does not reach it whole, but nothing in it runs. cmd takes no
// single quotes: there such a name is typed in double quotes, as README
// says.
const quote = (word, platform = process.platform) => {
  const text = String(word);
  if (platform === "win32") {
    if (/^[\w.:/-]+$/.test(text)) return text;
    if (/[$`"\u201c\u201d\u201e]|\\\\|\\$/.test(text)) return `'${text.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
    return `"${text}"`;
  }
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
};

// Text as Markdown code: in a run of backticks one longer than the longest
// run in it, as CommonMark reads a code span, with a space inside when it
// starts or ends with a backtick, so a command whose names hold backticks
// shows whole and copies as it is.
const codeSpan = (text) => {
  const value = String(text);
  const fence = "`".repeat(Math.max(0, ...(value.match(/`+/g) || []).map((run) => run.length)) + 1);
  const pad = /^`|`$/.test(value) ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
};

// The command that renders the folder's crop.json again: the program the
// way this run was started, the video and the folder as they were given,
// the places, and the options of this run that crop.json does not hold,
// so the files come out as this run made them: what goes behind a padded
// picture, the length, the loudness and the frame rate. A plan made with
// --mode fit needs no --mode, since its crop.json says fit.
function nextCommand({ program = "reframekit", video, dir, places, pad = null, brand = null, seconds = null, trim = true, lufs = null, fps = null, platform = process.platform }) {
  const crop = dir.includes("/") || dir.includes("\\") ? `${dir.replace(/[\\/]+$/, "")}/crop.json` : `${dir}/crop.json`;
  const q = (word) => quote(word, platform);
  const words = [program, q(video), "--crop", q(crop), "--for", q(places.join(",")), "--out", q(dir)];
  if (brand) words.push("--brand", q(brand));
  if (pad) words.push("--pad", q(pad));
  if (seconds !== null && seconds !== undefined) words.push("--seconds", String(seconds));
  if (trim === false) words.push("--no-trim");
  if (lufs !== null && lufs !== undefined) words.push("--lufs", String(lufs));
  if (fps) words.push("--fps", String(fps));
  return words.join(" ");
}

// Why loudnorm worked dynamically on a sound, as the run found it
// (render.js dynamicWhy()), in the words that follow "as it does on".
const DYNAMIC = {
  peaks: "sound whose sharp peaks stand far over its loudness",
  steady: "a sound whose loudness range measures 0 LU, as a steady tone's or a hum's does",
  wide: "a sound whose loudness range measures more than 20 LU",
};

// The words for a file whose sound was set again asking for another
// loudness: what the first try measured, and so which way it was moved.
// Where loudnorm worked dynamically on a try that came out short, why, as
// the run found it (`why`), when it found one.
function setAgain(f, target, why = null) {
  const first = f.firstTry;
  if (!first || typeof first.lufs !== "number") return `${f.file}'s sound was set again asking for ${f.aimed.toFixed(1)} LUFS, to measure nearer ${target} LUFS.`;
  if (first.lufs < target && first.normalization === "dynamic") return `${f.file} came out at ${first.lufs.toFixed(1)} LUFS, short of ${target} LUFS: loudnorm worked dynamically on it${Object.hasOwn(DYNAMIC, why || "") ? `, as it does on ${DYNAMIC[why]}` : ""}. So its sound was set again asking for ${f.aimed.toFixed(1)} LUFS.`;
  return `${f.file} came out at ${first.lufs.toFixed(1)} LUFS, ${first.lufs > target ? "louder" : "quieter"} than ${target} LUFS, so its sound was set again asking for ${f.aimed.toFixed(1)} LUFS.`;
}

// The words for the files whose sound loudnorm set dynamically, each by
// why, as the run found it (`loudnorm`, from reframe.js, by file): one gain
// would have put the peaks over the ceiling, the loudness range measured
// 0 LU or wider than 20 LU, or no reason found.
function dynamicText(dyn, loudnorm = {}) {
  const of = (f) => (loudnorm && Object.hasOwn(loudnorm, f.file) ? loudnorm[f.file] : {});
  const by = (why) => dyn.filter((f) => (Object.hasOwn(DYNAMIC, of(f).why || "") ? of(f).why : null) === why);
  const said = [];
  const peaks = by("peaks");
  if (peaks.length) said.push(`For ${names(peaks.map((f) => f.file))} one gain change would have pushed the peaks over the ceiling, so loudnorm worked dynamically there, which narrows the range between quiet and loud a little.`);
  const steady = by("steady");
  if (steady.length) said.push(`For ${names(steady.map((f) => f.file))} loudnorm worked dynamically, as it does on ${DYNAMIC.steady}.`);
  const wide = by("wide");
  if (wide.length) {
    const ranges = wide.map((f) => of(f).lra).filter((x) => typeof x === "number");
    const range = !ranges.length ? null : Math.min(...ranges) === Math.max(...ranges) ? `${Math.min(...ranges).toFixed(1)} LU` : `${Math.min(...ranges).toFixed(1)} to ${Math.max(...ranges).toFixed(1)} LU`;
    said.push(`For ${names(wide.map((f) => f.file))} the sound's loudness range ${range ? `measured ${range}, more than` : "is more than"} the 20 LU reframekit lets loudnorm keep, so loudnorm worked dynamically there, which narrows the range between quiet and loud.`);
  }
  const other = by(null);
  if (other.length) said.push(`For ${names(other.map((f) => f.file))} loudnorm worked dynamically, which narrows the range between quiet and loud a little.`);
  return said.join(" ");
}

// The words for a file encoded again to meet its place's file size limit:
// at a lower bit rate for one that came out over the most it takes, in
// two passes with x264, and at a steady bit rate for one under the least,
// as LinkedIn takes 75 KB at least; up to three times either way, and
// what it came to when the last time still missed.
function resizedText(f) {
  const rate = (x) => `${(x.bitrate / 1e6).toFixed(2)} Mb/s`;
  const known = (x) => typeof x.firstBytes === "number" && typeof x.limit === "number";
  // Whose limit: the place's owner, as "the 300 MB Instagram takes".
  const whose = (x) => (typeof x.by === "string" && x.by) || (typeof x.place === "string" && x.place) || "its place";
  const times = (x) => (x.rounds === 2 ? "twice" : x.rounds === 3 ? "three times" : `${x.rounds} times`);
  const missed = (x, over) => (typeof f.bytes === "number" && typeof x.limit === "number" && (over ? f.bytes > x.limit : f.bytes < x.limit) ? ` It still came out at ${size(f.bytes)}.` : "");
  const t = f.twoPass;
  if (t && typeof t.bitrate === "number") {
    // A file within 2% of the limit is encoded again too, for room.
    const over = known(t) && t.firstBytes > t.limit;
    const came = known(t) ? `came out at ${size(t.firstBytes)}, ${over ? "over" : "within 2% of"} the ${limitSize(t.limit)} ${whose(t)} takes` : "came out over its place's file size limit, or near it";
    const how = `encoded again${t.passes === 1 ? "" : " in two passes"} at a lower bit rate`;
    return `${f.file} ${came}, so it was ${t.rounds > 1 ? `${how}, ${times(t)} in all as it ${over ? "still" : "then"} came out over, the last at ${rate(t)}` : `${how}, ${rate(t)}`}.${missed(t, true)}`;
  }
  const r = f.raised;
  const came = known(r) ? `came out at ${size(r.firstBytes)}, under the ${limitSize(r.limit)} ${whose(r)} takes at least` : "came out under the least file size its place takes";
  const how = r.rounds > 1 ? `encoded again at a steady bit rate, padded where the picture needs less, ${times(r)} in all as it still came out under, the last at ${rate(r)}` : `encoded again at a steady ${rate(r)}, padded where the picture needs less`;
  return `${f.file} ${came}, so it was ${how}.${missed(r, false)}`;
}

// The words for how a file was cut to length: at a shot change, just
// before one that falls on its place's limit, on the frame of the video
// after it or in its last tenth of a second (render.js trimFor()), or at
// the limit with a fade.
function trimText(f) {
  const t = f.trimmed;
  const where = t.atCut ? (typeof t.before === "number" ? `at ${secs(t.end)}, just before the shot change at ${secs(t.before)}` : `at the shot change at ${secs(t.end)}`) : `at ${secs(t.end)}, with a half second fade, since no shot change fell in the last 30% of the time allowed`;
  const why = t.why === "asked" ? `--seconds asked for ${t.limit} s at most` : `${f.label} takes ${t.limit} s at most`;
  return `${f.file} ends ${where}: ${why}.`;
}

const names = (list) => (list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0] || "");

// The shots, a row each, at most 200 rows.
function shotTable(shots, keys) {
  const lines = [`| Shot | From | To | ${keys.join(" | ")} |`, `| --- | --- | --- | ${keys.map(() => "---").join(" | ")} |`];
  for (const s of shots.slice(0, TABLE_ROWS)) lines.push(`| ${s.n} | ${secs(s.start)} | ${secs(s.end)} | ${keys.map((k) => windowLabel(s.windows[k]).toLowerCase() || "").join(" | ")} |`);
  if (shots.length > TABLE_ROWS) lines.push("", `And ${shots.length - TABLE_ROWS} more shots, which crop.json holds.`);
  return [...lines, ""];
}

// Why each window does what it does (only the padded ones with
// `padsOnly`), at most 200 lines. `given` lists the shapes whose windows
// come from a crop.json given, whose modes may have been set by hand, so
// their pads are given as crop.json's.
function reasons(shots, keys, { given = [], padsOnly = false } = {}) {
  const why = [];
  for (const s of shots) {
    for (const k of keys) {
      const w = s.windows[k];
      if (given.includes(k)) {
        if (w.mode === "pad") why.push(`- Shot ${s.n}, ${k}: padded, as crop.json says.`);
      } else if (w.why && (!padsOnly || w.mode === "pad")) why.push(`- Shot ${s.n}, ${k}: ${w.mode === "pad" && padsOnly ? "padded, " : ""}${w.why}.`);
    }
  }
  if (why.length > TABLE_ROWS) why.splice(TABLE_ROWS, why.length - TABLE_ROWS, `- And ${why.length - TABLE_ROWS} more.`);
  return why.length ? [...why, ""] : [];
}

const LEGEND = "follows: the window moves with what moves. holds: it stays put for the shot. A share is how much of what moves stays inside the window. pad: the whole picture, smaller, on a blurred copy of itself or a color. full: the picture already has that shape.";

// options: { modeNotes, next, removed, given, sheets }
function formatsMarkdown(r, { modeNotes = [], next = "", removed = [], given = [], sheets = ["sheet.png"] } = {}) {
  const lines = [];
  const made = r.files.filter((f) => !f.earlier);
  const kept = r.files.filter((f) => f.earlier);
  lines.push(`# ${r.video} for ${made.length} ${made.length === 1 ? "place" : "places"}`, "");
  const s = r.source;
  lines.push(`From ${r.video}: ${s.width}x${s.height} at ${s.fps} fps, ${secs(s.seconds)}, ${r.shots.length} ${r.shots.length === 1 ? "shot" : "shots"}${s.sound ? "" : ", no sound"}. ${r.mode === "fit" ? "Each file keeps the picture's own shape (--mode fit), as large as the place's frame allows." : `The windows follow what moves in each shot, not faces or objects, so look at ${names(sheets)} before the files go out.`}`, "");
  lines.push("| File | For | Size | Length | File size | Loudness | Limits |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const f of r.files) {
    const loud = f.lufs === null || f.lufs === undefined ? (s.sound ? "silent" : "no sound") : `${f.lufs.toFixed(1)} LUFS, ${f.truePeak.toFixed(1)} dBTP`;
    const fits = f.pass ? (f.checks.some((c) => c.status === "warn") ? "pass, with warnings" : "pass") : `fail: ${f.checks.filter((c) => c.status === "fail").map((c) => c.name).join(", ")}`;
    const also = [f.sameAs ? `a copy of ${f.sameAs}` : "", f.earlier ? "from an earlier run" : ""].filter(Boolean).join(", ");
    // A kept file that could not be measured has what formats.json gave of
    // it, which can lack its size or length.
    const known = (x) => typeof x === "number" && Number.isFinite(x);
    lines.push(`| ${f.file} | ${f.label} | ${known(f.width) && known(f.height) ? `${f.width}x${f.height}` : "unknown"} | ${known(f.seconds) ? secs(f.seconds) : "unknown"} | ${size(f.bytes)} | ${loud} | ${fits}${also ? ` (${also})` : ""} |`);
  }
  // A file whose cover is from another moment than the cover time is named
  // with that moment and why: from before the half second fade a file cut
  // where no shot changes ends with, from just before the shot change one
  // is cut at or just before, else from near the end of its picture, for
  // one that is not cut and ends before or at the cover time, or whose
  // picture ends before its sound (render.js).
  const early = made.filter((f) => typeof f.coverAt === "number" && Math.abs(f.coverAt - r.cover) > 0.0005);
  const coverWhy = (f) => {
    const t = f.trimmed;
    if (t && typeof t.end === "number" && Math.abs(f.coverAt - Math.max(0, t.end - (t.atCut ? 0.1 : 0.6))) < 0.0015) return !t.atCut ? "before its half second fade" : typeof t.before === "number" ? `just before it ends, ahead of the shot change at ${secs(t.before)}` : "just before the shot change it ends at";
    return "near the end of its picture";
  };
  if (made.length) lines.push("", [`Each file has a cover next to it, like ${made[0].cover}: the frame at ${secs(r.cover)} of that file.`, ...early.map((f) => `${f.file}'s cover is from ${secs(f.coverAt)}, ${coverWhy(f)}.`)].join(" "));
  if (kept.length) lines.push("", `${names(kept.map((f) => f.file))} ${kept.length === 1 ? "was" : "were"} not made again: ${kept.length === 1 ? "it is" : "they are"} from an earlier run in this folder, for ${kept.length === 1 ? "a place" : "places"} this run was not asked for, and may come from other windows than these. Give ${kept.length === 1 ? "its place" : "their places"} in --for to make ${kept.length === 1 ? "it" : "them"} again.`);
  const before = kept.filter((f) => madeBefore(f, r));
  if (before.length) lines.push("", `${names(before.map((f) => f.file))} ${before.length === 1 ? "was" : "were"} made before ${r.video} changed, so ${before.length === 1 ? "it shows" : "they show"} the video as it was then.`);
  if (removed.length) lines.push("", `Removed from the earlier run in this folder: ${names(removed)}${removed.some((n) => /^check\.json$|^CHECK\.md$|^reframekit-check-/.test(n)) ? " (its check was of the files made before this run; run reframekit check again)" : ""}.`);
  lines.push("");

  lines.push("## Length", "");
  const cut = made.filter((f) => f.trimmed && !f.sameAs);
  const outside = made.filter((f) => f.checks.some((c) => c.name === "length" && c.status === "fail"));
  for (const f of cut) lines.push(`- ${trimText(f)}`);
  for (const f of outside) {
    const c = f.checks.find((x) => x.name === "length");
    const max = ((r.limits[f.place] || {}).seconds || {}).max;
    lines.push(`- ${f.file} is ${secs(f.seconds)}, outside what ${f.label} takes (${c.expected})${r.trim === false && max !== undefined && f.seconds > max ? ", and --no-trim kept it whole" : ""}.`);
  }
  for (const f of made.filter((x) => x.short && !x.sameAs)) lines.push(`- ${f.file} is ${secs(f.seconds)}, shorter than the ${secs(f.short)} planned: the video's picture or sound ends before its stated length.`);
  if (!cut.length && !outside.length) lines.push(r.trim === false ? "- No file was cut to its place's length (--no-trim), and every file is within it." : "- No file was cut: the video fits every place's length.");
  else if (!cut.length && r.trim === false) lines.push("- No file was cut to its place's length (--no-trim).");
  lines.push("");

  lines.push("## Sound", "");
  if (!s.sound) lines.push("The video has no sound, so neither have the files.");
  else {
    const own = made.filter((f) => !f.sameAs && f.lufs !== null);
    if (!own.length) lines.push("The sound is silent, so its level was left as it is. The files carry it as AAC at 48 kHz.");
    else {
      const dyn = own.filter((f) => f.normalization === "dynamic");
      const over = own.filter((f) => f.truePeak !== null && f.truePeak > -1);
      const lowered = own.filter((f) => f.ceiling !== null && f.ceiling < -2);
      const missed = own.filter((f) => Math.abs(f.lufs - r.lufs) > 0.5);
      const low = Math.min(...own.map((f) => f.lufs));
      const high = Math.max(...own.map((f) => f.lufs));
      const range = low === high ? `${low.toFixed(1)} LUFS` : `${low.toFixed(1)} to ${high.toFixed(1)} LUFS`;
      lines.push(`Each file's sound was set to ${r.lufs} LUFS with ffmpeg's loudnorm and encoded as stereo AAC at 48 kHz, then measured again: ${range}, ${over.length ? `with true peaks under -1 dBTP except in ${over.map((f) => `${f.file} (${f.truePeak.toFixed(1)} dBTP)`).join(", ")}` : "every true peak under -1 dBTP"}.`);
      const aimed = own.filter((f) => f.aimed !== null && f.aimed !== undefined);
      if (aimed.length) lines.push("", aimed.map((f) => setAgain(f, r.lufs, r.loudnorm && Object.hasOwn(r.loudnorm, f.file) ? r.loudnorm[f.file].first : null)).join(" "));
      if (missed.length) lines.push("", missed.map((f) => `${f.file} still measures ${f.lufs.toFixed(1)} LUFS after the last try, more than half a unit from ${r.lufs} LUFS${f.heldByPeak ? ": a try nearer it put the true peak over -1 dBTP and was set aside" : ""}.`).join(" "));
      if (lowered.length) lines.push("", `The AAC encoder rounds the waveform and lifts its peaks, so for ${names(lowered.map((f) => f.file))} loudnorm held them under a lower ceiling (${lowered.map((f) => `${f.ceiling.toFixed(1)} dBTP`).join(", ")}) until the encoded file stayed under -1 dBTP.`);
      lines.push("", dyn.length ? dynamicText(dyn, r.loudnorm) : "One gain change did it, so the mix is unchanged.");
    }
  }
  lines.push("");

  // Every file of the table, copies and kept files too: a copy is checked
  // against its own place, and can fail where the file it copies passes
  // (Reels takes 3 s at least, TikTok any length). A copy's rows that are
  // those of the file it copies are given once, under that file.
  const odd = (c) => c.status === "warn" || c.status === "fail";
  const same = (c, d) => c.name === d.name && c.status === d.status && c.found === d.found && (c.expected || "") === (d.expected || "");
  const rows = [];
  let shared = false;
  for (const f of r.files) {
    const source = f.sameAs ? r.files.find((g) => g.file === f.sameAs) : null;
    for (const c of f.checks.filter(odd)) {
      if (source && source.checks.some((d) => same(c, d))) shared = true;
      else rows.push(`- ${f.file}, ${c.name}: ${c.status}, ${c.found}${c.expected ? ` (asked for: ${c.expected})` : ""}.`);
    }
  }
  lines.push("## Checks", "");
  lines.push("Every file was measured against its place's limits: shape, size, frame rate, length, file size, codecs and how the MP4 is laid out. Loudness, black, still and silent stretches are launch-film's check's job.", "");
  if (!r.files.some((f) => f.checks.some(odd))) lines.push("Every check passed.");
  lines.push(...rows);
  if (shared) lines.push("", "A copy's warnings and failures that are those of the file it copies are given once, under that file.");
  lines.push("");

  if (r.notes.length || modeNotes.length) {
    lines.push("## Notes", "");
    for (const n of [...modeNotes, ...r.notes]) lines.push(`- ${n}`);
    lines.push("");
  }

  lines.push("## Limits", "");
  lines.push("| Place | Length | File size | Frame rate | Other | Source |", "| --- | --- | --- | --- | --- | --- |");
  for (const f of r.files) {
    const L = r.limits[f.place] || {};
    const len = L.seconds ? [L.seconds.min !== undefined ? `${L.seconds.min} s` : "", L.seconds.max !== undefined ? `${L.seconds.max} s` : ""].filter(Boolean).join(" to ") : "";
    const bytes = L.bytes ? `${L.bytes.min ? `${limitSize(L.bytes.min)} to ` : ""}${limitSize(L.bytes.max)}` : "";
    const fps = L.fps ? `${L.fps.min} to ${L.fps.max}` : "";
    const other = [L.shape ? L.shape.what : "", L.videoBitrate ? `${L.videoBitrate.max / 1e6} Mb/s` : "", L.width ? `${L.width.max} px wide` : "", L.side ? `sides ${L.side.min} to ${L.side.max} px` : ""].filter(Boolean).join(", ");
    const sources = [...new Set(Object.values(L).map((x) => x && x.source).filter((k) => typeof k === "string" && Object.hasOwn(SOURCES, k)))];
    lines.push(`| ${f.label} | ${len || "none given"} | ${bytes || "none given"} | ${fps || "none given"} | ${other} | ${sources.map((k) => `[${SOURCES[k].name}](${SOURCES[k].url})`).join(", ") || "general checks only"} |`);
  }
  const read = Object.values(r.sources)[0];
  lines.push("");
  lines.push(`A KB here is a thousand bytes and a MB a million, so a file under "300 MB" is under 300,000,000 bytes, the stricter reading of each place's limit.${read ? ` Each page was read on ${read.read}. A place can change its limits at any time.` : ""}`, "");
  const extra = limitNotes(r);
  if (extra.length) lines.push(...extra.map((n) => `- ${n}`), "");

  lines.push("## Change it", "");
  if (r.mode === "fit") lines.push("- These files keep the picture's shape, as crop.json's top mode, fit, says. To crop or pad each shot to each place's shape instead, set that mode to windows and render again with the command below: crop.json holds the windows planned for each shot.");
  else {
    lines.push("- Move a window: edit its path in crop.json (seconds, then x and y of the window's top left corner in the video's pixels).");
    lines.push("- Show a shot whole: set its window's mode to pad. Crop it instead: set mode to follow.");
    lines.push("- Switch between crop and pad inside a shot: split it in crop.json into two shots, each with its own windows.");
  }
  if (next) lines.push(`- Then render again, from the folder this run was started in: ${codeSpan(next)}. It has the options this run had. Without --crop a run plans afresh, which it does not do over a crop.json edited by hand.`);
  lines.push("- The cover: `--cover <seconds>`.", "");

  lines.push("## Shots", "");
  const keys = Object.keys(r.shots[0].windows);
  if (keys.length && r.mode !== "fit") lines.push(...shotTable(r.shotsFull, keys), LEGEND, "", ...reasons(r.shotsFull, keys, { given, padsOnly: true }));
  else lines.push(`${r.shots.length} ${r.shots.length === 1 ? "shot" : "shots"}, starting at ${r.shots.slice(0, TABLE_ROWS).map((x) => secs(x.start)).join(", ")}${r.shots.length > TABLE_ROWS ? " and more" : ""}.`, "");
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

function limitNotes(r) {
  const seen = new Set();
  const out = [];
  for (const f of r.files) {
    const L = r.limits[f.place] || {};
    for (const rule of Object.values(L)) {
      if (rule && rule.note && !seen.has(rule.note)) {
        seen.add(rule.note);
        out.push(`${f.label}: ${rule.note[0].toLowerCase()}${rule.note.slice(1)}`);
      }
    }
  }
  return out;
}

// options: { video, info, shots, shapes, cover, notes, mode, sheets, next,
// rendered, before (those of them made before the video changed), given }
function planMarkdown({ video, info, shots, shapes, cover, notes, mode, sheets, next, rendered = [], before = [], given = [] }) {
  const lines = [];
  const files = sheets.pages.map((s) => s.file);
  lines.push(`# The plan for ${video}`, "");
  lines.push(`${info.video.displayWidth}x${info.video.displayHeight}, ${secs(info.duration)}, ${shots.length} ${shots.length === 1 ? "shot" : "shots"}. Nothing was rendered for this plan.`, "");
  const frames = sheets.many ? "one of its frames" : shots.some((s) => s.end - s.start < 1.2) ? "one to three of its frames (one for a shot under 1.2 s)" : "three of its frames";
  lines.push(`Look at ${names(files)}: ${sheets.note ? `${sheets.drawn} of the shots` : "every shot"}, with each shape's window drawn on ${frames}. The windows follow what moves in each shot, not faces or objects, so check that each one holds what matters.${sheets.note ? ` ${sheets.note}` : ""}`, "");
  if (mode === "fit") lines.push("With --mode fit the windows are not used: every file keeps the picture's shape, as large as each place's frame allows. crop.json says so with its top mode, and renders that way with --crop; set that mode to windows to render the windows instead.", "");
  lines.push(`The covers will be the frame at ${secs(cover)}.`, "");
  if (rendered.length) lines.push(`The files of an earlier render are still in this folder (${names(rendered)}). They were made before this plan; rendering it replaces those of the places it renders.${before.length ? ` ${names(before)} ${before.length === 1 ? "was" : "were"} made before ${video} changed.` : ""}`, "");
  if (notes.length) {
    lines.push("## Notes", "");
    for (const n of notes) lines.push(`- ${n}`);
    lines.push("");
  }
  lines.push("## Next", "");
  if (mode !== "fit") {
    lines.push("- To move a window, edit its path in crop.json: [seconds, x, y], the window's top left corner in the video's pixels. One point holds it still; more points glide through them.");
    lines.push("- To show a shot whole, set its window's mode to pad; to crop it, set mode to follow. To switch inside a shot, split it into two shots in crop.json.");
  }
  lines.push(`- Then render, from the folder this plan was started in: ${codeSpan(next)}.`, "");
  const keys = Object.keys(shapes);
  lines.push("## Shots", "");
  lines.push(...shotTable(shots, keys), ...reasons(shots, keys, { given }));
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

module.exports = { formatsJson, formatsMarkdown, planMarkdown, sourcesOf, nextCommand, madeBefore, quote, codeSpan, size, limitSize, resizedText };
