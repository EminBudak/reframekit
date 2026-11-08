"use strict";

// The output folder: a run replaces only files reframekit wrote there, at
// the size it wrote them; a crop.json copied elsewhere claims nothing; a
// crop.json edited by hand is never planned over, and rendering it for
// fewer places keeps the other shapes' windows; two videos of one name get
// two folders; a plan leaves rendered files where they are; a failed,
// stopped or killed run leaves nothing behind; the folder can sit where
// its parent takes no files; and the odd names: a colon, letters stored
// decomposed, a very long name.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const { fixture, ffmpeg, cli, outDir, dir, CLI } = require("./helpers");
const { slug } = require("../skills/reframekit/scripts/lib/folder");

const hashes = (folder) => Object.fromEntries(fs.readdirSync(folder).sort().map((n) => [n, require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(folder, n))).digest("hex")]));
const hidden = (folder) => fs.readdirSync(folder).filter((n) => n.startsWith(".reframekit-"));

test("someone's files, with a crop.json copied in among them, are never taken for a run", () => {
  const plan = outDir("copied-plan");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", plan]).status, 0);
  const proj = outDir("proj");
  fs.mkdirSync(proj, { recursive: true });
  fs.copyFileSync(fixture("twoShots"), path.join(proj, "film.mp4"));
  fs.copyFileSync(fixture("twoShots"), path.join(proj, "youtube.mp4"));
  fs.writeFileSync(path.join(proj, "CHECK.md"), "# My release checklist\n");
  fs.writeFileSync(path.join(proj, "sheet.png"), "my storyboard");
  fs.copyFileSync(path.join(plan, "crop.json"), path.join(proj, "crop.json"));
  const before = hashes(proj);
  const r = cli([path.join(proj, "film.mp4"), "--crop", path.join(proj, "crop.json"), "--for", "360x640", "--out", proj]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /is not empty and holds no earlier reframekit run/);
  assert.deepEqual(hashes(proj), before);
  assert.deepEqual(hidden(proj), []);
});

test("a file of a run that someone changed is theirs, and a run that would replace it is refused", () => {
  const out = outDir("changed");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640,480x480", "--out", out]).status, 0);
  fs.appendFileSync(path.join(out, "480x480.mp4"), "edited");
  const mine = fs.readFileSync(path.join(out, "480x480.mp4"));
  const r = cli([fixture("twoShots"), "--for", "480x480", "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /480x480\.mp4 in .* is not a file reframekit wrote/);
  // The other place can be made again; the changed file stays as it is.
  const again = cli([fixture("twoShots"), "--for", "360x640", "--out", out, "--json"]);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(fs.readFileSync(path.join(out, "480x480.mp4")).equals(mine));
  assert.deepEqual(JSON.parse(again.stdout).files.map((f) => f.file), ["360x640.mp4"]);
});

test("a crop.json edited by hand is rendered with --crop and never planned over; rendered for fewer places, it keeps the other shapes' windows", () => {
  const out = outDir("edited");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640,480x480", "--plan", "--out", out]).status, 0);
  const file = path.join(out, "crop.json");
  const crop = JSON.parse(fs.readFileSync(file, "utf8"));
  crop.shots[0].windows["1:1"] = { mode: "follow", w: 360, h: 360, path: [[0, 0, 0]], why: "EDITED BY HAND" };
  crop.shots[1].windows["9:16"].path = [[2, 0, 0]];
  fs.writeFileSync(file, JSON.stringify(crop, null, 2));
  const replan = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]);
  assert.equal(replan.status, 1);
  assert.match(replan.stderr, /crop\.json was edited by hand, and this run would plan over it.*--crop/);
  const run = cli([fixture("twoShots"), "--crop", file, "--for", "360x640", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(after.shapes).sort(), ["1:1", "9:16"]);
  assert.equal(after.shots[0].windows["1:1"].why, "EDITED BY HAND");
  assert.deepEqual(after.shots[1].windows["9:16"].path, [[2, 0, 0]]);
  // Rendered as it is, the 1:1 windows render too.
  const both = cli([fixture("twoShots"), "--crop", file, "--for", "480x480", "--out", out, "--json"]);
  assert.equal(both.status, 0, both.stderr);
  assert.deepEqual(JSON.parse(both.stdout).files.map((f) => [f.file, Boolean(f.earlier)]), [["480x480.mp4", false], ["360x640.mp4", true]]);
});

test("a file named like one the run writes in other letters is someone's, and stops the run before any work", () => {
  const out = outDir("letters");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]).status, 0);
  fs.writeFileSync(path.join(out, "formats.md"), "# My notes on the formats\n");
  const before = hashes(out);
  const r = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /formats\.md in .* is not a file reframekit wrote, and a run there would replace it: it writes FORMATS\.md, which a disk that ignores letter case takes for formats\.md/);
  assert.doesNotMatch(r.stderr, /Reading/);
  assert.deepEqual(hashes(out), before);
});

test("a file in other letters that turns up while the run goes on stops the move, and the folder stays as it was", () => {
  const { openStage, finishStage } = require("../skills/reframekit/scripts/lib/folder");
  const out = outDir("late-letters");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "square.mp4"), "earlier");
  const stage = openStage(out);
  fs.writeFileSync(path.join(stage.stage, "square.mp4"), "new");
  fs.writeFileSync(path.join(out, "Square.mp4"), "mine");
  assert.throws(() => finishStage(stage), /Square\.mp4 is there, which a disk that ignores letter case takes for square\.mp4\)\. The folder is as it was; the finished files are in /);
  assert.equal(fs.readFileSync(path.join(out, "square.mp4"), "utf8"), "earlier");
  assert.equal(fs.readFileSync(path.join(out, "Square.mp4"), "utf8"), "mine");
  assert.equal(fs.readFileSync(path.join(stage.stage, "square.mp4"), "utf8"), "new");
  fs.rmSync(stage.stage, { recursive: true, force: true });
});

// Whether this machine can mount a disk that ignores letter case for a
// test: a tmpfs with casefold (Linux 6.13 or newer) in a user namespace.
function casefoldDisk() {
  if (process.platform !== "linux") return false;
  const at = outDir("casefold-probe");
  fs.mkdirSync(at, { recursive: true });
  return spawnSync("unshare", ["-rm", "sh", "-c", 'mount -t tmpfs -o casefold none "$1" && mkdir "$1/p" && chattr +F "$1/p" && : > "$1/p/A" && test -e "$1/p/a"', "sh", at], { timeout: 20_000 }).status === 0;
}

