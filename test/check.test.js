"use strict";

// The check: a reframekit folder passes; a file in the wrong shape, too
// long, with its index last or an edit list fails where the place says
// so; captions burned outside a 9:16 place's safe area fail.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { fixture, ffmpeg, cli, outDir, dir, ENCODE, SOUND } = require("./helpers");
const { layoutOf } = require("../skills/reframekit/scripts/lib/check");
const { readCaptions } = require("../skills/reframekit/scripts/lib/captions");

// What a run refused for a video cut short says to do, as a pattern: with
// the first frame of its picture whole in the file, with a byte of its
// media there but not that frame, and with none of its media.
const REMEDY = "\\. Copy or download it again, or, for a recording that stopped part way, make a whole file of the part that is there with ffmpeg -c copy, and reframe that\\.";
const FRAME = "\\. Not even the first frame of its picture is whole in the file: copy or download it again\\.";
const NONE = "\\. None of its media is in the file: copy or download it again\\.";

test("a reframekit folder passes its own check, and CHECK.md says so", () => {
  const out = outDir("checked");
  assert.equal(cli([fixture("twoShots"), "--for", "tiktok,square", "--out", out]).status, 0);
  const run = cli(["check", out]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^PASS: 2 files against 2 places/);
  const md = fs.readFileSync(path.join(out, "CHECK.md"), "utf8");
  assert.match(md, /^# PASS/);
  // check.json says reframekit wrote it, and the size of its CHECK.md.
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "check.json"), "utf8")).written["CHECK.md"], Buffer.byteLength(md));
  assert.equal(cli(["check", out]).status, 0, "a second check replaces the first");
  assert.match(md, /tiktok\.mp4 for TikTok: pass/);
  assert.match(md, /developers\.tiktok\.com/);
  const json = JSON.parse(fs.readFileSync(path.join(out, "check.json"), "utf8"));
  assert.equal(json.pass, true);
  const only = cli(["check", out, "--for", "square", "--json"]);
  assert.deepEqual(JSON.parse(only.stdout).results.map((r) => r.place), ["square"]);
  // --json prints check.json as the check wrote it, with what it checked
  // and the size and hash of its CHECK.md.
  const printed = cli(["check", out, "--json"]);
  assert.equal(printed.stdout, fs.readFileSync(path.join(out, "check.json"), "utf8"));
  assert.deepEqual(Object.keys(JSON.parse(printed.stdout)).slice(-3), ["checked", "written", "hashes"]);
});

test("a file cut short, as a copy that stopped part way leaves it, fails the check wherever the cut falls, in one reason, while the other files are measured", () => {
  const out = outDir("checked-cut");
  assert.equal(cli([fixture("twoShots"), "--for", "tiktok,square", "--out", out]).status, 0);
  const whole = fs.readFileSync(path.join(out, "tiktok.mp4"));
  // A copy of the folder whose tiktok.mp4 holds its first half: its index
  // comes first and is whole, so ffprobe reads it without a word.
  const copy = outDir("checked-cut-copy");
  fs.mkdirSync(copy);
  for (const name of fs.readdirSync(out)) fs.copyFileSync(path.join(out, name), path.join(copy, name));
  fs.writeFileSync(path.join(copy, "tiktok.mp4"), whole.subarray(0, Math.floor(whole.length / 2)));
  const half = cli(["check", copy, "--json"]);
  assert.equal(half.status, 1, half.stderr);
  const r = JSON.parse(half.stdout);
  assert.deepEqual(r.results.map((x) => [x.file, x.pass]), [["tiktok.mp4", false], ["square.mp4", true]]);
  const cut = r.results[0].checks.find((c) => c.name === "file");
  assert.equal(cut.status, "fail");
  assert.match(cut.found, /^cut short, its media \(the mdat box\) running \d+ KB past its end$/);
  assert.ok(r.results[0].checks.some((c) => c.name === "length"), "the other rows are measured too");
  assert.match(cli(["check", copy]).stdout, /^ {2}fail {2}tiktok\.mp4 for TikTok: file cut short, its media \(the mdat box\) running \d+ KB past its end \(asked for the whole file\)$/m);
  assert.equal(cli(["check", path.join(copy, "tiktok.mp4"), "--for", "tiktok", "--out", outDir("checked-cut-lone")]).status, 1);
  // Cut inside its index, at 1000 bytes or at 3000, it cannot be read, and
  // the reason is the same: ffprobe's own words differ, the end of the
  // file and data it does not know.
  for (const at of [1000, 3000]) {
    fs.writeFileSync(path.join(copy, "tiktok.mp4"), whole.subarray(0, at));
    const run = cli(["check", copy, "--json"]);
    assert.equal(run.status, 1, run.stderr);
    const checks = JSON.parse(run.stdout).results[0].checks;
    assert.equal(checks.length, 1);
    assert.match(checks[0].found, /^cannot be read: it is cut short, its index \(the moov box\) running \d+ KB past its end$/, `${at}: ${checks[0].found}`);
  }
  assert.match(fs.readFileSync(path.join(copy, "CHECK.md"), "utf8"), /^# FAIL \(tiktok\.mp4 for TikTok\)/);
  // One file alone is named once, with the same reason.
  const lone = cli(["check", "tiktok.mp4", "--for", "tiktok"], { cwd: copy });
  assert.equal(lone.status, 1);
  assert.match(lone.stderr, /^reframekit: Cannot read tiktok\.mp4: it is cut short, its index \(the moov box\) running \d+ KB past its end\n$/);
  // An MP4 whose index comes after its media, cut in half, loses its index:
  // a video given to reframe is refused in the same words.
  const late = path.join(dir, "index-last.mp4");
  ffmpeg(["-i", fixture("twoShots"), "-c", "copy", "-movflags", "0", late]);
  const bytes = fs.readFileSync(late);
  fs.writeFileSync(path.join(dir, "index-last-cut.mp4"), bytes.subarray(0, Math.floor(bytes.length / 2)));
  const refused = cli(["index-last-cut.mp4", "--for", "square", "--out", "index-last-cut"], { cwd: dir });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^reframekit: Cannot read index-last-cut\.mp4: it is cut short, its media \(the mdat box\) running \d+ KB past its end$/m);
  // Cut 4 bytes into the header of that index, it has none.
  let moov = 0;
  for (let at = 0; at + 8 <= bytes.length; at += bytes.readUInt32BE(at)) if (bytes.toString("latin1", at + 4, at + 8) === "moov") moov = at;
  fs.writeFileSync(path.join(dir, "index-last-header.mp4"), bytes.subarray(0, moov + 4));
  const headless = cli(["index-last-header.mp4", "--for", "square", "--out", "index-last-header"], { cwd: dir });
  assert.match(headless.stderr, /^reframekit: Cannot read index-last-header\.mp4: it has no index \(the moov box\), as an MP4 whose recording or copy stopped before its end$/m);
});

// Where the first frame of a file's picture ends, as ffprobe finds it.
const firstFrameEnd = (file) => {
  const [pos, size] = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "packet=pos,size", "-read_intervals", "%+#1", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim().split("\n")[0].split(",").map(Number);
  assert.ok(pos > 0 && size > 0, `${file}: ${pos}, ${size}`);
  return pos + size;
};

