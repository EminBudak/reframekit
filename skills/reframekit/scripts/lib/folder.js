"use strict";

// The output folder.
//
// A run is put together in a hidden folder and moved in only when it
// succeeds, so a failed or stopped run leaves the output folder as it was.
// The hidden folder sits inside the output folder, so every move stays on
// one disk however the folder is mounted or linked. An output folder that
// is not there yet is made first, as mkdir makes any folder, so the umask
// and a default ACL of the folder above decide who else may open it, and
// it goes again when the run fails.
//
// Every run lists the files it leaves in its folder, with their sizes and
// a digest of each ("written" and "hashes"), in crop.json and
// formats.json. A later run replaces only the files still there as it
// wrote them, and is refused before any work when it would replace any
// other file; the files it moves aside at the end are looked at again
// then, so one changed while it rendered stops the move. A folder is an
// earlier run's when at least one of them is there, so a crop.json copied
// elsewhere claims nothing. crop.json also carries a digest of itself as
// written, so a crop.json edited by hand is never planned over, nor after
// it was rendered with --crop, which marks the crop.json it writes as
// edited.
//
// Both also say where the video is from the folder and its size
// ("source"). A folder holds the run of one video: another file of the
// same name somewhere else is another video, and the same file changed
// since is said to be so.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
// What a run says when the system has no file descriptor to give it.
const { SHORT } = require("./tools");

const STAGE = ".reframekit-";
const SHEET = /^sheet(-\d+)?\.png$/;
// The folders of their own a check of one of this folder's files writes
// in, reframekit-check-<name> beside the file checked: reframekit-check-
// tiktok for tiktok.mp4, reframekit-check-formats for formats.json, as an
// agent's tool gives that place.
const CHECKS = /^reframekit-check-/;
// The files a folder's own system leaves in it, which a run passes over:
// Finder's .DS_Store and the ._ files macOS writes on a disk of another
// kind, Windows' Thumbs.db and desktop.ini. Each is a file: a folder or a
// link of such a name is someone's, like any other entry.
const SYSTEM_NAME = (name) => name === ".DS_Store" || name.startsWith("._") || /^(thumbs\.db|desktop\.ini)$/i.test(name);
const SYSTEM = (name, folder) => {
  if (!SYSTEM_NAME(name)) return false;
  try {
    return fs.lstatSync(path.join(folder, name)).isFile();
  } catch {
    return false;
  }
};

// Whether `name` in `folder` is a folder itself, not a link to one or a
// file: only such an entry can be a run's hidden folder.
const isFolder = (folder, name) => {
  try {
    return fs.lstatSync(path.join(folder, name)).isDirectory();
  } catch {
    return false;
  }
};

// A folder name from a file's name, letters of any script kept (composed
// first, as macOS stores them decomposed), at most 80 bytes long.
function slug(file) {
  let s = path
    .basename(String(file))
    .normalize("NFC")
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (Buffer.byteLength(s) > 80) {
    let cut = "";
    for (const ch of s) {
      if (Buffer.byteLength(cut + ch) > 80) break;
      cut += ch;
    }
    s = cut.replace(/-+$/, "");
  }
  return s || "video";
}

const defaultOut = (video) => `reframekit-${slug(video)}`;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const marked = (raw) => Boolean(raw) && typeof raw === "object" && !Array.isArray(raw) && "reframekit" in raw;

// A short digest of crop.json without its own digest, as JSON.stringify
// writes it: the same for the file read back, whatever its spacing.
function digestOf(raw) {
  const rest = { ...raw };
  delete rest.digest;
  return crypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
}

// A crop.json whose windows were set by hand: edited since reframekit
// wrote it, so its digest no longer matches, or written by a run that
// rendered such a crop.json, which marks it "edited" so the mark outlives
// the new digest.
const handMade = (raw) => marked(raw) && (raw.edited === true || !(typeof raw.digest === "string" && raw.digest === digestOf(raw)));

const sizeOf = (file) => {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
};

// A path with its links followed, or as it is when it is not there.
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

// Where a file is from a folder, as a run records its video: the same
// whatever way the folder and the file are named on the command line,
// through links or with .. in them.
function pathFrom(folder, file) {
  return path.relative(real(folder), real(file)).split(path.sep).join("/");
}