test("on a disk that ignores letter case, the run never writes over someone's Square.mp4, and its dry run says it would stop there", (t) => {
  if (!casefoldDisk()) {
    t.skip("no disk that ignores letter case can be mounted here");
    return;
  }
  const mnt = outDir("casefold");
  fs.mkdirSync(mnt, { recursive: true });
  // In a namespace of its own: a run, then someone's Square.mp4 in its
  // folder, then a run for square. The disk goes with the namespace.
  const script = [
    'mount -t tmpfs -o casefold none "$1" && mkdir "$1/p" && chattr +F "$1/p" || exit 9',
    '"$2" "$3" "$4" --for 64x64 --out "$1/p/out" > /dev/null 2>&1 || exit 8',
    'printf mine > "$1/p/out/Square.mp4"',
    '"$2" "$3" "$4" --for square --out "$1/p/out" --dry-run > "$1/dry" 2>&1',
    '"$2" "$3" "$4" --for square --out "$1/p/out" > "$1/said" 2>&1',
    'echo "exit $?"',
    'ls "$1/p/out"',
    'cat "$1/p/out/Square.mp4"; echo',
    'cat "$1/said"',
    'cat "$1/dry"',
  ].join("\n");
  const r = spawnSync("unshare", ["-rm", "sh", "-c", script, "sh", mnt, process.execPath, CLI, fixture("twoShots")], { encoding: "utf8", timeout: 600_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.split("\n");
  assert.equal(lines[0], "exit 1", r.stdout);
  assert.ok(lines.includes("Square.mp4") && !lines.includes("square.mp4"), r.stdout);
  assert.ok(lines.includes("mine"), r.stdout);
  assert.match(r.stdout, /Square\.mp4 in .* is not a file reframekit wrote, and a run there would replace it: it writes square\.mp4/);
  assert.match(r.stdout, /The run would stop: Square\.mp4 in .* is not a file reframekit wrote, and a run there would replace it: it writes square\.mp4/);
});

test("windows edited by hand stay protected after a --crop render, and a run that would replace them with another crop.json says so", () => {
  const out = outDir("edited-render");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]).status, 0);
  const file = path.join(out, "crop.json");
  const crop = JSON.parse(fs.readFileSync(file, "utf8"));
  crop.shots[0].windows["9:16"] = { mode: "follow", w: 202, h: 360, path: [[0, 0, 0]], why: "EDITED BY HAND" };
  fs.writeFileSync(file, JSON.stringify(crop, null, 2));
  const render = cli([fixture("twoShots"), "--crop", file, "--for", "360x640", "--out", out]);
  assert.equal(render.status, 0, render.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).edited, true);
  // A later run without --crop, to change the loudness, would plan again.
  const again = cli([fixture("twoShots"), "--for", "360x640", "--lufs", "-16", "--out", out]);
  assert.equal(again.status, 1, again.stdout);
  assert.match(again.stderr, /crop\.json was edited by hand, and this run would plan over it\. Render it with --crop/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).shots[0].windows["9:16"].why, "EDITED BY HAND");
  // Another folder's crop.json would replace the hand-set windows.
  const other = outDir("edited-other");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", other]).status, 0);
  const replace = cli([fixture("twoShots"), "--crop", path.join(other, "crop.json"), "--for", "360x640", "--plan", "--out", out]);
  assert.equal(replace.status, 1);
  assert.match(replace.stderr, /crop\.json was edited by hand, and this run would replace it with the windows of .*edited-other\/crop\.json\. Render it with --crop .* instead/);
  // An unedited crop.json rendered with --crop is not marked.
  assert.equal(cli([fixture("twoShots"), "--crop", path.join(other, "crop.json"), "--for", "360x640", "--plan", "--out", other]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, "crop.json"), "utf8")).edited, undefined);
});

test("a place of another shape added to an edited crop.json with --crop gets windows planned for its shots, and the hand-set ones stay", () => {
  const out = outDir("add-shape");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]).status, 0);
  const file = path.join(out, "crop.json");
  const crop = JSON.parse(fs.readFileSync(file, "utf8"));
  crop.shots[1].windows["9:16"].path = [[2, 0, 0]];
  fs.writeFileSync(file, JSON.stringify(crop, null, 2));
  // A plan without --crop is refused, so the shape is added with it.
  assert.match(cli([fixture("twoShots"), "--for", "360x640,480x480", "--plan", "--out", out]).stderr, /was edited by hand/);
  const plan = cli([fixture("twoShots"), "--crop", file, "--for", "360x640,480x480", "--plan", "--out", out]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /Note: crop\.json had no 1:1 windows, so this run planned them for its shots; look at them on the sheet before the files go out\./);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(after.shots[1].windows["9:16"].path, [[2, 0, 0]]);
  assert.ok(after.shots.every((s) => s.windows["1:1"] && s.windows["1:1"].path), JSON.stringify(after.shots.map((s) => s.windows)));
  assert.equal(after.edited, true);
  // The same windows a plan of that shape alone makes for those shots.
  const fresh = outDir("add-shape-fresh");
  assert.equal(cli([fixture("twoShots"), "--for", "480x480", "--plan", "--out", fresh]).status, 0);
  const plain = JSON.parse(fs.readFileSync(path.join(fresh, "crop.json"), "utf8"));
  assert.deepEqual(after.shots.map((s) => s.windows["1:1"]), plain.shots.map((s) => s.windows["1:1"]));
  const render = cli([fixture("twoShots"), "--crop", file, "--for", "360x640,480x480", "--out", out, "--json"]);
  assert.equal(render.status, 0, render.stderr);
  assert.deepEqual(JSON.parse(render.stdout).files.map((f) => f.file), ["360x640.mp4", "480x480.mp4"]);
  // A shape that some shots have and others lack is still refused.
  const partial = JSON.parse(fs.readFileSync(file, "utf8"));
  delete partial.shots[1].windows["1:1"];
  fs.writeFileSync(file, JSON.stringify(partial, null, 2));
  const refused = cli([fixture("twoShots"), "--crop", file, "--for", "480x480", "--out", out]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /crop\.json: shot 2 has no 1:1 window, though other shots have one; give it one/);
});