test("a video cut short whose index ffprobe still reads, or whose media is missing, is refused before any work in the check's words, for a plan too, told to copy the part that is there only when the first frame of its picture is, and else whether not even that frame or none of its media is there", () => {
  const whole = path.join(dir, "whole-fast.mp4");
  ffmpeg(["-i", fixture("twoShots"), "-c", "copy", "-movflags", "+faststart", whole]);
  const bytes = fs.readFileSync(whole);
  let mdat = 0;
  for (let at = 0; at + 8 <= bytes.length; at += bytes.readUInt32BE(at)) if (bytes.toString("latin1", at + 4, at + 8) === "mdat") mdat = at;
  fs.writeFileSync(path.join(dir, "half-fast.mp4"), bytes.subarray(0, Math.floor(bytes.length / 2)));
  fs.writeFileSync(path.join(dir, "no-media.mp4"), bytes.subarray(0, mdat));
  // Cut where the contents of its media box start: that box is there, and
  // none of the media. One byte further, or inside the first frame of its
  // picture, of which ffmpeg copies nothing, part of that frame is there;
  // just after it, that frame is whole.
  fs.writeFileSync(path.join(dir, "media-header.mp4"), bytes.subarray(0, mdat + 8));
  fs.writeFileSync(path.join(dir, "media-byte.mp4"), bytes.subarray(0, mdat + 9));
  const frame = firstFrameEnd(whole);
  fs.writeFileSync(path.join(dir, "in-first-frame.mp4"), bytes.subarray(0, frame - 1));
  fs.writeFileSync(path.join(dir, "first-frame.mp4"), bytes.subarray(0, frame));
  const cases = [
    ["half-fast.mp4", `it is cut short, its media \\(the mdat box\\) running \\d+ KB past its end${REMEDY}`],
    ["no-media.mp4", `it is cut short, its media \\(the mdat box\\) missing${NONE}`],
    ["media-header.mp4", `it is cut short, its media \\(the mdat box\\) running \\d+ KB past its end${NONE}`],
    ["media-byte.mp4", `it is cut short, its media \\(the mdat box\\) running \\d+ KB past its end${FRAME}`],
    ["in-first-frame.mp4", `it is cut short, its media \\(the mdat box\\) running \\d+ KB past its end${FRAME}`],
    ["first-frame.mp4", `it is cut short, its media \\(the mdat box\\) running \\d+ KB past its end${REMEDY}`],
  ];
  for (const [name, said] of cases) {
    for (const extra of [[], ["--plan"]]) {
      const out = `refused-${name}${extra.length ? "-plan" : ""}`;
      const r = cli([name, "--for", "180x320", ...extra, "--out", out], { cwd: dir });
      assert.equal(r.status, 1, `${name}: ${r.stdout}`);
      assert.match(r.stderr, new RegExp(`^reframekit: Cannot read ${name.replace(/\./g, "\\.")}: ${said}$`, "m"), name);
      assert.doesNotMatch(r.stderr, /Reading/, `${name} is refused before any work`);
      assert.ok(!fs.existsSync(path.join(dir, out)), `${out} is there`);
    }
  }
  // ffmpeg's copy of the part that is there is a whole file; of one that
  // holds none of its media, or not the whole of the first frame of its
  // picture, it holds nothing to reframe.
  ffmpeg(["-i", path.join(dir, "half-fast.mp4"), "-c", "copy", path.join(dir, "half-fast-whole.mp4")]);
  assert.equal(cli(["half-fast-whole.mp4", "--for", "180x320", "--plan", "--out", "half-fast-whole-plan"], { cwd: dir }).status, 0);
  for (const name of ["media-header", "in-first-frame"]) {
    ffmpeg(["-i", path.join(dir, `${name}.mp4`), "-c", "copy", path.join(dir, `${name}-whole.mp4`)]);
    assert.match(cli([`${name}-whole.mp4`, "--for", "180x320", "--plan", "--out", `${name}-whole-plan`], { cwd: dir }).stderr, /has no video stream|still picture/, name);
  }
  assert.equal(cli(["whole-fast.mp4", "--for", "180x320", "--plan", "--out", "whole-fast-plan"], { cwd: dir }).status, 0);
});

test("an MP4 that puts its sound before its picture, cut inside the first frame of its picture, holds whole samples of its sound, so the refusal says not even that frame is whole, not that none of its media is there", () => {
  // Fragments of half a second, each with the sound before the picture.
  const whole = path.join(dir, "sound-first.mp4");
  ffmpeg(["-i", fixture("twoShots"), "-map", "0:a", "-map", "0:v", "-c", "copy", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "500000", whole]);
  const at = firstFrameEnd(whole) - 1;
  fs.writeFileSync(path.join(dir, "sound-first-cut.mp4"), fs.readFileSync(whole).subarray(0, at));
  // Where each packet of its sound ends, as ffprobe lists them (where it
  // starts and its size): many end before the cut.
  const ends = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "packet=pos,size", "-of", "csv=p=0", whole], { encoding: "utf8" }).stdout.trim().split("\n").map((line) => line.split(",").reduce((sum, n) => sum + Number(n), 0));
  assert.ok(ends.filter((end) => end <= at).length > 10, `${at}: ${ends.slice(0, 3).join(" ")}`);
  const lay = layoutOf(path.join(dir, "sound-first-cut.mp4"));
  assert.deepEqual([lay.cut.lost, lay.someMedia, lay.mediaByte], [true, false, true]);
  for (const extra of [[], ["--plan"]]) {
    const r = cli(["sound-first-cut.mp4", "--for", "180x320", ...extra, "--out", `sound-first-cut${extra.length ? "-plan" : ""}`], { cwd: dir });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, new RegExp(`^reframekit: Cannot read sound-first-cut\\.mp4: it is cut short, its media \\(the mdat box\\) running \\d+ (?:bytes?|KB) past its end${FRAME}$`, "m"));
  }
  // ffmpeg's copy holds that sound and no frame to reframe.
  ffmpeg(["-i", path.join(dir, "sound-first-cut.mp4"), "-c", "copy", path.join(dir, "sound-first-copy.mkv")]);
  const copied = cli(["sound-first-copy.mkv", "--for", "180x320", "--plan", "--out", "sound-first-copy-plan"], { cwd: dir });
  assert.equal(copied.status, 1, copied.stdout);
  assert.match(copied.stderr, /has no frame ffmpeg could decode|s of picture under [\d.]+ s of sound|has no video stream|still picture/);
});

test("the copies SKILL.md says to make, of a recording cut short and of a video ffmpeg crashed on, are made as written and reframe, also of what ffmpeg copies into no MP4, as an editor's ProRes with PCM sound", () => {
  const mov = path.join(dir, "pro.mov");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=f=330:r=48000:d=3", "-c:v", "prores_ks", "-profile:v", "0", "-c:a", "pcm_s24le", "-movflags", "+faststart", mov]);
  const bytes = fs.readFileSync(mov);
  fs.writeFileSync(path.join(dir, "pro-cut.mov"), bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  const refused = cli(["pro-cut.mov", "--for", "180x320", "--plan", "--out", "pro-cut-plan"], { cwd: dir });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`^reframekit: Cannot read pro-cut\\.mov: it is cut short, its media \\(the mdat box\\) running \\d+ KB past its end${REMEDY}$`, "m"));
  const skill = fs.readFileSync(path.join(__dirname, "../skills/reframekit/SKILL.md"), "utf8");
  const commands = [/`(ffmpeg -i <video> -c copy (whole\.\w+))` makes; reframe (\S+)\./, /`(ffmpeg -i <video> -c copy (copy\.\w+))`\), and reframe (\S+)\./].map((pattern) => pattern.exec(skill));
  for (const [[, command, made, reframed], video] of [[commands[0], "pro-cut.mov"], [commands[1], "pro.mov"]]) {
    assert.equal(reframed, made, command);
    const words = command.split(" ").map((w) => (w === "<video>" ? video : w));
    const copy = spawnSync(words[0], ["-v", "error", "-y", ...words.slice(1)], { cwd: dir, encoding: "utf8" });
    assert.equal(copy.status, 0, `${command}: ${copy.stderr}`);
    const plan = cli([made, "--for", "180x320", "--plan", "--out", `${made}-plan`], { cwd: dir });
    assert.equal(plan.status, 0, `${command}: ${plan.stderr}`);
  }
});

