"use strict";

// The ffmpeg and the ffprobe a run starts, found before any work
// (ffmpeg.js checkTools()) as the system finds a program: at the path a
// variable gives, or on PATH. Each is looked at for what can be told for
// certain before it runs, then asked its version once, and taken only when
// it answers as ffmpeg (or ffprobe) does. One that is not there, may not
// be run, cannot be started or answers otherwise stops the run with the
// variable or PATH that gave it, its path, what the system said or the
// first line it printed, and how to get one; one that gives no answer in
// time stops it with its path and that alone. Which file of a chain of
// scripts is at fault is never guessed: the line it printed says that.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getSystemErrorMap } = require("node:util");

const INSTALL = "brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg";
const MISSING = `reframekit needs ffmpeg and ffprobe. Install ffmpeg (${INSTALL}), or set FFMPEG_PATH and FFPROBE_PATH to them.`;

const windows = process.platform === "win32";

// A path is a name with a slash in it, or on Windows a backslash too, as
// the system reads it there; any other name is looked for on PATH.
const isPath = (name) => (windows ? /[\\/]/ : /\//).test(name);

// A tool a variable names: a path, as ../bin/ffmpeg, from the folder the
// run was started in, since most of the kit's ffmpeg runs start in its
// work folder, where a path relative to another folder leads nowhere; a
// bare name, as ffmpeg-8, as it is, for PATH to find.
const located = (name) => (name && isPath(name) ? path.resolve(name) : name);

// The ffmpeg a run starts: the one FFMPEG_PATH names, else the one
// LAUNCH_FILM_FFMPEG names (the name launch-film and makersmcp pass an
// ffmpeg by), else the one on PATH. { tool, program, variable }
function ffmpegSource() {
  const variable = ["FFMPEG_PATH", "LAUNCH_FILM_FFMPEG"].find((name) => process.env[name]) || null;
  return { tool: "ffmpeg", program: variable ? located(process.env[variable]) : "ffmpeg", variable };
}

// The ffprobe a run starts: the one FFPROBE_PATH names, else the one
// LAUNCH_FILM_FFPROBE names, else, for an ffmpeg a variable names by its
// path, whatever is next to it by ffprobe's name (`beside`, that ffmpeg's
// source), a link that leads nowhere too, so a broken one is named rather
// than passed over for another; else the one on PATH (`after`, that
// ffmpeg's source, when there was none next to it). An ffmpeg named by a
// bare name, as ffmpeg-8, has nothing next to it: PATH finds each.
function ffprobeSource() {
  const variable = ["FFPROBE_PATH", "LAUNCH_FILM_FFPROBE"].find((name) => process.env[name]) || null;
  if (variable) return { tool: "ffprobe", program: located(process.env[variable]), variable };
  const ff = ffmpegSource();
  if (ff.variable && isPath(ff.program)) {
    const next = path.join(path.dirname(ff.program), path.basename(ff.program).replace(/ffmpeg/i, "ffprobe"));
    if (next !== ff.program) {
      if (lstatOf(next)) return { tool: "ffprobe", program: next, variable: null, beside: ff };
      return { tool: "ffprobe", program: "ffprobe", variable: null, after: ff };
    }
  }
  return { tool: "ffprobe", program: "ffprobe", variable: null };
}

const lstatOf = (file) => {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
};

const isFile = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

// The variable that holds PATH, by its name in any letters on Windows.
const pathKey = () => (windows ? Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") : "PATH");

// The files the system tries for a program, in its order, each with the
// entry of PATH it is in: the path itself, or for a bare name that name in
// each entry of PATH, an empty one as the current folder, or in /bin and
// /usr/bin when there is no PATH at all, as glibc looks. Windows looks in
// the current folder first, then in each entry of PATH (one in quotes as
// the folder inside them), with .com and .exe after the name, which it
// tries as it is only when it has an extension.
function places(name) {
  const names = windows ? [...(path.extname(name) ? [name] : []), `${name}.com`, `${name}.exe`] : [name];
  if (isPath(name)) return names.map((file) => ({ file }));
  const key = pathKey();
  const value = key ? process.env[key] : undefined;
  if (windows) {
    const entries = value === undefined ? [] : value.split(";").map((e) => e.replace(/^"|"$/g, "")).filter(Boolean);
    return ["", ...entries].flatMap((entry) => names.map((n) => ({ file: path.resolve(entry || ".", n), entry })));
  }
  const entries = value === undefined ? ["/bin", "/usr/bin"] : value.split(":");
  return entries.map((entry) => ({ file: path.resolve(entry || ".", name), entry }));
}

// The folders on the way to `file`, from the top.
function folders(file) {
  const parts = path.resolve(file).split(path.sep);
  return parts.slice(1, -1).map((_, i) => parts.slice(0, i + 2).join(path.sep) || path.sep);
}

// The first folder on the way to `file` that this user may not enter.
function lockedFolder(file) {
  for (const folder of folders(file)) {
    try {
      fs.accessSync(folder, fs.constants.X_OK);
    } catch (err) {
      return err.code === "EACCES" || err.code === "EPERM" ? folder : null;
    }
  }
  return null;
}

// The first name on the way to `file` that is a file, not a folder.
function fileOnTheWay(file) {
  for (const folder of folders(file)) {
    try {
      if (!fs.statSync(folder).isDirectory()) return folder;
    } catch {
      return null;
    }
  }
  return null;
}

// A name in the folder it really is in, as the system reads it: the
// folder's links followed, the name's own not.
function inRealFolder(file) {
  try {
    return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  } catch {
    return file;
  }
}

// Where a chain of links from `file` leads, as the system follows it:
// each link read from the folder it really is in, and a target that goes
// up with .. kept as it is written, as the system goes up from wherever a
// link on the way leads. { end }, the first name on the chain that is no
// link; { back, self }, the first link the chain comes to again, `self`
// when that is `file`; { end: null } past 40 links.
function chainOf(file) {
  const start = inRealFolder(file);
  const seen = new Set();
  let at = start;
  for (let i = 0; i <= 40; i++) {
    if (seen.has(at)) return { back: at, self: at === start };
    seen.add(at);
    let target;
    try {
      if (!fs.lstatSync(at).isSymbolicLink()) return { end: at };
      target = fs.readlinkSync(at);
    } catch {
      return { end: at };
    }
    const up = target.split(/[\\/]/).includes("..");
    if (path.isAbsolute(target)) at = up ? target : path.resolve(target);
    else at = up ? `${path.dirname(at)}${path.sep}${target}` : path.resolve(path.dirname(at), target);
    if (!up) at = inRealFolder(at);
  }
  return { end: null };
}

// The mount `file` is on when it is mounted noexec, where the system runs
// no program; null when it is not, or off Linux.
function noexecMount(file) {
  if (process.platform !== "linux") return null;
  let real;
  let table;
  try {
    real = fs.realpathSync(file);
    table = fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return null;
  }
  let found = null;
  for (const line of table.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 6) continue;
    const point = fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (real !== point && !real.startsWith(point.endsWith("/") ? point : `${point}/`)) continue;
    // A later mount on the same place hides the one before.
    if (!found || point.length >= found.point.length) found = { point, noexec: fields[5].split(",").includes("noexec") };
  }
  return found && found.noexec ? found.point : null;
}

// The errors the system gives that Node.js has no name for, and calls
// "Unknown system error -116": each one's name and the system's words, by
// system and number. Linux's numbers are those of every processor Node.js
// runs on but MIPS.
const UNNAMED = {
  linux: { 80: ["ELIBBAD", "accessing a corrupted shared library"], 116: ["ESTALE", "stale file handle"] },
  darwin: { 70: ["ESTALE", "stale NFS file handle"], 85: ["EBADEXEC", "bad executable (or shared library)"], 86: ["EBADARCH", "bad CPU type in executable"], 87: ["ESHLIBVERS", "shared library version mismatch"], 88: ["EBADMACHO", "malformed Mach-o file"] },
};

// An error's name and the system's words for it, as ["EACCES",
// "permission denied"], or [] when neither is known.
const known = (err) => getSystemErrorMap().get(err.errno) || (!/^mips/.test(process.arch) && (UNNAMED[process.platform] || {})[-err.errno]) || [];

// The system's name for an error, as ESTALE, else Node's.
const codeOf = (err) => known(err)[0] || err.code;

// The system's own words for an error, such as "permission denied", else
// its code.
const worded = (err) => known(err)[1] || err.code;

// The errors looking at a place can give that the system passes over, as
// it passes over a place where nothing is, when it looks for a program on
// PATH as glibc does: a folder of PATH on a network mount whose handle
// went stale, or that does not answer.
const UNREACHED = new Set(["ESTALE", "ENODEV", "ETIMEDOUT"]);

// What keeps the system from starting the file at `file`, as far as can
// be told for certain before it runs: null when nothing does, else the
// words for it, said after the file's name ("is a folder"), and what the
// system does with such a place when it looks for a program on PATH: it
// passes over a folder, a file this user may not run and a link that
// leads nowhere ("passes"), and looks on; it passes over a place where
// nothing is, one in a folder this user may not enter and one on a mount
// it cannot reach "quietly", as such a place may hold no such program at
// all; and it stops at a place it cannot follow, as a loop of links
// ("stops").
function barred(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (UNREACHED.has(codeOf(err))) return { on: "quietly", words: `cannot be looked at: ${worded(err)}` };
    const own = lstatOf(file);
    const link = Boolean(own && own.isSymbolicLink());
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      if (link) {
        const { end } = chainOf(file);
        const through = end && err.code === "ENOTDIR" ? fileOnTheWay(end) : null;
        return { on: "passes", words: end ? `is a link to ${end}, which is not there${through ? `, as ${through} is a file, not a folder` : ""}` : "is a link to a file that is not there" };
      }
      const through = err.code === "ENOTDIR" ? fileOnTheWay(file) : null;
      return { on: "quietly", words: through ? `is not there, as ${through} is a file, not a folder` : "is not there" };
    }
    if (err.code === "EACCES" || err.code === "EPERM") {
      const locked = lockedFolder(file);
      return { on: "quietly", words: locked ? `is in ${locked}, a folder this user may not enter` : `cannot be looked at: ${worded(err)}`, locked: Boolean(locked) };
    }
    if (err.code === "ELOOP" && link) {
      const { back, self } = chainOf(file);
      if (back) return { on: "stops", words: self ? "is a link that leads back to itself" : `is a link that leads into a loop of links, at ${back}` };
    }
    return { on: "stops", words: `cannot be looked at: ${worded(err)}` };
  }
  if (stat.isDirectory()) return { on: "passes", words: "is a folder", folder: true };
  if (!stat.isFile()) return { on: "passes", words: "is not a file" };
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    if ((stat.mode & 0o111) === 0) return { on: "passes", words: "is not executable" };
    const mount = noexecMount(file);
    return { on: "passes", words: mount ? `is on ${mount}, a mount where no program may be run (noexec)` : "may not be run by this user" };
  }
  return null;
}

