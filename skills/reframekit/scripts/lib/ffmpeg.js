"use strict";

// ffmpeg and ffprobe, the ones already on the machine. Arguments always go
// as a list, never through a shell, and the helper files a filter graph
// reads or writes are named relative to a work folder that is the run's
// cwd, so no path ever has to be written inside a filter graph.

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { WHY, SIGNALS } = require("./folder");
const { layoutOf, cutText } = require("./mp4");

const MISSING = "reframekit needs ffmpeg and ffprobe. Install ffmpeg (brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg), or set FFMPEG_PATH and FFPROBE_PATH to them.";

// A tool a variable names: a path, as ../bin/ffmpeg, from the folder the
// run was started in, since most of the kit's ffmpeg runs start in its
// work folder, where a path relative to another folder leads nowhere; a
// bare name, as ffmpeg-8, as it is, for PATH to find. A path is a name
// with a slash in it, or on Windows a backslash too, as the system reads
// it there.
const located = (name) => (name && (process.platform === "win32" ? /[\\/]/ : /\//).test(name) ? path.resolve(name) : name);

// FFMPEG_PATH, else LAUNCH_FILM_FFMPEG (the name launch-film and makersmcp
// pass an ffmpeg by), else the one on PATH.
function ffmpegPath() {
  return located(process.env.FFMPEG_PATH || process.env.LAUNCH_FILM_FFMPEG) || "ffmpeg";
}

// FFPROBE_PATH, else LAUNCH_FILM_FFPROBE, else the ffprobe next to the
// ffmpeg named, else the one on PATH.
function ffprobePath() {
  if (process.env.FFPROBE_PATH) return located(process.env.FFPROBE_PATH);
  if (process.env.LAUNCH_FILM_FFPROBE) return located(process.env.LAUNCH_FILM_FFPROBE);
  const ff = located(process.env.FFMPEG_PATH || process.env.LAUNCH_FILM_FFMPEG);
  if (ff) {
    const next = path.join(path.dirname(ff), path.basename(ff).replace(/ffmpeg/i, "ffprobe"));
    if (next !== ff && fs.existsSync(next)) return next;
  }
  return "ffprobe";
}

// With REFRAMEKIT_DEBUG set, every ffmpeg and ffprobe run is shown on
// stderr as it starts.
function debug(tool, args) {
  if (!process.env.REFRAMEKIT_DEBUG) return;
  const shown = [tool, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`)).join(" ");
  try {
    process.stderr.write(`${shown}\n`);
  } catch {
    // stderr is gone.
  }
}

// The filters a run needs. All are built into ffmpeg (no external
// library), Homebrew's default build included, but cropdetect and eq only
// into a build made with --enable-gpl, as Ubuntu's is: FFmpeg's configure
// gives each of them gpl as what it depends on. scdet came in ffmpeg 4.3,
// so an older ffmpeg stops here; the version itself is not checked. 4.4
// is Ubuntu 22.04's, and the oldest the kit is tested on.
const FILTERS = ["scdet", "cropdetect", "metadata", "sendcmd", "crop", "scale", "color", "overlay", "gblur", "eq", "fps", "tpad", "trim", "split", "setsar", "setparams", "loudnorm", "ebur128", "aresample", "aformat", "afade", "atrim"];
const GPL_ONLY = new Set(["cropdetect", "eq"]);

let checked = null;

const lastLine = (text) => String(text || "").trim().split("\n").filter(Boolean).pop() || "";

// The longest a run of ffmpeg or ffprobe may take that only says what it
// is or what it has (-version, -filters, -encoders).
const ASK = 60_000;

// Whether a signal, by its name or its number, is one that stops a run
// (folder.js SIGNALS), as Ctrl-C and whatever runs the kit send.
const stops = (signal) => (typeof signal === "number" ? Object.values(SIGNALS).includes(signal) : Object.hasOwn(SIGNALS, String(signal || "")));

// When a run of ffmpeg or ffprobe last ended by a signal that stops a run,
// by being stopped or by one it caught and says it received ("Exiting
// normally, received signal 15."). When a whole process group is
// stopped, as makersmcp stops a job and Ctrl-C a terminal's, ffmpeg or
// ffprobe can end before this process hears its own signal, and the run
// fails over it: reframekit.js then gives that signal a moment to come
// (stoppedLately()). A run that spawnSync makes counts as much as one
// run() makes: while it runs, Node hears no signal at all. Any other
// signal, as a crash or the system's kill when memory runs out, stops
// nothing else, and nothing waits for it.
let signaled = 0;
const stoppedLately = () => Date.now() - signaled < 5000;

// The signals a program raises on itself when it fails, as ffprobe can on
// a file it cannot read.
const CRASHES = new Set(["SIGSEGV", "SIGBUS", "SIGABRT", "SIGFPE", "SIGILL", "SIGSYS", "SIGTRAP"]);

// How a run of ffmpeg or ffprobe that `signal` ended ended, as said after
// the tool's name, with `when` after the signal: stopped, by a signal that
// stops a run; crashed; or killed, as the system kills a process when
// memory runs out (SIGKILL) or at a limit it sets.
const endedBy = (signal, when = "") => {
  if (stops(signal)) return `was stopped (${signal})${when}`;
  if (CRASHES.has(signal)) return `crashed (${signal})${when}`;
  return `was killed (${signal})${when}${signal === "SIGKILL" ? ", as when the machine runs out of memory" : ""}`;
};

// Why a run of ffmpeg or ffprobe (`tool`) that spawnSync made (`r`) did
// not answer, as an error: the tool is not there (MISSING), it did not
// answer within `limit` ms, as on a machine too busy, or what else
// stopped it. `doing` says when, as "when asked which version it is" or
// "while it read film.mp4". One that a signal that stops a run ended
// carries it (`stopped`), and is never a reason of the file it read: a
// check stops on it rather than failing that file's row. One that
// crashed, or that the system killed, carries none.
function unanswered(tool, r, limit, doing = "") {
  const code = r.error && r.error.code;
  const when = doing ? ` ${doing}` : "";
  if (code === "ENOENT") return new Error(MISSING);
  if (code === "ETIMEDOUT") return new Error(`${tool} did not answer within ${Math.round(limit / 1000)} s${when}: the machine may be too busy. Run reframekit again when the machine is less busy.`);
  if (r.error) return new Error(`${tool} could not be run: ${WHY[code] || r.error.message}`);
  if (r.signal) {
    const err = new Error(`${tool} ${endedBy(r.signal, when)}`);
    if (!stops(r.signal)) return err;
    signaled = Date.now();
    return Object.assign(err, { stopped: r.signal });
  }
  const said = lastLine(r.stderr);
  return new Error(`${tool} failed${when}${said ? `: ${said}` : `, ending with ${r.status}`}`);
}

// A run of ffmpeg or ffprobe that has to answer before any work: its
// output, or the error unanswered() gives.
function ask(tool, args, doing) {
  debug(tool, args);
  const r = spawnSync(tool, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: ASK, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw unanswered(tool, r, ASK, doing);
  return String(r.stdout || "");
}

// Both tools answer and have the filters, or the run stops before any work
// with what is missing, or with why one did not answer.
function checkTools() {
  if (checked) return checked;
  // What ffmpeg says of its version, "ffmpeg version 8.0.1 ...", as
  // -version says it after -hide_banner too.
  let said = "";
  for (const tool of [ffmpegPath(), ffprobePath()]) {
    debug(tool, ["-hide_banner", "-version"]);
    const r = spawnSync(tool, ["-hide_banner", "-version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: ASK });
    if (r.error || r.signal) throw unanswered(tool, r, ASK, "when asked which version it is");
    // A program that runs but is no ffmpeg, or a broken one.
    if (r.status !== 0) throw new Error(`${unanswered(tool, r, ASK, "when asked which version it is").message}. ${MISSING}`);
    if (!said) said = String(r.stdout || "");
  }
  const listed = new Set(ask(ffmpegPath(), ["-hide_banner", "-filters"], "when asked to list its filters").split("\n").map((line) => (/^\s*[A-Z.|]{2,3}\s+(\S+)\s/.exec(line) || [])[1]).filter(Boolean));
  const absent = FILTERS.filter((name) => !listed.has(name));
  if (absent.length) {
    const lacks = `This ffmpeg lacks the ${absent.join(", ")} filter${absent.length > 1 ? "s" : ""}`;
    // A build made without --enable-gpl, which a newer one of the same
    // kind would not mend.
    if (absent.every((name) => GPL_ONLY.has(name))) throw new Error(`${lacks}, which ${absent.length > 1 ? "come" : "comes"} only in a build made with --enable-gpl, as Ubuntu's is. Install such a build of ffmpeg (4.4 or later) or point FFMPEG_PATH at one.`);
    const gpl = absent.some((name) => GPL_ONLY.has(name));
    throw new Error(`${lacks}. Install a newer build of ffmpeg (4.4 or later)${gpl ? ", made with --enable-gpl," : ""} or point FFMPEG_PATH at one.`);
  }
  const version = /ffmpeg version (\S+)/.exec(said);
  checked = { ffmpeg: ffmpegPath(), ffprobe: ffprobePath(), version: version ? version[1] : "unknown" };
  return checked;
}

// The reasons the system gives for a write or a read it refused, as a
// full disk or a quota, which ffmpeg names before its closing words in
// the system's own words, with the code Node gives each. A Mac words a
// quota used up as "Disc quota exceeded", Linux as "Disk quota exceeded".
const REFUSALS = [
  [/No space left on device/i, "ENOSPC"],
  [/Dis[ck] quota exceeded/i, "EDQUOT"],
  [/Permission denied/i, "EACCES"],
  [/Input\/output error/i, "EIO"],
  [/Read-only file system/i, "EROFS"],
  [/File too large/i, "EFBIG"],
  [/Cannot allocate memory/i, "ENOMEM"],
];
const REASONS = REFUSALS.map(([words]) => words.source).join("|");
// Such a reason where ffmpeg puts one: at the end of its line, after a
// colon ("Error writing trailer of square.mp4: No space left on device")
// or in brackets ("Task finished with error code: -28 (No space left on
// device)"), or as the whole line.
const REFUSED = new RegExp(`(?:^|: )(${REASONS})$|\\((${REASONS})\\)$`, "i");
// ffmpeg's own closing words and its progress lines, which say nothing of
// why it failed.
const CLOSING = /^(Conversion failed!|Exiting normally|(frame|size|video|audio)[=:]|Press \[q\])|Task finished with error code|Terminating thread with return code/;

// The lines of a run's stderr that are ffmpeg's own words, each without
// the [muxer @ 0x...] it can start with. Left out is the description it
// gives of each file it opens: the Input # and Output # lines, which name
// the file, and the lines indented under them, which give its streams and
// its metadata (a title, a line of a title that has several, a comment, a
// chapter's name). So the words of a file's name or of its tags, as a
// video titled "File too large? Here is how to fit any video", are never
// taken for what ffmpeg says.
const ownLines = (stderr) =>
  String(stderr || "")
    .split(/\r?\n|\r/)
    .filter((line) => line.trim() && !/^\s/.test(line) && !/^(Input|Output) #\d+, /.test(line))
    .map((line) => line.trim().replace(/^(\[[^\]]* @ 0x[0-9a-f]+\]\s*)+/i, ""));

// What the system refused, as ffmpeg's line gives it ("No space left on
// device"), and its code (ENOSPC); null when the line gives no such
// reason.
function refusedIn(line) {
  const m = REFUSED.exec(line);
  if (!m) return null;
  const words = m[1] || m[2];
  return { words, code: REFUSALS.find(([w]) => w.test(words))[1] };
}

// The code of what the system refused a failed ffmpeg run, as ENOSPC for a
// full disk, from ffmpeg's own lines on stderr; null when they name none.
function refusal(stderr) {
  const refused = ownLines(stderr).map(refusedIn).find(Boolean);
  return refused ? refused.code : null;
}

// Why a failed ffmpeg run failed, from its own lines on stderr: what the
// system refused, when they name that, in the words the kit gives Node's
// own refusals (folder.js), so a full disk reads the same whichever wrote
// to it; else the last line that says what went wrong (with `telling`),
// or its last line; never its closing words.
function failure(stderr, { telling = false } = {}) {
  const lines = ownLines(stderr);
  const refused = lines.map(refusedIn).find(Boolean);
  if (refused) return WHY[refused.code] || refused.words;
  const said = lines.filter((line) => !CLOSING.test(line));
  return (telling && said.filter((l) => /error|invalid|failed|cannot|no such|not/i.test(l)).pop()) || said.pop() || "";
}

// The ffmpeg runs going on, so a run that is stopped can stop them too.
const running = new Set();

function stopAll() {
  for (const child of running) child.kill("SIGKILL");
  running.clear();
}

// Runs ffmpeg to its end and resolves { code, stdout, stderr }: stdout as
// one Buffer (only when `collect`), stderr's last `keep` characters as
// text. `onLine` gets every stderr line; `onStdout` gets stdout as it
// comes, for a stream of raw frames. A run that is not done after
// `timeout` milliseconds is killed.
function run(args, { cwd, timeout = 0, onLine, onStdout, collect = false, keep = 200_000, tool = ffmpegPath() } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    debug(tool, args);
    try {
      child = spawn(tool, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err.code === "ENOENT" ? new Error(MISSING) : err);
      return;
    }
    running.add(child);
    const out = [];
    let stderr = "";
    let partial = "";
    child.stdout.on("data", (chunk) => {
      if (onStdout) onStdout(chunk);
      if (collect) out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr = (stderr + text).slice(-keep);
      if (!onLine) return;
      const lines = (partial + text).split(/\r?\n|\r/);
      partial = lines.pop();
      for (const line of lines) onLine(line);
    });
    let timer = null;
    if (timeout) {
      timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      timer.unref();
    }
    child.on("error", (err) => {
      running.delete(child);
      if (timer) clearTimeout(timer);
      reject(err.code === "ENOENT" ? new Error(MISSING) : err);
    });
    child.on("close", (code, signal) => {
      running.delete(child);
      if (timer) clearTimeout(timer);
      if (onLine && partial) onLine(partial);
      const caught = /received signal (\d+)/.exec(stderr.slice(-4000));
      if (stops(signal) || (caught && stops(Number(caught[1])))) signaled = Date.now();
      resolve({ code: signal ? -1 : code, signal, stdout: collect ? Buffer.concat(out) : null, stderr });
    });
  });
}

