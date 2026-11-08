"use strict";

// What the other kits write: launch-film's timeline, easyscreenshotkit's
// steps.json, easybrandkit's colors, and cuts given by hand.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { parseCuts, timelineFor, stepsFor, brandColor } = require("../skills/reframekit/scripts/lib/hints");
const { windowPath } = require("../skills/reframekit/scripts/lib/plan");
const { fixture, ffmpeg, cli, outDir, dir, CLI, ENCODE } = require("./helpers");

const write = (name, value) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
};

test("cuts by hand: seconds, a list, frames, a launch-film timeline or steps.json", () => {
  assert.deepEqual(parseCuts("3.2, 7.5").map((c) => c.at), [3.2, 7.5]);
  assert.deepEqual(parseCuts(write("cuts.json", [1, 2.5])).map((c) => c.at), [1, 2.5]);
  assert.deepEqual(parseCuts(write("frames.json", { fps: 25, cuts: [50, 100] })).map((c) => c.at), [2, 4]);
  const timeline = parseCuts(write("t.timeline.json", { clips: [{ start: 0 }, { start: 4 }] }));
  assert.deepEqual(timeline.map((c) => [c.at, c.span]), [[0, 0.4], [4, 0.4]]);
  assert.deepEqual(parseCuts(write("pages.json", { kind: "demo", pages: [{ start: 0 }, { start: 3.1 }] })).map((c) => c.at), [0, 3.1]);
  assert.throws(() => parseCuts(write("nothing.json", { hello: 1 })), /holds no cuts/);
  assert.throws(() => parseCuts(path.join(dir, "absent.json")), /no such file/);
});