// What a file holds, to tell later whether it changed: { bytes, hash },
// the hash the first 16 hex digits of the SHA-256 of its bytes, or of its
// first and last MiB for a file over 16 MiB, so a long MP4 is not read
// whole (an edit of one keeps its size seldom, and its index and tags sit
// at its start or end). null when it is not a file.
const MIB = 1024 * 1024;
const hashed = (hash) => hash.digest("hex").slice(0, 16);
function printOf(file) {
  let fd = null;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    fd = fs.openSync(file, "r");
    const hash = crypto.createHash("sha256");
    const buf = Buffer.alloc(MIB);
    const read = (from, to) => {
      for (let at = from; at < to; ) {
        const got = fs.readSync(fd, buf, 0, Math.min(MIB, to - at), at);
        if (got <= 0) break;
        hash.update(buf.subarray(0, got));
        at += got;
      }
    };
    if (st.size <= 16 * MIB) read(0, st.size);
    else {
      read(0, MIB);
      read(st.size - MIB, st.size);
    }
    return { bytes: st.size, hash: hashed(hash) };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// The same for bytes read already, as a file given to the run is read
// once: what the run went by, however that file changes after.
function printOfBytes(bytes) {
  const hash = crypto.createHash("sha256");
  if (bytes.length <= 16 * MIB) hash.update(bytes);
  else hash.update(bytes.subarray(0, MIB)).update(bytes.subarray(bytes.length - MIB));
  return { bytes: bytes.length, hash: hashed(hash) };
}

// What a folder holds: its files (the hidden folders of runs and the
// system's files left out), the earlier run there and the files of it
// still as it wrote them, and a check's report; and `prints`, what each of
// its files the run may replace or remove held, to tell at the end
// whether it changed meanwhile. `shown` names the folder in an error.
function survey(full, shown = full) {
  if (!fs.existsSync(full)) return { exists: false, names: [], run: null, own: new Set(), checks: {}, prints: {} };
  let all;
  try {
    all = fs.readdirSync(full);
  } catch (err) {
    throw new Error(`Cannot read ${shown}: ${WHY[err.code] || err.message}; pick another folder with --out`);
  }
  const names = all.filter((n) => !n.startsWith(STAGE) && !SYSTEM(n, full));
  const formats = names.includes("formats.json") ? readJson(path.join(full, "formats.json")) : null;
  const crop = names.includes("crop.json") ? readJson(path.join(full, "crop.json")) : null;
  const listed = (raw) => marked(raw) && raw.written && typeof raw.written === "object" && !Array.isArray(raw.written);
  const own = new Set();
  const prints = {};
  const print = (n) => (Object.hasOwn(prints, n) ? prints[n] : (prints[n] = printOf(path.join(full, n))));
  for (const raw of [formats, crop]) {
    if (!listed(raw)) continue;
    const hashed = raw.hashes && typeof raw.hashes === "object" && !Array.isArray(raw.hashes) ? raw.hashes : {};
    for (const [name, bytes] of Object.entries(raw.written)) {
      const n = path.basename(String(name));
      if (n === "crop.json" || n === "formats.json" || !names.includes(n)) continue;
      // At the size the run wrote it, and with the content, where the run
      // recorded a hash (runs of 0.1.0 before that recorded none).
      if (typeof bytes !== "number" || sizeOf(path.join(full, n)) !== bytes) continue;
      const hash = Object.hasOwn(hashed, name) ? hashed[name] : undefined;
      if (hash !== undefined && !(print(n) && print(n).hash === hash)) continue;
      own.add(n);
      print(n);
    }
  }
  let run = null;
  if (own.size) {
    if (listed(formats)) own.add("formats.json");
    if (listed(crop)) own.add("crop.json");
    for (const n of ["formats.json", "crop.json"]) if (own.has(n)) print(n);
    // The video the run was of: crop.json's word first, as a plan after a
    // render writes only crop.json.
    const source = [crop, formats].map((raw) => (listed(raw) && raw.source && typeof raw.source.file === "string" ? raw.source : null)).find(Boolean);
    run = {
      video: (listed(crop) && crop.video) || (listed(formats) && formats.video) || null,
      file: source ? source.file : null,
      bytes: source && typeof source.bytes === "number" ? source.bytes : null,
      formats: listed(formats) && Array.isArray(formats.files) ? formats : null,
      // crop.json as reframekit wrote it, or edited since.
      cropEdited: own.has("crop.json") && handMade(crop),
    };
  }
  // A check's report: check.json says it is reframekit's, and the size of
  // the CHECK.md it wrote with it.
  const check = names.includes("check.json") ? readJson(path.join(full, "check.json")) : null;
  if (marked(check)) {
    own.add("check.json");
    print("check.json");
    if (reportWritten(full, check)) {
      own.add("CHECK.md");
      print("CHECK.md");
    }
  }
  // The check of one of the run's files, or of its formats.json, in a
  // folder of its own: when it holds that check's two reports and nothing
  // else, it is the folder's, and the file it checked is kept with it, so
  // a run that makes that file again removes the check.
  const checks = {};
  for (const n of names) {
    if (!CHECKS.test(n)) continue;
    const of = checkedIn(path.join(full, n));
    if (of && (of === "formats.json" || own.has(of))) {
      own.add(n);
      checks[n] = of;
      prints[n] = { of, inside: { "check.json": printOf(path.join(full, n, "check.json")), "CHECK.md": printOf(path.join(full, n, "CHECK.md")) } };
    }
  }
  return { exists: true, names, run, own, checks, prints };
}

// Whether the CHECK.md in `dir` is the one the check.json there says the
// check wrote: at its size, and with its content where it gives a hash.
function reportWritten(dir, check) {
  const md = check && check.written && check.written["CHECK.md"];
  if (typeof md !== "number" || sizeOf(path.join(dir, "CHECK.md")) !== md) return false;
  const hash = check.hashes && typeof check.hashes === "object" ? check.hashes["CHECK.md"] : undefined;
  if (hash === undefined) return true;
  const p = printOf(path.join(dir, "CHECK.md"));
  return Boolean(p) && p.hash === hash;
}

// The name of the file beside it that a folder of a check holds the check
// of, when it holds that check's two reports and nothing else (but the
// system's own files); else null.
function checkedIn(at) {
  try {
    if (!fs.lstatSync(at).isDirectory()) return null;
    const inside = fs.readdirSync(at).filter((n) => !SYSTEM(n, at));
    const report = readJson(path.join(at, "check.json"));
    if (!marked(report) || typeof report.checked !== "string" || sizeOf(path.join(at, "check.json")) < 0) return null;
    const of = /^\.\.\/([^/\\]+)$/.exec(report.checked);
    if (!of || of[1] === "." || of[1] === "..") return null;
    return inside.every((n) => n === "check.json" || (n === "CHECK.md" && reportWritten(at, report))) ? of[1] : null;
  } catch {
    return null;
  }
}

const WHY = { EACCES: "permission denied", EPERM: "permission denied", EROFS: "the disk is read-only", ENOTDIR: "a file is in the way", ENAMETOOLONG: "the name is too long for this disk", ENOSPC: "no space is left on the disk", EDQUOT: "the disk quota is used up" };

// Why a folder cannot be written, or null when it can: it, or the nearest
// folder above it that exists, has to be a folder that takes new files. A
// drive or a share that is not there stops the walk at its root, and a
// link that leads nowhere stops it there, since mkdir cannot make a
// folder through it.
function unwritable(full) {
  let at = full;
  for (;;) {
    let link = false;
    try {
      link = fs.lstatSync(at).isSymbolicLink();
    } catch {
      // Not there.
    }
    if (fs.existsSync(at)) break;
    if (link) {
      const name = at === full ? "it" : at;
      try {
        fs.statSync(at);
      } catch (err) {
        if (err.code === "ELOOP") return `${name} is a link that leads back to itself`;
      }
      let to = "";
      try {
        to = fs.readlinkSync(at);
      } catch {
        // Left out of the words.
      }
      return `${name} is a link to ${to || "a place"}, which is not there`;
    }
    const up = path.dirname(at);
    if (up === at) return `${at} is not there`;
    at = up;
  }
  try {
    if (!fs.statSync(at).isDirectory()) return WHY.ENOTDIR;
    fs.accessSync(at, fs.constants.W_OK);
    return null;
  } catch (err) {
    return WHY[err.code] || err.message;
  }
}

function checkWritable(full, dir) {
  const why = unwritable(full);
  if (why) throw new Error(`Cannot write to ${dir}: ${why}`);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

// When a process started, to tell it from a later one that has its id: on
// Linux the boot and the clock tick it started at, elsewhere but Windows
// what ps says; null when it cannot be told.
function startOf(pid) {
  try {
    if (process.platform === "linux") {
      const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return ticks ? `${boot}:${ticks}` : null;
    }
    if (process.platform === "win32") return null;
    const r = require("node:child_process").spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

// Whether the run an owner file names is still going on: its process is
// there, on this machine, and it is that process, not a later one that
// took its id after the run was killed (after a restart, say).
function going(owner) {
  if (!owner || owner.host !== os.hostname() || typeof owner.pid !== "number" || owner.pid === process.pid || !alive(owner.pid)) return false;
  if (typeof owner.started !== "string") return true;
  const now = startOf(owner.pid);
  return now === null || now === owner.started;
}

// The hidden folders in `folder`: its folders named like one, never a
// link of such a name, which a run would follow out of the folder.
function stagesIn(folder) {
  try {
    return fs.readdirSync(folder).filter((n) => n.startsWith(STAGE) && isFolder(folder, n));
  } catch {
    return [];
  }
}

// The runs going on in `folder`, by their hidden folders, read only: each
// owner file with the hidden folder's name (`stage`).
function running(folder) {
  const names = stagesIn(folder);
  return names.map((name) => ({ name, owner: readJson(path.join(folder, name, ".owner")) })).filter((x) => going(x.owner)).map((x) => ({ ...x.owner, stage: x.name }));
}

// The hidden folders runs left in `folder`: those of runs still going on
// here (with the hidden folder's name), after removing those whose run is
// over, as after a kill that left no time to clean up.
function sweep(folder) {
  const live = [];
  for (const name of stagesIn(folder)) {
    const at = path.join(folder, name);
    const owner = readJson(path.join(at, ".owner"));
    // One without its owner file is a run's finished files kept after a
    // failed move; it is left for the person to take. One of another
    // machine, as on a shared disk, is left too.
    if (!owner || owner.host !== os.hostname() || typeof owner.pid !== "number") continue;
    if (going(owner)) live.push({ ...owner, stage: name });
    else removeStage(at);
  }
  return live;
}

const busy = (owner, dir) => new Error(`Another reframekit run (process ${owner.pid}) is writing in ${dir}. Wait for it to end, or pick another folder with --out. If no reframekit run is going on, remove ${path.join(dir, owner.stage)}.`);

// A name as a disk that ignores letter case (macOS, Windows, exFAT)
// compares it, as near as can be told: without the code points such disks
// leave out, its accents in one form and in small letters as Unicode folds
// them. Square.mp4 there is the file square.mp4 names.
const folded = (name) => String(name).replace(/\p{Default_Ignorable_Code_Point}/gu, "").normalize("NFD").toLowerCase().toUpperCase().toLowerCase().normalize("NFC");

// A file by what the disk says it is, so one file named two ways (in
// other letters, through a link) is one. Read as BigInt: an NTFS file id
// keeps a sequence number in its top bits, past what a JavaScript number
// holds exactly, and two files would then share an id.
const idOf = (file) => {
  try {
    const st = fs.statSync(file, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
};

// When the run a folder holds is of another video than `video`: that
// video and this one, as the refusal names them, else null. The run's
// video by where it is, so a film.mp4 of another folder is another video;
// a run that recorded only the name, by its name.
function otherVideo(run, full, video) {
  const other = run.file ? run.file !== pathFrom(full, video) : Boolean(run.video) && run.video !== path.basename(video);
  if (!other) return null;
  const was = run.file ? path.relative(process.cwd(), path.resolve(real(full), run.file)) || run.file : run.video;
  const now = run.file ? path.relative(process.cwd(), path.resolve(video)) || video : path.basename(video);
  return { was, now };
}

// Before any work: whether a run may write in `dir`. `writes(name)` gives
// the name of a file the run writes that a disk ignoring letter case takes
// `name` for, or null; `crop` is the crop.json given and `cropPrint` what
// it held when the run read it (printOfBytes), `inputs` every file given.
// Returns { dir, exists, run, own, checks, prints }, or throws, with code
// OTHER_VIDEO when the folder holds a run for another video. A run going
// on there stops it: a run's hidden folder is always inside the folder it
// writes in, so one going on there writes in this folder, whatever name it
// was given, through a link or in other letters on a disk that ignores
// them. Its one write is removing the hidden folders of runs that are over.
function claim(dir, rules) {
  const full = path.resolve(dir);
  checkWritable(full, dir);
  const [owner] = sweep(full);
  if (owner) throw busy(owner, dir);
  return judge(dir, full, survey(full, dir), rules);
}

// The same for a dry run, writing nothing: throws what claim() throws.
function wouldClaim(dir, rules) {
  const full = path.resolve(dir);
  checkWritable(full, dir);
  const [owner] = running(full);
  if (owner) throw busy(owner, dir);
  return judge(dir, full, survey(full, dir), rules);
}

// What claim() decides from the folder's survey `s`.
function judge(dir, full, s, { video, writes, crop = null, cropPrint = null, inputs = [] }) {
  if (!s.exists) return { dir: full, exists: false, run: null, own: s.own, checks: s.checks, prints: s.prints };
  const givenCrop = crop ? idOf(crop) : null;
  const given = new Set(inputs.map(idOf).filter(Boolean));
  const isGiven = (name) => given.has(idOf(path.join(full, name)));
  const foreign = s.names.filter((n) => !s.own.has(n) && !isGiven(n));
  if (!s.run && foreign.length) throw new Error(`${dir} is not empty and holds no earlier reframekit run. Pick another folder with --out.`);
  for (const name of s.names) {
    // Only a file written exactly as the run writes it can be the run's
    // own: one in other letters is someone else's that the disk may take
    // for it.
    const as = writes(name);
    if (!as) continue;
    if (givenCrop && idOf(path.join(full, name)) === givenCrop && as === name) {
      // The crop.json given, which the run writes again: what it held when
      // the run read it, so that one saved again since, even before this
      // look at the folder, stops the move at the end. A link to it, as to
      // a crop.json kept elsewhere, keeps the print of a link, none: the
      // run replaces the link, never the file it leads to.
      const entry = printOf(path.join(full, name));
      s.prints[name] = entry ? cropPrint || entry : null;
      continue;
    }
    const other = as === name ? "" : `: it writes ${as}, which a disk that ignores letter case takes for ${name}`;
    if (isGiven(name)) throw new Error(`${name} in ${dir} is a file you gave, and a run there would replace it${other}. Copy it elsewhere or pick another folder with --out.`);
    if (!s.own.has(name) || as !== name) throw new Error(`${name} in ${dir} is not a file reframekit wrote, and a run there would replace it${other}. Move it, or pick another folder with --out.`);
  }
  if (s.run) {
    const ownCrop = Boolean(givenCrop) && givenCrop === idOf(path.join(full, "crop.json"));
    const other = ownCrop ? null : otherVideo(s.run, full, video);
    if (other) throw Object.assign(new Error(`${dir} holds a run for ${other.was}, not for ${other.now}. Pick another folder with --out.`), { code: "OTHER_VIDEO" });
    if (s.run.cropEdited && !ownCrop) {
      const file = path.join(dir, "crop.json");
      throw new Error(crop ? `${file} was edited by hand, and this run would replace it with the windows of ${crop}. Render it with --crop ${file} instead, or move it out of ${dir} first.` : `${file} was edited by hand, and this run would plan over it. Render it with --crop ${file}, or move it out of ${dir} to plan again.`);
    }
  }
  return { dir: full, exists: true, run: s.run, own: s.own, checks: s.checks, prints: s.prints };
}

// ─── the hidden folder ─────────────────────────────────────────────────────

const open = new Set();
let handlers = null;
// The runs dropped in this process, as drop() tells of each: those a
// signal stopped, and one that failed a moment before the signal came,
// as when the same signal stopped its ffmpeg first.
const dropped = [];

// The signals that stop a run, by name, with their numbers: Ctrl-C, what
// a supervisor or docker stop sends, a closed terminal, and Ctrl-Break on
// Windows. ffmpeg.js counts only these as a stop of an ffmpeg or an
// ffprobe.
const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, ...(process.platform === "win32" ? { SIGBREAK: 21 } : {}) };

// Stops every run (`stop` ends its ffmpeg runs) and removes what it was
// putting together, when the process is stopped or ends any other way:
// a signal, a closed terminal, an uncaught error. A signal then ends the
// process by that signal, raised again once the handlers are gone, so
// whatever started it sees the signal and not an exit code; where it does
// not end a process, as on Windows, it exits with 128 and the signal's
// number. `tell`, given by the program that runs the kit (reframekit.js),
// says so first: it gets the signal and drop()'s word of each run
// dropped. Its guard stays until the process ends, so a signal that comes
// just after a run failed over it still finds it; without `tell`, as when
// a run is used as a library, the guard goes with the last run.
function guard(stop, tell = null) {
  if (handlers) {
    if (tell) Object.assign(handlers, { tell, stays: true });
    return;
  }
  // Each step on its own, so one that fails neither hides the signal nor
  // keeps the others from running.
  const clean = () => {
    try {
      stop();
    } catch {
      // Its runs are gone already.
    }
    for (const rec of [...open]) {
      try {
        drop(rec);
      } catch {
        // Left as it is, for the next run here.
      }
    }
  };
  let stopping = false;
  handlers = { exit: clean, signals: {}, tell, stays: Boolean(tell) };
  process.on("exit", clean);
  for (const [name, n] of Object.entries(SIGNALS)) {
    handlers.signals[name] = () => {
      // A second signal, as a supervisor passes on the one its process
      // group got, changes nothing.
      if (stopping) return;
      stopping = true;
      const said = handlers && handlers.tell;
      clean();
      if (said) {
        try {
          said(name, [...dropped]);
        } catch {
          // Nobody is reading.
        }
      }
      for (const signal of Object.keys(SIGNALS)) process.removeAllListeners(signal);
      process.removeListener("exit", clean);
      handlers = null;
      try {
        process.kill(process.pid, name);
      } catch {
        process.exit(128 + n);
      }
      // Only reached where that signal does not end a process.
      setTimeout(() => process.exit(128 + n), 100);
    };
    process.on(name, handlers.signals[name]);
  }
}

function unguard() {
  if (!handlers || open.size || handlers.stays) return;
  process.removeListener("exit", handlers.exit);
  for (const [name, fn] of Object.entries(handlers.signals)) process.removeListener(name, fn);
  handlers = null;
}

// A turn of the event loop, after which the work goes on. Node hears a
// signal only when its loop reads what the system has for it. A run of
// ffprobe or ffmpeg that spawnSync makes holds that off for as long as it
// runs, and so does a promise already settled: a check of files that
// state their length would give the loop no turn before it wrote its
// reports. A signal that came meanwhile is heard here, and guard() ends
// the work there. Two immediates, so that the loop reads once between
// them, in whichever of its phases this is called.
const turn = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

// Opens the hidden folder for a run inside `full`, making `full` and the
// folders above it that are missing first (and noting the first of them,
// to remove again if the run fails). Each is made as mkdir makes any
// folder, the hidden folder too, under a name of its own: the umask and a
// default ACL decide who else may open it, as they do for the output
// folder, so the finished files a stopped move keeps there can be taken
// by whoever may take them from the folder. mkdtemp's 0700 would leave a
// default ACL's mask empty, and the hidden folder shut to all but the
// run's user.
function makeStage(full) {
  for (let tries = 0; ; tries++) {
    const stage = path.join(full, STAGE + crypto.randomBytes(4).toString("hex"));
    try {
      fs.mkdirSync(stage);
      return stage;
    } catch (err) {
      if (err.code !== "EEXIST" || tries >= 20) throw err;
    }
  }
}

// A file descriptor a run holds from when it opens its hidden folder until
// it is done with it, and lets go of just before it removes that folder,
// so a run that fails as the system leaves it no other one, as when ffmpeg
// cannot be started for want of them, can still remove what it made:
// removing a folder takes one at a time. It is the null device, or this
// file where there is none. A run that cannot hold one, as the process or
// the system has as many files open as it may, makes nothing.
let reserve = null;

function holdReserve(shown) {
  if (reserve !== null) return;
  for (const file of [os.devNull, __filename]) {
    try {
      reserve = fs.openSync(file, "r");
      return;
    } catch (err) {
      if (err.code === "EMFILE" || err.code === "ENFILE") throw new Error(`Cannot take ${shown}: ${SHORT[err.code]}`);
    }
  }
}

function freeReserve() {
  if (reserve === null || open.size) return;
  try {
    fs.closeSync(reserve);
  } catch {
    // Closed already.
  }
  reserve = null;
}

function openStage(full, { stop = () => {}, shown = full } = {}) {
  guard(stop);
  holdReserve(shown);
  const created = firstMissing(full);
  let stage;
  try {
    if (created) fs.mkdirSync(full, { recursive: true });
    stage = makeStage(full);
  } catch (err) {
    removeCreated(full, created);
    freeReserve();
    throw err;
  }
  const rec = { dir: full, shown, stage, work: path.join(stage, ".work"), created, keep: false };
  open.add(rec);
  try {
    fs.writeFileSync(path.join(stage, ".owner"), JSON.stringify({ pid: process.pid, host: os.hostname(), dir: full, started: startOf(process.pid) }));
    fs.mkdirSync(rec.work);
  } catch (err) {
    drop(rec);
    throw err;
  }
  return rec;
}

// The topmost folder of `full` that is not there yet, or null.
function firstMissing(full) {
  let first = null;
  for (let at = full; !fs.existsSync(at); at = path.dirname(at)) {
    first = at;
    if (path.dirname(at) === at) break;
  }
  return first;
}

// The output folder and the folders above it that a run made, from the
// output folder up to `created`, each while it is empty. One that is not
// there (a mkdir stopped half way) is passed over; rmdir removes no
// folder that holds anything.
function removeCreated(full, created) {
  if (!created) return;
  for (let at = full; at === created || at.startsWith(created + path.sep); at = path.dirname(at)) {
    try {
      fs.rmdirSync(at);
    } catch (err) {
      if (err.code === "ENOTEMPTY" || err.code === "EEXIST") break;
    }
    if (at === created) break;
  }
}

// A failed or stopped run: its hidden folder goes, and the folders made
// for it, while empty. Removing tries again for a second or so, as
// Windows keeps a file a killed ffmpeg had open until ffmpeg is gone.
// What still cannot go stays with its owner file, which goes last, and so
// do the folders above it; the next run in that folder removes it, once
// this process is over. A failure here never takes the place of the
// error that stopped the run.
const REMOVE = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

// Whether the hidden folder is gone.
function removeStage(stage) {
  try {
    // A folder of its own, never one a link leads to.
    if (!fs.lstatSync(stage).isDirectory()) return true;
    for (const name of fs.readdirSync(stage)) if (name !== ".owner") fs.rmSync(path.join(stage, name), REMOVE);
    fs.rmSync(stage, REMOVE);
    return true;
  } catch {
    // Left for the next run.
    return fs.existsSync(stage) === false;
  }
}

// Returns what it did, as a stopped run says it: { shown, the folder as
// given; stage, the hidden folder; gone, whether that went }, or null for
// a run no longer going on.
function drop(rec) {
  if (!open.has(rec)) return null;
  open.delete(rec);
  freeReserve();
  const gone = rec.keep ? false : removeStage(rec.stage);
  removeCreated(rec.dir, rec.created);
  const told = { shown: rec.shown, stage: rec.stage, gone };
  dropped.push(told);
  unguard();
  return told;
}

// A rename, or a copy and a delete when the two names are on different
// disks.
function move(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

const samePrint = (a, b) => (!a && !b) || (Boolean(a) && Boolean(b) && a.bytes === b.bytes && a.hash === b.hash);

// Why `name` in `dir` is no longer what claim() found there (`folder`,
// what it returned), or null: a file that changed since, one that turned
// up meanwhile, or a folder of a check that no longer holds that check
// alone or whose reports changed.
function changedSince(folder, dir, name) {
  const at = path.join(dir, name);
  if (!Object.hasOwn(folder.prints, name)) return `${name} turned up while the run went on`;
  const was = folder.prints[name];
  if (was && was.inside) {
    if (checkedIn(at) !== was.of) return `${name} changed while the run went on`;
    for (const [n, p] of Object.entries(was.inside)) if (!samePrint(printOf(path.join(at, n)), p)) return `${name}/${n} changed while the run went on`;
    return null;
  }
  return samePrint(printOf(at), was) ? null : `${name} changed while the run went on`;
}

// Whether two names in a folder are one file, as on a disk that ignores
// letter case.
function sameFile(a, b) {
  try {
    const x = fs.lstatSync(a, { bigint: true });
    const y = fs.lstatSync(b, { bigint: true });
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

// Moves a finished run into its folder. The earlier files it replaces,
// and those in `remove`, are moved aside first and put back if any move
// fails; the finished files then stay in the hidden folder, which the
// error names. Before anything moves, the folder is looked at again
// against what claim() found in it (`folder`), so that nothing saved into
// it while the run went on is replaced or removed: a file changed since,
// one that turned up meanwhile, or one in other letters that a disk
// ignoring letter case takes for a name the run writes (or takes for the
// same file as a name it removes) stops the move.
function finishStage(rec, remove = [], folder = null) {
  const { dir, stage } = rec;
  fs.rmSync(rec.work, { recursive: true, force: true });
  const names = fs.readdirSync(stage).filter((n) => n !== ".owner" && n !== ".earlier");
  const earlier = path.join(stage, ".earlier");
  fs.mkdirSync(earlier, { recursive: true });
  const aside = [];
  const moved = [];
  try {
    // Only a file of the very name goes aside, and only as claim() found
    // it.
    const listed = fs.readdirSync(dir);
    const going = [...new Set([...names, ...remove])];
    for (const name of going) {
      const why = folder && listed.includes(name) ? changedSince(folder, dir, name) : null;
      if (why) throw new Error(why);
      const other = listed.find((n) => n !== name && folded(n) === folded(name));
      if (other && (names.includes(name) || sameFile(path.join(dir, name), path.join(dir, other)))) throw new Error(`${other} is there, which a disk that ignores letter case takes for ${name}`);
    }
    for (const name of going) {
      if (!listed.includes(name)) continue;
      move(path.join(dir, name), path.join(earlier, name));
      aside.push(name);
    }
    for (const name of names) {
      move(path.join(stage, name), path.join(dir, name));
      moved.push(name);
    }
  } catch (err) {
    for (const name of moved.reverse()) {
      try {
        move(path.join(dir, name), path.join(stage, name));
      } catch {
        // Left where it is.
      }
    }
    for (const name of aside.reverse()) {
      try {
        move(path.join(earlier, name), path.join(dir, name));
      } catch {
        // Left in .earlier.
      }
    }
    rec.keep = true;
    fs.rmSync(path.join(stage, ".owner"), { force: true });
    open.delete(rec);
    freeReserve();
    unguard();
    // Named as the folder was given, as every other error names it.
    const shown = rec.shown || dir;
    throw new Error(`Moving the finished files into ${shown} failed (${err.message}). The folder is as it was; the finished files are in ${path.join(shown, path.basename(stage))}, which stays until you remove it.`);
  }
  // The files are in their folder; what is left is the earlier files set
  // aside, which the next run here removes if they cannot go now.
  removeStage(stage);
  open.delete(rec);
  freeReserve();
  unguard();
}

module.exports = { slug, defaultOut, digestOf, handMade, survey, claim, wouldClaim, checkWritable, unwritable, WHY, CHECKS, SYSTEM, SIGNALS, guard, turn, openStage, finishStage, drop, sweep, running, startOf, readJson, marked, printOf, printOfBytes, sizeOf, folded, pathFrom, real, idOf, reportWritten, firstMissing, removeCreated, SHEET, STAGE };