test("a crop.json rendered for fewer places keeps the other shapes' windows as someone left them, without a path or with one a render would refuse", () => {
  const out = outDir("kept-windows");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640,480x480", "--plan", "--out", out]).status, 0);
  const file = path.join(out, "crop.json");
  const crop = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const s of crop.shots) delete s.windows["1:1"].path;
  fs.writeFileSync(file, JSON.stringify(crop, null, 2));
  const plan = cli([fixture("twoShots"), "--crop", file, "--for", "360x640", "--plan", "--out", out]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /1:1 +shots 1 to 2 hold/);
  const again = JSON.parse(fs.readFileSync(file, "utf8"));
  again.shots[1].windows["1:1"].path = [["soon", 0, 0]];
  fs.writeFileSync(file, JSON.stringify(again, null, 2));
  const told = cli([fixture("twoShots"), "--crop", file, "--for", "360x640", "--plan", "--out", out]);
  assert.equal(told.status, 0, told.stderr);
  assert.match(told.stdout, /Note: crop\.json's 1:1 windows are kept as they are, though a run that renders them would refuse them: shot 2, 1:1: path point 1 is \[seconds, x, y\]\./);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).shots[1].windows["1:1"].path, [["soon", 0, 0]]);
});

test("a crop.json given with a shape or a window named like what every object has, toString, constructor or __proto__, renders: such a key names no shape and is left out", () => {
  const out = outDir("odd-keys");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640,480x480", "--plan", "--out", out]).status, 0);
  const text = JSON.stringify(JSON.parse(fs.readFileSync(path.join(out, "crop.json"), "utf8")));
  for (const key of ["toString", "constructor", "__proto__"]) {
    // Written into the JSON text, so that __proto__ is a key of its own.
    const odd = text.replace('"shapes":{', `"shapes":{"${key}":{"places":["myspace"],"width":100,"height":100},`).replace(/"windows":\{/g, `"windows":{"${key}":{"mode":"pad"},`);
    assert.ok(odd.includes(`"${key}":{"places"`) && odd.includes(`"${key}":{"mode"`));
    const file = path.join(dir, `crop-${key}.json`);
    fs.writeFileSync(file, odd);
    const r = cli([fixture("twoShots"), "--crop", file, "--for", "360x640", "--plan", "--out", outDir(`odd-keys-${key}`), "--json"]);
    assert.equal(r.status, 0, `${key}: ${r.stderr}`);
    const written = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(written.shapes).sort(), ["1:1", "9:16"], key);
    assert.ok(written.shots.every((s) => !Object.hasOwn(s.windows, key) && s.windows["1:1"]), key);
  }
});

test("two videos of one name get two folders; with --out, a folder of the other's run is refused", () => {
  const here = outDir("same-name");
  fs.mkdirSync(here, { recursive: true });
  fs.copyFileSync(fixture("twoShots"), path.join(here, "clip.mp4"));
  ffmpeg(["-i", fixture("twoShots"), "-c", "copy", path.join(here, "clip.mov")]);
  assert.equal(cli(["clip.mp4", "--for", "360x640", "--plan"], { cwd: here }).status, 0);
  const second = cli(["clip.mov", "--for", "360x640", "--plan"], { cwd: here });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /in reframekit-clip-2/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(here, "reframekit-clip", "crop.json"), "utf8")).video, "clip.mp4");
  assert.equal(JSON.parse(fs.readFileSync(path.join(here, "reframekit-clip-2", "crop.json"), "utf8")).video, "clip.mov");
  const forced = cli(["clip.mov", "--for", "360x640", "--plan", "--out", "reframekit-clip"], { cwd: here });
  assert.equal(forced.status, 1);
  assert.match(forced.stderr, /holds a run for clip\.mp4, not for clip\.mov/);
});

test("two films of one name from two folders, as launch-film names every film, get two folders; with --out, the other's folder is refused", () => {
  const here = outDir("two-films");
  for (const sub of ["acme", "beta"]) fs.mkdirSync(path.join(here, sub), { recursive: true });
  fs.copyFileSync(fixture("twoShots"), path.join(here, "acme", "film.mp4"));
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", path.join(here, "beta", "film.mp4")]);
  assert.equal(cli(["acme/film.mp4", "--for", "360x640", "--plan"], { cwd: here }).status, 0);
  const first = hashes(path.join(here, "reframekit-film"));
  const second = cli(["beta/film.mp4", "--for", "360x640", "--plan"], { cwd: here });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /in reframekit-film-2/);
  assert.deepEqual(hashes(path.join(here, "reframekit-film")), first);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(here, "reframekit-film-2", "crop.json"), "utf8")).source.file, "../beta/film.mp4");
  // Each film finds its own folder again.
  assert.match(cli(["acme/film.mp4", "--for", "360x640", "--plan"], { cwd: here }).stdout, /in reframekit-film\n/);
  const forced = cli(["beta/film.mp4", "--for", "360x640", "--plan", "--out", "reframekit-film"], { cwd: here });
  assert.equal(forced.status, 1);
  assert.match(forced.stderr, /reframekit-film holds a run for acme\/film\.mp4, not for beta\/film\.mp4/);
});