// Whether a run that ended well (0) still failed to write its file whole.
// ffmpeg 4.4 ends well when a write fails as it writes a file's trailer,
// where an MP4 has its index, as a disk or a quota that fills up then
// makes it: it says so in a line of its own, Error writing trailer of
// <file>: <why>, and only -xerror makes that fatal, which would also stop
// it on a frame of the video it cannot decode. ffmpeg 8 ends with an
// error. A line of ffmpeg's own that gives a full disk or quota, or a
// file too large, as why, counts too; a title or a name that holds those
// words does not (ownLines()).
const UNWRITTEN = new Set(["ENOSPC", "EDQUOT", "EFBIG"]);
const unfinished = (r) =>
  r.code === 0 &&
  ownLines(r.stderr).some((line) => {
    const refused = refusedIn(line);
    return /^Error writing trailer\b/.test(line) || Boolean(refused && UNWRITTEN.has(refused.code));
  });

// run(), failing with what ffmpeg said when it does not end well, or ends
// well with a file it did not write whole (unfinished()). The error
// carries the code of what the system refused (`refused`), so the run
// names a full disk with its folder (reframe.js), or the signal that
// ended ffmpeg (`signal`), whose last line is then only a stream it was
// reading (endedBy()).
async function mustRun(args, what, options = {}) {
  const r = await run(["-hide_banner", "-nostdin", ...args], options);
  if (r.code !== 0 || unfinished(r)) {
    const said = failure(r.stderr);
    throw Object.assign(new Error(`${what}: ffmpeg ${r.signal ? endedBy(r.signal) : `failed${said ? `: ${said}` : ""}`}`), { stderr: r.stderr, refused: r.signal ? null : refusal(r.stderr), signal: r.signal || null });
  }
  return r;
}

