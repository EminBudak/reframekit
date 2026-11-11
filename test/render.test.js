"use strict";

// Whole runs on made videos: the files have the size, length, frame rate
// and sound asked for, the window shows the moving box, the sound stays on
// its frame, places that need the same file share one encode, long videos
// are cut at a shot change, padded pictures sit on their color, fit keeps
// the shape, an edited crop.json is rendered as written, and a file limit
// is met with two passes.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { fixture, ffmpeg, probe, loudness, frameAt, cli, outDir, dir, TWO_SHOTS } = require("./helpers");
const { layoutOf } = require("../skills/reframekit/scripts/lib/check");
const { encodeJob, jobsFor, outputRate } = require("../skills/reframekit/scripts/lib/render");
const { probe: kitProbe } = require("../skills/reframekit/scripts/lib/ffmpeg");
const { parsePlaces } = require("../skills/reframekit/scripts/lib/places");

const white = (r, g, b) => r > 200 && g > 200 && b > 200;
const yellow = (r, g, b) => r > 200 && g > 160 && b < 90;

test("two shots in 9:16, 4:5 and 1:1: sizes, length, sound at -14 LUFS, and the box in the window", () => {
  const file = fixture("twoShots");
  const out = outDir("two");
  const run = cli([file, "--for", "360x640,432x540,480x480", "--out", out, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const formats = JSON.parse(run.stdout);
  assert.deepEqual(formats.files.map((f) => f.file), ["360x640.mp4", "432x540.mp4", "480x480.mp4"]);
  for (const f of formats.files) {
    const info = probe(path.join(out, f.file));
    assert.equal(`${info.video.width}x${info.video.height}`, f.place);
    assert.ok(Math.abs(info.duration - 4) < 0.01, `${f.file} is ${info.duration} s`);
    assert.equal(info.video.fps, 30);
    assert.equal(info.video.codec, "h264");
    assert.equal(info.video.pixFmt, "yuv420p");
    assert.equal(info.video.color, "tv bt709 bt709 bt709", `${f.file}: range, matrix, transfer and primaries`);
    assert.deepEqual([info.audio.codec, info.audio.sampleRate, info.audio.channels], ["aac", 48000, 2]);
    const l = loudness(path.join(out, f.file));
    assert.ok(Math.abs(l.integrated + 14) <= 0.5, `${f.file}: ${l.integrated} LUFS`);
    assert.ok(l.truePeak <= -1, `${f.file}: true peak ${l.truePeak}`);
    const lay = layoutOf(path.join(out, f.file));
    assert.equal(lay.faststart, true);
    assert.equal(lay.shiftingEdits, 0);
    assert.ok(fs.existsSync(path.join(out, f.cover)));
    // The box: whole in the window at every second of the first shot,
    // the second shot's box too.
    for (const t of [0.5, 1, 1.5, 3]) {
      const frame = frameAt(path.join(out, f.file), t);
      const box = TWO_SHOTS.box(t);
      const scale = frame.height / 360;
      const seen = frame.count(t < 2 ? white : yellow);
      const whole = box.w * box.h * scale * scale;
      assert.ok(seen > whole * 0.8, `${f.file} at ${t} s shows ${seen} of the box's ${Math.round(whole)} pixels`);
    }
  }
  for (const name of ["crop.json", "sheet.png", "formats.json", "FORMATS.md"]) assert.ok(fs.existsSync(path.join(out, name)), name);
  const md = fs.readFileSync(path.join(out, "FORMATS.md"), "utf8");
  assert.match(md, /not faces or objects/);
  assert.doesNotMatch(md, /\u2014|\u2013/);
});

test("TikTok, Reels and Shorts share one encode, and the sound lands on its frame", () => {
  const file = fixture("fourShots");
  const out = outDir("vertical");
  const run = cli([file, "--for", "tiktok,reels,shorts", "--mode", "center", "--out", out, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const formats = JSON.parse(run.stdout);
  assert.deepEqual(formats.files.map((f) => [f.file, f.sameAs]), [["tiktok.mp4", null], ["reels.mp4", "tiktok.mp4"], ["shorts.mp4", "tiktok.mp4"]]);
  const a = fs.readFileSync(path.join(out, "tiktok.mp4"));
  assert.ok(a.equals(fs.readFileSync(path.join(out, "reels.mp4"))));
  const info = probe(path.join(out, "tiktok.mp4"));
  assert.equal(`${info.video.width}x${info.video.height}`, "1080x1920");
  assert.ok(Math.abs(info.duration - 12) < 0.01, `${info.duration} s`);
  assert.ok(formats.files.every((f) => f.pass), JSON.stringify(formats.files.map((f) => f.checks.filter((c) => c.status === "fail"))));
  // A click near full scale, raised to -14 LUFS and encoded at Instagram's
  // 128 kb/s, still peaks under -1 dBTP.
  const l = loudness(path.join(out, "tiktok.mp4"));
  assert.ok(Math.abs(l.integrated + 14) <= 0.5, `${l.integrated} LUFS`);
  assert.ok(l.truePeak <= -1, `true peak ${l.truePeak}`);
  // The click at 1 s and the flash on the frame at 1 s stay together.
  const pcm = spawnSync("ffmpeg", ["-v", "error", "-i", path.join(out, "tiktok.mp4"), "-map", "0:a", "-ac", "1", "-f", "f32le", "-"], { maxBuffer: 64 * 1024 * 1024 }).stdout;
  let peak = 0;
  let at = 0;
  for (let i = 0; i < 48000 * 3; i++) {
    const v = Math.abs(pcm.readFloatLE(4 * i));
    if (v > peak) {
      peak = v;
      at = i;
    }
  }
  assert.ok(Math.abs(at / 48000 - 1) < 0.004, `the click is at ${at / 48000} s`);
  const flash = frameAt(path.join(out, "tiktok.mp4"), 1.0);
  assert.ok(flash.count(white) > flash.width * flash.height * 0.5, "the flash is on the frame at 1 s");
});

test("a video longer than asked is cut at a shot change, or at the limit with a fade when none is near", () => {
  const file = fixture("fourShots");
  const atCut = cli([file, "--for", "320x180", "--seconds", "7", "--out", outDir("cut-7"), "--json"]);
  assert.equal(atCut.status, 0, atCut.stderr);
  const f7 = JSON.parse(atCut.stdout).files[0];
  assert.deepEqual([f7.trimmed.end, f7.trimmed.atCut], [6, true]);
  assert.ok(Math.abs(probe(path.join(outDir("cut-7"), "320x180.mp4")).duration - 6) < 0.01);
  const atLimit = cli([file, "--for", "320x180", "--seconds", "5", "--out", outDir("cut-5"), "--json"]);
  assert.equal(atLimit.status, 0, atLimit.stderr);
  const f5 = JSON.parse(atLimit.stdout).files[0];
  assert.deepEqual([f5.trimmed.end, f5.trimmed.atCut], [5, false]);
  const last = frameAt(path.join(outDir("cut-5"), "320x180.mp4"), 4.95);
  assert.ok(last.count((r, g, b) => r + g + b < 30) > last.width * last.height * 0.9, "it fades to black");
  const md = fs.readFileSync(path.join(outDir("cut-5"), "FORMATS.md"), "utf8");
  assert.match(md, /ends at 5\.00 s, with a half second fade/);
});

test("a file too long for its place ends just before a shot change on the place's limit or in its last tenth of a second, not at the shot change before it, and FORMATS.md says so", () => {
  const { trimFor } = require("../skills/reframekit/scripts/lib/render");
  const { formatsMarkdown } = require("../skills/reframekit/scripts/lib/report");
  const { placeFor } = require("../skills/reframekit/scripts/lib/places");
  // 200 s with a shot change every 20 s, as an edit on round seconds has:
  // X takes 140 s, TikTok 180 s, and each file ends a tenth of a second
  // under, on a frame at 25 fps.
  const shots = (...starts) => starts.map((start, i) => ({ n: i + 1, start }));
  const every20 = shots(0, 20, 40, 60, 80, 100, 120, 140, 160, 180);
  const at = (name, list, extra = {}) => trimFor(placeFor(name), { duration: 200, shots: list, trim: true, fps: 25, ...extra });
  assert.deepEqual(at("x", every20), { end: 139.88, atCut: true, before: 140, why: "place", limit: 140 });
  assert.deepEqual(at("tiktok", every20), { end: 179.88, atCut: true, before: 180, why: "place", limit: 180 });
  // A shot change inside that tenth, with none in the 30% before it.
  assert.deepEqual(at("x", shots(0, 70, 139.95)), { end: 139.88, atCut: true, before: 139.95, why: "place", limit: 140 });
  // One that leaves that tenth ends the file at it, as before; past the
  // limit, it is no shot change of the file.
  assert.deepEqual(at("x", shots(0, 100, 139.9)), { end: 139.9, atCut: true, why: "place", limit: 140 });
  assert.deepEqual(at("x", shots(0, 120, 140.04)), { end: 120, atCut: true, why: "place", limit: 140 });
  // At 29.97 fps no frame starts on a round second: a cut on 140 s falls
  // on the frame 4196, at 140.007 s, which counts as on the limit. The
  // frame after it does not, nor a frame past the limit at 23.976 fps.
  const rate = (r) => ({ fps: r, videoFps: r });
  const ntsc = shots(0, 40.007, 80.013, 120.02, 140.007);
  assert.deepEqual(at("x", ntsc, { duration: 149.983, ...rate(30000 / 1001) }), { end: 139.873, atCut: true, before: 140.007, why: "place", limit: 140 });
  assert.deepEqual(at("x", shots(0, 120.02, 140.04), rate(30000 / 1001)), { end: 120.02, atCut: true, why: "place", limit: 140 });
  assert.deepEqual(at("x", shots(0, 120.012, 140.014), rate(24000 / 1001)), { end: 139.89, atCut: true, before: 140.014, why: "place", limit: 140 });
  assert.deepEqual(at("x", shots(0, 120.012, 140.056), rate(24000 / 1001)), { end: 120.012, atCut: true, why: "place", limit: 140 });
  assert.deepEqual(at("x", shots(0, 120.003, 140.007), rate(60000 / 1001)), { end: 139.89, atCut: true, before: 140.007, why: "place", limit: 140 });
  // At 29.97 fps the first frame after 33 s is at 33.033 s, nearly a frame
  // past, kept to the millisecond as no more than a frame is: it counts,
  // and the one after it, at 33.066 s, does not.
  const asked = { duration: 40, seconds: 33, ...rate(30000 / 1001) };
  assert.deepEqual(at("youtube", shots(0, 30.03, 33.033), asked), { end: 33, atCut: true, before: 33.033, why: "asked", limit: 33 });
  assert.deepEqual(at("youtube", shots(0, 30.03, 33.066), asked), { end: 30.03, atCut: true, why: "asked", limit: 33 });
  // A frame of the video, not of the files: a video at 19.98 fps, whose
  // files run at 30, has its cut on 140 s at 140.04 s, more than a frame
  // of the files past the limit.
  assert.deepEqual(at("x", shots(0, 120.02, 140.04), { fps: 30, videoFps: 20000 / 1001 }), { end: 139.9, atCut: true, before: 140.04, why: "place", limit: 140 });
  // --seconds keeps no tenth: a shot change on it ends the file there.
  assert.deepEqual(at("youtube", every20, { seconds: 60 }), { end: 60, atCut: true, why: "asked", limit: 60 });
  const file = { place: "x", label: "X", file: "x.mp4", cover: "x-cover.jpg", width: 1920, height: 1080, seconds: 139.88, bytes: 9e6, lufs: -14, truePeak: -2, normalization: "linear", pass: true, checks: [], trimmed: at("x", every20), coverAt: 139.78, sameAs: null };
  const md = formatsMarkdown({ video: "talk.mp4", source: { width: 1920, height: 1080, fps: 25, seconds: 200, sound: { codec: "aac" }, bytes: 1000 }, mode: "follow", lufs: -14, trim: true, cover: 150, limits: { x: { seconds: { max: 140 } } }, sources: {}, notes: [], shots: every20.map((s) => ({ ...s, end: s.start + 20, windows: {} })), shotsFull: [], files: [file] });
  assert.match(md, /^- x\.mp4 ends at 139\.88 s, just before the shot change at 140\.00 s: X takes 140 s at most\.$/m);
  assert.match(md, /x\.mp4's cover is from 139\.78 s, just before it ends, ahead of the shot change at 140\.00 s\./);
});

test("a video at 29.97 fps whose shot change falls on the first frame after the length asked for ends just before that change, not at the shot change before it", () => {
  // Shots of 90, 30 and 60 frames at 30000/1001 fps, red, green and blue:
  // they start at 0, 3.003 and 4.004 s, the frame 120 being the first
  // after 4 s, as a cut on a round second falls at this rate.
  const file = path.join(dir, "ntsc-cuts.mp4");
  const shots = [["0x802020", 90], ["0x20a040", 30], ["0x2040c0", 60]];
  ffmpeg([
    ...shots.flatMap(([c]) => ["-f", "lavfi", "-i", `color=c=${c}:s=320x180:r=30000/1001`]),
    "-f", "lavfi", "-i", "sine=f=330:r=48000:d=6.006,volume=0.2",
    "-filter_complex", `${shots.map(([, n], i) => `[${i}]trim=end_frame=${n},setpts=PTS-STARTPTS[s${i}]`).join(";")};[s0][s1][s2]concat=n=3:v=1:a=0,format=yuv420p[v];[3]aformat=channel_layouts=stereo[a]`,
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "128k", file,
  ]);
  const out = outDir("ntsc-4");
  const run = cli([file, "--for", "320x180", "--seconds", "4", "--out", out, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const f = JSON.parse(run.stdout);
  assert.deepEqual(f.shots.map((s) => s.start), [0, 3.003, 4.004]);
  assert.deepEqual(f.files[0].trimmed, { end: 3.971, atCut: true, before: 4.004, why: "asked", limit: 4 });
  const made = path.join(out, "320x180.mp4");
  assert.ok(Math.abs(probe(made).duration - 3.971) < 0.04, `${probe(made).duration} s`);
  // Its last frame is the green shot's, whole: no blue, and no fade.
  const last = frameAt(made, 3.92);
  const [r, g, b] = last.at(160, 90);
  assert.ok(g > 120 && r < 70 && b < 100, `the last frame is ${r},${g},${b}`);
  assert.match(fs.readFileSync(path.join(out, "FORMATS.md"), "utf8"), /^- 320x180\.mp4 ends at 3\.97 s, just before the shot change at 4\.00 s: --seconds asked for 4 s at most\.$/m);
});

test("a file that ends before the cover time has its cover from before its fade, as bright as the frames before it, and FORMATS.md and the summary say only what that file holds", () => {
  const out = outDir("cover-cut");
  const run = cli([fixture("twoShots"), "--for", "180x180", "--seconds", "3", "--cover", "3.5", "--out", out, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const f = JSON.parse(run.stdout);
  // Cut at 3 s where no shot changes, it fades out from 2.5 s.
  assert.deepEqual([f.cover, f.files[0].trimmed.end, f.files[0].trimmed.atCut, f.files[0].coverAt], [3.5, 3, false, 2.4]);
  const light = (file, t) => {
    const fr = frameAt(file, t);
    let sum = 0;
    for (let y = 0; y < fr.height; y++) for (let x = 0; x < fr.width; x++) sum += fr.at(x, y).reduce((a, b) => a + b, 0);
    return sum / (3 * fr.width * fr.height);
  };
  const before = light(path.join(out, "180x180.mp4"), 2.2);
  const cover = light(path.join(out, "180x180-cover.jpg"), 0);
  assert.ok(Math.abs(cover - before) < 0.1 * before, `the cover's light is ${cover}, the frames' before the fade ${before}`);
  assert.match(fs.readFileSync(path.join(out, "FORMATS.md"), "utf8"), /like 180x180-cover\.jpg: the frame at 3\.50 s of that file\. 180x180\.mp4's cover is from 2\.40 s, before its half second fade\./);
  // Cut at the shot change at 2 s, it has no fade: the frame just before.
  const atCut = cli([fixture("twoShots"), "--for", "180x180", "--seconds", "2.5", "--cover", "3.5", "--out", outDir("cover-at-cut"), "--json"]);
  assert.equal(atCut.status, 0, atCut.stderr);
  const c = JSON.parse(atCut.stdout).files[0];
  assert.deepEqual([c.trimmed.end, c.trimmed.atCut, c.coverAt], [2, true, 1.9]);
  assert.match(fs.readFileSync(path.join(outDir("cover-at-cut"), "FORMATS.md"), "utf8"), /the frame at 3\.50 s of that file\. 180x180\.mp4's cover is from 1\.90 s, just before the shot change it ends at\./);
  // Not cut, with a --cover past the end of the 4 s video: from near its
  // end, as a note says, with no fade nor shot change named.
  const late = cli([fixture("twoShots"), "--for", "180x180", "--cover", "999", "--out", outDir("cover-late"), "--json"]);
  assert.equal(late.status, 0, late.stderr);
  const l = JSON.parse(late.stdout);
  assert.deepEqual([l.cover, l.files[0].trimmed, l.files[0].coverAt], [4, null, 3.9]);
  assert.ok(l.notes.includes("--cover asked for 999 s, at or past the end of the 4.00 s video, so the covers are from near its end."), l.notes.join("\n"));
  assert.match(fs.readFileSync(path.join(outDir("cover-late"), "FORMATS.md"), "utf8"), /the frame at 4\.00 s of that file\. 180x180\.mp4's cover is from 3\.90 s, near the end of its picture\./);
  // The summary's padded shots are those the files hold: a shot after
  // the cut is in no file.
  const { summary } = require("../skills/reframekit/scripts/reframekit");
  const shot = (n, start, end, mode) => ({ n, start, end, windows: { "1:1": { mode } } });
  const file = { place: "square", label: "Square", file: "square.mp4", width: 1080, height: 1080, seconds: 4, bytes: 9e5, lufs: -14, pass: true, checks: [], trimmed: { end: 4, atCut: true }, sameAs: null };
  const said = summary({ dir: "out", next: "reframekit", removed: [], formats: { video: "film.mp4", source: { width: 1920, height: 1080, seconds: 9, sound: {} }, mode: "follow", notes: [], files: [file], shots: [shot(1, 0, 2, "pad"), shot(2, 2, 4, "follow"), shot(3, 4, 6, "pad"), shot(4, 6, 9, "pad")] } });
  assert.match(said, /Padded {2}1:1 shot 1: a crop would cut/);
});

test("a picture that ends before its sound has its cover from its last frame, which the file holds, with --cover past it, or from before when no frame is bright enough", () => {
  // Three seconds of picture under eight of sound: a test card, and a
  // dark one whose frames are all too dark to pick a cover from.
  const short = path.join(dir, "picture-short.mp4");
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=f=330:r=48000:d=8", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", short]);
  const dark = path.join(dir, "dark-short.mp4");
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "color=c=0x101010:s=320x180:r=30:d=3,drawbox=x=100:y=60:w=120:h=60:color=0x202020:t=fill", "-f", "lavfi", "-i", "sine=f=330:r=48000:d=9", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", dark]);
  for (const [file, extra, name] of [[short, ["--cover", "6"], "cover-past-picture"], [dark, [], "cover-dark"]]) {
    const r = cli([file, "--for", "180x180", ...extra, "--out", outDir(name), "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const f = JSON.parse(r.stdout).files[0];
    assert.ok(f.coverAt <= (extra.length ? 6 : 3), `${name}: the cover is from ${f.coverAt} s`);
    assert.ok(fs.statSync(path.join(outDir(name), "180x180-cover.jpg")).size > 0, name);
  }
  // The cover is from 6 s, where the file holds the picture's last frame.
  const held = frameAt(path.join(outDir("cover-past-picture"), "180x180.mp4"), 6);
  const last = frameAt(path.join(outDir("cover-past-picture"), "180x180.mp4"), 2.99);
  let off = 0;
  for (let y = 0; y < 180; y += 6) for (let x = 0; x < 180; x += 6) off += Math.abs(held.at(x, y)[1] - last.at(x, y)[1]);
  assert.ok(off / 900 < 3, `the frame at 6 s is not the last one: ${off / 900} apart on average`);
});

test("the blurred copy behind a padded picture has no green patches, however many threads ffmpeg gives the graph", { skip: process.platform === "win32" }, () => {
  // An ffmpeg that gives every graph 64 threads, more than the rows of the
  // small plane the blur runs on, as a machine of that many CPUs does.
  const bin = outDir("threads-bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bin, "ffmpeg"), `#!/bin/sh\nexec "${real}" -filter_complex_threads 64 "$@"\n`);
  fs.chmodSync(path.join(bin, "ffmpeg"), 0o755);
  const out = outDir("pad-threads");
  const r = cli([fixture("twoShots"), "--for", "360x360", "--mode", "pad", "--out", out], { env: { ...process.env, FFMPEG_PATH: path.join(bin, "ffmpeg"), FFPROBE_PATH: spawnSync("sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).stdout.trim() } });
  assert.equal(r.status, 0, r.stderr);
  // The band over the picture, 79 rows of the 360, in its two color
  // planes: a zero there is the green of the patches.
  for (const t of [0.5, 1.5, 3]) {
    const yuv = spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", path.join(out, "360x360.mp4"), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"], { maxBuffer: 1 << 20 }).stdout;
    const plane = 180 * 180;
    let low = 255;
    for (const from of [360 * 360, 360 * 360 + plane]) for (let i = 0; i < 180 * 36; i++) low = Math.min(low, yuv[from + i]);
    assert.ok(low > 40, `at ${t} s a color sample of the band is ${low}`);
  }
});

test("pad puts the whole picture on the color asked for, or on the brand's background", () => {
  const file = fixture("twoShots");
  const run = cli([file, "--for", "360x640", "--mode", "pad", "--pad", "#ff00ff", "--out", outDir("pad")]);
  assert.equal(run.status, 0, run.stderr);
  const frame = frameAt(path.join(outDir("pad"), "360x640.mp4"), 1);
  const [r, g, b] = frame.at(10, 10);
  assert.ok(r > 230 && g < 30 && b > 230, `the top corner is ${r},${g},${b}`);
  // The whole 640 px picture, 360 px wide, sits in the middle.
  assert.ok(frame.count(white) > 0, "the box shows");
  const brand = path.join(dir, "brand");
  fs.mkdirSync(brand, { recursive: true });
  fs.writeFileSync(path.join(brand, "brand.json"), JSON.stringify({ version: 1, colors: [{ hex: "#1a6b45", role: "logo" }, { hex: "#f6f5f1", role: "surface" }] }));
  const branded = cli([file, "--for", "360x640", "--mode", "pad", "--brand", brand, "--out", outDir("pad-brand"), "--json"]);
  assert.equal(branded.status, 0, branded.stderr);
  assert.match(JSON.parse(branded.stdout).notes.join(" "), /#f6f5f1, from brand\.json/);
  const [br, bg, bb] = frameAt(path.join(outDir("pad-brand"), "360x640.mp4"), 1).at(10, 10);
  assert.ok(Math.abs(br - 246) < 8 && Math.abs(bg - 245) < 8 && Math.abs(bb - 241) < 8, `the top corner is ${br},${bg},${bb}`);
  assert.equal(probe(path.join(outDir("pad-brand"), "360x640.mp4")).video.color, "tv bt709 bt709 bt709");
});

test("fit keeps the picture's shape inside each place's frame", () => {
  const file = fixture("twoShots");
  const run = cli([file, "--for", "360x640,480x480", "--mode", "fit", "--out", outDir("fit"), "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const sizes = JSON.parse(run.stdout).files.map((f) => `${f.width}x${f.height}`);
  assert.deepEqual(sizes, ["360x202", "480x270"]);
});

test("in fit mode places of other shapes that get the same picture share one encode", () => {
  // A 16:9 picture fits 9:16, 4:5 and 1:1 frames 360 wide at the same
  // 360x202.
  const out = outDir("fit-shared");
  const run = cli([fixture("twoShots"), "--for", "360x640,360x450,360x360", "--mode", "fit", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal((run.stderr.match(/^Encoding /gm) || []).length, 1, run.stderr);
  assert.match(run.stderr, /Encoding 360x640\.mp4 \(360x202, also for 360x450, 360x360\)/);
  const files = JSON.parse(fs.readFileSync(path.join(out, "formats.json"), "utf8")).files;
  assert.deepEqual(files.map((f) => [f.file, `${f.width}x${f.height}`, f.sameAs]), [["360x640.mp4", "360x202", null], ["360x450.mp4", "360x202", "360x640.mp4"], ["360x360.mp4", "360x202", "360x640.mp4"]]);
  const bytes = (name) => fs.readFileSync(path.join(out, name));
  assert.ok(bytes("360x450.mp4").equals(bytes("360x640.mp4")));
});

test("an edited crop.json is rendered as written", () => {
  const file = fixture("twoShots");
  const out = outDir("edit");
  const plan = cli([file, "--for", "360x640", "--plan", "--out", out]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.ok(!fs.existsSync(path.join(out, "360x640.mp4")));
  const crop = JSON.parse(fs.readFileSync(path.join(out, "crop.json"), "utf8"));
  // The second shot's window moved to the far left, away from its box.
  crop.shots[1].windows["9:16"].path = [[2, 0, 0]];
  fs.writeFileSync(path.join(out, "crop.json"), JSON.stringify(crop));
  const run = cli([file, "--crop", path.join(out, "crop.json"), "--for", "360x640", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const frame = frameAt(path.join(out, "360x640.mp4"), 3);
  assert.equal(frame.count(yellow), 0, "the yellow box is out of the window");
  const again = JSON.parse(fs.readFileSync(path.join(out, "crop.json"), "utf8"));
  assert.deepEqual(again.shots[1].windows["9:16"].path, [[2, 0, 0]]);
  // A smaller window of the same shape zooms in: half the size, twice the
  // box.
  again.shots[1].windows["9:16"] = { mode: "follow", w: 102, h: 180, path: [[2, 470, 40]] };
  fs.writeFileSync(path.join(out, "crop.json"), JSON.stringify(again));
  assert.equal(cli([file, "--crop", path.join(out, "crop.json"), "--for", "360x640", "--out", out]).status, 0);
  const zoomed = frameAt(path.join(out, "360x640.mp4"), 3).count(yellow);
  const box = (50 * 360) / 102;
  assert.ok(Math.abs(zoomed - box * box) < box * box * 0.15, `${zoomed} yellow pixels, about ${Math.round(box * box)} expected`);
});

test("a file over a place's size limit is encoded again in two passes to fit it", async () => {
  const file = fixture("noisy");
  const info = kitProbe(file);
  const work = fs.mkdtempSync(path.join(dir, "limit-"));
  const place = { ...parsePlaces("360x640")[0], limits: { bytes: { max: 300 * 1024, hard: true } } };
  const shots = [{ n: 1, start: 0, end: 3, cut: "start", fade: 0, windows: { "9:16": { mode: "follow", w: 202, h: 360, path: [[0, 219, 0]] } } }];
  const ctx = { info, picture: { x: 0, y: 0, w: 640, h: 360 }, shots, mode: "follow", pad: { kind: "blur" }, trim: true, lufs: -14, fps: outputRate(info.video), cover: 1, work, log: () => {}, version: "test" };
  const [job] = jobsFor([place], ctx);
  job.measured = null;
  const made = await encodeJob(job, ctx);
  assert.ok(made.twoPass, "it took two passes");
  assert.ok(made.size <= 300 * 1024, `${made.size} bytes`);
  assert.ok(made.size > 200 * 1024, `${made.size} bytes is far under the limit`);
  // What the reports say of it: what the first encode came to, the limit
  // and whose it is, and the rate it was encoded again at.
  const { firstBytes, limit, place: whose, passes } = made.twoPass;
  assert.ok(firstBytes > 0.98 * 300 * 1024, `${firstBytes} bytes at first`);
  assert.deepEqual([limit, whose, passes], [300 * 1024, "360x640", 2]);
  const { resizedText } = require("../skills/reframekit/scripts/lib/report");
  assert.match(resizedText({ file: "360x640.mp4", twoPass: made.twoPass }), /^360x640\.mp4 came out at [\d.]+ [KM]B, (over|within 2% of) the 307\.2 KB 360x640 takes, so it was encoded again in two passes at a lower bit rate, ((twice|three times) in all as it (still|then) came out over, the last at )?\d\.\d\d Mb\/s\.$/);
  // Whose limit it is, by the place's owner, and how many times it was
  // encoded again, in words.
  assert.equal(resizedText({ file: "x.mp4", twoPass: { bitrate: 8.7e6, rounds: 2, passes: 2, firstBytes: 6e8, limit: 5.12e8, place: "X", by: "X" } }), "x.mp4 came out at 600.0 MB, over the 512 MB X takes, so it was encoded again in two passes at a lower bit rate, twice in all as it still came out over, the last at 8.70 Mb/s.");
  assert.equal(resizedText({ file: "feed.mp4", twoPass: { bitrate: 20e6, rounds: 1, passes: 2, firstBytes: 3.2e8, limit: 3e8, place: "Feeds (4:5)", by: "Instagram" } }), "feed.mp4 came out at 320.0 MB, over the 300 MB Instagram takes, so it was encoded again in two passes at a lower bit rate, 20.00 Mb/s.");
  assert.equal(resizedText({ file: "tiktok.mp4", twoPass: { bitrate: 20e6, rounds: 3, passes: 2, firstBytes: 2.97e8, limit: 3e8, place: "Instagram Reels", by: "Instagram" } }), "tiktok.mp4 came out at 297.0 MB, within 2% of the 300 MB Instagram takes, so it was encoded again in two passes at a lower bit rate, three times in all as it then came out over, the last at 20.00 Mb/s.");
  const [feed] = jobsFor(parsePlaces("feed"), ctx);
  assert.deepEqual([feed.maxFor, feed.maxBy], ["Feeds (4:5)", "Instagram"]);
});

test("a file two passes leave over its place's size limit, as x264 of ffmpeg 4.4 leaves one, is encoded again at a lower rate", { skip: process.platform === "win32" }, async () => {
  // An ffmpeg whose first second pass asks x264 for 15% more than it was
  // given: an encoder that goes past the rate asked.
  const bin = fs.mkdtempSync(path.join(dir, "overshoot-"));
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bin, "ffmpeg"), `#!/bin/sh
case " $* " in *" -pass 2 "*) [ -e "${bin}/went-over" ] || { : > "${bin}/went-over"; more=1; };; esac
if [ -n "$more" ]; then
  next=
  for a do
    shift
    if [ -n "$next" ]; then a=$((a * 115 / 100)); next=; fi
    [ "$a" = "-b:v" ] && next=1
    set -- "$@" "$a"
  done
fi
exec "${real}" "$@"
`);
  fs.chmodSync(path.join(bin, "ffmpeg"), 0o755);
  const file = fixture("noisy");
  const info = kitProbe(file);
  const work = fs.mkdtempSync(path.join(dir, "limit-again-"));
  const place = { ...parsePlaces("360x640")[0], limits: { bytes: { max: 300 * 1024, hard: true } } };
  const shots = [{ n: 1, start: 0, end: 3, cut: "start", fade: 0, windows: { "9:16": { mode: "follow", w: 202, h: 360, path: [[0, 219, 0]] } } }];
  const said = [];
  const ctx = { info, picture: { x: 0, y: 0, w: 640, h: 360 }, shots, mode: "follow", pad: { kind: "blur" }, trim: true, lufs: -14, fps: outputRate(info.video), cover: 1, work, log: (line) => said.push(line), version: "test" };
  const [job] = jobsFor([place], ctx);
  job.measured = null;
  const was = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = path.join(bin, "ffmpeg");
  let made;
  try {
    made = await encodeJob(job, ctx);
  } finally {
    if (was === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = was;
  }
  assert.ok(fs.existsSync(path.join(bin, "went-over")), "the first second pass went over");
  assert.equal(made.twoPass.rounds, 2, said.join("\n"));
  assert.ok(made.size <= 300 * 1024, `${made.size} bytes`);
  assert.match(said.join("\n"), /still over 307 KB: encoding again at/);
});

test("sound raised by more than 30 dB to reach the target, as room tone alone is, gets a note with what it measured and the gain; sound raised less gets none", () => {
  // Pink noise at -55 LUFS, as the hiss of a quiet room, and at -40.
  const make = (name, amplitude) => {
    const file = path.join(dir, `${name}.mp4`);
    require("./helpers").ffmpeg(["-f", "lavfi", "-i", "color=c=0x303030:s=320x180:r=30:d=3", "-f", "lavfi", "-i", `anoisesrc=d=3:c=pink:r=48000:a=${amplitude}:seed=7`, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", file]);
    return file;
  };
  const tone = make("room-tone", 0.01);
  const run = cli([tone, "--for", "180x180", "--out", outDir("room-tone"), "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const f = JSON.parse(run.stdout);
  const note = f.notes.find((n) => n.startsWith("The sound measured"));
  assert.match(note || "", /^The sound measured -5\d\.\d LUFS, so it was raised by about 4\d dB to reach -14 LUFS, and any hiss or room tone in it was raised as much\. A lower --lufs, down to -40, raises it less\.$/, f.notes.join("\n"));
  assert.ok(fs.readFileSync(path.join(outDir("room-tone"), "FORMATS.md"), "utf8").includes(`- ${note}`));
  const louder = cli([make("quiet-hiss", 0.18), "--for", "180x180", "--out", outDir("quiet-hiss"), "--json"]);
  assert.equal(louder.status, 0, louder.stderr);
  assert.ok(!JSON.parse(louder.stdout).notes.some((n) => n.startsWith("The sound measured")), JSON.parse(louder.stdout).notes.join("\n"));
});

test("quiet sound with sharp clicks still reaches -14 LUFS, its peaks under -1 dBTP", () => {
  // Pink noise near -25 LUFS and a 3 ms click at 0.9 every 2 s: loudnorm
  // alone works dynamically on it and falls short.
  const file = path.join(dir, "quiet-clicks.mp4");
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "color=c=0x303030:s=320x180:r=30:d=6", "-f", "lavfi", "-i", "anoisesrc=d=6:c=pink:r=48000:a=0.05", "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,2),0.003),0.9,0)':s=48000:d=6", "-filter_complex", "[1][2]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[a]", "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", file]);
  const run = cli([file, "--for", "180x320", "--out", outDir("quiet-clicks"), "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const l = loudness(path.join(outDir("quiet-clicks"), "180x320.mp4"));
  assert.ok(Math.abs(l.integrated + 14) <= 0.5, `${l.integrated} LUFS`);
  assert.ok(l.truePeak <= -1, `true peak ${l.truePeak}`);
  // FORMATS.md gives the peaks as why loudnorm worked dynamically.
  assert.equal(JSON.parse(run.stdout).files[0].normalization, "dynamic");
  assert.match(fs.readFileSync(path.join(outDir("quiet-clicks"), "FORMATS.md"), "utf8"), /For 180x320\.mp4 one gain change would have pushed the peaks over the ceiling, so loudnorm worked dynamically there/);
});

test("FORMATS.md gives why loudnorm worked dynamically from what the run measured: a steady tone's range of 0 LU, not peaks far under the ceiling", () => {
  // The test video's sound is a steady 440 Hz tone at -36 LUFS, whose
  // true peak, raised to -14 LUFS, stays near -12 dBTP.
  const out = outDir("steady-tone");
  const run = cli([fixture("twoShots"), "--for", "180x320", "--out", out, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const f = JSON.parse(run.stdout).files[0];
  assert.equal(f.normalization, "dynamic");
  assert.ok(f.truePeak < -5, `true peak ${f.truePeak}`);
  const md = fs.readFileSync(path.join(out, "FORMATS.md"), "utf8");
  assert.match(md, /For 180x320\.mp4 loudnorm worked dynamically, as it does on a sound whose loudness range measures 0 LU, as a steady tone's or a hum's does\./);
  assert.doesNotMatch(md, /peaks over the ceiling/);
});

test("sound that measures louder than 0 LUFS, as a square wave at full scale does, is set to -14 LUFS like any other", () => {
  const file = path.join(dir, "square-wave.mov");
  const wave = "if(lt(mod(t*440\\,1)\\,0.5)\\,0.99\\,-0.99)";
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "color=c=0x203050:s=320x180:r=30:d=3", "-f", "lavfi", "-i", `aevalsrc='${wave}|${wave}':s=48000:d=3`, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", file]);
  assert.ok(loudness(file).integrated > 0, `the test sound measures ${loudness(file).integrated} LUFS`);
  const run = cli([file, "--for", "180x180", "--out", outDir("square-wave"), "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const l = loudness(path.join(outDir("square-wave"), "180x180.mp4"));
  assert.ok(Math.abs(l.integrated + 14) <= 0.5, `${l.integrated} LUFS`);
  assert.ok(l.truePeak <= -1, `true peak ${l.truePeak}`);
});

test("each file's sound is measured with what ffmpeg 4.4 takes too, and a meter that fails stops the run instead of calling the sound silent", { skip: process.platform === "win32" }, async () => {
  // An ffmpeg that refuses the quiet level for framelog, as Ubuntu 22.04's
  // 4.4 does; the option is put together here, so no file of the kit holds
  // it whole, as a search for its uses finds none.
  const bin = outDir("old-meter");
  fs.mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const fake = path.join(bin, "ffmpeg");
  const quiet = ["framelog", "quiet"].join("=");
  fs.writeFileSync(fake, `#!/bin/sh\ncase "$*" in *${quiet}*) echo "Error setting option framelog to value quiet." >&2; exit 1;; esac\nexec "${real}" "$@"\n`);
  fs.chmodSync(fake, 0o755);
  const env = { ...process.env, FFMPEG_PATH: fake };
  const run = cli([fixture("twoShots"), "--for", "180x320", "--out", outDir("old-meter-out"), "--json"], { env });
  assert.equal(run.status, 0, run.stderr);
  const f = JSON.parse(run.stdout).files[0];
  assert.ok(typeof f.lufs === "number" && Math.abs(f.lufs + 14) <= 0.5, `${f.lufs} LUFS`);
  assert.ok(typeof f.truePeak === "number" && f.truePeak <= -1, `true peak ${f.truePeak}`);
  // A file the meter cannot read is an error, not silence.
  const { loudnessOf } = require("../skills/reframekit/scripts/lib/render");
  await assert.rejects(loudnessOf(fixture("twoSubjects"), dir, "tiktok.mp4"), /^Error: Measuring the sound of tiktok\.mp4: ffmpeg failed/);
});

test("FORMATS.md says which way a file's sound was set again, and names sharp peaks only where loudnorm worked dynamically and fell short", () => {
  const { formatsMarkdown } = require("../skills/reframekit/scripts/lib/report");
  const file = (name, extra) => ({ place: name, label: name, file: `${name}.mp4`, cover: `${name}-cover.jpg`, width: 1080, height: 1080, seconds: 4, bytes: 120000, lufs: -14, truePeak: -2, normalization: "linear", ceiling: -2, aimed: null, firstTry: null, heldByPeak: false, pass: true, checks: [], ...extra });
  const r = {
    video: "film.mp4",
    source: { width: 640, height: 360, fps: 30, seconds: 4, sound: { codec: "aac" }, bytes: 1000 },
    mode: "follow",
    lufs: -14,
    trim: true,
    cover: 1,
    limits: {},
    sources: {},
    notes: [],
    shots: [{ n: 1, start: 0, end: 4, windows: {} }],
    shotsFull: [],
    files: [
      file("square", { lufs: -14.1, aimed: -14.9, firstTry: { lufs: -13.1, normalization: "linear" } }),
      file("clicks", { lufs: -14.2, normalization: "dynamic", aimed: -11.6, firstTry: { lufs: -16.5, normalization: "dynamic" } }),
      file("quiet", { lufs: -15.3, heldByPeak: true }),
      file("stubborn", { lufs: -12.9 }),
      file("film", { lufs: -14.1, normalization: "dynamic", aimed: -12.3, firstTry: { lufs: -15.4, normalization: "dynamic" } }),
      file("hum", { normalization: "dynamic" }),
      file("odd", { normalization: "dynamic" }),
    ],
    // Why loudnorm worked dynamically, as the run found it.
    loudnorm: { "clicks.mp4": { why: "peaks", first: "peaks" }, "film.mp4": { why: "wide", first: "wide", lra: 23.4 }, "hum.mp4": { why: "steady", lra: 0 }, "odd.mp4": { why: null } },
  };
  const md = formatsMarkdown(r);
  assert.match(md, /square\.mp4 came out at -13\.1 LUFS, louder than -14 LUFS, so its sound was set again asking for -14\.9 LUFS\./);
  assert.match(md, /clicks\.mp4 came out at -16\.5 LUFS, short of -14 LUFS: loudnorm worked dynamically on it, as it does on sound whose sharp peaks stand far over its loudness\. So its sound was set again asking for -11\.6 LUFS\./);
  assert.match(md, /quiet\.mp4 still measures -15\.3 LUFS after the last try, more than half a unit from -14 LUFS: a try nearer it put the true peak over -1 dBTP and was set aside\./);
  assert.match(md, /stubborn\.mp4 still measures -12\.9 LUFS after the last try, more than half a unit from -14 LUFS\./);
  assert.doesNotMatch(md, /asked again for more|more loudness would have pushed/);
  // Each file loudnorm set dynamically is said to be with its own reason,
  // or with none where the run found none.
  assert.match(md, /film\.mp4 came out at -15\.4 LUFS, short of -14 LUFS: loudnorm worked dynamically on it, as it does on a sound whose loudness range measures more than 20 LU\. So its sound was set again asking for -12\.3 LUFS\./);
  assert.match(md, /For clicks\.mp4 one gain change would have pushed the peaks over the ceiling, so loudnorm worked dynamically there, which narrows the range between quiet and loud a little\. For hum\.mp4 loudnorm worked dynamically, as it does on a sound whose loudness range measures 0 LU, as a steady tone's or a hum's does\. For film\.mp4 the sound's loudness range measured 23\.4 LU, more than the 20 LU reframekit lets loudnorm keep, so loudnorm worked dynamically there, which narrows the range between quiet and loud\. For odd\.mp4 loudnorm worked dynamically, which narrows the range between quiet and loud a little\./);
  // Without what the run found, no reason is given.
  const bare = formatsMarkdown({ ...r, loudnorm: undefined });
  assert.match(bare, /clicks\.mp4 came out at -16\.5 LUFS, short of -14 LUFS: loudnorm worked dynamically on it\. So its sound/);
  assert.match(bare, /For clicks\.mp4, film\.mp4, hum\.mp4 and odd\.mp4 loudnorm worked dynamically, which narrows the range between quiet and loud a little\./);
});

test("FORMATS.md's checks list a copy that fails its own place where the file it copies passes, and say every check passed only when none failed or warned", () => {
  const { formatsMarkdown } = require("../skills/reframekit/scripts/lib/report");
  const row = (name, status, found, expected) => ({ name, status, found, expected, source: null });
  const file = (name, label, extra) => ({ place: name, label, file: `${name}.mp4`, cover: `${name}-cover.jpg`, width: 1080, height: 1920, seconds: 2.8, bytes: 157000, lufs: null, truePeak: null, pass: true, sameAs: null, ...extra });
  const r = (files) => ({ video: "demo.mp4", source: { width: 1920, height: 1080, fps: 30, seconds: 2.8, sound: null, bytes: 1000 }, mode: "follow", lufs: -14, trim: true, cover: 1, limits: {}, sources: {}, notes: [], shots: [{ n: 1, start: 0, end: 2.8, windows: {} }], shotsFull: [], files });
  const steady = row("steady frame rate", "warn", "30 at most, 29.5 on average", "one frame rate throughout");
  const md = formatsMarkdown(r([
    file("tiktok", "TikTok", { checks: [row("length", "pass", "2.80 s", "180 s at most"), steady] }),
    file("reels", "Instagram Reels", { sameAs: "tiktok.mp4", pass: false, checks: [row("length", "fail", "2.80 s", "3 to 900 s"), steady] }),
  ]));
  const checks = md.slice(md.indexOf("## Checks"), md.indexOf("## Limits"));
  assert.match(checks, /- reels\.mp4, length: fail, 2\.80 s \(asked for: 3 to 900 s\)\./);
  assert.match(checks, /- tiktok\.mp4, steady frame rate: warn/);
  assert.doesNotMatch(checks, /reels\.mp4, steady frame rate/);
  assert.match(checks, /A copy's warnings and failures that are those of the file it copies are given once, under that file\./);
  assert.doesNotMatch(checks, /Every check passed/);
  const clean = formatsMarkdown(r([file("tiktok", "TikTok", { checks: [row("length", "pass", "2.80 s", "180 s at most")] })]));
  assert.match(clean, /## Checks\n\n.*\n\nEvery check passed\./);
});

test("a still title card too small for LinkedIn, with or without a silent track, is encoded again to reach 75 KB, and sizes under a megabyte read in KB", () => {
  const file = path.join(dir, "card.mp4");
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "color=c=0x101418:s=640x360:r=30:d=4,drawbox=x=200:y=150:w=240:h=60:color=white:t=fill", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", file]);
  const run = cli([file, "--for", "linkedin", "--out", outDir("card")]);
  assert.equal(run.status, 0, run.stderr);
  const bytes = fs.statSync(path.join(outDir("card"), "linkedin.mp4")).size;
  assert.ok(bytes >= 75_000 && bytes < 150_000, `${bytes} bytes`);
  assert.match(run.stdout, /linkedin\.mp4 +1920x1080 +4\.00 s +\d+ KB +no sound\n/);
  const formats = JSON.parse(fs.readFileSync(path.join(outDir("card"), "formats.json"), "utf8"));
  assert.ok(formats.files[0].raised && formats.files[0].pass, JSON.stringify(formats.files[0].checks.filter((c) => c.status !== "pass")));
  // The summary and FORMATS.md say it was encoded again, and why.
  const said = /linkedin\.mp4 came out at \d+ KB, under the 75 KB LinkedIn takes at least, so it was encoded again at a steady \d\.\d\d Mb\/s, padded where the picture needs less\./;
  assert.match(run.stdout, new RegExp(`Note: ${said.source}`));
  assert.match(fs.readFileSync(path.join(outDir("card"), "FORMATS.md"), "utf8"), said);
  // A card of 3.5 s with a silent track, which takes a few kb/s, not the
  // 192 it was encoded at: the rate is raised with what the sound takes.
  const silent = path.join(dir, "card-silent.mp4");
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "color=c=0x1a6b45:s=640x360:r=30:d=3.5,drawbox=x=200:y=150:w=240:h=60:color=white:t=fill", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=3.5", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", silent]);
  const quiet = cli([silent, "--for", "linkedin", "--out", outDir("card-silent"), "--json"]);
  assert.equal(quiet.status, 0, quiet.stderr);
  const q = JSON.parse(quiet.stdout).files[0];
  assert.ok(q.raised && q.pass, `${q.bytes} bytes: ${JSON.stringify(q.checks.filter((c) => c.status !== "pass"))}`);
  assert.ok(fs.statSync(path.join(outDir("card-silent"), "linkedin.mp4")).size >= 75_000);
  // A file encoded again up to three times says what it came to when the
  // last time still missed.
  const { resizedText } = require("../skills/reframekit/scripts/lib/report");
  assert.equal(resizedText({ file: "linkedin.mp4", bytes: 70_000, raised: { bitrate: 3e5, rounds: 3, firstBytes: 2e4, limit: 75_000, place: "LinkedIn", by: "LinkedIn" } }), "linkedin.mp4 came out at 20 KB, under the 75 KB LinkedIn takes at least, so it was encoded again at a steady bit rate, padded where the picture needs less, three times in all as it still came out under, the last at 0.30 Mb/s. It still came out at 70 KB.");
  assert.equal(resizedText({ file: "linkedin.mp4", bytes: 90_000, raised: { bitrate: 2e5, rounds: 2, firstBytes: 2e4, limit: 75_000, place: "LinkedIn", by: "LinkedIn" } }), "linkedin.mp4 came out at 20 KB, under the 75 KB LinkedIn takes at least, so it was encoded again at a steady bit rate, padded where the picture needs less, twice in all as it still came out under, the last at 0.20 Mb/s.");
});

test("a plan made with --mode fit renders in fit mode with --crop", () => {
  const out = outDir("fit-plan");
  const plan = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--mode", "fit", "--out", out]);
  assert.equal(plan.status, 0, plan.stderr);
  // Its crop.json says fit, so the command to render it needs no --mode.
  const next = plan.stdout.trim().split("\n").pop();
  assert.match(next, /--crop .*crop\.json --for 360x640 --out \S+$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "crop.json"), "utf8")).mode, "fit");
  const run = cli([fixture("twoShots"), "--crop", path.join(out, "crop.json"), "--for", "360x640", "--out", out, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const f = JSON.parse(run.stdout);
  assert.deepEqual([f.mode, f.files[0].width, f.files[0].height], ["fit", 360, 202]);
});

test("files made with --mode fit are cropped or padded once crop.json's top mode is set to windows, as their FORMATS.md says", () => {
  const out = outDir("fit-advice");
  const run = cli([fixture("twoShots"), "--for", "360x640", "--mode", "fit", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const md = fs.readFileSync(path.join(out, "FORMATS.md"), "utf8");
  // The command to render again has no --mode, and leaving --mode out
  // still renders fit, as crop.json's top mode says: that mode is what
  // FORMATS.md says to change.
  assert.match(md, /These files keep the picture's shape, as crop\.json's top mode, fit, says\. To crop or pad each shot to each place's shape instead, set that mode to windows and render again with the command below/);
  assert.doesNotMatch(md, /Run without --mode/);
  const next = /Then render again, from the folder this run was started in: `([^`]+)`/.exec(md)[1];
  assert.doesNotMatch(next, /--mode/);
  const file = path.join(out, "crop.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), mode: "windows" }, null, 2));
  const again = spawnSync("sh", ["-c", next], { encoding: "utf8", timeout: 600_000, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` } });
  assert.equal(again.status, 0, again.stderr);
  const f = JSON.parse(fs.readFileSync(path.join(out, "formats.json"), "utf8"));
  assert.deepEqual([f.mode, f.files[0].width, f.files[0].height], ["follow", 360, 640]);
});

test("the command a render prints to render again has the run's other options, and following it makes the files the same way", () => {
  const here = outDir("again-command");
  fs.mkdirSync(here, { recursive: true });
  fs.copyFileSync(fixture("twoShots"), path.join(here, "film.mp4"));
  const first = cli(["film.mp4", "--for", "180x180", "--pad", "#0f172a", "--seconds", "3", "--lufs", "-16", "--fps", "25", "--no-trim", "--out", "n1"], { cwd: here });
  assert.equal(first.status, 0, first.stderr);
  const next = first.stdout.trim().split("\n").pop().trim();
  assert.match(next, /^node .*reframekit\.js'? film\.mp4 --crop n1\/crop\.json --for 180x180 --out n1 --pad '#0f172a' --seconds 3 --no-trim --lufs -16 --fps 25$/);
  assert.ok(fs.readFileSync(path.join(here, "n1", "FORMATS.md"), "utf8").includes(`\`${next}\``));
  const settings = () => {
    const f = JSON.parse(fs.readFileSync(path.join(here, "n1", "formats.json"), "utf8"));
    return [f.pad, f.lufs, f.seconds, f.fps, f.trim, f.files[0].seconds, f.files[0].fps];
  };
  const before = settings();
  const again = spawnSync("sh", ["-c", next], { cwd: here, encoding: "utf8", timeout: 600_000, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` } });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(settings(), before);
});

test("a file too short for its place is said to be so, not cut; a video cut short is refused, and one whose index states a length its picture and sound do not reach gets a note", () => {
  const out = outDir("short-reels");
  const short = path.join(dir, "short2.mp4");
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", short]);
  const run = cli([short, "--for", "reels", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const md = fs.readFileSync(path.join(out, "FORMATS.md"), "utf8");
  assert.match(md, /reels\.mp4 is 2\.00 s, outside what Instagram Reels takes \(3 to 900 s\)/);
  assert.doesNotMatch(md, /No file was cut/);
  // Its index first, then half its data cut away, as a copy that stopped
  // leaves it: refused before any work, as the check fails it.
  const cut = path.join(dir, "cut-short.mp4");
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=8", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", cut]);
  fs.truncateSync(cut, Math.round(fs.statSync(cut).size * 0.55));
  const r = cli([cut, "--for", "180x320", "--out", outDir("cut-short"), "--json"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /^reframekit: Cannot read .*cut-short\.mp4: it is cut short, its media \(the mdat box\) running \d+ KB past its end\. Copy or download it again, or, for a recording that stopped part way, make a whole file of the part that is there with ffmpeg -c copy, and reframe that\.$/m);
  // A whole video of 4 s with a caption track of 8 s: ffmpeg 4.4 gives it
  // the caption's length, so its files come out shorter than planned and
  // a note says why; ffmpeg 8 gives it the length of its picture and sound.
  const srt = path.join(dir, "long-caption.srt");
  fs.writeFileSync(srt, "1\n00:00:00,000 --> 00:00:08,000\nA caption that runs on\n");
  const texted = path.join(dir, "texted.mp4");
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=4", "-i", srt, "-map", "0", "-map", "1", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:s", "mov_text", texted]);
  const t = cli([texted, "--for", "180x320", "--out", outDir("texted"), "--json"]);
  assert.equal(t.status, 0, t.stderr);
  const f = JSON.parse(t.stdout);
  assert.ok(Math.abs(f.files[0].seconds - 4) < 0.1, `${f.files[0].seconds} s`);
  if (f.source.seconds > 5) assert.match(f.notes.join(" "), /180x320\.mp4 is 4\.0\d s, shorter than the 8\.00 s planned: the video's picture or sound ends before the length its index states, so the files end there too\./);
  else assert.doesNotMatch(f.notes.join(" "), /shorter than/);
});