test("a video made again in its place keeps its folder, and the files made before it changed are said to be so", () => {
  const here = outDir("remade");
  fs.mkdirSync(here, { recursive: true });
  fs.copyFileSync(fixture("twoShots"), path.join(here, "film.mp4"));
  assert.equal(cli(["film.mp4", "--for", "64x64,96x64"], { cwd: here }).status, 0);
  // The film made again: another cut, so another size.
  ffmpeg(["-i", fixture("twoShots"), "-t", "3", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", path.join(here, "film.mp4")]);
  const again = cli(["film.mp4", "--for", "96x64"], { cwd: here });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /into reframekit-film\n/);
  assert.match(again.stdout, /64x64\.mp4 +kept from an earlier run, made before film\.mp4 changed/);
  const md = fs.readFileSync(path.join(here, "reframekit-film", "FORMATS.md"), "utf8");
  assert.match(md, /64x64\.mp4 was made before film\.mp4 changed, so it shows the video as it was then/);
  // A plan says so too.
  const plan = cli(["film.mp4", "--for", "96x64", "--plan"], { cwd: here });
  assert.match(plan.stdout, /Kept from an earlier render in the folder: 64x64-cover\.jpg, 64x64\.mp4, 96x64-cover\.jpg, 96x64\.mp4\n  Made before film\.mp4 changed: 64x64-cover\.jpg, 64x64\.mp4\n/);
  assert.match(fs.readFileSync(path.join(here, "reframekit-film", "FORMATS.md"), "utf8"), /64x64-cover\.jpg and 64x64\.mp4 were made before film\.mp4 changed\./);
  // Made again for its place, it is this film's.
  const third = cli(["film.mp4", "--for", "64x64"], { cwd: here });
  assert.match(third.stdout, /96x64\.mp4 +kept from an earlier run\n/);
});

test("a plan into a folder of rendered files leaves them there and says so", () => {
  const out = outDir("plan-after");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--out", out]).status, 0);
  const mp4 = fs.readFileSync(path.join(out, "360x640.mp4"));
  const plan = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out, "--json"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.ok(fs.readFileSync(path.join(out, "360x640.mp4")).equals(mp4));
  assert.ok(fs.existsSync(path.join(out, "formats.json")));
  assert.ok("360x640.mp4" in JSON.parse(plan.stdout).written);
  assert.match(fs.readFileSync(path.join(out, "FORMATS.md"), "utf8"), /The files of an earlier render are still in this folder \(360x640-cover\.jpg and 360x640\.mp4\)/);
});

test("an output folder under a folder that takes no new files is written all the same", { skip: process.getuid && process.getuid() === 0 }, () => {
  const parent = outDir("ro-parent");
  const out = path.join(parent, "out");
  fs.mkdirSync(out, { recursive: true });
  fs.chmodSync(parent, 0o555);
  try {
    const r = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(out).sort(), ["FORMATS.md", "crop.json", "sheet.png"]);
    const refused = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", path.join(parent, "new")]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Cannot write to .*new: permission denied/);
  } finally {
    fs.chmodSync(parent, 0o755);
  }
});

test("a new output folder is made as mkdir makes any folder, so the umask and a default ACL decide who else may open it", { skip: process.platform === "win32" }, (t) => {
  const parent = outDir("modes");
  fs.mkdirSync(parent, { recursive: true });
  const run = (umask, out) => spawnSync("sh", ["-c", `umask ${umask} && exec "$0" "$@"`, process.execPath, CLI, fixture("twoShots"), "--for", "360x640", "--plan", "--out", out], { encoding: "utf8", timeout: 600_000 });
  const plain = path.join(parent, "plain");
  const r = run("022", plain);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((fs.statSync(plain).mode & 0o777).toString(8), "755");
  // A default ACL that gives another user every folder made in it, as the
  // hosted service gives its worker the jobs' folders: under umask 077 the
  // ACL's mask, the group bits of the mode, still lets that user in.
  const shared = path.join(parent, "shared");
  fs.mkdirSync(shared);
  if (spawnSync("setfacl", ["-m", "d:u:nobody:rwx,d:o::---", shared]).status !== 0) {
    t.skip("this disk or machine has no ACLs");
    return;
  }
  const out = path.join(shared, "out");
  const acl = run("077", out);
  assert.equal(acl.status, 0, acl.stderr);
  assert.equal((fs.statSync(out).mode & 0o070).toString(8), "70");
});

test("an --out name too long for the disk is told before the video is read, and the folder made above it goes again", () => {
  const above = outDir("long-out");
  const r = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", path.join(above, "x".repeat(300))]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the name is too long for this disk; pass a shorter folder with --out/);
  assert.doesNotMatch(r.stderr, /Reading/);
  assert.ok(!fs.existsSync(above), `${above} is still there`);
});

test("a run that fails half way leaves none of the folders it made, and a hidden folder a killed run left is removed", () => {
  // A wrapper that fails the second picture encode.
  const bin = outDir("failing-bin");
  fs.mkdirSync(bin, { recursive: true });
  const count = path.join(bin, "count");
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bin, "ffmpeg"), `#!/bin/sh\ncase " $* " in *" -progress pipe:1 "*) n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${count}"; [ $n -ge 2 ] && exit 1;; esac\nexec "${real}" "$@"\n`);
  fs.chmodSync(path.join(bin, "ffmpeg"), 0o755);
  const deep = outDir("deep");
  const out = path.join(deep, "er", "out");
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  // The hidden folder a killed run left inside its output folder.
  const left = path.join(outDir("leftover"), ".reframekit-AbC123");
  fs.mkdirSync(left, { recursive: true });
  fs.writeFileSync(path.join(left, ".owner"), JSON.stringify({ pid: Number(dead), host: os.hostname(), dir: outDir("leftover") }));
  const env = { ...process.env, FFMPEG_PATH: path.join(bin, "ffmpeg"), FFPROBE_PATH: spawnSync("sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).stdout.trim() };
  const r = cli([fixture("twoShots"), "--for", "360x640,480x480", "--out", out], { env });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Encoding .* failed/);
  assert.ok(!fs.existsSync(deep), `${deep} is still there`);
  const next = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", outDir("leftover")]);
  assert.equal(next.status, 0, next.stderr);
  assert.ok(!fs.existsSync(left), "the dead run's hidden folder is gone");
});

test("a run whose terminal closes stops and leaves nothing; one whose reader goes away finishes quietly", async () => {
  const out = outDir("hup");
  const child = spawn(process.execPath, [CLI, fixture("twoShots"), "--for", "1080x1920,1920x1080", "--out", out], { stdio: ["ignore", "ignore", "pipe"] });
  let said = "";
  const signal = await new Promise((resolve) => {
    child.stderr.on("data", (chunk) => {
      said += chunk;
      if (/Encoding/.test(said) && !child.killed) child.kill("SIGHUP");
    });
    child.on("close", (exit, ended) => resolve(ended));
  });
  assert.equal(signal, "SIGHUP", said);
  assert.ok(said.endsWith(`reframekit: stopped by SIGHUP, so ${out} is as it was\n`), said);
  assert.ok(!fs.existsSync(out));
  assert.deepEqual(hidden(dir), []);
  const quiet = outDir("epipe");
  const reader = spawn(process.execPath, [CLI, fixture("twoShots"), "--for", "360x640", "--out", quiet], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = await new Promise((resolve) => {
    reader.stderr.once("data", () => {
      reader.stderr.destroy();
      reader.stdout.destroy();
    });
    reader.on("close", (c) => resolve(c));
  });
  assert.equal(exit, 0);
  assert.ok(fs.existsSync(path.join(quiet, "360x640.mp4")));
});

test("odd names: a colon reads as a file, letters stored decomposed keep their accents, a long name is cut", () => {
  const here = outDir("odd-names");
  fs.mkdirSync(here, { recursive: true });
  fs.copyFileSync(fixture("twoShots"), path.join(here, "take:2.mp4"));
  const r = cli(["take:2.mp4", "--for", "360x640", "--plan"], { cwd: here });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(here, "reframekit-take-2", "crop.json")));
  const c = cli(["check", "take:2.mp4", "--for", "youtube"], { cwd: here });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.ok(fs.existsSync(path.join(here, "reframekit-check-take-2", "CHECK.md")));
  assert.equal(slug("Ünlü çekim.mp4".normalize("NFD")), "ünlü-çekim");
  const long = slug(`${"映像".repeat(41)}.mp4`);
  assert.ok(Buffer.byteLength(long) <= 80 && long.startsWith("映像"), long);
});

