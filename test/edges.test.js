"use strict";

// The odd inputs: mono sound at 44.1 kHz, silent sound, no sound, a frame
// rate that varies, 23.976 and 120 fps, a phone video stored sideways,
// pixels that are not square, black bars, a path with spaces and letters
// from other scripts, and a WebM that states no length. And a run again
// in the same folder.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { fixture, ffmpeg, probe, loudness, frameAt, cli, outDir, dir, knows, CLI, ENCODE, SOUND } = require("./helpers");

const make = (name, args) => fixture(name, { name: "x", make: (file) => ffmpeg([...args, file]) });
const moving = (size = "640x360", d = 2, rate = 30) => ["-f", "lavfi", "-i", `color=c=0x203040:s=${size}:r=${rate}:d=${d}`, "-f", "lavfi", "-i", `color=c=white:s=40x40:r=${rate}:d=${d}`];
const MOVE = "[0][1]overlay=x='60+200*t':y=160";

function run(file, args, name) {
  const out = outDir(name);
  const r = cli([file, ...args, "--out", out, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  return { out, formats: JSON.parse(r.stdout) };
}

test("mono sound at 44.1 kHz comes out stereo at 48 kHz and -14 LUFS", () => {
  const file = make("mono44", [...moving(), "-f", "lavfi", "-i", "sine=f=300:r=44100:d=2,volume=0.2", "-filter_complex", `${MOVE}[v]`, "-map", "[v]", "-map", "2:a", "-ac", "1", ...ENCODE, ...SOUND]);
  assert.deepEqual([probe(file).audio.sampleRate, probe(file).audio.channels], [44100, 1]);
  const { out } = run(file, ["--for", "360x640"], "mono44");
  const info = probe(path.join(out, "360x640.mp4"));
  assert.deepEqual([info.audio.sampleRate, info.audio.channels], [48000, 2]);
  assert.ok(Math.abs(loudness(path.join(out, "360x640.mp4")).integrated + 14) <= 0.5);
});

test("silent sound is kept as it is, and no sound stays no sound", () => {
  const silent = make("silent", [...moving(), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=2", "-filter_complex", `${MOVE}[v]`, "-map", "[v]", "-map", "2:a", ...ENCODE, ...SOUND, "-shortest"]);
  const a = run(silent, ["--for", "360x640"], "silent");
  assert.equal(a.formats.files[0].lufs, null);
  assert.match(a.formats.notes.join(" "), /The sound is silent/);
  assert.ok(probe(path.join(a.out, "360x640.mp4")).audio, "the silent sound track is kept");
  const none = make("mute", [...moving(), "-filter_complex", `${MOVE}[v]`, "-map", "[v]", ...ENCODE]);
  const b = run(none, ["--for", "360x640"], "mute");
  assert.equal(probe(path.join(b.out, "360x640.mp4")).audio, undefined);
  assert.match(fs.readFileSync(path.join(b.out, "FORMATS.md"), "utf8"), /no sound, so neither have the files/);
});

test("a video of two sound tracks keeps the first, and FORMATS.md says the second is not in the files", () => {
  const file = make("two-tracks", [...moving(), "-f", "lavfi", "-i", "sine=f=440:r=48000:d=2", "-f", "lavfi", "-i", "sine=f=880:r=48000:d=2", "-filter_complex", `${MOVE}[v]`, "-map", "[v]", "-map", "2:a", "-map", "3:a", ...ENCODE, ...SOUND, "-shortest"]);
  const { out, formats } = run(file, ["--for", "360x640"], "two-tracks");
  assert.match(formats.notes.join(" "), /The video has 2 sound tracks; only the first is in the files\./);
  assert.match(fs.readFileSync(path.join(out, "FORMATS.md"), "utf8"), /only the first is in the files/);
  const streams = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path.join(out, "360x640.mp4")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  assert.deepEqual(streams, ["video", "audio"]);
});

test("a frame rate that varies comes out steady at its fast rate; 23.976 stays, 120 halves to 60 and 15 goes up to 30, each with a note", () => {
  // 30 fps for the first second, 15 after it.
  const vfr = make("vfr", [...moving(), "-filter_complex", `${MOVE},setpts='if(lt(N,30),N/30/TB,(30+(N-30)*2)/30/TB)'[v]`, "-map", "[v]", ...(knows("-fps_mode") ? ["-fps_mode", "vfr"] : ["-vsync", "vfr"]), ...ENCODE]);
  const p = probe(vfr);
  assert.ok(Math.abs(p.video.fps - p.video.baseFps) > 1, `the test video varies: ${p.video.fps} and ${p.video.baseFps}`);
  const a = run(vfr, ["--for", "360x640"], "vfr");
  const out = probe(path.join(a.out, "360x640.mp4"));
  assert.equal(out.video.fps, out.video.baseFps);
  assert.equal(out.video.fps, 30);
  // Every frame of the fast second is kept (by best_effort_timestamp_time,
  // which ffprobe 4.4 has; its frames have no pts_time).
  const times = require("node:child_process").spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", path.join(a.out, "360x640.mp4")], { encoding: "utf8" }).stdout.split("\n").filter((t) => t && parseFloat(t) < 1 - 1e-6);
  assert.equal(times.length, 30);
  assert.match(a.formats.notes.join(" "), /do not come at one steady rate/);
  const film = make("ntsc", [...moving("640x360", 2, "24000/1001"), "-filter_complex", `${MOVE}[v]`, "-map", "[v]", ...ENCODE]);
  const b = run(film, ["--for", "360x640"], "ntsc");
  assert.ok(Math.abs(probe(path.join(b.out, "360x640.mp4")).video.fps - 23.976) < 0.001);
  assert.doesNotMatch(b.formats.notes.join(" "), /The video runs at/);
  const fast = make("fast", [...moving("320x180", 1, 120), "-filter_complex", "[0][1]overlay=x='60+100*t':y=60[v]", "-map", "[v]", ...ENCODE]);
  const c = run(fast, ["--for", "180x320"], "fast");
  assert.equal(probe(path.join(c.out, "180x320.mp4")).video.fps, 60);
  assert.match(c.formats.notes.join(" "), /The video runs at 120 fps; the files run at 60, as TikTok and Instagram take 60 fps at most\./);
  // A rate the places refuse, and one asked for, which gets no note.
  const slow = make("slow15", [...moving("320x180", 2, 15), "-filter_complex", "[0][1]overlay=x='60+100*t':y=60[v]", "-map", "[v]", ...ENCODE]);
  const d = run(slow, ["--for", "180x320"], "slow15");
  assert.equal(probe(path.join(d.out, "180x320.mp4")).video.fps, 30);
  assert.match(d.formats.notes.join(" "), /The video runs at 15 fps; the files run at 30, as TikTok and Instagram take 23 fps at least\./);
  assert.match(fs.readFileSync(path.join(d.out, "FORMATS.md"), "utf8"), /The video runs at 15 fps; the files run at 30/);
  const asked = JSON.parse(cli([slow, "--for", "180x320", "--fps", "25", "--plan", "--out", outDir("slow15-asked"), "--json"]).stdout);
  assert.doesNotMatch(asked.notes.join(" "), /The video runs at/);
  // A fastest rate is said only where the files' rate comes from it: one
  // over 120 fps is what ffprobe gives frames at odd times.
  const { variableNote } = require("../skills/reframekit/scripts/lib/reframe");
  assert.equal(variableNote({ fps: 20.15, baseFps: 30, variable: true }), "The video's frames do not come at one steady rate (20.15 fps on average, 30 at its fastest); the files run at a steady 30 fps.");
  assert.equal(variableNote({ fps: 16.43, baseFps: 240, variable: true }), "The video's frames come at uneven times (16.43 fps on average); the files run at a steady 30 fps.");
  assert.equal(variableNote({ fps: 47.5, baseFps: 1000, variable: true }), "The video's frames come at uneven times (47.5 fps on average); the files run at a steady 48 fps.");
});

test("a phone video stored sideways is shown upright, and its files are stored upright", () => {
  const flat = make("flat", [...moving("640x360"), "-filter_complex", `${MOVE}[v]`, "-map", "[v]", ...ENCODE]);
  const turned = path.join(dir, "turned.mp4");
  // ffmpeg 4.4 has no -display_rotation; it takes the rotate tag instead.
  ffmpeg(knows("-display_rotation") ? ["-display_rotation", "90", "-i", flat, "-c", "copy", turned] : ["-i", flat, "-c", "copy", "-metadata:s:v:0", "rotate=90", turned]);
  assert.ok(probe(turned).video.sideData.some((d) => Number(d.rotation)), "the test video carries a rotation");
  const { out, formats } = run(turned, ["--for", "360x640,640x360"], "turned");
  assert.deepEqual([formats.source.width, formats.source.height, formats.source.rotation], [360, 640, 90]);
  const tall = probe(path.join(out, "360x640.mp4"));
  assert.deepEqual([tall.video.width, tall.video.height], [360, 640]);
  assert.ok(!tall.video.sideData.some((d) => Number(d.rotation)), "no rotation left in the file");
  const crop = JSON.parse(fs.readFileSync(path.join(out, "crop.json"), "utf8"));
  assert.equal(crop.shots[0].windows["9:16"].mode, "full");
});

test("pixels that are not square are made square first", () => {
  const file = make("anamorphic", ["-f", "lavfi", "-i", "color=c=0x203040:s=480x360:r=30:d=2", "-f", "lavfi", "-i", "color=c=white:s=30x40:r=30:d=2", "-filter_complex", "[0][1]overlay=x='40+150*t':y=160,setsar=4/3[v]", "-map", "[v]", ...ENCODE]);
  const { out, formats } = run(file, ["--for", "360x640"], "anamorphic");
  assert.deepEqual([formats.source.width, formats.source.height], [640, 360]);
  const crop = JSON.parse(fs.readFileSync(path.join(out, "crop.json"), "utf8"));
  assert.deepEqual([crop.width, crop.height], [640, 360]);
  assert.match(formats.notes.join(" "), /pixels are not square/);
});

test("black bars around the picture are found and left out", () => {
  const file = make("letterbox", ["-f", "lavfi", "-i", "testsrc2=s=640x272:r=30:d=2", "-vf", "pad=640:360:0:44:black", ...ENCODE]);
  const { out, formats } = run(file, ["--for", "360x640,640x360"], "letterbox");
  assert.deepEqual(formats.source.picture, [0, 44, 640, 272]);
  assert.match(formats.notes.join(" "), /Black bars were found/);
  // The 16:9 file shows the picture without the bars, padded on its blur.
  const crop = JSON.parse(fs.readFileSync(path.join(out, "crop.json"), "utf8"));
  assert.notEqual(crop.shots[0].windows["16:9"].mode, "full");
  const tall = frameAt(path.join(out, "360x640.mp4"), 1);
  const black = tall.count((r, g, b) => r + g + b < 20);
  assert.ok(black < tall.width * tall.height * 0.05, `${black} black pixels in the 9:16 file`);
});

test("a path with spaces and letters of other scripts, and its folder name", () => {
  const folder = path.join(dir, "my clips", "çekim ğünü");
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "Ünlü 映像 'take' 1.mp4");
  fs.copyFileSync(fixture("twoShots"), file);
  const r = cli([file, "--for", "360x640", "--json"], { cwd: folder });
  assert.equal(r.status, 0, r.stderr);
  const made = path.join(folder, "reframekit-ünlü-映像-take-1");
  assert.ok(fs.existsSync(path.join(made, "360x640.mp4")), fs.readdirSync(folder).join(", "));
  assert.equal(JSON.parse(r.stdout).video, "Ünlü 映像 'take' 1.mp4");
});

test("a run again in its folder replaces the files it makes again and keeps the other places' files", () => {
  const file = fixture("twoShots");
  const out = outDir("again");
  assert.equal(cli([file, "--for", "360x640,480x480", "--out", out]).status, 0);
  fs.writeFileSync(path.join(out, "notes.txt"), "mine");
  const before = fs.readFileSync(path.join(out, "360x640.mp4"));
  const second = cli([file, "--for", "480x480", "--out", out, "--json"]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ["360x640-cover.jpg", "360x640.mp4", "480x480-cover.jpg", "480x480.mp4", "FORMATS.md", "crop.json", "formats.json", "notes.txt", "sheet.png"]);
  assert.ok(fs.readFileSync(path.join(out, "360x640.mp4")).equals(before), "the 9:16 file is the earlier run's");
  const formats = JSON.parse(second.stdout);
  assert.deepEqual(formats.files.map((f) => [f.file, Boolean(f.earlier)]), [["480x480.mp4", false], ["360x640.mp4", true]]);
  assert.ok("360x640.mp4" in formats.written && !("notes.txt" in formats.written));
  assert.match(fs.readFileSync(path.join(out, "FORMATS.md"), "utf8"), /360x640\.mp4 was not made again: it is from an earlier run/);
  // The check of the earlier files is out of date once files are made again.
  assert.equal(cli(["check", out]).status, 0);
  const third = cli([file, "--for", "480x480", "--out", out]);
  assert.equal(third.status, 0, third.stderr);
  assert.ok(!fs.existsSync(path.join(out, "CHECK.md")) && !fs.existsSync(path.join(out, "check.json")));
  assert.match(third.stdout, /Removed from the earlier run: (CHECK\.md, check\.json|check\.json, CHECK\.md)/);
});

test("the files a run keeps are measured again, so a formats.json edited by hand can neither say they passed nor stop the run once its files are made", () => {
  const file = fixture("twoShots");
  const out = outDir("edited-formats");
  assert.equal(cli([file, "--for", "360x640,480x480", "--out", out]).status, 0);
  const formats = JSON.parse(fs.readFileSync(path.join(out, "formats.json"), "utf8"));
  const square = formats.files.find((f) => f.file === "480x480.mp4");
  delete square.checks;
  square.pass = true;
  square.lufs = "loud";
  square.trimmed = { end: "soon" };
  formats.files.push({ ...square, place: "myspace" });
  formats.limits["480x480"] = { seconds: { max: 1, note: 5 } };
  fs.writeFileSync(path.join(out, "formats.json"), JSON.stringify(formats, null, 2));
  const r = cli([file, "--for", "360x640", "--out", out, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const kept = JSON.parse(r.stdout).files.filter((f) => f.earlier);
  assert.equal(kept.length, 1, "the entry for no place is left out");
  assert.deepEqual([kept[0].file, kept[0].trimmed, kept[0].pass], ["480x480.mp4", null, true]);
  assert.ok(Math.abs(kept[0].lufs + 14) <= 0.5 && kept[0].truePeak <= -1, `the loudness, measured again: ${kept[0].lufs} LUFS, ${kept[0].truePeak} dBTP`);
  assert.ok(kept[0].checks.some((c) => c.name === "size" && c.status === "pass"), JSON.stringify(kept[0].checks));
  assert.deepEqual(JSON.parse(r.stdout).limits["480x480"], {});
  assert.match(fs.readFileSync(path.join(out, "FORMATS.md"), "utf8"), /\| 480x480\.mp4 \| 480x480 \| 480x480 \| 4\.00 s \| \d+ KB \| -1\d\.\d LUFS, -\d+\.\d dBTP \| pass \(from an earlier run\) \|/);
  // A true peak left out beside a loudness is measured again as well.
  const again = JSON.parse(fs.readFileSync(path.join(out, "formats.json"), "utf8"));
  again.files.find((f) => f.earlier).truePeak = null;
  fs.writeFileSync(path.join(out, "formats.json"), JSON.stringify(again, null, 2));
  const third = cli([file, "--for", "360x640", "--out", out, "--json"]);
  assert.equal(third.status, 0, third.stderr);
  assert.equal(typeof JSON.parse(third.stdout).files.find((f) => f.earlier).truePeak, "number");
  // A file formats.json gives only a place reframekit does not make is
  // left out, and a note says so; listed for a place it makes too, as
  // above, it is not.
  assert.ok(!JSON.parse(r.stdout).notes.some((n) => /left out of this report/.test(n)), JSON.parse(r.stdout).notes.join("\n"));
  const placeless = JSON.parse(fs.readFileSync(path.join(out, "formats.json"), "utf8"));
  placeless.files.find((f) => f.earlier).place = "myspace";
  fs.writeFileSync(path.join(out, "formats.json"), JSON.stringify(placeless, null, 2));
  const fourth = cli([file, "--for", "360x640", "--out", out, "--json"]);
  assert.equal(fourth.status, 0, fourth.stderr);
  const left = JSON.parse(fourth.stdout);
  assert.deepEqual(left.files.map((f) => f.file), ["360x640.mp4"]);
  assert.ok(left.notes.includes("480x480.mp4, kept from an earlier run, is left out of this report: formats.json gives it the place myspace, which reframekit does not make."), left.notes.join("\n"));
});

// When a file's loudest sound and its first bright frame come, between
// `from` and `to` seconds: its click and its flash.
function moments(file, from = 0, to = Infinity) {
  const pcm = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-af", "aresample=first_pts=0", "-ac", "1", "-f", "f32le", "-"], { maxBuffer: 64 * 1024 * 1024 }).stdout;
  let peak = 0;
  let click = 0;
  for (let i = Math.round(from * 48000); i < Math.min(pcm.length / 4, to * 48000); i++) {
    const value = Math.abs(pcm.readFloatLE(4 * i));
    if (value > peak) {
      peak = value;
      click = i / 48000;
    }
  }
  // The first bright frame, from signalstats' average brightness.
  // The file is named inside the filter graph, so ffmpeg runs in the
  // test folder and the name has no path.
  const notes = `yavg-${path.basename(file)}.txt`;
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-map", "0:v", "-vf", `signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=${notes}`, "-f", "null", "-"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  let flash = null;
  let at = null;
  for (const line of fs.readFileSync(path.join(dir, notes), "utf8").split("\n")) {
    const f = /pts_time:(\S+)/.exec(line);
    if (f) at = Number(f[1]);
    const m = /YAVG=(\S+)/.exec(line);
    if (m && Number(m[1]) > 100 && flash === null && at >= from - 1e-6 && at < to) flash = at;
  }
  return { click, flash };
}

// A flash on the frame at `at` s and a click at `at` s.
const flashClick = (at = 1) => make(at === 1 ? "flashclick" : `flashclick-${at}`, ["-f", "lavfi", "-i", `color=c=black:s=320x180:r=30:d=3,format=yuv420p,geq=lum='if(between(T,${at - 0.01},${at + 0.02}),235,16)':cb=128:cr=128`, "-f", "lavfi", "-i", `aevalsrc='0.05*sin(2*PI*300*t)+if(between(t,${at},${at + 0.002}),0.9,0)':s=48000:d=3`, ...ENCODE, ...SOUND]);

test("a picture that starts after its sound, or sound after its picture, stays where it was against the other", () => {
  // The picture or the sound moved half a second later in the file.
  const both = flashClick();
  const lateVideo = path.join(dir, "late-video.mp4");
  ffmpeg(["-itsoffset", "0.5", "-i", both, "-i", both, "-map", "0:v", "-map", "1:a", "-c", "copy", lateVideo]);
  const lateSound = path.join(dir, "late-sound.mp4");
  ffmpeg(["-i", both, "-itsoffset", "0.5", "-i", both, "-map", "0:v", "-map", "1:a", "-c", "copy", lateSound]);
  for (const [file, want] of [[lateVideo, { click: 1, flash: 1.5 }], [lateSound, { click: 1.5, flash: 1 }]]) {
    const { out } = run(file, ["--for", "180x320", "--mode", "pad"], path.basename(file, ".mp4"));
    const got = moments(path.join(out, "180x320.mp4"));
    assert.ok(Math.abs(got.click - want.click) < 0.03, `${path.basename(file)}: the click is at ${got.click}`);
    assert.ok(Math.abs(got.flash - want.flash) < 0.04, `${path.basename(file)}: the flash is at ${got.flash}`);
  }
});

test("in an MPEG-TS, which ffmpeg times from the start of the streams a run reads, the sound keeps its place against the picture", () => {
  // The sound a second after the picture, the picture a second after the
  // sound, and the file as it is, whose sound starts 21 ms early: the
  // AAC encoder's own samples, which the MP4's edit list hid.
  const both = flashClick();
  const files = {
    "sound-late.ts": [["-i", both, "-itsoffset", "1", "-i", both], { click: 2, flash: 1 }],
    "picture-late.ts": [["-itsoffset", "1", "-i", both, "-i", both], { click: 1, flash: 2 }],
    "remuxed.ts": [["-i", both, "-i", both], { click: 1, flash: 1 }],
  };
  for (const [name, [inputs, want]] of Object.entries(files)) {
    const file = path.join(dir, name);
    ffmpeg([...inputs, "-map", "0:v", "-map", "1:a", "-c", "copy", "-f", "mpegts", file]);
    const { out } = run(file, ["--for", "180x320", "--mode", "pad"], name.replace(".", "-"));
    const got = moments(path.join(out, "180x320.mp4"));
    // Within half a frame, as the frames land on the file's steady rate,
    // and the 2 ms the click lasts.
    const off = got.click - got.flash - (want.click - want.flash);
    assert.ok(Math.abs(off) < 1 / 60 + 0.002, `${name}: the click is at ${got.click} s and the flash at ${got.flash} s`);
  }
});

test("an MPEG-TS whose times jump, as two recordings joined with cat, comes out with its parts back to back, the sound with the picture in each", () => {
  // Two recordings of 3 s, the flash and the click at 1 s in the first
  // and at 2 s in the second, whose times start 30 s later.
  const first = path.join(dir, "first.ts");
  ffmpeg(["-i", flashClick(1), "-c", "copy", "-f", "mpegts", first]);
  const second = path.join(dir, "second.ts");
  ffmpeg(["-i", flashClick(2), "-c", "copy", "-output_ts_offset", "30", "-f", "mpegts", second]);
  const joined = path.join(dir, "joined.ts");
  fs.writeFileSync(joined, Buffer.concat([fs.readFileSync(first), fs.readFileSync(second)]));
  assert.ok(probe(joined).duration > 30, "ffprobe gives the joined file the jump's length");
  const { out, formats } = run(joined, ["--for", "180x320", "--mode", "pad"], "joined-ts");
  const file = path.join(out, "180x320.mp4");
  assert.ok(Math.abs(probe(file).duration - 6) < 0.1, `the file is ${probe(file).duration} s`);
  assert.match(formats.notes.join(" "), /joined\.ts gives its length as 3\d\.\d\d s, but its picture and sound last 6\.\d\d s: its times jump, as where two recordings were joined, so the files hold its parts back to back\./);
  // The second part's flash 2 s into it. ffmpeg's copy puts that part's
  // sound after the first part's, which ends a little after its picture,
  // so it can come up to a frame late there.
  for (const [from, at, within] of [[0, 1, 1 / 60 + 0.002], [3, 5, 1 / 30 + 0.002]]) {
    const got = moments(file, from, from + 3);
    assert.ok(Math.abs(got.flash - at) < 0.05, `the flash after ${from} s is at ${got.flash} s`);
    assert.ok(Math.abs(got.click - got.flash) < within, `after ${from} s the click is at ${got.click} s and the flash at ${got.flash} s`);
  }
  // Two recordings whose times both start at the same moment, as two
  // files of one recorder are, joined with cat: a jump back.
  const again = path.join(dir, "again.ts");
  ffmpeg(["-i", flashClick(2), "-c", "copy", "-f", "mpegts", again]);
  const back = path.join(dir, "back.ts");
  fs.writeFileSync(back, Buffer.concat([fs.readFileSync(first), fs.readFileSync(again)]));
  const b = run(back, ["--for", "180x320", "--mode", "pad"], "back-ts");
  const backFile = path.join(b.out, "180x320.mp4");
  assert.ok(Math.abs(probe(backFile).duration - 6) < 0.1, `the file is ${probe(backFile).duration} s`);
  for (const [from, at] of [[0, 1], [3, 5]]) {
    const got = moments(backFile, from, from + 3);
    assert.ok(Math.abs(got.flash - at) < 0.05, `back.ts: the flash after ${from} s is at ${got.flash} s`);
    assert.ok(Math.abs(got.click - got.flash) < 1 / 30 + 0.002, `back.ts: after ${from} s the click is at ${got.click} s and the flash at ${got.flash} s`);
  }
  // A jump ahead of ten seconds or less is a gap, which ffmpeg keeps: the
  // second recording 5 s after the first's start leaves 2 s between them.
  const soon = path.join(dir, "soon.ts");
  ffmpeg(["-i", flashClick(2), "-c", "copy", "-output_ts_offset", "5", "-f", "mpegts", soon]);
  const gap = path.join(dir, "gap.ts");
  fs.writeFileSync(gap, Buffer.concat([fs.readFileSync(first), fs.readFileSync(soon)]));
  const g = run(gap, ["--for", "180x320", "--mode", "pad"], "gap-ts");
  assert.ok(Math.abs(probe(path.join(g.out, "180x320.mp4")).duration - 8) < 0.15, `the file is ${probe(path.join(g.out, "180x320.mp4")).duration} s`);
  // The run says where, and what the files hold there; the picture's rate
  // is that of its frames, not one the gap makes up (ffprobe gives the
  // copy 20 fps on average).
  const said = g.formats.notes.join(" ");
  assert.match(said, /gap\.ts has no picture or sound from 3\.0\d s to 4\.9\d s, as where two recordings were joined: the files hold the picture there and are silent\./);
  assert.doesNotMatch(said, /steady rate|uneven times/);
  assert.equal(g.formats.source.fps, 30);
  assert.match(fs.readFileSync(path.join(g.out, "FORMATS.md"), "utf8"), /^From gap\.ts: 320x180 at 30 fps, /m);
  // A recording joined with a copy of itself whose times start 8 s later,
  // which leaves its copy's frames at times ffprobe gives 240 fps at their
  // fastest, and 16.43 on average.
  const later = path.join(dir, "later.ts");
  ffmpeg(["-i", first, "-c", "copy", "-output_ts_offset", "8", "-f", "mpegts", later]);
  const far = path.join(dir, "far.ts");
  fs.writeFileSync(far, Buffer.concat([fs.readFileSync(first), fs.readFileSync(later)]));
  const f = run(far, ["--for", "180x320", "--mode", "pad", "--plan"], "far-ts");
  assert.match(f.formats.notes.join(" "), /far\.ts has no picture or sound from 3\.0\d s to 7\.9\d s, as where two recordings were joined: the files hold the picture there and are silent\./);
  assert.doesNotMatch(f.formats.notes.join(" "), /fastest|uneven times|steady rate/);
  assert.match(fs.readFileSync(path.join(f.out, "FORMATS.md"), "utf8"), /^320x180, 10\.9\d s, /m);
});

test("an MPEG-TS joined from two recordings at 30 fps, whose copy puts two frames of the second at the times of the first's last two, runs at its steady 30 fps, with no note of an uneven rate", () => {
  const part = (name, offset) => {
    const file = path.join(dir, name);
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=3", "-ac", "2", ...ENCODE, ...SOUND, "-output_ts_offset", String(offset), "-f", "mpegts", file]);
    return file;
  };
  const joined = path.join(dir, "joined-steady.ts");
  fs.writeFileSync(joined, Buffer.concat([fs.readFileSync(part("steady-1.ts", 0)), fs.readFileSync(part("steady-2.ts", 3))]));
  const { out, formats } = run(joined, ["--for", "180x320"], "joined-steady");
  assert.doesNotMatch(formats.notes.join(" "), /steady rate|uneven times|fastest/);
  assert.equal(formats.source.fps, 30);
  assert.match(fs.readFileSync(path.join(out, "FORMATS.md"), "utf8"), /^From joined-steady\.ts: 320x180 at 30 fps, /m);
  assert.equal(probe(path.join(out, "180x320.mp4")).video.fps, 30);
});

test("a picture that changes its size or its range part way, as two recordings joined or a WebM of a window resized, is read whole and comes out at the size of its first frames", () => {
  // Two seconds of a dark red picture at 320x180, then two of a dark blue
  // one, at 640x360 or at 320x180 in full range, each with a box that
  // moves and a tone, joined as cat joins two recordings.
  const part = (name, color, size, pixels = "yuv420p") => {
    const file = path.join(dir, name);
    ffmpeg(["-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=30:d=2`, "-f", "lavfi", "-i", "color=c=white:s=24x24:r=30:d=2", "-f", "lavfi", "-i", "sine=f=330:r=48000:d=2", "-filter_complex", "[0][1]overlay=x='20+60*t':y=40[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", pixels, ...SOUND, "-f", "mpegts", file]);
    return file;
  };
  const joined = (name, a, b) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.concat([fs.readFileSync(a), fs.readFileSync(b)]));
    return file;
  };
  const red = part("red-small.ts", "0x802020", "320x180");
  const blue = (r, g, b) => b > 100 && b > 2 * r;
  for (const file of [joined("sizes.ts", red, part("blue-big.ts", "0x203080", "640x360")), joined("ranges.ts", red, part("blue-full.ts", "0x203080", "320x180", "yuvj420p"))]) {
    const name = path.basename(file);
    const { out, formats } = run(file, ["--for", "320x180"], name.replace(".", "-"));
    assert.deepEqual(formats.shots.map((s) => Math.round(s.start)), [0, 2], name);
    const made = probe(path.join(out, "320x180.mp4"));
    assert.deepEqual([made.video.width, made.video.height], [320, 180], name);
    assert.ok(Math.abs(made.duration - 4) < 0.1, `${name}: ${made.duration} s`);
    const later = frameAt(path.join(out, "320x180.mp4"), 3);
    assert.ok(later.count(blue) > 0.8 * later.width * later.height, `${name}: the second part does not show at 3 s`);
  }
  // A WebM that a browser recorded while its window was resized: 320x180,
  // then 280x160, rendered through a window that moves.
  const webm = (name, size) => {
    const file = path.join(dir, name);
    ffmpeg(["-f", "lavfi", "-i", `testsrc2=s=${size}:r=30:d=2`, "-f", "lavfi", "-i", "sine=f=330:r=48000:d=2", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", file]);
    return file;
  };
  const list = path.join(dir, "resized.txt");
  fs.writeFileSync(list, `file '${webm("wide.webm", "320x180")}'\nfile '${webm("narrow.webm", "280x160")}'\n`);
  const resized = path.join(dir, "resized.webm");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", resized]);
  const out = outDir("resized-webm");
  const plan = cli([resized, "--for", "180x320", "--plan", "--out", out]);
  assert.equal(plan.status, 0, plan.stderr);
  const file = path.join(out, "crop.json");
  const crop = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const s of crop.shots) s.windows["9:16"] = { ...s.windows["9:16"], mode: "follow", path: [[s.start, 0, 0], [s.end, 200, 0]] };
  fs.writeFileSync(file, JSON.stringify(crop, null, 2));
  const r = cli([resized, "--crop", file, "--for", "180x320", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Math.abs(probe(path.join(out, "180x320.mp4")).duration - 4) < 0.1);
});

test("the moment written on each frame of the sheet sits on a patch of its own, so it reads on a light picture", () => {
  // A light page with a dark box on it, as a demo or a title card shows.
  const light = make("light-page", ["-f", "lavfi", "-i", "color=c=0xeeeeea:s=640x360:r=30:d=3,drawbox=x=100:y=100:w=80:h=80:color=0x333333:t=fill", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"]);
  const out = outDir("light-sheet");
  const r = cli([light, "--for", "square,tiktok", "--plan", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const sheet = path.join(out, "sheet.png");
  const width = probe(sheet).video.width;
  const px = spawnSync("ffmpeg", ["-v", "error", "-i", sheet, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 * 1024 * 1024 }).stdout;
  // As sheet.js lays out a page of a 640x360 video: frames of 320x180, 24
  // px in and 334 px apart, the first 122 px down; the moment, as 0.45 S,
  // 4 px in from the left and 12 px up from the foot of its frame.
  for (const m of [0, 1, 2]) {
    const fx = 24 + m * 334;
    const fy = 122;
    let dark = 0;
    let bright = 0;
    let all = 0;
    for (let y = fy + 167; y < fy + 176; y++) {
      for (let x = fx + 3; x < fx + 40; x++) {
        const i = (y * width + x) * 3;
        if (px[i] < 40 && px[i + 1] < 40 && px[i + 2] < 40) dark++;
        else if (px[i] > 200) bright++;
        all++;
      }
    }
    assert.ok(dark > 0.5 * all, `frame ${m + 1}: ${dark} of ${all} pixels around its moment are dark`);
    assert.ok(bright > 0.1 * all, `frame ${m + 1}: ${bright} of ${all} pixels of its moment are light`);
  }
});

test("the sheet's frames of an MPEG-TS and an MPEG-PS are those of the moments they are drawn for, as an MP4's are", () => {
  // Two shots of 3 s, a key frame every second (every half second in the
  // MPEG-PS), and a white box that crosses the picture at 100 px a
  // second, at x = 20 + 100 t, so a frame's box tells its time.
  const mp4 = make("clock", ["-f", "lavfi", "-i", "color=c=0x203040:s=640x360:r=30:d=3", "-f", "lavfi", "-i", "color=c=0x604020:s=640x360:r=30:d=3", "-f", "lavfi", "-i", "color=c=white:s=16x16:r=30:d=6", "-filter_complex", "[0][1]concat=n=2:v=1:a=0[bg];[bg][2]overlay=x='20+100*t':y=40,format=yuv420p[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-x264-params", "keyint=30:min-keyint=30:scenecut=0"]);
  const ts = path.join(dir, "clock.ts");
  ffmpeg(["-i", mp4, "-c", "copy", "-f", "mpegts", ts]);
  const ps = path.join(dir, "clock.mpg");
  ffmpeg(["-i", mp4, "-c:v", "mpeg2video", "-q:v", "3", "-g", "15", "-f", "mpeg", ps]);
  for (const file of [mp4, ts, ps]) {
    const name = path.basename(file);
    const out = outDir(`sheet-${name.replace(".", "-")}`);
    // youtube's window is the whole 16:9 picture, so nothing is drawn
    // over the frames.
    const r = cli([file, "--for", "youtube", "--plan", "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    const crop = JSON.parse(fs.readFileSync(path.join(out, "crop.json"), "utf8"));
    assert.deepEqual(crop.shots.map((s) => [s.start, s.end]), [[0, 3], [3, 6]], name);
    const sheet = path.join(out, "sheet.png");
    const width = probe(sheet).video.width;
    const px = spawnSync("ffmpeg", ["-v", "error", "-i", sheet, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 * 1024 * 1024 }).stdout;
    // As sheet.js lays out a page of a 640x360 video: frames of 320x180,
    // 24 px in and 334 px apart, rows from 92 px down and 232 px apart,
    // each frame 30 px under its row's top; three moments a shot.
    crop.shots.forEach((s, row) => {
      const len = s.end - s.start;
      [s.start + 0.15 * len, s.start + 0.5 * len, s.end - 0.15 * len].forEach((t, m) => {
        const fx = 24 + m * 334;
        const fy = 92 + row * 232 + 30;
        let sum = 0;
        let n = 0;
        // The box's band, above the moment written at the frame's foot.
        for (let y = fy + 10; y < fy + 40; y++) {
          for (let x = fx; x < fx + 320; x++) {
            const i = (y * width + x) * 3;
            if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) {
              sum += x - fx;
              n++;
            }
          }
        }
        assert.ok(n > 0, `${name}: the frame for ${t.toFixed(2)} s shows no box`);
        // The box's middle, 8 px wide at half size, at 10 + 50 t + 4.
        const shown = (sum / n - 14) / 50;
        const frame = Math.ceil(t * 30 - 1e-6) / 30;
        assert.ok(Math.abs(shown - frame) < 0.05, `${name}: the frame for ${t.toFixed(2)} s shows ${shown.toFixed(3)} s`);
      });
    });
  }
});

test("an MPEG-PS whose sound an MP4 cannot hold as it is, as a DVD's PCM, renders with that sound on its frame, and formats.json names the sound's own codec", () => {
  // A DVD's VOB: MPEG-2 picture and PCM sound, the flash and the click at
  // 1 s. Its copy holds the sound as ALAC.
  const vob = path.join(dir, "dvd.vob");
  ffmpeg(["-i", flashClick(), "-c:v", "mpeg2video", "-q:v", "3", "-c:a", "pcm_dvd", "-f", "vob", vob]);
  assert.equal(probe(vob).audio.codec, "pcm_dvd");
  const { out, formats } = run(vob, ["--for", "180x320", "--mode", "pad"], "dvd-vob");
  assert.equal(formats.source.sound.codec, "pcm_dvd");
  const file = path.join(out, "180x320.mp4");
  assert.equal(probe(file).audio.codec, "aac");
  assert.ok(Math.abs(loudness(file).integrated + 14) <= 0.5, `${loudness(file).integrated} LUFS`);
  const got = moments(file);
  assert.ok(Math.abs(got.flash - 1) < 0.05, `the flash is at ${got.flash} s`);
  assert.ok(Math.abs(got.click - got.flash) < 1 / 60 + 0.002, `the click is at ${got.click} s and the flash at ${got.flash} s`);
});

test("a file with sound and no picture is refused", () => {
  const sound = path.join(dir, "only-sound.m4a");
  ffmpeg(["-f", "lavfi", "-i", "sine=f=300:d=1", "-c:a", "aac", sound]);
  const r = cli([sound, "--out", outDir("only-sound")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no video stream/);
});

test("a picture under a longer sound, as ffmpeg makes an MP4 of a cover and a talk without -loop 1, is refused before any work with what it is and what to do", () => {
  const cover = path.join(dir, "cover.png");
  ffmpeg(["-f", "lavfi", "-i", "color=c=0x802020:s=320x180", "-frames:v", "1", cover]);
  const talk = path.join(dir, "talk.m4a");
  ffmpeg(["-f", "lavfi", "-i", "sine=f=330:r=48000:d=5", "-c:a", "aac", talk]);
  const file = path.join(dir, "cover-talk.mp4");
  ffmpeg(["-i", cover, "-i", talk, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file]);
  const r = cli(["cover-talk.mp4", "--for", "180x320", "--out", "cover-talk"], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^reframekit: cover-talk\.mp4 holds one picture under 5\.0\d s of sound, not a video to reframe: hold its picture as long as the sound first, as ffmpeg's tpad filter does$/m);
  assert.doesNotMatch(r.stderr, /Reading/);
  assert.ok(!fs.existsSync(outDir("cover-talk")));
  // What SKILL.md gives for it works on the file as it is: -loop 1 takes a
  // picture's own file only, and ffmpeg stops on this one.
  const skill = fs.readFileSync(path.join(__dirname, "../skills/reframekit/SKILL.md"), "utf8");
  const command = /`(ffmpeg -i <video> -vf tpad=[^`]+)`/.exec(skill)[1];
  const held = path.join(dir, "cover-talk-held.mkv");
  const words = command.split(" ").map((w) => (w === "<video>" ? file : w === "held.mkv" ? held : w.replace("stop_duration=N", "stop_duration=5")));
  const made = spawnSync(words[0], ["-v", "error", "-y", ...words.slice(1)], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const plan = cli([held, "--for", "180x320", "--plan", "--out", outDir("cover-talk-held")]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(skill, /^- "under N s of sound", as in "holds one picture under N s of sound": /m);
});

test("a picture under a longer sound in a WebM or a Matroska file is refused as in an MP4, by the length its tag gives, or by the reading where no tag gives one", () => {
  // A picture of no frame at all is not such a picture: it has none.
  const { briefPicture } = require("../skills/reframekit/scripts/lib/analyze");
  const info = { duration: 20, audio: {}, video: { fps: 25 } };
  const scores = (...t) => ({ length: t.length, t: Float64Array.from(t) });
  assert.equal(briefPicture(scores(), info), null);
  assert.deepEqual(briefPicture(scores(0), info), { frames: 1, seconds: 0.04 });
  assert.equal(briefPicture(scores(0, 0.04, 0.08, 0.12, 0.16, 0.2), info), null);
  const cover = path.join(dir, "cover-tagged.png");
  ffmpeg(["-f", "lavfi", "-i", "color=c=0x802020:s=320x180", "-frames:v", "1", cover]);
  const talk = path.join(dir, "talk-tagged.m4a");
  ffmpeg(["-f", "lavfi", "-i", "sine=f=330:r=48000:d=5", "-c:a", "aac", talk]);
  const webm = path.join(dir, "cover-talk.webm");
  ffmpeg(["-i", cover, "-i", talk, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", webm]);
  const mkv = path.join(dir, "cover-talk.mkv");
  ffmpeg(["-i", cover, "-i", talk, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", mkv]);
  // The same with ffmpeg's DURATION tags renamed, as from a muxer that
  // writes none: only the reading can tell.
  const untagged = (file) => {
    const bytes = fs.readFileSync(file);
    for (let at = bytes.indexOf("DURATION"); at >= 0; at = bytes.indexOf("DURATION", at + 1)) bytes.write("DURATIOX", at, "latin1");
    const out = file.replace(/(\.\w+)$/, "-untagged$1");
    fs.writeFileSync(out, bytes);
    return out;
  };
  for (const [file, read] of [[webm, false], [mkv, false], [untagged(webm), true], [untagged(mkv), true]]) {
    const name = path.basename(file);
    const out = `refused-${name}`;
    const r = cli([name, "--for", "180x320", "--out", out], { cwd: dir });
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^reframekit: ${name.replace(/\./g, "\\.")} holds (one picture|0\\.\\d\\d s of picture) under 5\\.0\\d s of sound, not a video to reframe: `, "m"), `${name}: ${r.stderr}`);
    if (!read) assert.doesNotMatch(r.stderr, /Reading/, `${name} is refused before any work`);
    assert.ok(!fs.existsSync(path.join(dir, out)), `${name}: ${out} is still there`);
  }
});

test("a picture that ends before its sound holds its last frame in the files to the end of the sound, and the notes and the sheet say from when", () => {
  // Two seconds of picture, a box crossing it, under five of sound.
  const file = path.join(dir, "ends-early.mp4");
  ffmpeg(["-f", "lavfi", "-i", "color=c=0x305070:s=320x180:r=30:d=2", "-f", "lavfi", "-i", "color=c=white:s=30x30:r=30:d=2", "-f", "lavfi", "-i", "sine=f=300:r=48000:d=5", "-filter_complex", "[0][1]overlay=x='20+100*t':y=60,format=yuv420p[v];[2]aformat=channel_layouts=stereo[a]", "-map", "[v]", "-map", "[a]", ...ENCODE, ...SOUND, file]);
  const note = /The picture of ends-early\.mp4 ends at 2\.00 s and its sound at 5\.0\d s: from 2\.00 s on, 180x320\.mp4 holds the picture's last frame\./;
  const out = outDir("ends-early");
  const r = cli([file, "--for", "180x320", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, note);
  assert.match(fs.readFileSync(path.join(out, "FORMATS.md"), "utf8"), note);
  const made = path.join(out, "180x320.mp4");
  const streams = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", made], { encoding: "utf8" }).stdout).streams;
  const length = (kind) => Number(streams.find((x) => x.codec_type === kind).duration);
  assert.ok(Math.abs(length("video") - length("audio")) < 0.05, `the picture lasts ${length("video")} s, the sound ${length("audio")} s`);
  // The frame at 4 s is the last one of the picture.
  const last = frameAt(made, 1.95);
  const held = frameAt(made, 4);
  let off = 0;
  for (let y = 0; y < last.height; y += 4) for (let x = 0; x < last.width; x += 4) off += Math.abs(last.at(x, y)[0] - held.at(x, y)[0]);
  assert.ok(off / ((last.height / 4) * (last.width / 4)) < 3, `the frame at 4 s is not the last one: ${off}`);
  // The sheet shows that frame at the moments after 2 s, marked, in place
  // of an empty panel: as sheet.js lays out a page of a 320x180 video, the
  // second and the third frame, 334 px apart from 24 px in, 122 px down.
  const sheet = path.join(out, "sheet.png");
  const width = probe(sheet).video.width;
  const px = spawnSync("ffmpeg", ["-v", "error", "-i", sheet, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 * 1024 * 1024 }).stdout;
  for (const m of [1, 2]) {
    const i = ((122 + 10) * width + 24 + m * 334 + 300) * 3;
    assert.ok(px[i + 2] > 90 && px[i + 2] > px[i] + 40, `frame ${m + 1} of the sheet shows no picture: ${[px[i], px[i + 1], px[i + 2]]}`);
  }
  // A file cut before the sound ends holds the frame to its own end, and
  // says so.
  const cut = outDir("ends-early-cut");
  const c = cli([file, "--for", "180x320", "--seconds", "3", "--out", cut]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, note);
  const cutLength = Number(spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", path.join(cut, "180x320.mp4")], { encoding: "utf8" }).stdout);
  assert.ok(Math.abs(cutLength - 3) < 0.05, `${cutLength} s of picture in a file cut at 3 s`);
  // Files that all end before the picture does hold nothing, and no note
  // says they do.
  const before = outDir("ends-early-before");
  const b = cli([file, "--for", "180x320,180x180", "--seconds", "1.5", "--out", before]);
  assert.equal(b.status, 0, b.stderr);
  assert.doesNotMatch(b.stdout + fs.readFileSync(path.join(before, "FORMATS.md"), "utf8"), /last frame/);
  // A plan says what a file that runs that far does.
  const plan = cli([file, "--for", "180x320", "--plan", "--out", outDir("ends-early-plan"), "--json"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(JSON.parse(plan.stdout).notes.join(" "), /The picture of ends-early\.mp4 ends at 2\.00 s and its sound at 5\.0\d s: a file that runs past 2\.00 s holds the picture's last frame from there\./);
  // Of several files, those that hold the frame are named, and every one
  // when all of them do.
  const { heldNote } = require("../skills/reframekit/scripts/lib/reframe");
  const ends = { from: 190, to: 200 };
  const job = (hold, ...names) => ({ hold, places: names.map((name) => ({ name })) });
  assert.equal(heldNote("talk.mp4", ends, [job(10, "youtube", "linkedin"), job(0, "x")]), "The picture of talk.mp4 ends at 190.00 s and its sound at 200.00 s: from 190.00 s on, youtube.mp4 and linkedin.mp4 hold the picture's last frame.");
  assert.equal(heldNote("talk.mp4", ends, [job(10, "youtube"), job(4, "x")]), "The picture of talk.mp4 ends at 190.00 s and its sound at 200.00 s: from 190.00 s on, every file holds the picture's last frame.");
  assert.equal(heldNote("talk.mp4", ends, [job(0, "x"), job(0, "tiktok", "reels")]), null);
});

test("a WebM whose container states no length is measured, not refused as a still, from where its picture and sound start", () => {
  const webm = path.join(dir, "nodur.webm");
  const r = spawnSync("sh", ["-c", `ffmpeg -v error -i "${fixture("twoShots")}" -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -c:a libopus -f webm pipe:1 > "${webm}"`]);
  assert.equal(r.status, 0, String(r.stderr));
  const plan = cli([webm, "--for", "360x640", "--plan", "--out", outDir("nodur"), "--json"]);
  assert.equal(plan.status, 0, plan.stderr);
  const crop = JSON.parse(plan.stdout);
  assert.ok(Math.abs(crop.duration - 4) < 0.1, `${crop.duration} s`);
  assert.match(crop.notes.join(" "), /does not state its length, so it was measured/);
  // One whose times start 5 s in, as a recording cut from a stream: as
  // long as its picture and sound, not as the time its last packet ends.
  const late = path.join(dir, "late-start.webm");
  const w = spawnSync("sh", ["-c", `ffmpeg -v error -f lavfi -i testsrc2=s=320x180:r=30:d=4 -f lavfi -i sine=f=300:d=4 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -c:a libopus -output_ts_offset 5 -f webm pipe:1 > "${late}"`]);
  assert.equal(w.status, 0, String(w.stderr));
  const lp = cli([late, "--for", "180x320", "--seconds", "6", "--plan", "--out", outDir("late-start"), "--json"]);
  assert.equal(lp.status, 0, lp.stderr);
  const lc = JSON.parse(lp.stdout);
  assert.ok(Math.abs(lc.duration - 4) < 0.1, `${lc.duration} s`);
  assert.match(lc.notes.join(" "), /so it was measured: 4\.0\d s/);
});

test("a WebM whose container states no length, and which ffprobe cannot measure or crashes on, is refused with what happened, and one stopped while it is measured stops at once", { skip: process.platform === "win32" }, async () => {
  const webm = path.join(dir, "nodur-unmeasured.webm");
  const made = spawnSync("sh", ["-c", `ffmpeg -v error -i "${fixture("twoShots")}" -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -c:a libopus -f webm pipe:1 > "${webm}"`]);
  assert.equal(made.status, 0, String(made.stderr));
  // An ffprobe whose list of the packets fails, as one cut off or stopped
  // part way ends, one that crashes as it lists them, and one that takes
  // 8 s to list them, as on a slow disk.
  const bin = outDir("measure-bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).stdout.trim();
  const listing = path.join(bin, "listing");
  fs.writeFileSync(path.join(bin, "failing"), `#!/bin/sh\ncase "$*" in *packet=stream_index,pts_time,dts_time*) echo "nodur-unmeasured.webm: Input/output error" >&2; exit 1;; esac\nexec "${real}" "$@"\n`);
  fs.writeFileSync(path.join(bin, "crashing"), `#!/bin/sh\ncase "$*" in *packet=stream_index,pts_time,dts_time*) kill -SEGV $$;; esac\nexec "${real}" "$@"\n`);
  fs.writeFileSync(path.join(bin, "slow"), `#!/bin/sh\ncase "$*" in *packet=stream_index,pts_time,dts_time*) : > "${listing}"; sleep 8;; esac\nexec "${real}" "$@"\n`);
  for (const name of ["failing", "crashing", "slow"]) fs.chmodSync(path.join(bin, name), 0o755);
  const r = cli(["nodur-unmeasured.webm", "--for", "180x320", "--plan", "--out", "nodur-unmeasured"], { cwd: dir, env: { ...process.env, FFPROBE_PATH: path.join(bin, "failing") } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^reframekit: nodur-unmeasured\.webm does not state its length, and ffprobe could not measure it: nodur-unmeasured\.webm: Input\/output error$/m);
  assert.doesNotMatch(r.stderr, /still picture/);
  assert.ok(!fs.existsSync(outDir("nodur-unmeasured")));
  // A crash is said as such, not as a stop.
  const crashed = cli(["nodur-unmeasured.webm", "--for", "180x320", "--plan", "--out", "nodur-unmeasured"], { cwd: dir, env: { ...process.env, FFPROBE_PATH: path.join(bin, "crashing") } });
  assert.deepEqual([crashed.status, crashed.signal], [1, null]);
  assert.match(crashed.stderr, /^reframekit: nodur-unmeasured\.webm does not state its length, and ffprobe crashed \(SIGSEGV\) while it measured it$/m);
  assert.ok(!fs.existsSync(outDir("nodur-unmeasured")));
  // A SIGTERM to node alone, as docker stop sends, while ffprobe measures.
  const out = outDir("nodur-stopped");
  // The same for a check, which writes nothing before it has measured.
  const checked = outDir("nodur-check");
  for (const args of [[webm, "--for", "180x320", "--plan", "--out", out], ["check", webm, "--for", "tiktok", "--out", checked]]) {
    fs.rmSync(listing, { force: true });
    const child = require("node:child_process").spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, FFPROBE_PATH: path.join(bin, "slow") } });
    let said = "";
    child.stderr.on("data", (chunk) => (said += chunk));
    const ended = new Promise((resolve) => child.on("close", (code, signal) => resolve(signal)));
    for (let i = 0; i < 400 && !fs.existsSync(listing); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(fs.existsSync(listing), `ffprobe never listed the packets: ${said}`);
    const sent = Date.now();
    child.kill("SIGTERM");
    assert.equal(await ended, "SIGTERM", said);
    assert.ok(Date.now() - sent < 4000, `the run took ${Date.now() - sent} ms to stop`);
    assert.ok(said.endsWith(`reframekit: stopped by SIGTERM, so ${args[0] === "check" ? "nothing was written" : `${out} is as it was`}\n`), said);
    assert.ok(!fs.existsSync(out), `${out} is still there`);
    assert.ok(!fs.existsSync(checked), `${checked} is there`);
  }
});