test("a file cut where its index ends and before its media starts, or a fragmented one of more than a thousand boxes cut near its end, fails the check too", () => {
  const out = outDir("checked-moov-end");
  assert.equal(cli([fixture("twoShots"), "--for", "tiktok", "--out", out]).status, 0);
  const whole = fs.readFileSync(path.join(out, "tiktok.mp4"));
  // Its boxes: ftyp, moov, free, then mdat. A copy that stopped at the
  // end of moov, at the end of free, or 4 or 7 bytes into mdat's header
  // keeps the whole index, which ffprobe reads, and none of the media.
  const tops = [];
  for (let at = 0; at + 8 <= whole.length; at += whole.readUInt32BE(at)) tops.push([whole.toString("latin1", at + 4, at + 8), at]);
  const start = (type) => tops.find(([t]) => t === type)[1];
  assert.deepEqual(tops.map(([t]) => t), ["ftyp", "moov", "free", "mdat"]);
  const copy = outDir("checked-moov-end-copy");
  fs.mkdirSync(copy);
  for (const name of fs.readdirSync(out)) fs.copyFileSync(path.join(out, name), path.join(copy, name));
  for (const at of [start("free"), start("mdat"), start("mdat") + 4, start("mdat") + 7]) {
    fs.writeFileSync(path.join(copy, "tiktok.mp4"), whole.subarray(0, at));
    const run = cli(["check", copy, "--json"]);
    assert.equal(run.status, 1, `${at}: ${run.stdout}`);
    const cut = JSON.parse(run.stdout).results[0].checks.find((c) => c.name === "file");
    assert.ok(cut, `${at}: no file row`);
    assert.equal(cut.found, "cut short, its media (the mdat box) missing", `${at}: ${cut.found}`);
  }
  // A fragmented MP4 of a fragment for each frame, 2 boxes each, and the
  // index of its fragments (mfra) last, as ffmpeg writes one: cut inside
  // the media of its last fragment, inside that index, and after the
  // index of its last fragment, whose media is then gone.
  const frag = path.join(dir, "fragmented.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=64x64:r=30:d=20", "-c:v", "libx264", "-preset", "ultrafast", "-g", "1", "-pix_fmt", "yuv420p", "-movflags", "+frag_keyframe+empty_moov", frag]);
  const bytes = fs.readFileSync(frag);
  const lay = layoutOf(frag);
  assert.equal(lay.cut, null);
  assert.ok(lay.count > 1000, `${lay.count} boxes`);
  const boxes = [];
  for (let at = 0; at + 8 <= bytes.length; at += bytes.readUInt32BE(at)) boxes.push([bytes.toString("latin1", at + 4, at + 8), at, at + bytes.readUInt32BE(at)]);
  const lastOf = (type) => boxes.filter(([t]) => t === type).pop();
  assert.equal(boxes[boxes.length - 1][0], "mfra");
  const checked = (name, cut) => {
    const file = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(file, bytes.subarray(0, cut));
    const r = cli(["check", file, "--for", "square", "--out", outDir(`${name}-check`), "--json"]);
    assert.equal(r.status, 1, `${name}: ${r.stdout}`);
    const row = JSON.parse(r.stdout).results[0].checks.find((c) => c.name === "file");
    return row ? row.found : "no file row";
  };
  assert.match(checked("fragmented-media-cut", lastOf("mdat")[1] + 20), /^cut short, its media \(the mdat box\) running \d+ (KB|bytes) past its end$/);
  assert.match(checked("fragmented-index-cut", bytes.length - 20), /^cut short, the index of its fragments \(the mfra box\) running 20 bytes past its end$/);
  const noMedia = path.join(dir, "fragmented-no-media.mp4");
  fs.writeFileSync(noMedia, bytes.subarray(0, lastOf("moof")[2]));
  assert.deepEqual(layoutOf(noMedia).cut, { box: "mdat", missing: true, fragment: true, lost: true });
  const nm = cli(["check", noMedia, "--for", "square", "--out", outDir("fragmented-no-media-check")]);
  assert.match(nm.stdout, /^ {2}fail {2}fragmented-no-media\.mp4 for Square: file cut short, the media of its last fragment \(an mdat box\) missing \(asked for the whole file\)$/m);
  // A whole file is whole, a fragmented one too. One cut 4 bytes into the
  // header of the box after a fragment's index, its media, is cut short,
  // and that fragment's media lost; one cut 4 bytes into the header of the
  // box after a fragment's media, the index of its fragments, is cut short
  // with every fragment whole. Bytes after the index of its fragments,
  // where nothing comes, are bytes after its last box.
  assert.equal(layoutOf(path.join(out, "tiktok.mp4")).cut, null);
  const cutAt = (name, at) => {
    const file = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(file, bytes.subarray(0, at));
    return layoutOf(file);
  };
  assert.deepEqual(cutAt("fragment-header-cut", lastOf("mdat")[1] + 4).cut, { box: null, header: true, lost: true });
  assert.deepEqual(cutAt("fragments-index-header-cut", lastOf("mfra")[1] + 4).cut, { box: null, header: true, lost: false });
  const tail = path.join(dir, "tail-cut.mp4");
  fs.writeFileSync(tail, Buffer.concat([bytes, Buffer.from([0, 0])]));
  assert.deepEqual([layoutOf(tail).cut, layoutOf(tail).stray], [null, 2]);
  // A file of more boxes than are read is said to be read only so far.
  const { checkFile } = require("../skills/reframekit/scripts/lib/check");
  const { placeFor } = require("../skills/reframekit/scripts/lib/places");
  const rows = checkFile(frag, placeFor("square"), { layout: { ...lay, partial: true } });
  assert.deepEqual(rows.find((c) => c.name === "MP4 layout"), { name: "MP4 layout", status: "warn", expected: "every box read", found: "read as far as its first 1,000,000 boxes, so a cut after them is not seen", source: null });
});