test("a folder on a drive or share that is not there is told, not walked up forever", () => {
  const { checkWritable } = require("../skills/reframekit/scripts/lib/folder");
  // As on Windows, where Z:\\ is its own parent: nothing exists at all.
  const existsSync = fs.existsSync;
  fs.existsSync = () => false;
  try {
    assert.throws(() => checkWritable(path.resolve("/nowhere/exports/out"), "/nowhere/exports/out"), /Cannot write to \/nowhere\/exports\/out: \/ is not there/);
  } finally {
    fs.existsSync = existsSync;
  }
});

test("an --out that is a link to nothing, or a folder that cannot be listed, is told before any work", { skip: process.platform === "win32" }, () => {
  const base = outDir("odd-out");
  fs.mkdirSync(base, { recursive: true });
  const dangling = path.join(base, "dangling");
  fs.symlinkSync(path.join(base, "nowhere", "out"), dangling);
  const r = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", dangling]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^reframekit: Cannot write to .*dangling: it is a link to .*nowhere\/out, which is not there$/m);
  assert.ok(!fs.existsSync(path.join(base, "nowhere")));
  const check = cli(["check", fixture("twoShots"), "--for", "youtube", "--out", path.join(dangling, "checks")]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /Cannot write the check to .*checks: .*dangling is a link to .*nowhere\/out, which is not there; give --out a folder that takes files$/m);
  if (process.getuid && process.getuid() === 0) return;
  const unlisted = path.join(base, "unlisted");
  fs.mkdirSync(unlisted);
  fs.chmodSync(unlisted, 0o300);
  try {
    const u = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", unlisted]);
    assert.equal(u.status, 1);
    assert.match(u.stderr, /^reframekit: Cannot read .*unlisted: permission denied; pick another folder with --out$/m);
  } finally {
    fs.chmodSync(unlisted, 0o755);
  }
});

test("two files whose ids differ only past 2^53, as NTFS ids do, are two files", () => {
  const { idOf } = require("../skills/reframekit/scripts/lib/folder");
  // NTFS keeps a sequence number in a file id's top 16 bits.
  const ids = { a: (1n << 60n) + 4n, b: (1n << 60n) + 5n };
  const statSync = fs.statSync;
  fs.statSync = (file, options) => {
    const ino = ids[path.basename(file)];
    if (ino === undefined) return statSync(file, options);
    return options && options.bigint ? { dev: 7n, ino } : { dev: 7, ino: Number(ino) };
  };
  try {
    assert.notEqual(idOf("/x/a"), idOf("/x/b"));
  } finally {
    fs.statSync = statSync;
  }
});

test("a run stopped by a signal ends by that signal, and leaves no stack trace, when part of its hidden folder cannot be removed, and the program that runs it is told so", { skip: process.platform === "win32" || (process.getuid && process.getuid() === 0) }, () => {
  const base = outDir("held");
  fs.mkdirSync(base, { recursive: true });
  // A folder inside the hidden one that takes no changes stands in for a
  // file another process holds open, as Windows keeps one a killed ffmpeg
  // had open.
  const script = path.join(base, "stopped.js");
  fs.writeFileSync(script, `const fs = require("node:fs");
const path = require("node:path");
const { openStage, guard } = require(${JSON.stringify(require.resolve("../skills/reframekit/scripts/lib/folder"))});
if (process.argv[2] === "told") guard(() => {}, (signal, stopped) => process.stderr.write(JSON.stringify({ signal, stopped })));
const rec = openStage(path.join(${JSON.stringify(base)}, "a", "b", "out"), { shown: "out" });
const held = path.join(rec.work, "held");
fs.mkdirSync(held);
fs.writeFileSync(path.join(held, "tiktok.mp4"), "x");
fs.chmodSync(held, 0o500);
process.stdout.write(held);
process.kill(process.pid, "SIGTERM");
setTimeout(() => {}, 10000);
`);
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 60_000 });
  const told = spawnSync(process.execPath, [script, "told"], { encoding: "utf8", timeout: 60_000 });
  try {
    assert.deepEqual([r.status, r.signal], [null, "SIGTERM"], r.stderr);
    assert.equal(r.stderr, "");
    // Told, the program says what stayed.
    assert.equal(told.signal, "SIGTERM", told.stderr);
    const { stopped } = JSON.parse(told.stderr);
    assert.deepEqual(stopped.map((s) => [s.shown, s.gone]), [["out", false]]);
    const { stoppedText } = require("../skills/reframekit/scripts/reframekit");
    assert.deepEqual(stoppedText("SIGTERM", stopped), [`stopped by SIGTERM, so out is as it was but for ${path.join("out", path.basename(stopped[0].stage))}, which could not be removed and which the next run there removes`]);
    assert.deepEqual(stoppedText("SIGINT", []), ["stopped by SIGINT, so nothing was written"]);
    // What is left keeps its owner file, so the next run there removes it
    // once it can, and a run there meanwhile is not stopped by it.
    const stage = path.dirname(path.dirname(r.stdout));
    assert.ok(fs.existsSync(path.join(stage, ".owner")), fs.readdirSync(stage).join(", "));
    const next = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", path.join(base, "a", "b", "out")]);
    assert.equal(next.status, 0, next.stderr);
    fs.chmodSync(r.stdout, 0o755);
    assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", path.join(base, "a", "b", "out")]).status, 0);
    assert.ok(!fs.existsSync(stage), "the next run removed it");
  } finally {
    for (const left of [r.stdout, told.stdout]) if (left && fs.existsSync(left)) fs.chmodSync(left, 0o755);
    fs.rmSync(path.join(base, "a"), { recursive: true, force: true });
  }
});