const rational = (text) => {
  const [a, b] = String(text || "").split("/").map(Number);
  return a > 0 && b > 0 ? a / b : Number(a) > 0 && b === undefined ? Number(a) : 0;
};

// A picture's rates from its average rate and its base rate, ffprobe's
// avg_frame_rate and r_frame_rate: { fps, baseFps, variable }. Its frames
// do not come at one steady rate when the average is more than 1% under
// the base. An average over the base comes of frames that share a time,
// as where ffmpeg's copy of an MPEG-TS joined from two recordings puts
// frames of the second at the times of the first's last ones, not of
// uneven frames: its rate is then the base.
function ratesOf(avg, base) {
  if (avg > 0 && base > 0 && avg > base * 1.01) return { fps: base, baseFps: base, variable: false };
  return { fps: avg || base, baseFps: base || avg, variable: Boolean(avg && base && (base - avg) / base > 0.01) };
}

// A stream's tag, by its name in any letters, or with a language after it
// (DURATION-eng); undefined when it has none.
const tagOf = (stream, key) => {
  const tags = (stream && stream.tags) || {};
  const name = Object.keys(tags).find((n) => n.toUpperCase() === key || n.toUpperCase().startsWith(`${key}-`));
  return name === undefined ? undefined : tags[name];
};