test("a whole MP4 followed by a few bytes that make no box, as the line break a broken upload leaves, is reframed, and its check passes with a warning", () => {
  // A plain MP4, a fragmented one that ends with the index of its
  // fragments (mfra), and one that ends with the media of its last
  // fragment, as a recorder that writes its fragments as it goes leaves
  // one.
  const bases = { plain: fixture("twoShots") };
  for (const [name, flags] of [["fragmented", "+frag_keyframe+empty_moov"], ["fragmented-open", "+frag_keyframe+empty_moov+skip_trailer"]]) {
    bases[name] = path.join(dir, `stray-base-${name}.mp4`);
    ffmpeg(["-i", fixture("twoShots"), "-c", "copy", "-movflags", flags, bases[name]]);
  }
  assert.equal(layoutOf(bases.fragmented).boxes.pop(), "mfra");
  assert.equal(layoutOf(bases["fragmented-open"]).boxes.pop(), "mdat");
  const extras = {
    crlf: Buffer.from("\r\n"),
    abc: Buffer.from("abc"),
    zeros: Buffer.alloc(8),
    "four-zeros": Buffer.alloc(4),
    text: Buffer.from("hello world\n"),
  };
  // Each of them followed by each of those is whole, with bytes after its
  // last box; a few are planned and checked.
  const runs = new Set(["plain-crlf", "plain-abc", "plain-zeros", "fragmented-open-crlf", "fragmented-open-text"]);
  for (const [base, file] of Object.entries(bases)) {
    const whole = fs.readFileSync(file);
    assert.deepEqual([layoutOf(file).cut, layoutOf(file).stray], [null, 0], base);
    for (const [kind, extra] of Object.entries(extras)) {
      const name = `${base}-${kind}`;
      const stray = path.join(dir, `stray-${name}.mp4`);
      fs.writeFileSync(stray, Buffer.concat([whole, extra]));
      const lay = layoutOf(stray);
      assert.deepEqual([lay.cut, lay.stray], [null, extra.length], name);
      if (!runs.has(name)) continue;
      const plan = cli([stray, "--for", "180x320", "--plan", "--out", outDir(`stray-${name}`)]);
      assert.equal(plan.status, 0, `${name}: ${plan.stderr}`);
      const r = cli(["check", stray, "--for", "youtube", "--out", outDir(`stray-${name}-check`), "--json"]);
      assert.equal(r.status, 0, `${name}: ${r.stdout}`);
      const row = JSON.parse(r.stdout).results[0].checks.find((c) => c.name === "file");
      assert.deepEqual(row, { name: "file", status: "warn", expected: "nothing after its last box", found: `${extra.length} bytes after its last box`, source: null }, name);
    }
  }
  // After the media of a fragment, bytes that can start the header of the
  // index of a next fragment, a size under 16 MB, are a cut there: one or
  // two zero bytes, a size of 16 and two letters of a type, a size in 64
  // bits. Its media is all there, so a run takes it.
  const open = fs.readFileSync(bases["fragmented-open"]);
  for (const [kind, extra] of [["one-zero", Buffer.alloc(1)], ["two-zeros", Buffer.alloc(2)], ["size", Buffer.from([0, 0, 0, 16, 0x6d, 0x6f])], ["wide-size", Buffer.from([0, 0, 0, 1, 0x6d, 0x6f, 0x6f, 0x66])]]) {
    const file = path.join(dir, `next-fragment-${kind}.mp4`);
    fs.writeFileSync(file, Buffer.concat([open, extra]));
    assert.deepEqual([layoutOf(file).cut, layoutOf(file).stray], [{ box: null, header: true, lost: false }, 0], kind);
  }
  const r = cli(["check", path.join(dir, "next-fragment-two-zeros.mp4"), "--for", "youtube", "--out", outDir("next-fragment-check")]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^ {2}fail {2}next-fragment-two-zeros\.mp4 for YouTube: file cut short in the header of its last box \(asked for the whole file\)$/m);
});

test("a fragmented MP4 cut only in the index of its fragments at its end, or where its next fragment starts, is reframed, as all its media is there; one cut inside a fragment is refused with how to keep the part that is there, and that part reframes", () => {
  // A fragment every half second, as a recording made to survive a crash
  // writes them, and the index of its fragments (mfra) last.
  const frag = path.join(dir, "fragmented-run.mp4");
  ffmpeg(["-i", fixture("twoShots"), "-c:v", "libx264", "-preset", "ultrafast", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+frag_keyframe+empty_moov", frag]);
  const bytes = fs.readFileSync(frag);
  const boxes = [];
  for (let at = 0; at + 8 <= bytes.length; at += bytes.readUInt32BE(at)) boxes.push([bytes.toString("latin1", at + 4, at + 8), at]);
  const lastOf = (type) => boxes.filter(([t]) => t === type).pop()[1];
  assert.ok(boxes.filter(([t]) => t === "moof").length > 4, boxes.map(([t]) => t).join(" "));
  const planned = (name, at) => {
    const file = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(file, bytes.subarray(0, at));
    return cli([`${name}.mp4`, "--for", "180x320", "--plan", "--out", `${name}-plan`, "--json"], { cwd: dir });
  };
  for (const [name, at] of [["fragments-index-cut", bytes.length - 20], ["fragments-index-header", lastOf("mfra") + 4]]) {
    const r = planned(name, at);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.ok(Math.abs(JSON.parse(r.stdout).duration - 4) < 0.1, `${name}: ${JSON.parse(r.stdout).duration} s`);
  }
  const cut = planned("fragment-cut", lastOf("mdat") + 200);
  assert.equal(cut.status, 1);
  assert.match(cut.stderr, new RegExp(`^reframekit: Cannot read fragment-cut\\.mp4: it is cut short, its media \\(the mdat box\\) running \\d+ KB past its end${REMEDY}$`, "m"));
  // Cut after the index of its first fragment, it holds none of its media,
  // and cut inside the first frame of that fragment's picture, not even
  // that frame whole.
  const firstMoof = boxes.find(([t]) => t === "moof")[1];
  const none = planned("first-fragment-cut", firstMoof + bytes.readUInt32BE(firstMoof));
  assert.equal(none.status, 1);
  assert.match(none.stderr, new RegExp(`^reframekit: Cannot read first-fragment-cut\\.mp4: it is cut short, the media of its last fragment \\(an mdat box\\) missing${NONE}$`, "m"));
  const inFrame = planned("first-fragment-frame-cut", firstFrameEnd(frag) - 1);
  assert.equal(inFrame.status, 1);
  assert.match(inFrame.stderr, new RegExp(`^reframekit: Cannot read first-fragment-frame-cut\\.mp4: it is cut short, its media \\(the mdat box\\) running \\d+ KB past its end${FRAME}$`, "m"));
  assert.ok(!fs.existsSync(path.join(dir, "fragment-cut-plan")));
  // ffmpeg's copy of the part that is there is a whole file.
  ffmpeg(["-i", path.join(dir, "fragment-cut.mp4"), "-c", "copy", path.join(dir, "fragment-cut-whole.mp4")]);
  assert.equal(cli(["fragment-cut-whole.mp4", "--for", "180x320", "--plan", "--out", "fragment-cut-whole-plan"], { cwd: dir }).status, 0);
});

test("an MP4 whose tables claim four billion samples a track is read in step with its size, so a check and a run of it end at once", () => {
  // As a 20 KB file a sweep of MP4s found: forty tracks of one chunk each,
  // whose tables claim 2^32 - 1 samples a track, of one size given once,
  // or of sizes given one each of which only one is there.
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, body]);
  };
  const u32 = (...ns) => {
    const b = Buffer.alloc(4 * ns.length);
    ns.forEach((n, i) => b.writeUInt32BE(n >>> 0, 4 * i));
    return b;
  };
  const many = 0xffffffff;
  const trak = (stsz) => box("trak", box("mdia", box("minf", box("stbl", stsz, box("stsc", u32(0, 1, 1, many, 1)), box("stco", u32(0, 1, 0))))));
  // ffprobe reads the first, which lists media four billion bytes past its
  // end and no picture, and not the second, whose index the walk then reads
  // to say why.
  const cases = [
    ["claims-one-size", box("stsz", u32(0, 1, many)), [["container", "pass"], ["file", "fail"], ["picture", "fail"]], /square\.mp4 has no video stream$/m],
    ["claims-each-size", box("stsz", u32(0, 0, many, 1)), [["file", "fail"]], /Cannot read .*square\.mp4: ffmpeg cannot read its index \(the moov box\)$/m],
  ];
  for (const [name, stsz, rows, said] of cases) {
    const folder = outDir(name);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "square.mp4"), Buffer.concat([box("ftyp", Buffer.from("isom"), u32(512), Buffer.from("isomiso2")), box("moov", ...Array.from({ length: 40 }, () => trak(stsz))), box("mdat", Buffer.alloc(16))]));
    fs.writeFileSync(path.join(folder, "formats.json"), JSON.stringify({ reframekit: "0.1.0", files: [{ file: "square.mp4", place: "square" }] }));
    for (const args of [["check", folder, "--json"], [path.join(folder, "square.mp4"), "--for", "square", "--plan", "--out", outDir(`${name}-plan`)]]) {
      const started = Date.now();
      // SIGKILL: a run in such a loop hears no SIGTERM.
      const r = cli(args, { timeout: 30_000, killSignal: "SIGKILL" });
      assert.equal(r.error, undefined, `${name} ${args[0]}: still reading after 30 s`);
      assert.ok(Date.now() - started < 10_000, `${name} ${args[0]}: ${Date.now() - started} ms`);
      assert.equal(r.status, 1, `${name} ${args[0]}: ${r.stdout}${r.stderr}`);
      if (args[0] === "check") assert.deepEqual(JSON.parse(r.stdout).results[0].checks.map((c) => [c.name, c.status]), rows, name);
      else assert.match(r.stderr, said, name);
    }
  }
});