// Runs the CLI and calls `change` once it says it is encoding, as a person
// or an agent saving into the folder while a render goes on.
function whileEncoding(args, change, cwd = undefined) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"], cwd });
    let said = "";
    let done = false;
    child.stderr.on("data", (chunk) => {
      said += chunk;
      if (!done && /Encoding/.test(said)) {
        done = true;
        change();
      }
    });
    child.stdout.resume();
    child.on("close", (code) => resolve({ code, stderr: said, changed: done }));
  });
}

test("the hidden folder a stopped move keeps is made as mkdir makes any folder, so those a default ACL lets into the output folder can take the finished files from it", { skip: process.platform === "win32" }, async (t) => {
  const parent = outDir("kept-modes");
  fs.mkdirSync(parent, { recursive: true });
  // A plan whose move stops: FORMATS.md saved into its folder while it
  // draws the sheet.
  const stopped = (umask, out) =>
    new Promise((resolve) => {
      const child = spawn("sh", ["-c", `umask ${umask} && exec "$0" "$@"`, process.execPath, CLI, fixture("twoShots"), "--for", "360x640", "--plan", "--out", out], { stdio: ["ignore", "ignore", "pipe"] });
      let said = "";
      let done = false;
      child.stderr.on("data", (chunk) => {
        said += chunk;
        if (!done && /Drawing/.test(said)) {
          done = true;
          fs.writeFileSync(path.join(out, "FORMATS.md"), "mine\n");
        }
      });
      child.on("close", (code) => resolve({ code, said }));
    });
  const keptMode = (out, bits) => {
    const kept = hidden(out);
    assert.equal(kept.length, 1, fs.readdirSync(out).join(", "));
    return (fs.statSync(path.join(out, kept[0])).mode & bits).toString(8);
  };
  const plain = path.join(parent, "plain");
  const r = await stopped("022", plain);
  assert.equal(r.code, 1, r.said);
  assert.match(r.said, /\(FORMATS\.md turned up while the run went on\)/);
  assert.equal(keptMode(plain, 0o777), "755");
  // Under umask 077, the mask of a default ACL that gives another user
  // every folder made in it, as the hosted service gives its worker the
  // jobs' folders, still lets that user in.
  const shared = path.join(parent, "shared");
  fs.mkdirSync(shared);
  if (spawnSync("setfacl", ["-m", "d:u:nobody:rwx,d:o::---", shared]).status !== 0) {
    t.skip("this disk or machine has no ACLs");
    return;
  }
  const out = path.join(shared, "out");
  const a = await stopped("077", out);
  assert.equal(a.code, 1, a.said);
  assert.equal(keptMode(out, 0o070), "70");
});

test("what is saved into the folder while a run renders is never replaced or removed: the move stops and names it, and the finished files wait in the hidden folder", async () => {
  const film = fixture("twoShots");
  // crop.json edited for the next pass while its render goes on.
  const out = outDir("meanwhile");
  assert.equal(cli([film, "--for", "1080x1920", "--plan", "--out", out]).status, 0);
  const file = path.join(out, "crop.json");
  const edit = (why) => {
    const crop = JSON.parse(fs.readFileSync(file, "utf8"));
    crop.shots[1].windows["9:16"] = { ...crop.shots[1].windows["9:16"], path: [[2, 0, 0]], why };
    fs.writeFileSync(file, JSON.stringify(crop, null, 2));
  };
  edit("EDITED BY HAND");
  const r = await whileEncoding([film, "--crop", file, "--for", "1080x1920", "--out", out], () => edit("MOVED BY HAND DURING THE RENDER"));
  assert.ok(r.changed, r.stderr);
  assert.equal(r.code, 1, r.stderr);
  assert.ok(r.stderr.includes(`Moving the finished files into ${out} failed (crop.json changed while the run went on). The folder is as it was; the finished files are in ${out}/.reframekit-`), r.stderr);
  assert.match(r.stderr, /\/\.reframekit-\w+, which stays until you remove it\.\n/);
  assert.match(fs.readFileSync(file, "utf8"), /MOVED BY HAND DURING THE RENDER/);
  assert.ok(!fs.existsSync(path.join(out, "1080x1920.mp4")));
  // The hidden folder holds the finished files, and stays: the next run
  // there leaves it alone.
  const kept = hidden(out);
  assert.equal(kept.length, 1);
  assert.ok(fs.existsSync(path.join(out, kept[0], "1080x1920.mp4")));
  // Named as the folder was given, as every other error names it.
  const rel = cli([film, "--for", "1080x1920", "--plan", "--out", "meanwhile-rel"], { cwd: dir });
  assert.equal(rel.status, 0, rel.stderr);
  const r2 = await whileEncoding([film, "--for", "1080x1920", "--out", "meanwhile-rel"], () => fs.writeFileSync(path.join(dir, "meanwhile-rel", "1080x1920.mp4"), "my own cut"), dir);
  assert.equal(r2.code, 1, r2.stderr);
  assert.match(r2.stderr, /^reframekit: Moving the finished files into meanwhile-rel failed \(1080x1920\.mp4 turned up while the run went on\)\. The folder is as it was; the finished files are in meanwhile-rel\/\.reframekit-\w+, which stays until you remove it\.$/m);
  // A file of a name the run writes, saved meanwhile into a new folder or
  // over the earlier run's.
  const fresh = outDir("meanwhile-new");
  const n = await whileEncoding([film, "--for", "1080x1920", "--out", fresh], () => fs.writeFileSync(path.join(fresh, "1080x1920.mp4"), "my own cut"));
  assert.equal(n.code, 1, n.stderr);
  assert.match(n.stderr, /\(1080x1920\.mp4 turned up while the run went on\)/);
  assert.equal(fs.readFileSync(path.join(fresh, "1080x1920.mp4"), "utf8"), "my own cut");
  const again = outDir("meanwhile-again");
  assert.equal(cli([film, "--for", "1080x1920", "--out", again]).status, 0);
  const a = await whileEncoding([film, "--for", "1080x1920", "--out", again], () => fs.writeFileSync(path.join(again, "1080x1920-cover.jpg"), "my own cover"));
  assert.equal(a.code, 1, a.stderr);
  assert.match(a.stderr, /\(1080x1920-cover\.jpg changed while the run went on\)/);
  assert.equal(fs.readFileSync(path.join(again, "1080x1920-cover.jpg"), "utf8"), "my own cover");
  // A note saved into the folder of a check the run would remove.
  const checked = outDir("meanwhile-check");
  assert.equal(cli([film, "--for", "1080x1920", "--out", checked]).status, 0);
  assert.equal(cli(["check", path.join(checked, "1080x1920.mp4")]).status, 0);
  const c = await whileEncoding([film, "--for", "1080x1920", "--out", checked], () => fs.writeFileSync(path.join(checked, "reframekit-check-1080x1920", "notes.md"), "mine"));
  assert.equal(c.code, 1, c.stderr);
  assert.match(c.stderr, /\(reframekit-check-1080x1920 changed while the run went on\)/);
  assert.equal(fs.readFileSync(path.join(checked, "reframekit-check-1080x1920", "notes.md"), "utf8"), "mine");
});