// A line a program printed, in quotes, as it printed it, with its control
// characters written out, as \r or \x1b. A line longer than 200 characters
// keeps its first 120 and its last 80, as its end most often says why.
function quoted(line) {
  const chars = Array.from(line).map((c) => {
    if (c === "\t") return "\\t";
    if (c === "\r") return "\\r";
    if (!/[\p{Cc}\p{Cf}]/u.test(c)) return c;
    const n = c.codePointAt(0);
    return n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u${n.toString(16).padStart(4, "0")}`;
  });
  const shown = chars.length > 200 ? [...chars.slice(0, 120), "...", ...chars.slice(-80)] : chars;
  return `"${shown.join("")}"`;
}

// The first line with anything in it of what a program printed, or null.
const firstLine = (text) =>
  String(text || "")
    .split(/\r?\n/)
    .find((line) => line.trim()) || null;

// The first line of a file that starts with #!, as the system reads it to
// find the program that runs the file, or null.
function bangLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const bytes = Buffer.alloc(512);
    const got = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0));
    if (got.indexOf("#!") !== 0) return null;
    const end = got.indexOf(10);
    return got.subarray(0, end < 0 ? got.length : end).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The ways the system can be short of what it takes to start a program,
// none of them the program's fault: what to say of each, and what to do.
const SHORT = {
  EMFILE: "this process has as many files open as it may (too many open files). Raise that limit, as ulimit -n does, and run it again.",
  ENFILE: "the system has as many files open as it may (too many open files in system). Run it again once fewer files are open.",
  EAGAIN: "the system would not start another process just then (resource temporarily unavailable). Run it again once fewer processes run.",
  ENOMEM: "there was not enough memory to start it (cannot allocate memory). Close what else takes memory and run it again.",
  E2BIG: "what it was to be given is longer than the system passes to a program (argument list too long).",
};

// The errors a start fails with that the system passes over to try the
// next entry of PATH, as glibc's execvp does: a file it may not run, one
// whose interpreter or loader is not there or may not be run, and one on
// a network mount it cannot reach (UNREACHED).
const PASSED = new Set(["ENOENT", "EACCES", "ENOTDIR", ...UNREACHED]);

// What happened to a file the system did not start (`err`), once the
// checks above found nothing wrong with the file itself. The system says
// ENOENT of a file that is there when an interpreter or a loader it needs
// is not, so a script's first line, which names its interpreter, is shown.
function unstartable(file, err) {
  const code = codeOf(err);
  if (["ENOEXEC", "EFTYPE", "EBADARCH", "EBADMACHO"].includes(code)) return "it is not a program this system can run";
  const line = bangLine(file);
  const first = line === null ? "" : `; its first line is ${quoted(line)}`;
  if (code === "ENOENT") return `the system could not start it, as an interpreter or a loader it needs is not there${first}`;
  return `the system could not start it: ${worded(err)}${first}`;
}

// The longest a program may take to say its version, and the most of it
// that is taken in.
const ASK = 60_000;
const MAX = 1024 * 1024;

// What a program that ran when asked its version and did not answer as
// the tool does did (`r`, from spawnSync): the first line it printed, on
// its error output, where a program says what is wrong, else on its
// output, then how it ended. The tool prints its version on its output,
// so a program that ended well printing only on its error output is said
// to.
function answered(r) {
  const out = firstLine(r.stdout);
  const err = firstLine(r.stderr);
  if (r.error && r.error.code === "ENOBUFS") {
    const line = err || out;
    return line ? `it printed ${quoted(line)} and went on past ${MAX / 1024 / 1024} MB, so it was stopped` : `it printed more than ${MAX / 1024 / 1024} MB with no line of text in it, so it was stopped`;
  }
  const ended = r.signal ? `was stopped by ${r.signal}` : `exited with ${r.status}`;
  if (err && r.status === 0 && !out) return `it printed ${quoted(err)} on its error output, nothing on its output, and exited with 0`;
  if (err || out) return `it printed ${quoted(err || out)} and ${ended}`;
  return r.signal ? `it was stopped by ${r.signal}` : `it printed nothing and exited with ${r.status}`;
}

// An error for a tool the run cannot use, marked, so what reads ffmpeg's
// words of a failure leaves it as it is.
const unusable = (message, more = {}) => Object.assign(new Error(message), { unstarted: true }, more);

// How to get or point to a tool that works, by who named the one that does
// not.
function how({ tool, variable, beside, after }) {
  if (beside || after) return `Set FFPROBE_PATH to an ffprobe that runs, such as the one that comes with ffmpeg (${INSTALL}).`;
  if (variable) return `Set ${variable} to an ${tool} that runs, or unset it and install ${tool === "ffmpeg" ? "one" : "ffmpeg, which comes with one"} (${INSTALL}).`;
  if (tool === "ffmpeg") return `Install ffmpeg (${INSTALL}), or set FFMPEG_PATH to an ffmpeg that runs.`;
  return `Install ffmpeg, which comes with ffprobe (${INSTALL}), or set FFPROBE_PATH to an ffprobe that runs.`;
}

// The error for the tool at `file` that `source` gave, with the `words`
// that say what is wrong there, after its name, and how to get one.
function told(source, file, words, more) {
  const { tool, variable, program } = source;
  let subject;
  if (source.beside) subject = `the ffprobe next to the ffmpeg ${source.beside.variable} points to, ${file}, ${words}`;
  else if (variable && isPath(program)) subject = `${variable} points to ${file}, which ${words}`;
  else if (variable) subject = `the ${program} on your PATH that ${variable} names, ${file}, ${words}`;
  else subject = `the ${tool} on your PATH, ${file}, ${words}`;
  return unusable(`reframekit needs ffmpeg and ffprobe, and ${subject}. ${how(source)}`, more);
}

// The error for a tool that is nowhere the system looks: at its path, with
// what is wrong there (`quiet`), or on PATH, where `locked` is an entry of
// PATH this user may not enter, which may hold one.
function nowhere(source, quiet, locked) {
  const { tool, variable, program } = source;
  if (isPath(program)) return told(source, program, quiet ? quiet.words : "is not there");
  const unless = locked ? `, unless it is in ${locked}, a folder on it that this user may not enter` : "";
  if (variable) return unusable(`reframekit needs ffmpeg and ffprobe, and ${variable} names ${program}, which is not on your PATH${unless}. ${how(source)}`);
  if (tool === "ffmpeg") return unusable(locked ? `reframekit needs ffmpeg and ffprobe, and there is no ffmpeg on your PATH${unless}. ${how(source)}` : MISSING);
  const where = source.after ? `next to the ffmpeg ${source.after.variable} points to, or on your PATH` : "on your PATH";
  return unusable(`reframekit needs ffmpeg and ffprobe, and there is no ffprobe ${where}${unless}. ${how(source)}`);
}

// The error for a tool the system could not start for want of what it
// takes to start a program, which names no file and no install.
const short = (tool, err) => unusable(`reframekit could not start ${tool}, as ${SHORT[codeOf(err)]}`);

// The error for a tool at `file` that gave no answer in `limit` ms when
// asked its version. A working ffmpeg can be that slow on a machine too
// busy or short of memory, as well as a program that is not one, so only
// that is said, and to run it again, with no advice to install another.
const late = (tool, file, limit) => unusable(`reframekit could not check ${tool}, ${file}: it gave no answer in ${limit / 1000} s when asked its version, as on a machine too busy or short of memory. Run it again.`);

const ARGS = ["-hide_banner", "-version"];

// The file the system runs for `source`, found before any work: the path
// a variable gives, or the first file on PATH the system would start,
// past what it passes over (barred() and PASSED), asked its version once
// with `limit` ms to answer (`show` gets each file and its arguments as
// it starts). It is taken only when it exits with 0 and prints a line
// that starts with "ffmpeg version" (or "ffprobe version"), and returned
// as { file, source, said }, `said` being what it printed. Else the run
// stops with that file, what the system said or the first line it
// printed, and how it ended; when the system finds no file to run after
// one it passed over, that first one is named. One that gives no answer
// in time stops the run as late() says. The error for a file that a
// signal ended carries the signal (`signal`).
function find(source, show = () => {}, limit = ASK) {
  const { tool } = source;
  let passed = null;
  let quiet = null;
  let locked = null;
  for (const place of places(source.program)) {
    let seen = barred(place.file);
    if (!seen) {
      show(place.file, ARGS);
      const r = spawnSync(place.file, ARGS, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: limit, killSignal: "SIGKILL", maxBuffer: MAX, windowsHide: true });
      // An error with no process is the system's, at the start, as one
      // that fails at once with ETIMEDOUT on a network mount; one with a
      // process came after it started: the time limit, or the most of
      // its output that is taken in.
      const err = r.error && !r.pid ? r.error : null;
      if (err && Object.hasOwn(SHORT, codeOf(err))) throw short(tool, err);
      if (!err && r.error && r.error.code === "ETIMEDOUT") throw late(tool, place.file, limit);
      if (!r.error && r.status === 0 && new RegExp(`^${tool} version `, "m").test(r.stdout)) return { file: place.file, source, said: String(r.stdout) };
      seen = { on: err && PASSED.has(codeOf(err)) ? "passes" : "stops", words: `did not run as ${tool}: ${err ? unstartable(place.file, err) : answered(r)}`, signal: r.error ? null : r.signal };
    } else if (seen.folder && source.variable && isPath(source.program)) {
      // A folder that holds the tool, as a static build's folder does.
      const inner = path.join(place.file, windows ? `${tool}.exe` : tool);
      if (isFile(inner)) seen = { ...seen, words: `is a folder, with ${inner} in it` };
    }
    if (seen.on === "stops") throw told(source, place.file, seen.words, seen.signal ? { signal: seen.signal } : {});
    if (seen.on === "passes") passed = passed || { file: place.file, words: seen.words };
    else {
      quiet = quiet || seen;
      if (seen.locked && place.entry !== undefined) locked = locked || path.resolve(place.entry || ".");
    }
  }
  if (passed) throw told(source, passed.file, passed.words);
  throw nowhere(source, quiet, locked);
}

// The error for a tool the system could not start when the run went on to
// use it (`err`, from spawn or spawnSync), after it answered before any
// work (`before`): short of what it takes to start one, or in the
// system's own words.
function again(tool, file, err, before = true) {
  if (Object.hasOwn(SHORT, codeOf(err))) return short(tool, err);
  return unusable(`reframekit could not start ${tool}, ${file}${before ? ", again" : ""}: ${worded(err)}.`);
}

module.exports = { INSTALL, MISSING, ASK, isPath, located, ffmpegSource, ffprobeSource, places, barred, quoted, find, again, short, SHORT };