test("a file whose description from ffprobe runs over 64 MB, as one with a title that large, is refused by name, and fails its own row of a folder's check while the others are measured", () => {
  // A title of 11.3 million bytes of 0x01, each of which ffprobe's JSON
  // writes as six characters: 68 MB of description of an 11 MB file.
  const meta = path.join(dir, "large-title.txt");
  fs.writeFileSync(meta, Buffer.concat([Buffer.from(";FFMETADATA1\ntitle="), Buffer.alloc(11_300_000, 1), Buffer.from("\n")]));
  const large = path.join(dir, "large-title.mp4");
  ffmpeg(["-i", fixture("twoShots"), "-f", "ffmetadata", "-i", meta, "-map", "0", "-map_metadata", "1", "-c", "copy", large]);
  const said = "ffprobe's description of it runs over 64 MB, as for a file whose tags are that large";
  for (const args of [["large-title.mp4", "--for", "180x320", "--plan", "--out", "large-title-plan"], ["check", "large-title.mp4", "--for", "reels"]]) {
    const r = cli(args, { cwd: dir });
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.stderr, `reframekit: Cannot read large-title.mp4: ${said}\n`, args[0]);
  }
  assert.ok(!fs.existsSync(path.join(dir, "large-title-plan")));
  const out = outDir("large-title-folder");
  assert.equal(cli([fixture("twoShots"), "--for", "180x320,180x180", "--out", out]).status, 0);
  fs.copyFileSync(large, path.join(out, "180x180.mp4"));
  const check = cli(["check", out]);
  assert.equal(check.status, 1, check.stdout + check.stderr);
  const json = JSON.parse(fs.readFileSync(path.join(out, "check.json"), "utf8"));
  assert.deepEqual(json.results.map((x) => [x.file, x.pass, x.checks.length > 1]), [["180x320.mp4", true, true], ["180x180.mp4", false, false]]);
  assert.equal(json.results[1].checks[0].found, `cannot be read: ${said}`);
});

test("a check of a folder's formats.json kept in reframekit-check-formats inside it, as an agent's tool places it, goes when the files are made again", () => {
  const out = outDir("kit-check");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--out", out]).status, 0);
  const checks = path.join(out, "reframekit-check-formats");
  assert.equal(cli(["check", path.join(out, "formats.json"), "--out", checks]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(checks, "check.json"), "utf8")).checked, "../formats.json");
  // A plan leaves the rendered files, so their check still holds.
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]).status, 0);
  assert.ok(fs.existsSync(path.join(checks, "CHECK.md")));
  const again = cli([fixture("twoShots"), "--for", "360x640", "--out", out]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Removed from the earlier run: reframekit-check-formats/);
  assert.ok(!fs.existsSync(checks));
  assert.match(fs.readFileSync(path.join(out, "FORMATS.md"), "utf8"), /Removed from the earlier run in this folder: reframekit-check-formats \(its check was of the files made before this run; run reframekit check again\)/);
  // With a file of someone's in it, the folder stays.
  assert.equal(cli(["check", path.join(out, "formats.json"), "--out", checks]).status, 0);
  fs.writeFileSync(path.join(checks, "notes.txt"), "mine");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--out", out]).status, 0);
  assert.equal(fs.readFileSync(path.join(checks, "notes.txt"), "utf8"), "mine");
});

test("the check of one file of a run, in reframekit-check-<name> inside its folder, goes when that file is made again and stays while it is kept", () => {
  const out = outDir("one-file-check");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640,480x480", "--out", out]).status, 0);
  const tall = cli(["check", path.join(out, "360x640.mp4"), "--for", "360x640"]);
  assert.equal(tall.status, 0, tall.stderr);
  const checks = path.join(out, "reframekit-check-360x640");
  assert.equal(JSON.parse(fs.readFileSync(path.join(checks, "check.json"), "utf8")).checked, "../360x640.mp4");
  // A render of the other place keeps 360x640.mp4, so its check holds.
  assert.equal(cli([fixture("twoShots"), "--for", "480x480", "--out", out]).status, 0);
  assert.ok(fs.existsSync(path.join(checks, "CHECK.md")));
  const again = cli([fixture("twoShots"), "--for", "360x640", "--lufs", "-16", "--out", out]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Removed from the earlier run: reframekit-check-360x640/);
  assert.ok(!fs.existsSync(checks));
  assert.match(fs.readFileSync(path.join(out, "FORMATS.md"), "utf8"), /reframekit-check-360x640 \(its check was of the files made before this run; run reframekit check again\)/);
});