test("a crop.json in the folder that is a link to one kept elsewhere renders with --crop: the run replaces the link, and the file it leads to stays as it was", { skip: process.platform === "win32" }, () => {
  const here = outDir("crop-link");
  fs.mkdirSync(path.join(here, "keep"), { recursive: true });
  const film = fixture("twoShots");
  assert.equal(cli([film, "--for", "180x320", "--plan", "--out", "P"], { cwd: here }).status, 0);
  fs.renameSync(path.join(here, "P", "crop.json"), path.join(here, "keep", "crop.json"));
  fs.symlinkSync(path.join("..", "keep", "crop.json"), path.join(here, "P", "crop.json"));
  const kept = fs.readFileSync(path.join(here, "keep", "crop.json"));
  const r = cli([film, "--crop", "P/crop.json", "--for", "180x320", "--out", "P"], { cwd: here });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.lstatSync(path.join(here, "P", "crop.json")).isFile(), "crop.json in the folder is the run's own file");
  assert.ok(fs.existsSync(path.join(here, "P", "180x320.mp4")));
  assert.ok(fs.readFileSync(path.join(here, "keep", "crop.json")).equals(kept), "the crop.json kept elsewhere is as it was");
  assert.deepEqual(hidden(path.join(here, "P")), []);
});

test("a crop.json given and saved again after the run read it, while ffprobe still reads the video, stops the move: the later edit stays, and so does what it holds", { skip: process.platform === "win32" }, async () => {
  const film = fixture("twoShots");
  const out = outDir("saved-early");
  assert.equal(cli([film, "--for", "360x640", "--plan", "--out", out]).status, 0);
  const file = path.join(out, "crop.json");
  const edit = (x) => {
    const crop = JSON.parse(fs.readFileSync(file, "utf8"));
    crop.shots[0].windows["9:16"].path = [[0, x, 0]];
    fs.writeFileSync(file, JSON.stringify(crop, null, 2));
  };
  edit(0);
  // An ffprobe that waits on its first look at the video, which comes
  // after the run read crop.json and before it looks at the folder, as a
  // WebM that states no length takes a while to measure.
  const bin = outDir("slow-probe-bin");
  fs.mkdirSync(bin, { recursive: true });
  const probing = path.join(bin, "probing");
  const real = spawnSync("sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bin, "ffprobe"), `#!/bin/sh\ncase " $* " in *" -show_streams "*) if [ ! -e "${probing}" ]; then : > "${probing}"; sleep 3; fi;; esac\nexec "${real}" "$@"\n`);
  fs.chmodSync(path.join(bin, "ffprobe"), 0o755);
  const child = spawn(process.execPath, [CLI, film, "--crop", file, "--for", "360x640", "--out", out], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, FFPROBE_PATH: path.join(bin, "ffprobe") } });
  let said = "";
  child.stderr.on("data", (chunk) => (said += chunk));
  const ended = new Promise((resolve) => child.on("close", resolve));
  for (let i = 0; i < 200 && !fs.existsSync(probing); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(probing), "ffprobe never started");
  edit(400);
  assert.equal(await ended, 1, said);
  assert.match(said, /Moving the finished files into .*saved-early failed \(crop\.json changed while the run went on\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).shots[0].windows["9:16"].path, [[0, 400, 0]]);
  for (const name of hidden(out)) fs.rmSync(path.join(out, name), { recursive: true, force: true });
  // What the run read is told by the same print as a file in the folder,
  // also past 16 MiB, where only the first and the last MiB count.
  const { printOf, printOfBytes } = require("../skills/reframekit/scripts/lib/folder");
  const big = Buffer.alloc(17 * 1024 * 1024, 7);
  big[big.length - 1] = 9;
  fs.writeFileSync(path.join(bin, "big"), big);
  assert.deepEqual(printOfBytes(big), printOf(path.join(bin, "big")));
  fs.writeFileSync(path.join(bin, "small"), "{}\n");
  assert.deepEqual(printOfBytes(Buffer.from("{}\n")), printOf(path.join(bin, "small")));
});