test("cuts given at or past the video's end are named in a note, and cuts none of which falls inside the video stop the run before any work", () => {
  const { givenCuts } = require("../skills/reframekit/scripts/lib/reframe");
  const at = (list) => list.map((t) => ({ at: t, span: 0, from: "given" }));
  assert.deepEqual(givenCuts(at([0, 2.5]), 4), { cuts: at([2.5]), note: null });
  assert.equal(givenCuts(at([2, 3.99, 9]), 4).note, "--cuts gave 3.99 s and 9 s, at or past the end of the 4.00 s video; they were left out.");
  assert.deepEqual(givenCuts(at([3.99]), 4).cuts, []);
  assert.throws(() => givenCuts(at([96, 225]), 4), /--cuts gives no cut inside the video, which is 4\.00 s long \(96 s and 225 s are at or past its end\)\. Give the seconds of this video's shot changes, or frames in a JSON file with their rate/);
  const note = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--cuts", "1.5,6", "--out", outDir("cuts-past"), "--json"]);
  assert.equal(note.status, 0, note.stderr);
  const crop = JSON.parse(note.stdout);
  assert.deepEqual(crop.shots.map((s) => s.start), [0, 1.5]);
  assert.match(crop.notes.join(" "), /--cuts gave 6 s, at or past the end of the 4\.00 s video; it was left out\./);
  const frames = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--cuts", "60,90", "--out", outDir("cuts-frames")]);
  assert.equal(frames.status, 1);
  assert.match(frames.stderr, /--cuts gives no cut inside the video/);
  assert.doesNotMatch(frames.stderr, /Reading/);
  assert.ok(!fs.existsSync(outDir("cuts-frames")));
});

test("launch-film's timeline next to its film gives the shots, with the crossfade, in place of the cuts found in the picture", () => {
  const film = path.join(dir, "lf", "film.mp4");
  fs.mkdirSync(path.dirname(film), { recursive: true });
  fs.copyFileSync(fixture("twoShots"), film);
  write("lf/film.timeline.json", { film: "film.json", seconds: 4, look: "gridline", clips: [{ index: 1, kind: "scene", start: 0, seconds: 1.5 }, { index: 2, kind: "screen", start: 1.5, seconds: 2.5 }] });
  const t = timelineFor(film, 4);
  assert.deepEqual(t.cuts.map((c) => [c.at, c.span, c.from]), [[1.5, 0.4, "timeline"]]);
  assert.match(timelineFor(film, 9).ignored, /its length, 4 s, is not the video's/);
  const r = cli([film, "--for", "360x640", "--plan", "--out", outDir("timeline"), "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const crop = JSON.parse(r.stdout);
  // The timeline's cut at 1.5 alone: the picture's at 2 falls inside the
  // second clip, as a title that comes in does, and makes no shot.
  assert.deepEqual(crop.shots.map((s) => [s.start, s.cut, s.fade]), [[0, "start", 0], [1.5, "timeline", 0.4]]);
  assert.ok(crop.notes.includes("The shots start where launch-film's film.timeline.json says its clips do, and only there: a change inside a clip, as a title that comes in, is no cut."), crop.notes.join("\n"));
});

test("steps.json: the window goes to where the pointer pressed and stays on the page", () => {
  // A plain page in a frame on a dark backdrop, a button on its far right
  // where the pointer presses, and a small box bobbing on the left, away
  // from the press.
  const demo = path.join(dir, "demo", "demo.mp4");
  fs.mkdirSync(path.dirname(demo), { recursive: true });
  ffmpeg([
    "-f", "lavfi", "-i", "color=c=0x101010:s=640x360:r=30:d=3,drawbox=x=40:y=30:w=560:h=300:color=0xf4f1ea:t=fill,drawbox=x=520:y=100:w=70:h=40:color=0xe4572e:t=fill",
    "-f", "lavfi", "-i", "color=c=0x2040c0:s=20x20:r=30:d=3",
    "-filter_complex", "[0][1]overlay=x=60:y='100+60*sin(4*t)':shortest=1[v]",
    "-map", "[v]", ...ENCODE, demo,
  ]);
  write("demo/steps.json", {
    version: 1,
    kind: "demo",
    tool: "easyscreenshotkit 0.1.1",
    video: { file: "demo.mp4", width: 640, height: 360, fps: 30, frames: 90, duration: 3 },
    page: { viewport: { width: 1600, height: 900 }, density: 1.5, box: [40, 30, 560, 300], framed: true },
    pages: [{ n: 1, url: "https://example.com/", start: 0, end: 3 }],
    steps: [{ n: 1, action: "click", label: "Click Pricing", start: 0.8, end: 1.6, at: [560, 120], pressedAt: 1.2, pressedFrame: 36 }],
  });
  const s = stepsFor(demo, { duration: 3, width: 640, height: 360 });
  assert.deepEqual(s.presses.map((p) => [p.at, p.x, p.y]), [[1.2, 560, 120]]);
  assert.deepEqual(s.box, { x: 40, y: 30, w: 560, h: 300 });
  const r = cli([demo, "--for", "360x640", "--plan", "--out", outDir("demo-plan"), "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const crop = JSON.parse(r.stdout);
  const where = windowPath(crop.shots, "9:16");
  const win = crop.shots[0].windows["9:16"];
  assert.equal(win.mode, "follow");
  const [x] = where(1.2);
  assert.ok(x <= 560 && x + win.w >= 560, `at the press the window spans ${x} to ${x + win.w}`);
  for (let t = 0; t <= 3; t += 0.25) {
    const [wx] = where(t);
    assert.ok(wx >= 40 - 1 && wx + win.w <= 600 + 1, `at ${t} s the window (${wx}) leaves the page's box`);
  }
  assert.match(win.why, /the press in steps\.json/);
  assert.match(crop.notes.join(" "), /steps\.json gave 1 page and 1 press/);
});

test("a press in steps.json whose place is not two numbers is left out, and said, so its shot's window follows what moves as with no press", () => {
  const demo = path.join(dir, "unplaced", "demo.mp4");
  fs.mkdirSync(path.dirname(demo), { recursive: true });
  fs.copyFileSync(fixture("twoShots"), demo);
  write("unplaced/steps.json", { kind: "demo", video: { file: "demo.mp4", width: 640, height: 360, duration: 4 }, pages: [{ start: 0 }, { start: 2 }], steps: [{ action: "click", label: "Go", at: ["left", "top"], pressedAt: 1 }, { action: "click", label: "Go2", at: [500, 100], pressedAt: 3 }, { action: "click", label: "Go3", at: [null, 100], pressedAt: 3.5 }] });
  const s = stepsFor(demo, { duration: 4, width: 640, height: 360 });
  assert.deepEqual(s.presses.map((p) => [p.at, p.x, p.y]), [[3, 500, 100]]);
  assert.deepEqual(s.notes, ['steps.json gives the place of 2 presses as something other than two numbers of the video\'s pixels (["left","top"]), so the windows do not go to them.']);
  const r = cli([demo, "--for", "360x640", "--plan", "--out", outDir("unplaced-plan"), "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const crop = JSON.parse(r.stdout);
  // The white box that crosses the first shot is followed, all of it kept.
  const win = crop.shots[0].windows["9:16"];
  assert.ok(win.keeps >= 0.9, JSON.stringify(win));
  assert.doesNotMatch(win.why, /press/);
  assert.match(crop.notes.join(" "), /steps\.json gave 2 pages and 1 press for the windows to go to/);
  assert.ok(crop.notes.includes(s.notes[0]), crop.notes.join("\n"));
});

test("a steps.json given with --steps through a pipe, as <(...) gives one, is read once and used, by a dry run and a run alike", { skip: process.platform === "win32" }, () => {
  const video = path.join(dir, "piped", "vid.mp4");
  fs.mkdirSync(path.dirname(video), { recursive: true });
  fs.copyFileSync(fixture("twoShots"), video);
  const steps = write("piped-steps/steps.json", { kind: "demo", video: { file: "vid.mp4", width: 640, height: 360, duration: 4 }, pages: [{ start: 0 }], steps: [{ action: "click", label: "Go", at: [520, 100], pressedAt: 1 }] });
  // bash gives the file as /dev/fd/63, a pipe that can be read once.
  const piped = (...extra) => spawnSync("bash", ["-c", '"$0" "$1" "$2" --for 360x640 --plan --steps <(cat "$3") --out "$4" "${@:5}"', process.execPath, CLI, video, steps, outDir("piped-plan"), ...extra], { encoding: "utf8", timeout: 120_000 });
  const dry = piped("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.doesNotMatch(dry.stdout, /would stop/);
  const r = piped("--json");
  assert.equal(r.status, 0, r.stderr);
  const crop = JSON.parse(r.stdout);
  // Its notes call it steps.json, as the windows' reasons do, not 63.
  assert.ok(crop.notes.some((note) => note.startsWith("steps.json gave 1 page and 1 press")), crop.notes.join("\n"));
  assert.match(fs.readFileSync(path.join(outDir("piped-plan"), "FORMATS.md"), "utf8"), /^- steps\.json gave 1 page and 1 press/m);
  assert.match(crop.shots[0].windows["9:16"].why, /the press in steps\.json/);
});

test("the notes on a steps.json call it by its own name when that ends in .json, and steps.json otherwise, as for one given through a pipe", () => {
  const video = path.join(dir, "named", "vid.mp4");
  const raw = { kind: "demo", video: { file: "vid.mp4", width: 640, height: 360, duration: 9 }, pages: [{ start: 0 }], steps: [{ action: "click", label: "Go", at: ["left", "top"], pressedAt: 1 }] };
  // As the run reads one given as <(...), which bash names /dev/fd/63.
  const piped = stepsFor(video, { given: "/dev/fd/63", read: raw, duration: 4, width: 640, height: 360 });
  assert.equal(piped.name, "steps.json");
  assert.deepEqual(piped.notes, [
    "steps.json says the demo is 9 s long, the video is 4.00 s; its times are used as they are.",
    'steps.json gives the place of a press as something other than two numbers of the video\'s pixels (["left","top"]), so the windows do not go to it.',
  ]);
  const flow = stepsFor(video, { given: write("named/flow.json", raw), duration: 4, width: 640, height: 360 });
  assert.equal(flow.name, "flow.json");
  assert.match(flow.notes.join(" "), /^flow\.json says the demo is 9 s long.* flow\.json gives the place of a press/);
  // One found next to the video is steps.json, left out when it is
  // another length.
  write("named/steps.json", raw);
  assert.deepEqual(stepsFor(video, { duration: 4, width: 640, height: 360 }), { file: path.join(dir, "named", "steps.json"), name: "steps.json", ignored: "its length, 9 s, is not the video's" });
});

test("the brand's background: brand.json's surface, else _brand.yml's color.background", () => {
  write("kit/brand.json", { version: 1, colors: [{ hex: "#1A6B45", role: "logo" }, { hex: "#F6F5F1", role: "surface" }] });
  assert.equal(brandColor(path.join(dir, "kit")).hex, "#f6f5f1");
  write("yml/_brand.yml", 'meta:\n  name: Acme\ncolor:\n  palette:\n    surface: "#000000"\n  foreground: "#131312"\n  background: "#fafafa"\n');
  assert.equal(brandColor(path.join(dir, "yml")).hex, "#fafafa");
  assert.equal(brandColor(path.join(dir, "yml", "_brand.yml")).hex, "#fafafa");
  write("empty/brand.json", { version: 1, colors: [] });
  assert.throws(() => brandColor(path.join(dir, "empty")), /names no background color/);
  // A brand.json that holds no object.
  for (const [name, text] of [["null", "null"], ["list", "[1, 2]"], ["number", "7"]]) {
    write(`${name}kit/brand.json`, text);
    assert.throws(() => brandColor(path.join(dir, `${name}kit`)), /names no background color: give --pad a color instead/);
  }
});

test("a video of many shots gets sheets of twelve, one frame of each shot", () => {
  const cuts = Array.from({ length: 25 }, (_, i) => ((i + 1) * 0.45).toFixed(2)).join(",");
  const out = outDir("many-shots");
  const r = cli([fixture("fourShots"), "--for", "180x320", "--plan", "--cuts", cuts, "--out", out, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).shots.length, 26);
  assert.deepEqual(fs.readdirSync(out).filter((n) => /^sheet/.test(n)).sort(), ["sheet-2.png", "sheet-3.png", "sheet.png"]);
  assert.match(fs.readFileSync(path.join(out, "FORMATS.md"), "utf8"), /sheet\.png, sheet-2\.png and sheet-3\.png/);
});

test("a video of more shots than ten pages hold gets 120 of them on its sheets, and a summary of runs", () => {
  const file = path.join(dir, "many.mp4");
  ffmpeg(["-f", "lavfi", "-i", "color=c=0x203040:s=160x90:r=10:d=54,drawbox=x='10+t':y=30:w=20:h=20:color=white:t=fill", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file]);
  const cuts = Array.from({ length: 129 }, (_, i) => ((i + 1) * 0.415).toFixed(3)).join(",");
  const out = outDir("very-many");
  const r = cli([file, "--for", "180x320", "--plan", "--cuts", cuts, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const sheets = fs.readdirSync(out).filter((n) => /^sheet/.test(n));
  assert.equal(sheets.length, 10);
  const md = fs.readFileSync(path.join(out, "FORMATS.md"), "utf8");
  assert.match(md, /The video has 130 shots; the sheets show 120 of them, spread evenly, and crop.json holds them all/);
  assert.ok(md.indexOf("## Next") < md.indexOf("## Shots"), "the shots come last");
  // The summary names the folder, the sheets and the program by their
  // paths, as long as the temp folder's and the checkout's: it is measured
  // with short words in their place.
  const shown = r.stdout.split(CLI).join("<cli>").split(dir).join("<tmp>");
  assert.ok(shown.length < 2000, `${shown.length} characters of summary`);
});