// Seconds from a time such as 00:00:09.000000000, NaN from anything else.
const clock = (text) => {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(text ?? "").trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
};

// What reframekit needs to know about a file, from ffprobe. Sizes are the
// picture as it is shown: square pixels, turned by its rotation. A file
// whose container does not state its length (a WebM a browser recorded,
// anything ffmpeg wrote to a pipe) is `unstated`, its duration 0 until
// measureLength() measures it. `name` is the file as the errors name it,
// as it was given. An error about the file carries why apart (`why`), as
// a check's row gives it, an ffprobe that crashed on it or that the
// system killed as it read it too, and a description of it too long to
// take in; one about ffprobe has none, as an ffprobe stopped by a signal
// that stops a run, which says nothing of the file.
function probe(file, name = file) {
  const args = ["-v", "error", "-show_format", "-show_streams", "-of", "json", file];
  debug(ffprobePath(), args);
  const r = spawnSync(ffprobePath(), args, { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  const cannot = (why) => Object.assign(new Error(`Cannot read ${name}: ${why}`), { why });
  // A description longer than the 64 MB taken in, which Node stops
  // ffprobe at: the file's own reason, as a title or a comment of many MB
  // gives it, not a run of ffprobe that failed.
  if (r.error && r.error.code === "ENOBUFS") throw cannot("ffprobe's description of it runs over 64 MB, as for a file whose tags are that large");
  if (r.error || stops(r.signal)) throw unanswered(ffprobePath(), r, 120_000, `while it read ${name}`);
  if (r.status !== 0) {
    // ffprobe's words, without the path it names the file by, so a name
    // such as "No such file here.mp4" is never read as what it says.
    const told = String(r.stderr || "");
    const said = told.split(file).join("");
    if (/No such file/i.test(said)) throw cannot("no such file");
    // An MP4 a copy or a recording left cut short, which ffprobe calls a
    // file it cannot read in other words wherever the cut falls: the end
    // of the file when cut in its index, data it does not know when cut
    // further in, no index when the index was to come after the media.
    // ffprobe reads any file named .mp4 as an MP4 at last, so its words
    // about the index count only for a file that starts as an MP4 does.
    // One cut inside the header of its index, when the index comes last,
    // is said to have none, which tells more than where the cut is.
    const lay = layoutOf(file);
    if (lay && lay.cut && !lay.cut.header) throw cannot(`it is ${cutText(lay.cut)}`);
    if (lay && lay.mp4 && /moov atom not found/i.test(said)) throw cannot("it has no index (the moov box), as an MP4 whose recording or copy stopped before its end");
    if (lay && lay.mp4 && /\[mov,[^\]]*\] error reading header/i.test(said)) throw cannot("ffmpeg cannot read its index (the moov box)");
    if (lay && lay.cut) throw cannot(`it is ${cutText(lay.cut)}`);
    // An ffprobe that crashed on the file, or that the system killed as it
    // read it, as when memory runs out: said so, not by a line it wrote
    // before.
    if (r.signal) throw cannot(`ffprobe ${endedBy(r.signal)}`);
    if (/Invalid data found|could not find codec|Unknown format/i.test(said)) throw cannot("ffmpeg does not know this format");
    if (/Permission denied/i.test(said)) throw cannot("permission denied");
    // ffprobe's last line names the file before why; the error names it
    // once, as it was given.
    const last = lastLine(told);
    throw cannot((last.startsWith(`${file}: `) ? last.slice(file.length + 2) : last).split(file).join(name) || "ffprobe failed");
  }
  let info;
  try {
    info = JSON.parse(r.stdout);
  } catch {
    throw cannot("ffprobe gave no answer");
  }
  const format = info.format || {};
  const streams = info.streams || [];
  const v = streams.find((s) => s.codec_type === "video" && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === "audio");
  // A stream's own length. A Matroska file or a WebM gives a stream no
  // length, or the whole file's: there it is in the DURATION tag ffmpeg
  // writes on each stream, the moment the stream ends (mkvmerge writes it
  // as DURATION-eng, and the frames as NUMBER_OF_FRAMES-eng). 0 when it
  // is not known.
  const matroska = /matroska|webm/.test(format.format_name || "");
  const ownLength = (s) => {
    const start = Number(s.start_time) || 0;
    if (!matroska) return Number(s.duration) || 0;
    const end = clock(tagOf(s, "DURATION"));
    return end > start ? end - start : end > 0 ? end : 0;
  };
  let video = null;
  if (v) {
    const sideRotation = (v.side_data_list || []).map((d) => Number(d.rotation)).find((n) => Number.isFinite(n));
    const rotation = Number.isFinite(sideRotation) ? sideRotation : Number((v.tags || {}).rotate) || 0;
    const [sn, sd] = String(v.sample_aspect_ratio || "1:1").split(":").map(Number);
    const sar = sn > 0 && sd > 0 ? sn / sd : 1;
    const width = Number(v.width) || 0;
    const height = Number(v.height) || 0;
    // Square pixels first, then the turn.
    let w = Math.round(width * sar);
    let h = height;
    const turned = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    if (turned) [w, h] = [h, w];
    const rates = ratesOf(rational(v.avg_frame_rate), rational(v.r_frame_rate));
    video = {
      index: v.index,
      codec: v.codec_name || "",
      profile: v.profile || "",
      width,
      height,
      displayWidth: w,
      displayHeight: h,
      rotation: ((Math.round(rotation) % 360) + 360) % 360,
      sar: Math.abs(sar - 1) < 0.001 ? "1:1" : `${sn}:${sd}`,
      sarValue: sar,
      // Its rates, and whether its frames do not come at one steady rate.
      ...rates,
      frames: Number(v.nb_frames) || (matroska && Number(tagOf(v, "NUMBER_OF_FRAMES"))) || 0,
      pixFmt: v.pix_fmt || "",
      fieldOrder: v.field_order || "",
      colorTransfer: v.color_transfer || "",
      colorSpace: v.color_space || "",
      startTime: Number(v.start_time) || 0,
      duration: ownLength(v),
      bitRate: Number(v.bit_rate) || 0,
    };
  }
  const audio = a
    ? {
        index: a.index,
        codec: a.codec_name || "",
        profile: a.profile || "",
        sampleRate: Number(a.sample_rate) || 0,
        channels: Number(a.channels) || 0,
        layout: a.channel_layout || "",
        startTime: Number(a.start_time) || 0,
        duration: ownLength(a),
        bitRate: Number(a.bit_rate) || 0,
      }
    : null;
  let bytes = Number(format.size) || 0;
  if (!bytes) {
    try {
      bytes = fs.statSync(file).size;
    } catch {
      // Left at 0.
    }
  }
  // Where the video's time starts: at the earlier of its picture and its
  // sound (the first sound track, the one the files carry), as the file
  // states their starts, else at the file's start.
  const startOf = (s) => (s && s.start_time !== undefined && Number.isFinite(Number(s.start_time)) ? Number(s.start_time) : null);
  const starts = [v, a].map(startOf).filter((n) => n !== null);
  const origin = starts.length ? Math.min(...starts) : Number.isFinite(Number(format.start_time)) ? Number(format.start_time) : 0;
  const duration = Number(format.duration) || (video && video.duration) || 0;
  return {
    file,
    bytes,
    duration,
    unstated: !(duration > 0) && Boolean(video),
    measured: false,
    origin,
    // Whether a stream states where it starts, so that the origin is not
    // measured.
    startsGiven: starts.length > 0,
    // How many sound tracks the file has; only the first is used.
    audioTracks: streams.filter((s) => s.codec_type === "audio").length,
    formatName: format.format_name || "",
    bitRate: Number(format.bit_rate) || 0,
    startTime: Number(format.start_time) || 0,
    video,
    audio,
  };
}

// The length of a video whose container does not state it (probe()'s
// `unstated`), from the packets of its picture and of its first sound
// track: from the origin to where the last of them ends, so a file whose
// times start late, as a recording cut from a stream, is as long as its
// picture and sound; its picture's frames; and where its picture and its
// sound each start and end. ffprobe lists the packets through run(), each
// line read as it comes, so a signal stops it with the run, the list of a
// long video is never held whole, and no time limit cuts it off on a slow
// disk. A list that fails, or that has no packet, stops the run with what
// happened. Returns the info, measured. `name` is the video as it was
// given.
async function measureLength(info, name = info.file) {
  if (!info.unstated) return info;
  const picture = String(info.video.index);
  const sound = info.audio ? String(info.audio.index) : null;
  const num = (x) => (x === undefined || x === "" || x === "N/A" ? NaN : Number(x));
  let first = Infinity;
  let end = -Infinity;
  const frames = { count: 0, first: Infinity, end: -Infinity };
  const blocks = { first: Infinity, end: -Infinity };
  const take = (line) => {
    const [index, pts, dts, dur] = line.trim().split(",");
    if (index !== picture && index !== sound) return;
    const at = Number.isFinite(num(pts)) ? num(pts) : num(dts);
    if (!Number.isFinite(at)) return;
    const ends = at + (num(dur) > 0 ? num(dur) : 0);
    first = Math.min(first, at);
    end = Math.max(end, ends);
    const own = index === picture ? frames : blocks;
    if (index === picture) frames.count++;
    own.first = Math.min(own.first, at);
    own.end = Math.max(own.end, ends);
  };
  let rest = "";
  const r = await run(["-v", "error", "-show_entries", "packet=stream_index,pts_time,dts_time,duration_time", "-of", "csv=p=0", info.file], {
    tool: ffprobePath(),
    onStdout: (chunk) => {
      const lines = (rest + chunk.toString("latin1")).split("\n");
      rest = lines.pop();
      for (const line of lines) take(line);
    },
  });
  if (rest) take(rest);
  const cannot = (why) => Object.assign(new Error(`${name} ${why}`), { why: `it ${why}` });
  // A signal that stops a run says nothing of the file: a check stops on
  // it. A crash, or a kill as when memory runs out, is the file's reason.
  if (stops(r.signal)) throw Object.assign(new Error(`${name} does not state its length, and ffprobe ${endedBy(r.signal, " while it measured it")}`), { stopped: r.signal });
  if (r.signal) throw cannot(`does not state its length, and ffprobe ${endedBy(r.signal, " while it measured it")}`);
  if (r.code !== 0) {
    const last = lastLine(r.stderr).split(info.file).join(name);
    throw cannot(`does not state its length, and ffprobe could not measure it: ${last || `ffprobe exited with ${r.code}`}`);
  }
  if (!Number.isFinite(first)) throw cannot("does not state its length, and ffprobe found no packet of its picture or its sound to measure it by");
  const origin = info.startsGiven ? info.origin : first;
  const video = { ...info.video, frames: info.video.frames || frames.count };
  if (!(video.duration > 0) && frames.count) Object.assign(video, { startTime: frames.first, duration: Math.max(0, frames.end - frames.first) });
  const audio = info.audio && !(info.audio.duration > 0) && Number.isFinite(blocks.first) ? { ...info.audio, startTime: blocks.first, duration: Math.max(0, blocks.end - blocks.first) } : info.audio;
  return { ...info, origin, duration: Math.max(0, end - origin), unstated: false, measured: true, video, audio };
}

// The video as a run that reads it opens it, and the seconds its filter
// graph takes off every time, so that every run counts from the video's
// origin. ffmpeg counts a run's time from the start of the streams the
// run reads when the file is an MPEG-TS or MPEG-PS (.ts, .mts, .m2ts,
// .mpg): a run of the sound alone and one of the picture alone would each
// start at 0, and the gap between the two starts would be lost. -copyts
// keeps the file's own times instead. The second added with -itsoffset
// keeps ffmpeg 4.4 from moving them all the same, which it does to a file
// that starts at 0 when its input offset is 0 too; the graph takes that
// second off with the origin.
//
// A picture that changes its size, its pixel format or its range part
// way, as two recordings joined or a browser's WebM of a window that was
// resized, makes ffmpeg build the filter graph again from that frame on:
// each notes file of the reading is opened again and emptied, and a
// window's crop can fail. -reinit_filter 0 keeps the graph, and every
// graph that reads the picture starts with shownPicture(), which turns
// each frame to the size and the format of the first.
const SHIFT = 1;
const openVideo = (info, file = info.file) => ["-copyts", "-itsoffset", String(SHIFT), "-reinit_filter:v", "0", "-i", path.resolve(file)];
const fromOrigin = (info) => ((Number.isFinite(info.origin) ? info.origin : 0) + SHIFT).toFixed(6);

// The picture at the size it is shown, in square pixels, a frame of
// another size scaled to it; `how` adds scale's own options.
const shownPicture = (info, how = "") => `scale=${info.video.displayWidth}:${info.video.displayHeight}${how},setsar=1`;

// An MPEG-TS or an MPEG-PS (.ts, .mts, .m2ts, .mpg, .vob) has no index:
// a seek there lands on a packet, not on a key frame, so a frame of the
// sheet would be the next key frame's. Its times can also jump, as where
// two recordings were joined, which ffmpeg closes when it copies such a
// file but not with -copyts: a jump back, or one ahead of more than ten
// seconds (a shorter one ahead it keeps, as a gap). So a run reads such a
// video from a copy in its work folder, an MP4 of its picture and its
// first sound track as they are, made once as ffmpeg copies a file: the
// gap between the starts of the picture and the sound is kept, a jump is
// closed, and the MP4's index finds every frame. Sound an MP4 cannot hold
// as it is, such as a Blu-ray's PCM, is turned into ALAC, which loses
// nothing.
const UNINDEXED = new Set(["mpegts", "mpeg"]);
const unindexed = (info) => String(info.formatName || "").split(",").some((name) => UNINDEXED.has(name));

// Makes that copy in a folder of its own in `work`, apart from the files
// a run makes there, and returns what probe() says of it. `name` is the
// video as it was given, for the errors.
async function readableCopy(info, work, name = info.file) {
  fs.mkdirSync(path.join(work, "read"), { recursive: true });
  const copy = path.join("read", "video.mp4");
  const maps = ["-map", `0:${info.video.index}`, ...(info.audio ? ["-map", `0:${info.audio.index}`] : [])];
  const args = (sound) => ["-v", "error", "-fflags", "+genpts", "-i", path.resolve(info.file), ...maps, "-c:v", "copy", "-c:a", sound, "-max_muxing_queue_size", "65536", "-f", "mp4", "-y", copy];
  const what = `Copying ${name} to read it`;
  try {
    await mustRun(args("copy"), what, { cwd: work });
  } catch (err) {
    if (!info.audio || err.signal || err.refused) throw err;
    await mustRun(args("alac"), what, { cwd: work });
  }
  // The copy is the run's own file: one ffprobe cannot read is named so,
  // not as the video given.
  try {
    return probe(path.join(work, copy), name);
  } catch (err) {
    throw err.why ? new Error(`${what}: the copy ffmpeg made cannot be read: ${err.why}`) : err;
  }
}

// Where that copy has no picture, or no sound, for more than a second: a
// jump ahead in the times of the MPEG-TS or MPEG-PS of ten seconds or
// less, which ffmpeg keeps as a gap when it copies such a file, as where
// two recordings were joined. Its picture holds there in the files, and
// its sound is silent. A frame or a block of sound spans such a gap in the
// copy, so a gap is where two in a row start more than a second apart
// (and four times as far as two frames do most often). ffprobe's rates
// count the gap, as frames that come slowly or at odd times, so the
// picture's rate is taken from its frames outside the gaps. Times are
// from the video's origin. Returns { picture: [[from, to]], sound:
// [[from, to]], fps: { avg, base } or null when the picture has no gap }.
// ffprobe lists the copy's packets through run(), each line read as it
// comes, so a signal stops it with the run, as it stops ffmpeg, and the
// list of a long copy is never held whole.
async function gapsOf(info) {
  const none = { picture: [], sound: [], fps: null };
  if (!info.video) return none;
  const starts = { [info.video.index]: [], ...(info.audio ? { [info.audio.index]: [] } : {}) };
  const take = (line) => {
    const [index, pts] = line.split(",");
    const at = Number(pts);
    if (Object.hasOwn(starts, index) && pts !== "" && Number.isFinite(at)) starts[index].push(at);
  };
  let rest = "";
  const r = await run(["-v", "error", "-show_entries", "packet=stream_index,pts_time", "-of", "csv=p=0", info.file], {
    tool: ffprobePath(),
    onStdout: (chunk) => {
      const lines = (rest + chunk.toString("latin1")).split("\n");
      rest = lines.pop();
      for (const line of lines) take(line);
    },
  });
  if (rest) take(rest);
  if (r.code !== 0) return none;
  const origin = Number.isFinite(info.origin) ? info.origin : 0;
  // The stretches between two starts in a row too far apart, and the
  // spacing of most.
  const holes = (list) => {
    list.sort((x, y) => x - y);
    const steps = list.slice(1).map((t, i) => t - list[i]);
    const most = steps.length ? [...steps].sort((x, y) => x - y)[Math.floor(steps.length / 2)] : 0;
    const far = Math.max(1, 4 * most);
    const found = [];
    steps.forEach((step, i) => {
      if (step > far) found.push([list[i] + most - origin, list[i + 1] - origin]);
    });
    return { found, steps, far, most };
  };
  const picture = holes(starts[info.video.index]);
  const sound = info.audio ? holes(starts[info.audio.index]).found : [];
  if (!picture.found.length) return { ...none, sound };
  const kept = picture.steps.filter((step) => step <= picture.far);
  const total = kept.reduce((sum, step) => sum + step, 0);
  return { picture: picture.found, sound, fps: total > 0 && picture.most > 0 ? { avg: kept.length / total, base: 1 / picture.most } : null };
}

// The H.264 encoder this ffmpeg has, best first: x264 where it is built in
// (Homebrew, most Linux packages), then the Mac's own, Cisco's and
// Windows' own, which take a bit rate instead of a quality.
let encoder = null;
function pickEncoder() {
  if (encoder) return encoder;
  const listed = ask(ffmpegPath(), ["-hide_banner", "-encoders"], "when asked to list its encoders");
  const has = (name) => new RegExp(`^\\s*V\\S*\\s+${name}\\s`, "m").test(listed);
  if (has("libx264")) encoder = { name: "libx264", quality: true };
  else if (has("h264_videotoolbox")) encoder = { name: "h264_videotoolbox", quality: false };
  else if (has("libopenh264")) encoder = { name: "libopenh264", quality: false };
  else if (has("h264_mf")) encoder = { name: "h264_mf", quality: false };
  else throw new Error("This ffmpeg has no H.264 encoder (x264, VideoToolbox, OpenH264 or Media Foundation). Install a full build of ffmpeg.");
  const aac = /^\s*A\S*\s+aac\s/m.test(listed);
  if (!aac) throw new Error("This ffmpeg has no AAC encoder. Install a full build of ffmpeg.");
  return encoder;
}

module.exports = { MISSING, ffmpegPath, ffprobePath, checkTools, unanswered, run, mustRun, unfinished, probe, measureLength, pickEncoder, rational, ratesOf, lastLine, failure, refusal, endedBy, stops, stopAll, stoppedLately, openVideo, fromOrigin, shownPicture, SHIFT, unindexed, readableCopy, gapsOf };