test("on a disk that keeps letter case, someone's check.md beside reframekit's CHECK.md is left alone, and the run that removes the check goes on", (t) => {
  const out = outDir("check-twins");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--out", out]).status, 0);
  assert.equal(cli(["check", out]).status, 0);
  fs.writeFileSync(path.join(out, "check.md"), "my notes\n");
  if (fs.existsSync(path.join(out, "CHECK.md")) && fs.readFileSync(path.join(out, "CHECK.md"), "utf8") === "my notes\n") {
    t.skip("this disk ignores letter case");
    return;
  }
  const r = cli([fixture("twoShots"), "--for", "360x640", "--lufs", "-16", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Removed from the earlier run: (CHECK\.md, check\.json|check\.json, CHECK\.md)/);
  assert.equal(fs.readFileSync(path.join(out, "check.md"), "utf8"), "my notes\n");
  assert.ok(!fs.existsSync(path.join(out, "CHECK.md")));
  assert.deepEqual(hidden(out), []);
});

test("the system's own files are passed over: Finder's .DS_Store in a check's folder, Windows' desktop.ini and Thumbs.db, macOS's ._ files", () => {
  const out = outDir("system-files");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--out", out]).status, 0);
  assert.equal(cli(["check", path.join(out, "360x640.mp4")]).status, 0);
  fs.writeFileSync(path.join(out, "reframekit-check-360x640", ".DS_Store"), "x");
  fs.writeFileSync(path.join(out, ".DS_Store"), "x");
  const r = cli([fixture("twoShots"), "--for", "360x640", "--lufs", "-16", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Removed from the earlier run: reframekit-check-360x640/);
  assert.ok(!fs.existsSync(path.join(out, "reframekit-check-360x640")));
  const win = outDir("system-files-new");
  fs.mkdirSync(win, { recursive: true });
  for (const name of ["desktop.ini", "Thumbs.db", "._360x640.mp4"]) fs.writeFileSync(path.join(win, name), "x");
  const w = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", win]);
  assert.equal(w.status, 0, w.stderr);
  assert.deepEqual(fs.readdirSync(win).sort(), ["._360x640.mp4", "FORMATS.md", "Thumbs.db", "crop.json", "desktop.ini", "sheet.png"]);
});

test("a folder or a link named like a system's file counts as someone's: a check's folder that holds one is kept, with what is in it", () => {
  const out = outDir("system-named");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--out", out]).status, 0);
  assert.equal(cli(["check", path.join(out, "360x640.mp4")]).status, 0);
  const mine = path.join(out, "reframekit-check-360x640", "._mine");
  fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, "notes.txt"), "my notes");
  const r = cli([fixture("twoShots"), "--for", "360x640", "--lufs", "-16", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Removed from the earlier run/);
  assert.equal(fs.readFileSync(path.join(mine, "notes.txt"), "utf8"), "my notes");
  // A new folder that holds a folder named Thumbs.db is someone's.
  const theirs = outDir("system-named-new");
  fs.mkdirSync(path.join(theirs, "Thumbs.db"), { recursive: true });
  const t = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", theirs]);
  assert.equal(t.status, 1);
  assert.match(t.stderr, /is not empty and holds no earlier reframekit run/);
});

test("a link named like a hidden folder of a run is never followed: what it leads to stays, and so does the link", { skip: process.platform === "win32" }, () => {
  const out = outDir("stage-link");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]).status, 0);
  // A folder outside, whose owner file names this machine and a process
  // that is not there, as a killed run's would, and a link to it.
  const victim = outDir("stage-link-victim");
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "a.txt"), "precious");
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  fs.writeFileSync(path.join(victim, ".owner"), JSON.stringify({ pid: Number(dead), host: os.hostname(), dir: out }));
  fs.symlinkSync(victim, path.join(out, ".reframekit-evil"));
  const r = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(victim, "a.txt"), "utf8"), "precious");
  assert.ok(fs.lstatSync(path.join(out, ".reframekit-evil")).isSymbolicLink());
  // One whose owner file names a process that is there is no run going
  // on either: neither the run nor its dry run is refused for it.
  fs.writeFileSync(path.join(victim, ".owner"), JSON.stringify({ pid: process.pid === 1 ? 2 : 1, host: os.hostname(), dir: path.resolve(out) }));
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]).status, 0);
  assert.equal(JSON.parse(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out, "--dry-run", "--json"]).stdout).refused, null);
  assert.equal(fs.readFileSync(path.join(victim, "a.txt"), "utf8"), "precious");
});

test("a hidden folder of a killed run whose process id another process took since is removed, and one whose process may still be it is named in the refusal", { skip: process.platform !== "linux" }, () => {
  const out = outDir("stale-owner");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]).status, 0);
  // Process 1 is there, and started before any run: not the one that
  // wrote this owner file, which says when its process started.
  const left = path.join(out, ".reframekit-Zz9Yy8");
  fs.mkdirSync(left);
  fs.writeFileSync(path.join(left, ".owner"), JSON.stringify({ pid: 1, host: os.hostname(), dir: out, started: "another boot:12345" }));
  const r = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(left), "the killed run's hidden folder is gone");
  // An owner file that does not say when its process started, as one of a
  // run that may still be going: the refusal names the hidden folder.
  fs.mkdirSync(left);
  fs.writeFileSync(path.join(left, ".owner"), JSON.stringify({ pid: 1, host: os.hostname(), dir: out }));
  const busy = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]);
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /Another reframekit run \(process 1\) is writing in .*stale-owner\. Wait for it to end, or pick another folder with --out\. If no reframekit run is going on, remove .*stale-owner\/\.reframekit-Zz9Yy8\./);
  fs.rmSync(left, { recursive: true, force: true });
  // A run records when its process started.
  const { openStage, drop, startOf } = require("../skills/reframekit/scripts/lib/folder");
  const rec = openStage(outDir("owner-started"));
  try {
    assert.equal(JSON.parse(fs.readFileSync(path.join(rec.stage, ".owner"), "utf8")).started, startOf(process.pid));
    assert.match(startOf(process.pid), /^[\w-]+:\d+$/);
  } finally {
    drop(rec);
  }
});

test("a run going on in a folder stops a run there however the folder is named, through a link or as it was given", { skip: process.platform === "win32" }, () => {
  const real = outDir("busy-real");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", real]).status, 0);
  const alias = outDir("busy-alias");
  fs.symlinkSync(real, alias);
  const before = hashes(real);
  // The hidden folder of a run going on there, given as the folder itself:
  // its process is this test's, which is there.
  const stage = path.join(real, ".reframekit-Busy01");
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, ".owner"), JSON.stringify({ pid: process.pid, host: os.hostname(), dir: path.resolve(real) }));
  for (const out of [alias, real]) {
    const dry = JSON.parse(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out, "--dry-run", "--json"]).stdout);
    assert.match(String(dry.refused), new RegExp(`^Another reframekit run \\(process ${process.pid}\\) is writing in ${out}\\.`), out);
    const r = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(`is writing in ${out}. Wait for it to end, or pick another folder with --out. If no reframekit run is going on, remove ${path.join(out, ".reframekit-Busy01")}.`), r.stderr);
    assert.doesNotMatch(r.stderr, /Reading/);
  }
  assert.ok(fs.existsSync(path.join(stage, ".owner")));
  fs.rmSync(stage, { recursive: true, force: true });
  assert.deepEqual(hashes(real), before);
});

test("a file of a run edited without changing its size is someone's, as its hash tells, and a run that would replace it stops", () => {
  const out = outDir("same-size");
  assert.equal(cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]).status, 0);
  const md = path.join(out, "FORMATS.md");
  const text = fs.readFileSync(md, "utf8");
  const mine = text.replace("Nothing was rendered for this plan.", "MY NOTE: check the logo shot first.");
  assert.equal(Buffer.byteLength(mine), Buffer.byteLength(text));
  fs.writeFileSync(md, mine);
  const r = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", out]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /FORMATS\.md in .*same-size is not a file reframekit wrote, and a run there would replace it/);
  assert.equal(fs.readFileSync(md, "utf8"), mine);
  const crop = JSON.parse(fs.readFileSync(path.join(out, "crop.json"), "utf8"));
  assert.deepEqual(Object.keys(crop.hashes), Object.keys(crop.written));
});