test("a 16:9 file is not a Short, and a file of 141 s is too long for X", () => {
  const wide = fixture("twoShots");
  const shorts = cli(["check", wide, "--for", "shorts", "--out", outDir("check-shorts")]);
  assert.equal(shorts.status, 1);
  assert.match(shorts.stdout, /fail\s+twoShots\.mp4 for YouTube Shorts: shape 16:9 \(asked for square or vertical\)/);
  assert.ok(fs.existsSync(path.join(outDir("check-shorts"), "CHECK.md")));
  const long = path.join(dir, "long.mp4");
  ffmpeg(["-f", "lavfi", "-i", "color=c=gray:s=320x180:r=5:d=141", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", long]);
  const x = cli(["check", long, "--for", "x", "--json"]);
  assert.equal(x.status, 1);
  const r = JSON.parse(x.stdout).results[0];
  assert.equal(r.checks.find((c) => c.name === "length").status, "fail");
  // Without --for, a lone file is checked against the places of its shape.
  const all = JSON.parse(cli(["check", wide, "--json"]).stdout);
  assert.deepEqual(all.results.map((x) => x.place), ["youtube", "x", "linkedin"]);
});

test("the index at the end and an edit list fail for Reels and only warn for YouTube", () => {
  const plain = path.join(dir, "plain.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=4", "-f", "lavfi", "-i", "sine=d=4", ...ENCODE, ...SOUND, "-shortest", plain]);
  const lay = layoutOf(plain);
  assert.equal(lay.faststart, false);
  assert.ok(lay.shiftingEdits >= 1, JSON.stringify(lay));
  const reels = JSON.parse(cli(["check", plain, "--for", "reels,shorts", "--json"]).stdout);
  const status = (place, name) => reels.results.find((r) => r.place === place).checks.find((c) => c.name === name).status;
  assert.equal(status("reels", "index first"), "fail");
  assert.equal(status("reels", "edit lists"), "fail");
  assert.equal(status("shorts", "index first"), "warn");
  assert.equal(status("shorts", "edit lists"), "warn");
});

test("an MP4 whose boxes nest forty thousand deep, or whose edit list is too short for its count, is checked like any other", () => {
  // A valid MP4 with a moov box of its own after it, which ffprobe passes
  // over and the layout reader reads.
  const crafted = (name, moov) => {
    const file = path.join(dir, name);
    const box = Buffer.alloc(8);
    box.writeUInt32BE(8 + moov.length, 0);
    box.write("moov", 4, "latin1");
    fs.writeFileSync(file, Buffer.concat([fs.readFileSync(fixture("twoShots")), box, moov]));
    return file;
  };
  const deep = Buffer.alloc(40_000 * 8);
  for (let i = 0; i < 40_000; i++) deep.write("trak", i * 8 + 4, "latin1");
  // moov > trak > edts > an elst box of its header alone.
  const short = Buffer.from("000000187472616b000000106564747300000008656c7374", "hex");
  for (const file of [crafted("nested.mp4", deep), crafted("short-elst.mp4", short)]) {
    const lay = layoutOf(file);
    assert.ok(lay && lay.boxes.includes("moov"), `${path.basename(file)}: ${JSON.stringify(lay)}`);
    const r = cli(["check", file, "--for", "reels", "--out", path.join(dir, `check-${path.basename(file)}`)]);
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    assert.doesNotMatch(r.stderr, /call stack|out of range/);
    assert.ok(fs.existsSync(path.join(dir, `check-${path.basename(file)}`, "CHECK.md")), r.stderr);
  }
  const lay = layoutOf(path.join(dir, "short-elst.mp4"));
  assert.deepEqual([lay.editLists, lay.shiftingEdits], [1, 0], "an edit list with no entries skips nothing");
});

test("captions burned near the bottom fail a 9:16 place's safe area; centered ones pass; an SRT cannot say", () => {
  const out = outDir("captioned");
  assert.equal(cli([fixture("twoShots"), "--for", "tiktok,reels", "--out", out]).status, 0);
  const ass = (lines) => `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Inter,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,80,80,120,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.join("\n")}\n`;
  const low = path.join(dir, "low.ass");
  fs.writeFileSync(low, ass(["Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,Down by the buttons", "Dialogue: 0,0:00:02.00,0:00:03.50,Default,,0,0,0,,{\\an5\\pos(540,900)}In the middle"]));
  const bad = cli(["check", out, "--captions", low, "--json"]);
  assert.equal(bad.status, 1);
  const r = JSON.parse(bad.stdout);
  for (const x of r.results) {
    const c = x.checks.find((y) => y.name === "captions in the safe area");
    assert.equal(c.status, "fail");
    assert.equal(x.outside.length, 1);
    assert.deepEqual(x.outside[0].sides, ["bottom"]);
  }
  assert.match(r.results.find((x) => x.place === "tiktok").checks.find((c) => c.name === "captions in the safe area").expected, /standing in: TikTok publishes none/);
  const good = path.join(dir, "good.ass");
  fs.writeFileSync(good, ass(["Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,{\\an5\\pos(540,1000)}Clear of everything"]));
  assert.equal(cli(["check", out, "--captions", good]).status, 0);
  const srt = path.join(dir, "words.srt");
  fs.writeFileSync(srt, "1\n00:00:00,500 --> 00:00:02,000\nHello\n\n2\n00:00:02,000 --> 00:00:05,000\nPast the end\n");
  const s = JSON.parse(cli(["check", out, "--captions", srt, "--json"]).stdout);
  const checks = s.results[0].checks;
  assert.equal(checks.find((c) => c.name === "captions in the safe area").status, "info");
  assert.equal(checks.find((c) => c.name === "captions in time").status, "warn");
  // CHECK.md says what was measured of each kind: an ASS file's timing
  // and place, an SRT or WebVTT file's timing only.
  assert.equal(cli(["check", out, "--captions", good]).status, 0);
  assert.match(fs.readFileSync(path.join(out, "CHECK.md"), "utf8"), /pages state them, and good\.ass for its timing and, for each 9:16 place, against its safe area\./);
  const vtt = path.join(dir, "words.vtt");
  fs.writeFileSync(vtt, "WEBVTT\n\n00:00.500 --> 00:02.000\nHello\n");
  assert.equal(cli(["check", out, "--captions", vtt]).status, 0);
  const md = fs.readFileSync(path.join(out, "CHECK.md"), "utf8");
  assert.match(md, /pages state them, and the timing of words\.vtt\./);
  assert.match(md, /\| captions in the safe area \| info \| {2}\| a WebVTT file does not say where its text sits/);
  cli(["check", out, "--captions", srt]);
  assert.match(fs.readFileSync(path.join(out, "CHECK.md"), "utf8"), /\| an SRT file does not say where its text sits/);
});

test("caption boxes are read from ASS styles, override tags and line breaks", () => {
  const file = path.join(dir, "boxes.ass");
  fs.writeFileSync(file, "[Script Info]\nPlayResX: 1000\nPlayResY: 1000\n[V4+ Styles]\nFormat: Name, Fontsize, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\nStyle: Default,50,0,0,8,100,100,50\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,ten chars!\\Nline two\nDialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,{\\an1\\pos(10,990)\\fs20}x\nDialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100\nDialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\an5\\pos(500,500)}字幕です\n");
  const c = readCaptions(file);
  assert.equal(c.cues.length, 3);
  const [top, corner, wide] = c.cues;
  // Four characters of Japanese, each a whole size wide.
  assert.ok(Math.abs(wide.box.w - 0.2) < 0.001, JSON.stringify(wide.box));
  // Top center: 10 characters at 0.55 of 50 px, two lines of 1.25 x 50.
  assert.ok(Math.abs(top.box.w - 0.275) < 0.001 && Math.abs(top.box.h - 0.125) < 0.001, JSON.stringify(top.box));
  assert.ok(Math.abs(top.box.y - 0.05) < 0.001 && Math.abs(top.box.x - 0.3625) < 0.001, JSON.stringify(top.box));
  assert.ok(Math.abs(corner.box.x - 0.01) < 0.001 && Math.abs(corner.box.y + corner.box.h - 0.99) < 0.001, JSON.stringify(corner.box));
});

test("a line styled as what every object has, as constructor or toString, is measured in Default's style, as libass draws a style it does not know, and a style named __proto__ is one like any other", () => {
  // Styles by name, size, alignment and vertical margin; each line has the
  // same words at the middle of a 1080x1920 frame.
  const ass = (name, styles, lines) => {
    const file = path.join(dir, name);
    const style = ([n, size, align, marginV]) => `Style: ${n},Arial,${size},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,4,0,${align},40,40,${marginV},1`;
    const line = (s, i) => `Dialogue: 0,0:00:0${i}.00,0:00:0${i + 1}.00,${s},,0,0,0,,{\\pos(540,960)}Ship it to every feed today`;
    fs.writeFileSync(file, `[Script Info]\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${styles.map(style).join("\n")}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.map(line).join("\n")}\n`);
    return file;
  };
  // Default is large, so its line runs past both sides of a 9:16 frame.
  const unknown = ["Missing", "constructor", "toString", "valueOf", "hasOwnProperty"];
  const named = ass("styles-named.ass", [["Default", 120, 5, 40]], unknown);
  assert.deepEqual(readCaptions(named).cues.map((c) => [c.size, c.align, c.marginV]), unknown.map(() => [120, 5, 40]));
  // A script whose one style is named __proto__ draws every line in it.
  const proto = ass("styles-proto.ass", [["__proto__", 30, 8, 400]], ["__proto__", "Missing"]);
  assert.deepEqual(readCaptions(proto).cues.map((c) => [c.size, c.align, c.marginV]), [[30, 8, 400], [30, 8, 400]]);
  // So the check fails a line styled constructor as it fails one styled
  // Missing.
  const tall = path.join(dir, "styles-tall.mp4");
  ffmpeg(["-f", "lavfi", "-i", "color=c=0x203040:s=180x320:r=30:d=5", ...ENCODE, tall]);
  for (const s of ["Missing", "constructor"]) {
    const file = ass(`styles-${s}.ass`, [["Default", 120, 5, 40]], [s]);
    const r = cli(["check", tall, "--for", "tiktok", "--captions", file, "--out", outDir(`styles-${s}-check`)]);
    assert.equal(r.status, 1, `${s}: ${r.stdout}`);
    assert.ok(r.stdout.split("\n").includes("  fail  styles-tall.mp4 for TikTok: captions in the safe area 1 of 1 reach into the left, right margin, by an estimate from the ASS styles that errs wide (asked for clear of the top 14%, bottom 35% and sides 6% (Meta's margins for Reels, standing in: TikTok publishes none))"), `${s}: ${r.stdout}`);
  }
});

test("an ASS file whose [Events] Format line has no Text, Start or End is refused with what it lacks", () => {
  const ass = (format, dialogue) => {
    const file = path.join(dir, `format-${format.replace(/\W+/g, "-")}.ass`);
    fs.writeFileSync(file, `[Script Info]\nPlayResX: 384\nPlayResY: 288\n\n[Events]\nFormat: ${format}\nDialogue: ${dialogue}\n`);
    return file;
  };
  const notext = ass("Layer, Start, End, Style", "0,0:00:00.50,0:00:02.00,Default");
  assert.throws(() => readCaptions(notext), (err) => err.message === `${notext} has no Text in its [Events] Format line, so its captions cannot be read`);
  assert.throws(() => readCaptions(ass("Layer, Style, Text", "0,Default,Hello")), /has no Start and End in its \[Events\] Format line/);
  // Names in any letters, as libass reads them.
  assert.equal(readCaptions(ass("layer, start, end, style, text", "0,0:00:00.50,0:00:02.00,Default,Hello")).cues.length, 1);
  const r = cli(["check", fixture("twoShots"), "--for", "youtube", "--captions", notext, "--out", outDir("notext-check")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no Text in its \[Events\] Format line, so its captions cannot be read\n$/);
  assert.doesNotMatch(r.stderr, /TypeError|Cannot read properties/);
});

test("a caption that wraps into two even rows inside the safe area passes, as libass draws it, and one too low fails at the bottom only", () => {
  const { checkCaptions } = require("../skills/reframekit/scripts/lib/check");
  const { placeFor } = require("../skills/reframekit/scripts/lib/places");
  // An SRT turned into ASS by ffmpeg: PlayRes 384x288, Arial 16, margins
  // of 10. On a 1080x1920 frame libass draws the long line in two rows.
  const srt = path.join(dir, "two-rows.srt");
  fs.writeFileSync(srt, "1\n00:00:00,500 --> 00:00:02,500\nThis line is a bit longer than most\n\n2\n00:00:02,600 --> 00:00:04,000\nShort one\n");
  const stock = path.join(dir, "two-rows.ass");
  ffmpeg(["-i", srt, stock]);
  const raised = path.join(dir, "two-rows-up.ass");
  fs.writeFileSync(raised, fs.readFileSync(stock, "utf8").replace(/^(Style: Default,.*),10,10,10,(\d+)$/m, "$1,10,10,110,$2"));
  assert.notEqual(fs.readFileSync(raised, "utf8"), fs.readFileSync(stock, "utf8"));
  const frame = { width: 1080, height: 1920 };
  const up = checkCaptions(readCaptions(raised), placeFor("reels"), 4, frame);
  assert.deepEqual(up.outside, []);
  assert.equal(up.rows.find((r) => r.name === "captions in the safe area").status, "pass");
  const low = checkCaptions(readCaptions(stock), placeFor("reels"), 4, frame);
  assert.deepEqual(low.outside.map((o) => o.sides), [["bottom"], ["bottom"]]);
  assert.match(low.rows.find((r) => r.name === "captions in the safe area").found, /reach into the bottom margin, by an estimate from the ASS styles that errs wide/);
});

test("a lone MP4's check writes to a folder of its own, and never replaces a report reframekit did not write", () => {
  const user = path.join(dir, "userfolder");
  fs.mkdirSync(user, { recursive: true });
  fs.copyFileSync(fixture("twoShots"), path.join(user, "clip.mp4"));
  fs.writeFileSync(path.join(user, "CHECK.md"), "# My release checklist\n");
  fs.writeFileSync(path.join(user, "check.json"), '{"mine": true}\n');
  const run = cli(["check", path.join(user, "clip.mp4"), "--for", "youtube"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /reframekit-check-clip/);
  assert.ok(fs.existsSync(path.join(user, "reframekit-check-clip", "CHECK.md")));
  assert.equal(fs.readFileSync(path.join(user, "CHECK.md"), "utf8"), "# My release checklist\n");
  assert.equal(fs.readFileSync(path.join(user, "check.json"), "utf8"), '{"mine": true}\n');
  const into = cli(["check", path.join(user, "clip.mp4"), "--for", "youtube", "--out", user]);
  assert.equal(into.status, 1);
  assert.match(into.stderr, /(CHECK\.md|check\.json) is not a report reframekit wrote/);
  assert.equal(fs.readFileSync(path.join(user, "check.json"), "utf8"), '{"mine": true}\n');
  // A CHECK.md that is a link: the report replaces the link, not the file
  // it points at.
  const own = path.join(user, "reframekit-check-clip");
  const outside = path.join(dir, "outside.txt");
  fs.writeFileSync(outside, "keep me\n");
  fs.rmSync(path.join(own, "CHECK.md"));
  fs.symlinkSync(outside, path.join(own, "CHECK.md"));
  const linked = cli(["check", path.join(user, "clip.mp4"), "--for", "youtube"]);
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /CHECK\.md is not a report reframekit wrote/);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep me\n");
});

test("a lone clip.mov checked after a clip.mp4 of the same folder gets a folder of its own for its reports", () => {
  const here = path.join(dir, "two-clips");
  fs.mkdirSync(here, { recursive: true });
  fs.copyFileSync(fixture("twoShots"), path.join(here, "clip.mp4"));
  ffmpeg(["-i", fixture("twoShots"), "-c", "copy", path.join(here, "clip.mov")]);
  assert.equal(cli(["check", "clip.mp4", "--for", "youtube"], { cwd: here }).status, 0);
  const mov = cli(["check", "clip.mov", "--for", "youtube"], { cwd: here });
  assert.equal(mov.status, 0, mov.stdout + mov.stderr);
  assert.match(mov.stdout, /reframekit-check-clip-2/);
  const report = (name) => JSON.parse(fs.readFileSync(path.join(here, name, "check.json"), "utf8"));
  assert.deepEqual([report("reframekit-check-clip").checked, report("reframekit-check-clip-2").checked], ["../clip.mp4", "../clip.mov"]);
  // Each finds its own folder again.
  assert.match(cli(["check", "clip.mp4", "--for", "youtube"], { cwd: here }).stdout, /reframekit-check-clip\/CHECK\.md/);
  // With --out, as an agent's tool gives one folder by the name, the check
  // of clip.mov stops instead of replacing that of clip.mp4.
  assert.equal(cli(["check", "clip.mp4", "--for", "youtube", "--out", "checks"], { cwd: here }).status, 0);
  const before = fs.readFileSync(path.join(here, "checks", "CHECK.md"), "utf8");
  const refused = cli(["check", "clip.mov", "--for", "youtube", "--out", "checks"], { cwd: here });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^reframekit: checks holds the check of clip\.mp4, not of clip\.mov\. Give --out another folder\.$/m);
  assert.equal(fs.readFileSync(path.join(here, "checks", "CHECK.md"), "utf8"), before);
  assert.equal(report("checks").checked, "../clip.mp4");
  assert.equal(cli(["check", "clip.mp4", "--for", "youtube", "--out", "checks"], { cwd: here }).status, 0);
});

test("a check that cannot write its reports says so before measuring, and how to send them elsewhere", { skip: process.getuid && process.getuid() === 0 }, () => {
  const card = path.join(dir, "camera-card");
  fs.mkdirSync(card, { recursive: true });
  fs.copyFileSync(fixture("twoShots"), path.join(card, "clip.mp4"));
  fs.writeFileSync(path.join(card, "notes.mp4"), "not a video\n");
  fs.chmodSync(card, 0o555);
  try {
    const r = cli(["check", path.join(card, "clip.mp4"), "--for", "youtube"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^reframekit: Cannot write the check to .*camera-card\/reframekit-check-clip: permission denied; give --out a folder that takes files$/m);
    // Said before the file is read: a file that is no video gets the same
    // answer, not what ffprobe makes of it.
    const early = cli(["check", path.join(card, "notes.mp4"), "--for", "youtube"]);
    assert.equal(early.status, 1);
    assert.match(early.stderr, /^reframekit: Cannot write the check to .*camera-card\/reframekit-check-notes: permission denied; give --out a folder that takes files$/m);
    const json = JSON.parse(cli(["check", path.join(card, "clip.mp4"), "--for", "youtube", "--json"]).stdout);
    assert.match(json.error, /^Cannot write the check to .*: permission denied; give --out a folder that takes files$/);
    assert.equal(cli(["check", path.join(card, "clip.mp4"), "--for", "youtube", "--out", path.join(dir, "card-check")]).status, 0);
  } finally {
    fs.chmodSync(card, 0o755);
  }
});

test("a formats.json names files in its own folder only", () => {
  const trav = path.join(dir, "trav");
  fs.mkdirSync(trav, { recursive: true });
  fs.writeFileSync(path.join(trav, "formats.json"), JSON.stringify({ files: [{ place: "tiktok", file: "../twoShots.mp4" }] }));
  const r = JSON.parse(cli(["check", trav, "--json"]).stdout);
  assert.deepEqual([r.results[0].file, r.results[0].checks[0].found], ["twoShots.mp4", "missing"]);
  // A place's name a formats.json gives is only a place when it is one.
  fs.copyFileSync(fixture("twoShots"), path.join(trav, "a.mp4"));
  fs.writeFileSync(path.join(trav, "formats.json"), JSON.stringify({ files: [{ place: "constructor", file: "a.mp4" }] }));
  const odd = JSON.parse(cli(["check", trav, "--json"]).stdout);
  assert.deepEqual([odd.results[0].place, odd.results[0].label], ["constructor", "constructor"]);
  fs.writeFileSync(path.join(trav, "formats.json"), JSON.stringify({ files: [{ place: "tiktok" }] }));
  const bad = cli(["check", trav]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /file 1 has no file name/);
});

test("caption boxes follow libass when the script's PlayRes has another shape than the video, and emoji joined into one count once", () => {
  const { boxesFor, widthOf } = require("../skills/reframekit/scripts/lib/captions");
  // As ffmpeg writes an SRT out as ASS: 384x288, margins of 10.
  const file = path.join(dir, "from-srt.ass");
  fs.writeFileSync(file, "[Script Info]\nScriptType: v4.00+\nPlayResX: 384\nPlayResY: 288\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,16,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,0\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,Y omega.\nDialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,Pero por el menos de la diferencia\n");
  const captions = readCaptions(file);
  const [short4x3, long4x3] = boxesFor(captions, 1440, 1080);
  const [short, long] = boxesFor(captions, 1080, 1920);
  // On a 9:16 frame the text is drawn 2.37 times wider than its PlayResX
  // units say (1920 / 288 against 1080 / 384); on a 4:3 frame as they say.
  assert.ok(Math.abs(short.box.w / short4x3.box.w - 2.37) < 0.02, `${short.box.w} against ${short4x3.box.w}`);
  assert.ok(long4x3.box.x > 0.06, `on 4:3 the long line starts at ${long4x3.box.x}`);
  // The long line wraps at the script's margins, into the side margins
  // of a 9:16 place.
  assert.ok(long.box.x < 0.06 && long.box.h > 2 * long4x3.box.h - 0.01, JSON.stringify(long.box));
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
  assert.equal(widthOf(`Hi ${family}${family}${family}`), widthOf("Hi \u{1F600}\u{1F600}\u{1F600}"));
  assert.equal(widthOf("été"), widthOf("été"));
});

test("the check's summary names CHECK.md by the folder as it was given, as a run's summary names FORMATS.md, and --help says only an ASS file's text is placed", () => {
  const here = path.join(dir, "named-check");
  fs.mkdirSync(path.join(here, "video"), { recursive: true });
  fs.copyFileSync(fixture("twoShots"), path.join(here, "video", "clip.mp4"));
  const run = cli(["video/clip.mp4", "--for", "360x640", "--out", "video/formats"], { cwd: here });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Read video\/formats\/FORMATS\.md and look at video\/formats\/sheet\.png\./);
  assert.match(cli(["check", "video/formats"], { cwd: here }).stdout, /\nRead video\/formats\/CHECK\.md\.\n$/);
  assert.match(cli(["check", "video/formats/formats.json"], { cwd: here }).stdout, /\nRead video\/formats\/CHECK\.md\.\n$/);
  assert.match(cli(["check", "video/clip.mp4", "--for", "youtube"], { cwd: here }).stdout, /\nRead video\/reframekit-check-clip\/CHECK\.md\.\n$/);
  const out = path.join(here, "elsewhere");
  const given = cli(["check", "video/clip.mp4", "--for", "youtube", "--out", out], { cwd: here });
  assert.ok(given.stdout.endsWith(`\nRead ${path.join(out, "CHECK.md")}.\n`), given.stdout);
  const help = cli(["--help"]).stdout;
  assert.match(help, /--captions <file> {2}an ASS, SRT or WebVTT file burned into the video: its\n +timing is checked, and an ASS file's text against\n +each 9:16 place's safe area/);
});
