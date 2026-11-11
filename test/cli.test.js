"use strict";

// The command line: its options and their bounds, the dry run, the
// version in every manifest, the errors told before any work, and which
// ffmpeg it runs.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { parse, parseTime } = require("../skills/reframekit/scripts/reframekit");
const { fixture, ffmpeg, cli, outDir, dir, CLI } = require("./helpers");

test("the skill folder carries its own version, the same as the package's and every plugin manifest's", () => {
  const version = require("../skills/reframekit/scripts/lib/version");
  assert.equal(version, require("../package.json").version);
  assert.equal(version, require("../package-lock.json").version);
  assert.equal(version, require("../package-lock.json").packages[""].version);
  assert.equal(version, require("../.claude-plugin/marketplace.json").plugins[0].version);
  assert.equal(version, require("../.codex-plugin/plugin.json").version);
  assert.equal(version, require("../plugin.json").version);
});

test("the Agent Plugins manifest keeps to its closed schema", () => {
  const manifest = require("../plugin.json");
  const allowed = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
  for (const key of Object.keys(manifest)) assert.ok(allowed.has(key), `plugin.json has ${key}`);
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.match(manifest.name, /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
});

test("the CLI explains itself and refuses a missing video or a bad option with exit code 2", () => {
  const help = cli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: reframekit <video> \[options\]/);
  assert.equal(cli(["-v"]).stdout.trim(), require("../package.json").version);
  const none = cli([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /Give one video/);
  for (const [args, said] of [
    [["a.mp4", "--for", "myspace"], /--for does not know myspace/],
    [["a.mp4", "--for", "constructor"], /--for does not know constructor/],
    [["a.mp4", "--for", "__proto__,square"], /--for does not know __proto__/],
    [["a.mp4", "--for", "1081x1920"], /must be even/],
    [["a.mp4", "--mode", "zoom"], /--mode takes follow, center, pad, fit/],
    [["a.mp4", "--lufs", "-4"], /--lufs takes -40 to -5/],
    [["a.mp4", "--fps", "61"], /--fps takes 10 to 60/],
    [["a.mp4", "--seconds", "0.5"], /--seconds takes 1 second/],
    [["a.mp4", "--pad", "pink"], /--pad takes blur, black, white, brand/],
    [["a.mp4", "--pad", "brand"], /--pad brand needs --brand/],
    [["a.mp4", "--crop", "c.json", "--mode", "pad"], /--crop already says/],
    [["a.mp4", "--cuts", "soon"], /--cuts takes seconds/],
    [["a.mp4", "--wat"], /Unknown option: --wat/],
    [["a.mp4", "--out"], /--out needs a value/],
    [["a.mp4", "--captions", "c.ass"], /--captions is a check option/],
    [["check"], /Give one folder or file to check/],
    [["check", "f", "--lufs", "-14"], /--lufs is not a check option/],
    [["a.mp4", "--for", "4096x64"], /a shape from 1:4 to 4:1/],
    [["a.mp4", "--for", "all,200x200,202x202,204x204,206x206,208x208"], /at most 12 places in one run, not 13/],
  ]) {
    const run = cli(args);
    assert.equal(run.status, 2, `${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, said);
  }
});

test("README's command line block gives --help's options and check options word for word, and the Codex manifest names the ffmpeg it needs as README does", () => {
  const help = cli(["--help"]).stdout;
  const end = "It exits with 1 when a file fails a place's limits.";
  const block = help.slice(help.indexOf("Options:"), help.indexOf(end) + end.length);
  assert.ok(block.length > 1000, block);
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8").includes(block), "README's options are not --help's");
  assert.match(require("../.codex-plugin/plugin.json").interface.longDescription, /Needs Node 22 or newer and ffmpeg 4\.4 or newer, and no API key\.$/);
});

test("the help keeps to 80 columns, and a color for --pad needs no quotes without its #", () => {
  const help = cli(["--help"]).stdout;
  for (const line of help.split("\n")) assert.ok(line.length <= 80, `${line.length}: ${line}`);
  assert.match(help, /reframekit check <folder\|formats\.json\|file\.mp4>/);
  assert.equal(parse(["a.mp4", "--pad", "0F172A"]).pad, "#0f172a");
  assert.equal(parse(["a.mp4", "--crop", "c.json", "--mode", "fit"]).mode, "fit");
});

test("crop.json is refused with shots shorter than 0.4 s, more points than a path takes, or a window too small", () => {
  const { readCrop } = require("../skills/reframekit/scripts/lib/plan");
  const { shapesFor } = require("../skills/reframekit/scripts/lib/plan");
  const { parsePlaces } = require("../skills/reframekit/scripts/lib/places");
  const shapes = shapesFor(parsePlaces("360x640"));
  const at = { width: 640, height: 360, duration: 4, shapes };
  const shot = (start, end, win = { mode: "follow", path: [[start, 0, 0]] }) => ({ start, end, windows: { "9:16": win } });
  const base = { reframekit: "0.1.0", width: 640, height: 360 };
  assert.equal(readCrop({ ...base, shots: [shot(0, 2), shot(2, 4)] }, at).shots.length, 2);
  assert.throws(() => readCrop({ ...base, shots: [shot(0, 2), shot(2, 2.1), shot(2.1, 4)] }, at), /shot 2 lasts 0\.1 s; a shot lasts at least 0\.4 s/);
  assert.throws(() => readCrop({ ...base, shots: Array.from({ length: 3000 }, (_, i) => shot((i * 4) / 3000, ((i + 1) * 4) / 3000)) }, at), /it has 3000 shots, and a 4 s video holds at most 10/);
  const many = Array.from({ length: 500 }, (_, i) => [i / 125, 0, 0]);
  assert.throws(() => readCrop({ ...base, shots: [shot(0, 4, { mode: "follow", path: many })] }, at), /its path has 500 points; a 4 s shot takes at most 122/);
  assert.throws(() => readCrop({ ...base, shots: [shot(0, 4, { mode: "follow", w: 0.5, h: 1, path: [[0, 0, 0]] })] }, at), /too small/);
  // A fade JSON reads as Infinity, or longer than its shot, would never let
  // a padded shot switch on.
  const faded = (fade) => ({ ...base, shots: [shot(0, 2), { ...shot(2, 4, { mode: "pad" }), fade }] });
  assert.throws(() => readCrop(JSON.parse(JSON.stringify(faded(0)).replace('"fade":0', '"fade":1e400')), at), /shot 2's fade, the cross-fade from the shot before, is Infinity; it takes 0 to 2 s, the shot's length/);
  assert.throws(() => readCrop(faded(2.5), at), /shot 2's fade.* is 2\.5; it takes 0 to 2 s/);
  assert.equal(readCrop(faded(0.4), at).shots[1].fade, 0.4);
});

test("the command to render again starts with the program the way it was run", () => {
  const { program } = require("../skills/reframekit/scripts/reframekit");
  const version = require("../skills/reframekit/scripts/lib/version");
  const was = process.argv[1];
  const as = (script) => {
    process.argv[1] = script;
    return program();
  };
  try {
    assert.equal(as("/home/me/.npm/_npx/0a1b2c/node_modules/.bin/reframekit"), `npx reframekit@${version}`);
    assert.equal(as("/home/me/site/node_modules/reframekit/skills/reframekit/scripts/reframekit.js"), `npx reframekit@${version}`);
    assert.equal(as("/home/me/.claude/skills/reframekit/scripts/reframekit.js"), "node /home/me/.claude/skills/reframekit/scripts/reframekit.js");
    assert.equal(as("/home/me/My Skills/reframekit/scripts/reframekit.js"), "node '/home/me/My Skills/reframekit/scripts/reframekit.js'");
    assert.equal(as("/usr/local/bin/reframekit"), "reframekit");
  } finally {
    process.argv[1] = was;
  }
  // On Windows: npm's reframekit.cmd runs the script from npm's global
  // node_modules, and names with spaces, backslashes or signs cmd,
  // PowerShell or Git Bash read go in double quotes.
  const win = (script, execPath = "C:\\Program Files\\nodejs\\node.exe") => program({ script, platform: "win32", env: { APPDATA: "C:\\Users\\Emin Budak\\AppData\\Roaming" }, execPath });
  assert.equal(win("C:\\Users\\Emin Budak\\AppData\\Roaming\\npm\\node_modules\\reframekit\\skills\\reframekit\\scripts\\reframekit.js"), "reframekit");
  assert.equal(win("C:\\Program Files\\nodejs\\node_modules\\reframekit\\skills\\reframekit\\scripts\\reframekit.js"), "reframekit");
  assert.equal(win("C:\\Users\\Emin Budak\\AppData\\Local\\npm-cache\\_npx\\0a1b\\node_modules\\reframekit\\skills\\reframekit\\scripts\\reframekit.js"), `npx reframekit@${version}`);
  assert.equal(win("C:\\Users\\Emin Budak\\.claude\\skills\\reframekit\\scripts\\reframekit.js"), 'node "C:\\Users\\Emin Budak\\.claude\\skills\\reframekit\\scripts\\reframekit.js"');
  assert.equal(win("C:\\Users\\emin\\.claude\\skills\\reframekit\\scripts\\reframekit.js"), 'node "C:\\Users\\emin\\.claude\\skills\\reframekit\\scripts\\reframekit.js"');
  const { nextCommand } = require("../skills/reframekit/scripts/lib/report");
  assert.equal(nextCommand({ program: "reframekit", video: "C:\\clips\\Emin's film.mp4", dir: "reframekit-emin-s-film", places: ["tiktok", "square"], pad: "#0f172a", platform: "win32" }), 'reframekit "C:\\clips\\Emin\'s film.mp4" --crop reframekit-emin-s-film/crop.json --for "tiktok,square" --out reframekit-emin-s-film --pad "#0f172a"');
  assert.equal(nextCommand({ program: "reframekit", video: "Emin's film.mp4", dir: "out", places: ["tiktok", "square"], pad: "#0f172a", platform: "linux" }), "reframekit 'Emin'\\''s film.mp4' --crop out/crop.json --for tiktok,square --out out --pad '#0f172a'");
});

test("the command to render again on Windows reaches Git Bash, as Claude Code runs it there, with every name whole and nothing in a name run", { skip: process.platform === "win32" }, () => {
  const { nextCommand } = require("../skills/reframekit/scripts/lib/report");
  const here = outDir("win-bash");
  fs.mkdirSync(here, { recursive: true });
  const printer = path.join(here, "args.js");
  fs.writeFileSync(printer, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const program = `'${process.execPath}' '${printer}'`;
  const said = (video, dir) => {
    const command = nextCommand({ program, video, dir, places: ["tiktok", "square"], pad: "#0f172a", platform: "win32" });
    const r = spawnSync("bash", ["-c", command], { cwd: here, encoding: "utf8" });
    assert.equal(r.status, 0, `${command}\n${r.stderr}`);
    return { command, args: JSON.parse(r.stdout) };
  };
  // Each of these reaches the program as it is.
  for (const [video, dir] of [
    ["clip$(touch PWNED).mp4", "reframekit-clip-touch-pwned"],
    ["Q4 $5 offer.mp4", "reframekit-q4-5-offer"],
    ["Emin's film (final) #2, 50% off & more!.mp4", "out"],
    ["C:\\Users\\Emin\\clip.mp4", "C:\\Users\\Emin\\reframekit-clip"],
    ["\\\\server\\share\\clip.mp4", "out dir\\"],
    ["My \u201cbest\u201d film.mp4", "out"],
  ]) {
    const { command, args } = said(video, dir);
    assert.equal(args[0], video, command);
    assert.equal(args[6], dir, command);
    assert.equal(args[4], "tiktok,square", command);
    assert.equal(args[args.length - 1], "#0f172a", command);
    assert.doesNotMatch(command, /"[^"]*\$[^"]*"/, "a $ inside double quotes");
  }
  // A name with both an apostrophe and a $ or a backtick is quoted as
  // PowerShell reads it, where Git Bash loses the apostrophe; nothing in
  // it runs either way.
  const { command, args } = said("it's `touch PWNED`.mp4", "out");
  assert.equal(command.split(" --crop")[0].slice(program.length + 1), "'it''s `touch PWNED`.mp4'");
  assert.equal(args[0], "its `touch PWNED`.mp4");
  assert.ok(!fs.existsSync(path.join(here, "PWNED")), "a name ran a command");
});

test("the command to render again sits whole in FORMATS.md's code span when a name holds a backtick", () => {
  const here = outDir("backtick");
  fs.mkdirSync(here, { recursive: true });
  fs.copyFileSync(fixture("twoShots"), path.join(here, "a`b`.mp4"));
  const r = cli(["a`b`.mp4", "--for", "180x320", "--plan", "--out", "bt"], { cwd: here });
  assert.equal(r.status, 0, r.stderr);
  const next = r.stdout.trim().split("\n").pop().trim();
  assert.match(next, /'a`b`\.mp4'/);
  assert.ok(fs.readFileSync(path.join(here, "bt", "FORMATS.md"), "utf8").includes(`- Then render, from the folder this plan was started in: \`\`${next}\`\`.\n`));
  const { codeSpan } = require("../skills/reframekit/scripts/lib/report");
  assert.equal(codeSpan("reframekit film.mp4"), "`reframekit film.mp4`");
  assert.equal(codeSpan("x ``y`` z"), "```x ``y`` z```");
  assert.equal(codeSpan("`x`"), "`` `x` ``");
});

test("options: places, sizes, times and the rest", () => {
  const o = parse(["film.mp4", "--for", "tiktok,1080x1350,Square", "--mode", "PAD", "--pad", "#0F172A", "--seconds", "1:30", "--lufs", "-16", "--fps", "30000/1001", "--cover=4.5s", "--no-trim", "--out", "x", "--json"]);
  assert.deepEqual(o.places.map((p) => p.name), ["tiktok", "1080x1350", "square"]);
  assert.equal(o.places[1].custom, true);
  assert.equal(o.mode, "pad");
  assert.equal(o.pad, "#0f172a");
  assert.equal(o.seconds, 90);
  assert.equal(o.lufs, -16);
  assert.ok(Math.abs(o.fps - 29.97) < 0.001);
  assert.equal(o.cover, 4.5);
  assert.equal(o.trim, false);
  assert.equal(o.json, true);
  assert.deepEqual(parse(["film.mp4"]).places.map((p) => p.name), ["tiktok", "reels", "shorts", "youtube", "x", "linkedin", "feed", "square"]);
  assert.equal(parseTime("--seconds", "1:02:03"), 3723);
  assert.throws(() => parseTime("--cover", "soon"), /--cover takes a time/);
  // Seconds of 60 or more after a colon, or minutes of 60 or more between
  // two, are a time mistyped, not another length; minutes alone may run
  // past 59.
  for (const t of ["1:99", "1:60", "0:00:99.5", "1:60:00", "0:59:60"]) assert.throws(() => parseTime("--seconds", t), new RegExp(`^Error: --seconds takes a time such as 30, 30\\.5s or 1:05, not ${t}$`), t);
  assert.equal(parseTime("--seconds", "1:59.5"), 119.5);
  // To the millisecond, without the sum's float noise.
  assert.equal(parseTime("--seconds", "1:59.99"), 119.99);
  assert.equal(parseTime("--cover", "1:00:00.07"), 3600.07);
  assert.equal(parseTime("--seconds", "12.3456"), 12.346);
  assert.match(cli(["film.mp4", "--for", "square", "--seconds", "1:59.99", "--dry-run", "--json"]).stdout, /"seconds": 119\.99,/);
  assert.equal(parseTime("--cover", "0:59:59.9"), 3599.9);
  assert.equal(parseTime("--seconds", "90:00"), 5400);
  const typo = cli(["film.mp4", "--for", "square", "--seconds", "1:99", "--dry-run", "--json"]);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /^reframekit: --seconds takes a time such as 30, 30\.5s or 1:05, not 1:99$/m);
  // A rate given with --fps comes back as it was given, a fraction only
  // where it is one.
  const { outputRate, rateText } = require("../skills/reframekit/scripts/lib/render");
  assert.deepEqual([10, 15, 20, 12.5, 29.97, 59.94, 16.667].map((g) => rateText(outputRate({}, g))), ["10", "15", "20", "25/2", "30000/1001", "60000/1001", "16667/1000"]);
  const c = parse(["check", "dir", "--for", "reels", "--captions", "c.ass"]);
  assert.equal(c.command, "check");
  assert.equal(c.places[0].name, "reels");
});

test("the dry run reads no video and starts no ffmpeg, and takes every number at its bounds", () => {
  const env = { ...process.env, FFMPEG_PATH: "/nonexistent/ffmpeg", FFPROBE_PATH: "/nonexistent/ffprobe" };
  for (const extra of [["--lufs", "-40"], ["--lufs", "-5"], ["--seconds", "1"], ["--seconds", "43200"], ["--fps", "10"], ["--fps", "60"]]) {
    const run = cli(["no-such-video.mp4", ...extra, "--dry-run"], { env });
    assert.equal(run.status, 0, `${extra.join(" ")}: ${run.stderr}`);
    assert.match(run.stdout, /The video was not read and nothing was written/);
  }
  const json = cli(["no such video.mp4", "--for", "tiktok,square", "--dry-run", "--json"], { env });
  assert.equal(json.status, 0);
  const d = JSON.parse(json.stdout);
  assert.equal(d.exists, false);
  assert.equal(d.out, "reframekit-no-such-video");
  assert.deepEqual(d.places.map((p) => p.name), ["tiktok", "square"]);
  assert.equal(d.places[0].seconds, 180);
  const check = cli(["check", "nowhere", "--for", "reels", "--dry-run"], { env });
  assert.equal(check.status, 0);
  assert.match(check.stdout, /would check nowhere against reels/);
  assert.ok(!fs.existsSync(path.join(process.cwd(), "reframekit-no-such-video")));
});

test("the dry run names the folder the run would take, past one that holds another video's run or another file's check, and says when --out would stop it", () => {
  const here = outDir("dry-folders");
  for (const sub of ["acme", "beta"]) {
    fs.mkdirSync(path.join(here, sub), { recursive: true });
    fs.copyFileSync(fixture("twoShots"), path.join(here, sub, "film.mp4"));
  }
  assert.equal(cli(["acme/film.mp4", "--for", "360x640", "--plan"], { cwd: here }).status, 0);
  const env = { ...process.env, FFMPEG_PATH: "/nonexistent/ffmpeg", FFPROBE_PATH: "/nonexistent/ffprobe" };
  const dry = (args) => JSON.parse(cli([...args, "--dry-run", "--json"], { cwd: here, env }).stdout);
  assert.deepEqual([dry(["acme/film.mp4", "--for", "360x640", "--plan"]).out, dry(["beta/film.mp4", "--for", "360x640", "--plan"]).out], ["reframekit-film", "reframekit-film-2"]);
  const told = cli(["beta/film.mp4", "--for", "360x640", "--out", "reframekit-film", "--dry-run"], { cwd: here, env });
  assert.equal(told.status, 0);
  assert.match(told.stdout, /The run would stop: reframekit-film holds a run for acme\/film\.mp4, not for beta\/film\.mp4\. Pick another folder with --out\./);
  // The real runs go where the dry runs said.
  assert.match(cli(["beta/film.mp4", "--for", "360x640", "--plan"], { cwd: here }).stdout, /in reframekit-film-2\n/);
  assert.equal(cli(["beta/film.mp4", "--for", "360x640", "--plan", "--out", "reframekit-film"], { cwd: here }).status, 1);
  // A lone MP4's check, past the folder of another file's check.
  fs.copyFileSync(fixture("twoShots"), path.join(here, "clip.mp4"));
  ffmpeg(["-i", fixture("twoShots"), "-c", "copy", path.join(here, "clip.mov")]);
  assert.equal(cli(["check", "clip.mp4", "--for", "youtube"], { cwd: here }).status, 0);
  assert.equal(dry(["check", "clip.mov", "--for", "youtube"]).out, "reframekit-check-clip-2");
  assert.equal(dry(["check", "clip.mov", "--for", "youtube", "--out", "reframekit-check-clip"]).refused, "reframekit-check-clip holds the check of clip.mp4, not of clip.mov. Give --out another folder.");
});

test("the dry run stops for every reason the run stops before any work, with the run's own words, and writes nothing", () => {
  const here = outDir("dry-refusals");
  fs.mkdirSync(here, { recursive: true });
  const film = fixture("twoShots");
  const env = { ...process.env, FFMPEG_PATH: "/nonexistent/ffmpeg", FFPROBE_PATH: "/nonexistent/ffprobe" };
  const listing = () => JSON.stringify(fs.readdirSync(here, { recursive: true }).sort());
  // The dry run's refusal, and that the run itself stops with it.
  const refused = (args) => {
    const before = listing();
    const dry = cli([...args, "--dry-run", "--json"], { cwd: here, env });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(listing(), before, "the dry run wrote nothing");
    const said = JSON.parse(dry.stdout).refused;
    const run = cli(args, { cwd: here });
    assert.equal(run.status, 1, run.stdout);
    assert.equal(run.stderr.trim(), `reframekit: ${said}`);
    return said;
  };
  fs.mkdirSync(path.join(here, "mine"));
  fs.writeFileSync(path.join(here, "mine", "notes.txt"), "mine");
  assert.equal(refused([film, "--for", "360x640", "--plan", "--out", "mine"]), "mine is not empty and holds no earlier reframekit run. Pick another folder with --out.");
  fs.writeFileSync(path.join(here, "afile"), "x");
  assert.equal(refused([film, "--for", "360x640", "--plan", "--out", "afile"]), "Cannot write to afile: a file is in the way");
  assert.equal(cli([film, "--for", "360x640", "--plan", "--out", "edited"], { cwd: here }).status, 0);
  const crop = JSON.parse(fs.readFileSync(path.join(here, "edited", "crop.json"), "utf8"));
  crop.shots[1].windows["9:16"].path = [[2, 0, 0]];
  fs.writeFileSync(path.join(here, "edited", "crop.json"), JSON.stringify(crop, null, 2));
  assert.match(refused([film, "--for", "360x640", "--out", "edited"]), /^edited\/crop\.json was edited by hand, and this run would plan over it\./);
  assert.equal(cli([film, "--for", "360x640", "--plan", "--out", "letters"], { cwd: here }).status, 0);
  fs.writeFileSync(path.join(here, "letters", "formats.md"), "# my notes\n");
  assert.match(refused([film, "--for", "360x640", "--plan", "--out", "letters"]), /^formats\.md in letters is not a file reframekit wrote, and a run there would replace it: it writes FORMATS\.md/);
  // A check: someone's CHECK.md in the folder given, a folder that takes
  // no files.
  fs.mkdirSync(path.join(here, "theirs"));
  fs.writeFileSync(path.join(here, "theirs", "CHECK.md"), "# my checklist\n");
  assert.match(refused(["check", film, "--for", "youtube", "--out", "theirs"]), /^theirs\/CHECK\.md is not a report reframekit wrote, and the check would replace it/);
  // Next to a file given, the check's folder is named as found there.
  fs.mkdirSync(path.join(here, "clips", "reframekit-check-short"), { recursive: true });
  fs.copyFileSync(film, path.join(here, "clips", "short.mp4"));
  fs.writeFileSync(path.join(here, "clips", "reframekit-check-short", "CHECK.md"), "# mine\n");
  assert.match(refused(["check", "clips/short.mp4", "--for", "youtube"]), /^clips\/reframekit-check-short\/CHECK\.md is not a report reframekit wrote/);
  if (process.getuid && process.getuid() === 0) return;
  const card = path.join(here, "card");
  fs.mkdirSync(card);
  fs.copyFileSync(film, path.join(card, "short.mp4"));
  fs.chmodSync(card, 0o555);
  try {
    assert.equal(refused(["check", "card/short.mp4", "--for", "youtube"]), "Cannot write the check to card/reframekit-check-short: permission denied; give --out a folder that takes files");
  } finally {
    fs.chmodSync(card, 0o755);
  }
});

test("the dry run stops where the run stops on a file given that is not there or not what it should be, and says ok only when the run would go", () => {
  const here = outDir("dry-arguments");
  fs.mkdirSync(path.join(here, "foreign"), { recursive: true });
  fs.writeFileSync(path.join(here, "foreign", "notes.txt"), "mine");
  fs.copyFileSync(fixture("twoShots"), path.join(here, "film.mp4"));
  const write = (name, text) => fs.writeFileSync(path.join(here, name), text);
  write("bad-cuts.json", '{"x":1}');
  write("theirs.json", '{"a":1}');
  write("page.json", '{"kind":"page"}');
  write("bad.txt", "no captions here\n");
  write("notext.ass", "[Script Info]\nPlayResX: 384\nPlayResY: 288\n\n[Events]\nFormat: Layer, Start, End, Style\nDialogue: 0,0:00:00.50,0:00:02.00,Default\n");
  fs.mkdirSync(path.join(here, "kit"));
  fs.writeFileSync(path.join(here, "kit", "brand.json"), JSON.stringify({ colors: [{ hex: "#f6f5f1", role: "surface" }] }));
  const env = { ...process.env, FFMPEG_PATH: "/nonexistent/ffmpeg", FFPROBE_PATH: "/nonexistent/ffprobe" };
  const listing = () => JSON.stringify(fs.readdirSync(here, { recursive: true }).sort());
  const refused = (args, said) => {
    const before = listing();
    const dry = cli([...args, "--dry-run", "--json"], { cwd: here, env });
    assert.equal(dry.status, 0, dry.stderr);
    const d = JSON.parse(dry.stdout);
    assert.deepEqual([d.refused, d.ok], [said, false], args.join(" "));
    const text = cli([...args, "--dry-run"], { cwd: here, env }).stdout;
    assert.ok(text.includes(`would stop: ${said}\n`), text);
    assert.equal(listing(), before, "the dry run wrote nothing");
    const run = cli(args, { cwd: here });
    assert.equal(run.status, 1, run.stdout);
    assert.equal(run.stderr.trim().split("\n").pop(), `reframekit: ${said}`, args.join(" "));
    assert.equal(listing(), before, "the run left the folder as it was");
  };
  refused(["nothing.mp4", "--for", "360x640", "--out", "o"], "Cannot read nothing.mp4: no such file");
  refused(["foreign", "--for", "360x640", "--out", "o"], "foreign is a folder; give a video file");
  refused(["film.mp4", "--for", "360x640", "--crop", "nope.json", "--out", "o"], "Cannot read nope.json: no such file");
  refused(["film.mp4", "--for", "360x640", "--crop", "theirs.json", "--out", "o"], "theirs.json is not a crop.json reframekit wrote");
  refused(["film.mp4", "--for", "360x640", "--cuts", "nope.json", "--out", "o"], "Cannot read nope.json: no such file");
  refused(["film.mp4", "--for", "360x640", "--cuts", "bad-cuts.json", "--out", "o"], 'bad-cuts.json holds no cuts: give seconds, { "fps", "cuts" } in frames, a launch-film timeline or easyscreenshotkit\'s steps.json');
  refused(["film.mp4", "--for", "360x640", "--steps", "nope.json", "--out", "o"], "Cannot read nope.json: no such file");
  refused(["film.mp4", "--for", "360x640", "--steps", "page.json", "--out", "o"], 'page.json is not easyscreenshotkit\'s steps.json (a demo\'s steps, with "kind": "demo")');
  refused(["film.mp4", "--for", "360x640", "--brand", "nobrand", "--out", "o"], "Cannot read nobrand: no such file");
  refused(["film.mp4", "--for", "360x640", "--pad", "brand", "--brand", "foreign", "--out", "o"], "foreign names no background color: give --pad a color instead, such as --pad '#0f172a'");
  // A check's caption file, and the formats.json of the folder checked.
  refused(["check", "film.mp4", "--for", "youtube", "--captions", "missing.srt"], "Cannot read missing.srt: no such file");
  refused(["check", "film.mp4", "--for", "youtube", "--captions", "bad.txt"], "bad.txt is not a caption file reframekit reads (ASS, SRT or WebVTT)");
  refused(["check", "film.mp4", "--for", "youtube", "--captions", "notext.ass"], "notext.ass has no Text in its [Events] Format line, so its captions cannot be read");
  fs.mkdirSync(path.join(here, "broken"));
  write("broken/formats.json", "{ not json");
  const broken = JSON.parse(cli(["check", "broken", "--dry-run", "--json"], { cwd: here, env }).stdout);
  assert.equal(broken.ok, false);
  assert.match(broken.refused, /^broken\/formats\.json is not reframekit's formats\.json: /);
  // A brand kit the run reads, and one --pad leaves out.
  const branded = cli(["film.mp4", "--for", "360x640", "--pad", "brand", "--brand", "kit", "--out", "o", "--dry-run"], { cwd: here, env });
  assert.match(branded.stdout, /padded shots on the brand's background/);
  assert.doesNotMatch(branded.stdout, /would stop/);
  assert.equal(JSON.parse(cli(["film.mp4", "--for", "360x640", "--pad", "black", "--brand", "foreign", "--out", "o", "--dry-run", "--json"], { cwd: here, env }).stdout).ok, true);
});

test("without ffmpeg it says how to get it", () => {
  const file = fixture("twoShots");
  const run = cli([file, "--out", outDir("no-ffmpeg")], { env: { ...process.env, FFMPEG_PATH: "/nonexistent/ffmpeg", FFPROBE_PATH: "/nonexistent/ffprobe" } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /reframekit needs ffmpeg and ffprobe/);
  assert.ok(!fs.existsSync(outDir("no-ffmpeg")));
});

test("an ffmpeg that lacks filters is named with them before any work, one made without --enable-gpl or with filters left out as such, not as one too old", { skip: process.platform === "win32" }, () => {
  // The system's ffmpeg, listing its filters without some of them: as a
  // build made without --enable-gpl lists them (no cropdetect, no eq), as
  // one older than 4.3 does (no scdet), as both at once, and as one made
  // with some filters left out does, here bwdif, which only an interlaced
  // picture takes, and volume, or transpose, which ffmpeg adds itself to
  // turn a phone's video upright.
  const bin = outDir("filters-bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const said = {
    "cropdetect|eq": "This ffmpeg lacks the cropdetect, eq filters, which come only in a build made with --enable-gpl, as Ubuntu's is. Install such a build of ffmpeg (4.4 or later) or point FFMPEG_PATH at one.",
    eq: "This ffmpeg lacks the eq filter, which comes only in a build made with --enable-gpl, as Ubuntu's is. Install such a build of ffmpeg (4.4 or later) or point FFMPEG_PATH at one.",
    scdet: "This ffmpeg lacks the scdet filter. Install a newer build of ffmpeg (4.4 or later) or point FFMPEG_PATH at one.",
    "scdet|eq": "This ffmpeg lacks the scdet, eq filters. Install a newer build of ffmpeg (4.4 or later), made with --enable-gpl, or point FFMPEG_PATH at one.",
    "bwdif|volume": "This ffmpeg lacks the bwdif, volume filters. Install a full build of ffmpeg (4.4 or later) or point FFMPEG_PATH at one.",
    transpose: "This ffmpeg lacks the transpose filter. Install a full build of ffmpeg (4.4 or later) or point FFMPEG_PATH at one.",
  };
  for (const [hidden, words] of Object.entries(said)) {
    const name = hidden.replace("|", "-");
    const fake = path.join(bin, name);
    fs.writeFileSync(fake, `#!/bin/sh\ncase "$*" in *-filters*) "${real}" "$@" | grep -v -E '^ *[A-Z.|]{2,3} +(${hidden}) '; exit 0;; esac\nexec "${real}" "$@"\n`);
    fs.chmodSync(fake, 0o755);
    const env = { ...process.env, FFMPEG_PATH: fake };
    for (const args of [[fixture("twoShots"), "--for", "180x320", "--plan"], ["check", fixture("twoShots")]]) {
      const out = outDir(`filters-${name}-${args[0] === "check" ? "check" : "plan"}`);
      const r = cli([...args, "--out", out], { env });
      assert.equal(r.status, 1, `${name}: ${r.stderr}`);
      assert.equal(r.stderr, `reframekit: ${words}\n`, name);
      assert.ok(!fs.existsSync(out), name);
    }
  }
});

test("an ffmpeg with no H.264 encoder a render can use, or with no AAC encoder, stops a render before any work with what it lacks, while a plan and a check, which encode nothing, go ahead", { skip: process.platform === "win32" }, () => {
  // The system's ffmpeg, listing its encoders without the four H.264 ones
  // a render takes (libx264rgb, which it does not take, is left in), or
  // without ffmpeg's own AAC encoder.
  const bin = outDir("encoders-bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const said = {
    "no-h264": ["libx264|h264_videotoolbox|libopenh264|h264_mf", "This ffmpeg has no H.264 encoder (x264, VideoToolbox, OpenH264 or Media Foundation). Install a full build of ffmpeg."],
    "no-aac": ["aac", "This ffmpeg has no AAC encoder. Install a full build of ffmpeg."],
  };
  for (const [name, [hidden, words]] of Object.entries(said)) {
    const fake = path.join(bin, name);
    fs.writeFileSync(fake, `#!/bin/sh\ncase "$*" in *-encoders*) "${real}" "$@" | grep -v -E '^ *[A-Z.]+ +(${hidden}) '; exit 0;; esac\nexec "${real}" "$@"\n`);
    fs.chmodSync(fake, 0o755);
    const env = { ...process.env, FFMPEG_PATH: fake };
    const listed = spawnSync(fake, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout;
    assert.doesNotMatch(listed, new RegExp(`^ *[A-Z.]+ +(${hidden}) `, "m"), name);
    assert.match(listed, name === "no-aac" ? /^ *V\S* +libx264 /m : /^ *A\S* +aac /m, name);
    const render = outDir(`encoders-${name}-render`);
    const r = cli([fixture("twoShots"), "--for", "180x320", "--out", render], { env });
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.equal(r.stderr, `reframekit: ${words}\n`, name);
    assert.ok(!fs.existsSync(render), name);
    const plan = outDir(`encoders-${name}-plan`);
    const planned = cli([fixture("twoShots"), "--for", "180x320", "--plan", "--out", plan], { env });
    assert.equal(planned.status, 0, `${name}: ${planned.stderr}`);
    assert.ok(fs.existsSync(path.join(plan, "crop.json")), name);
    const checked = cli(["check", fixture("twoShots"), "--for", "youtube", "--out", outDir(`encoders-${name}-check`)], { env });
    assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
    assert.ok(fs.existsSync(path.join(outDir(`encoders-${name}-check`), "check.json")), name);
  }
});

test("an ffmpeg or an ffprobe that does not answer is named with why it did not", { skip: process.platform === "win32" }, () => {
  const { unanswered } = require("../skills/reframekit/scripts/lib/ffmpeg");
  // One too slow to answer, as on a machine too busy, which spawnSync ends.
  const late = { error: Object.assign(new Error("spawnSync ffprobe ETIMEDOUT"), { code: "ETIMEDOUT" }), signal: "SIGTERM", status: null };
  assert.equal(unanswered("ffprobe", late, 120_000, "while it read film.mp4").message, "ffprobe did not answer within 120 s while it read film.mp4: the machine may be too busy. Run reframekit again when the machine is less busy.");
  assert.equal(unanswered("ffmpeg", late, 60_000, "when asked to list its filters").message, "ffmpeg did not answer within 60 s when asked to list its filters: the machine may be too busy. Run reframekit again when the machine is less busy.");
  // A signal that stops a run, as Ctrl-C, is a stop (`stopped`); a crash,
  // or the system's kill when memory runs out, is not.
  const ended = (signal) => unanswered("ffprobe", { signal, status: null }, 120_000, "while it read film.mp4");
  assert.deepEqual([ended("SIGTERM").message, ended("SIGTERM").stopped], ["ffprobe was stopped (SIGTERM) while it read film.mp4", "SIGTERM"]);
  assert.deepEqual([ended("SIGINT").stopped, ended("SIGHUP").stopped], ["SIGINT", "SIGHUP"]);
  assert.deepEqual([ended("SIGSEGV").message, ended("SIGSEGV").stopped], ["ffprobe crashed (SIGSEGV) while it read film.mp4", undefined]);
  assert.deepEqual([ended("SIGABRT").message, ended("SIGBUS").message], ["ffprobe crashed (SIGABRT) while it read film.mp4", "ffprobe crashed (SIGBUS) while it read film.mp4"]);
  assert.deepEqual([ended("SIGKILL").message, ended("SIGKILL").stopped], ["ffprobe was killed (SIGKILL) while it read film.mp4, as when the machine runs out of memory", undefined]);
  assert.deepEqual([ended("SIGXCPU").message, ended("SIGXCPU").stopped], ["ffprobe was killed (SIGXCPU) while it read film.mp4", undefined]);
  // A program given for ffmpeg that is none, a file and a folder that
  // cannot be run, and an ffmpeg that crashes as it says what it is, or
  // that is killed or fails as it lists what it has: after its version, a
  // failure is told by the tool's path and what it was asked.
  const bin = outDir("tool-bin");
  fs.mkdirSync(path.join(bin, "folder"), { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const probe = spawnSync("sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).stdout.trim();
  const tools = {
    other: "#!/bin/sh\necho 'not an ffmpeg' >&2\nexit 3\n",
    killed: `#!/bin/sh\ncase "$*" in *-filters*) kill -9 $$;; esac\nexec "${real}" "$@"\n`,
    crashing: `#!/bin/sh\ncase "$*" in *-version*) kill -SEGV $$;; esac\nexec "${real}" "$@"\n`,
    failing: `#!/bin/sh\ncase "$*" in *-encoders*) echo 'cannot list them' >&2; exit 1;; esac\nexec "${real}" "$@"\n`,
  };
  for (const [name, body] of Object.entries(tools)) {
    fs.writeFileSync(path.join(bin, name), body);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  fs.writeFileSync(path.join(bin, "shut"), "#!/bin/sh\n");
  fs.chmodSync(path.join(bin, "shut"), 0o644);
  const said = {
    other: pointsTo("FFMPEG_PATH", path.join(bin, "other"), 'did not run as ffmpeg: it printed "not an ffmpeg" and exited with 3'),
    shut: pointsTo("FFMPEG_PATH", path.join(bin, "shut"), "is not executable"),
    folder: pointsTo("FFMPEG_PATH", path.join(bin, "folder"), "is a folder"),
    killed: `${path.join(bin, "killed")} was killed (SIGKILL) when asked to list its filters, as when the machine runs out of memory`,
    crashing: pointsTo("FFMPEG_PATH", path.join(bin, "crashing"), "did not run as ffmpeg: it was stopped by SIGSEGV"),
    failing: `${path.join(bin, "failing")} failed when asked to list its encoders: cannot list them`,
  };
  for (const [name, words] of Object.entries(said)) {
    const r = cli([fixture("twoShots"), "--for", "180x320", "--out", outDir(`tool-${name}`)], { env: { ...process.env, FFMPEG_PATH: path.join(bin, name), FFPROBE_PATH: probe } });
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.equal(r.stderr, `reframekit: ${words}\n`, name);
    assert.ok(!fs.existsSync(outDir(`tool-${name}`)), name);
  }
  // An ffprobe given as a folder or as a file that cannot be run stops a
  // render, a plan and a check the same way.
  for (const name of ["folder", "shut"]) {
    for (const [i, args] of [[fixture("twoShots"), "--for", "180x320"], [fixture("twoShots"), "--for", "180x320", "--plan"], ["check", fixture("twoShots"), "--for", "youtube"]].entries()) {
      const out = outDir(`probe-${name}-${i}`);
      const r = cli([...args, "--out", out], { env: { ...process.env, FFMPEG_PATH: real, FFPROBE_PATH: path.join(bin, name) } });
      assert.equal(r.status, 1, `${name} ${i}: ${r.stderr}`);
      assert.equal(r.stderr, `reframekit: ${pointsTo("FFPROBE_PATH", path.join(bin, name), name === "folder" ? "is a folder" : "is not executable")}\n`, `${name} ${i}`);
      assert.ok(!fs.existsSync(out), `${name} ${i}`);
    }
  }
});

// The ffmpeg and the ffprobe on PATH, as files, and what a run that cannot
// use a tool says of it, with how to get one.
const INSTALL = "brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg";
const realTool = (tool) => fs.realpathSync(spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim());
const toGet = {
  FFMPEG_PATH: `Set FFMPEG_PATH to an ffmpeg that runs, or unset it and install one (${INSTALL}).`,
  LAUNCH_FILM_FFMPEG: `Set LAUNCH_FILM_FFMPEG to an ffmpeg that runs, or unset it and install one (${INSTALL}).`,
  FFPROBE_PATH: `Set FFPROBE_PATH to an ffprobe that runs, or unset it and install ffmpeg, which comes with one (${INSTALL}).`,
  LAUNCH_FILM_FFPROBE: `Set LAUNCH_FILM_FFPROBE to an ffprobe that runs, or unset it and install ffmpeg, which comes with one (${INSTALL}).`,
  ffmpeg: `Install ffmpeg (${INSTALL}), or set FFMPEG_PATH to an ffmpeg that runs.`,
  ffprobe: `Install ffmpeg, which comes with ffprobe (${INSTALL}), or set FFPROBE_PATH to an ffprobe that runs.`,
  beside: `Set FFPROBE_PATH to an ffprobe that runs, such as the one that comes with ffmpeg (${INSTALL}).`,
};
function pointsTo(variable, file, what) {
  return `reframekit needs ffmpeg and ffprobe, and ${variable} points to ${file}, which ${what}. ${toGet[variable]}`;
}
const onPathIs = (tool, file, what) => `reframekit needs ffmpeg and ffprobe, and the ${tool} on your PATH, ${file}, ${what}. ${toGet[tool]}`;

// What a run says of a file that ran when asked its version and did not
// answer as `tool` does: the first line it printed, on its error output or
// else on its output, in quotes, and how it ended, as the test sees it run
// the same way.
function printed(file, tool = "ffmpeg") {
  const { quoted } = require("../skills/reframekit/scripts/lib/tools");
  const r = spawnSync(file, ["-hide_banner", "-version"], { encoding: "utf8" });
  const first = (text) => String(text || "").split(/\r?\n/).find((line) => line.trim());
  const line = first(r.stderr);
  if (line && r.status === 0 && !first(r.stdout)) return `did not run as ${tool}: it printed ${quoted(line)} on its error output, nothing on its output, and exited with 0`;
  const ended = r.signal ? `was stopped by ${r.signal}` : `exited with ${r.status}`;
  if (line || first(r.stdout)) return `did not run as ${tool}: it printed ${quoted(line || first(r.stdout))} and ${ended}`;
  return `did not run as ${tool}: ${r.signal ? `it was stopped by ${r.signal}` : `it printed nothing and exited with ${r.status}`}`;
}

// What a run says of a file the system did not start, as its interpreter
// or its loader is not there, with the first line of a script.
const lacking = (tool, line) => {
  const { quoted } = require("../skills/reframekit/scripts/lib/tools");
  return `did not run as ${tool}: the system could not start it, as an interpreter or a loader it needs is not there${line ? `; its first line is ${quoted(line)}` : ""}`;
};

// Whether binfmt_misc gives files that start with `magic` (in hex) to a
// program of its own, as qemu or wine, which would run them.
function handled(magic) {
  try {
    const root = "/proc/sys/fs/binfmt_misc";
    return fs.readdirSync(root).some((name) => {
      if (name === "register" || name === "status") return false;
      const entry = fs.readFileSync(path.join(root, name), "utf8");
      return /^enabled$/m.test(entry) && entry.includes(`\nmagic ${magic}`);
    });
  } catch {
    return false;
  }
}

// What a run says of a program made for another system or other
// processors, which the system gives to /bin/sh to read as a script: the
// shell's first line names the file, but what follows is the program's
// bytes, and which of the lines it prints comes first can change from one
// run to the next, as some bytes make it run commands at once.
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const shellRead = (variable, file, tool) => new RegExp(`^${escaped(pointsTo(variable, file, "\0"))}$`.replace(escaped("\0"), `did not run as ${tool}: it printed "${escaped(file)}: .*" and (exited with \\d+|was stopped by SIG\\w+)`));

// Runs reframekit with `env` and each of a render, a plan and a check, or
// the one `only` names, and holds that each stops before any work with
// `message` (or one it matches), exit code 1, no out folder and nothing
// left in TMPDIR, and with --json gives the same error on stdout.
function stopsBeforeWork(name, env, message, only = null) {
  const runs = { render: [fixture("twoShots"), "--for", "180x320"], plan: [fixture("twoShots"), "--for", "180x320", "--plan"], check: ["check", fixture("twoShots"), "--for", "youtube"], json: [fixture("twoShots"), "--for", "180x320", "--json"] };
  for (const [mode, args] of Object.entries(runs)) {
    if (only && only !== mode) continue;
    const folder = outDir(path.join("unstarted-runs", `${name}-${mode}`));
    const tmp = path.join(folder, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const r = cli([...args, "--out", path.join(folder, "out")], { env: { ...env, TMPDIR: tmp } });
    assert.equal(r.status, 1, `${name} ${mode}: ${r.stderr}`);
    const said = r.stderr.replace(/^reframekit: /, "").replace(/\n$/, "");
    if (message instanceof RegExp) assert.match(said, message, `${name} ${mode}`);
    else assert.equal(r.stderr, `reframekit: ${message}\n`, `${name} ${mode}`);
    assert.ok(/^reframekit: [^\n]*\n$/.test(r.stderr), `${name} ${mode}: ${r.stderr}`);
    if (mode === "json") assert.deepEqual(JSON.parse(r.stdout), { ok: false, error: said }, `${name} ${mode}`);
    assert.deepEqual(fs.readdirSync(folder), ["tmp"], `${name} ${mode}`);
    assert.deepEqual(fs.readdirSync(tmp), [], `${name} ${mode}`);
  }
}

test("an ffmpeg or an ffprobe that cannot be started, or that does not answer as one when asked its version, stops a run before any work with the variable or PATH that gives it, its path, what the system or the program said and how to get one", { skip: process.platform !== "linux" ? "the ways a program cannot start are Linux's here" : false }, () => {
  const root = outDir("unstarted");
  const at = (...names) => path.join(root, ...names);
  const real = { ffmpeg: realTool("ffmpeg"), ffprobe: realTool("ffprobe") };
  const root0 = process.getuid && process.getuid() === 0;
  const put = (kind, tool, data, mode = 0o755) => {
    fs.mkdirSync(at(kind), { recursive: true });
    fs.writeFileSync(at(kind, tool), data);
    fs.chmodSync(at(kind, tool), mode);
    return at(kind, tool);
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(at("afile"), "x");
  fs.writeFileSync(at("not-a-program"), "x");
  const cases = [];
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const other = tool === "ffmpeg" ? "ffprobe" : "ffmpeg";
    const variable = tool === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
    const env = { ...process.env, FFMPEG_PATH: real.ffmpeg, FFPROBE_PATH: real.ffprobe };
    const given = (file, what) => [{ ...env, [variable]: file }, pointsTo(variable, file, what)];
    fs.mkdirSync(at("folder", tool), { recursive: true });
    fs.mkdirSync(at("linkdir"), { recursive: true });
    fs.symlinkSync(at("folder", tool), at("linkdir", tool));
    fs.mkdirSync(at("dangling"), { recursive: true });
    fs.symlinkSync(at("nowhere", tool), at("dangling", tool));
    fs.mkdirSync(at("loop"), { recursive: true });
    fs.symlinkSync(at("loop", `${tool}-2`), at("loop", tool));
    fs.symlinkSync(at("loop", tool), at("loop", `${tool}-2`));
    // A link through a file, which the system takes for a folder there.
    fs.mkdirSync(at("linkthru"), { recursive: true });
    fs.symlinkSync(at("afile", tool), at("linkthru", tool));
    const script = put("badinterp", tool, "#!/nonexistent/interpreter\n");
    // A script whose interpreter is a script whose interpreter is missing,
    // one whose #! line ends in a carriage return, as a file saved with
    // Windows line ends, which the system takes as part of its name, and
    // one whose #! line names itself.
    const nested = put("nested", tool, `#!${script}\n`);
    const crlf = put("crlf", tool, `#!/bin/sh\r\nexec "${real[tool]}" "$@"\r\n`);
    const self = put("self", tool, `#!${at("self", tool)}\n`);
    // A script that starts its program through env, which is not there:
    // env names it, on the first line it prints, before any hint.
    const viaEnv = put("env", tool, "#!/usr/bin/env nothing-such-program\n");
    // A text file with no #! line, which the system gives to /bin/sh, and
    // which runs a program that is not there.
    const bare = put("bare", tool, "exec /nonexistent/bin/ffmpeg \"$@\"\n");
    const text = put("text", tool, "not a program\n");
    const empty = put("empty", tool, "");
    const toError = put("to-error", tool, `#!/bin/sh\nexec "${real[tool]}" "$@" >&2\n`);
    const term = put("term", tool, "#!/bin/sh\nkill -TERM $$\n");
    cases.push(
      [`${tool} where nothing is`, ...given(at("nowhere", tool), "is not there")],
      [`${tool} a folder`, ...given(at("folder", tool), "is a folder")],
      [`${tool} a link to a folder`, ...given(at("linkdir", tool), "is a folder")],
      [`${tool} a link that leads nowhere`, ...given(at("dangling", tool), `is a link to ${at("nowhere", tool)}, which is not there`)],
      [`${tool} a loop of links`, ...given(at("loop", tool), "is a link that leads back to itself")],
      [`${tool} through a file`, ...given(at("afile", tool), `is not there, as ${at("afile")} is a file, not a folder`)],
      [`${tool} a link through a file`, ...given(at("linkthru", tool), `is a link to ${path.join(fs.realpathSync(at("afile")), tool)}, which is not there, as ${fs.realpathSync(at("afile"))} is a file, not a folder`)],
      [`${tool} not a file`, ...given("/dev/null", "is not a file")],
      [`${tool} not executable`, ...given(put("plain", tool, "#!/bin/sh\n", 0o644), "is not executable")],
      [`${tool} empty`, ...given(empty, `did not run as ${tool}: it printed nothing and exited with 0`)],
      [`${tool} text with no #!`, ...given(text, printed(text, tool))],
      [`${tool} a script with no #! line whose program is not there`, ...given(bare, printed(bare, tool))],
      [`${tool} #! of a missing program`, ...given(script, lacking(tool, "#!/nonexistent/interpreter"))],
      [`${tool} #! of a script whose #! program is missing`, ...given(nested, lacking(tool, `#!${script}`))],
      [`${tool} #! line ending in a carriage return`, ...given(crlf, lacking(tool, "#!/bin/sh\r"))],
      [`${tool} #! of itself`, ...given(self, `did not run as ${tool}: the system could not start it: too many symbolic links encountered; its first line is "#!${self}"`)],
      [`${tool} #! of a file that may not be run`, ...given(put("fileinterp", tool, `#!${at("not-a-program")}\n`), `did not run as ${tool}: the system could not start it: permission denied; its first line is "#!${at("not-a-program")}"`)],
      [`${tool} #! of a folder`, ...given(put("dirinterp", tool, `#!${root}\n`), `did not run as ${tool}: the system could not start it: permission denied; its first line is "#!${root}"`)],
      [`${tool} #! of a program env does not find`, ...given(viaEnv, printed(viaEnv, tool))],
      [`${tool} for Windows`, { ...env, [variable]: put("pe", tool, Buffer.concat([Buffer.from("4d5a90000300000004000000ffff0000b8", "hex"), Buffer.alloc(4096)])) }, shellRead(variable, at("pe", tool), tool)],
      [`${tool} for macOS`, { ...env, [variable]: put("macho", tool, Buffer.concat([Buffer.from("cffaedfe07000001030000000200000000", "hex"), Buffer.alloc(4096)])) }, shellRead(variable, at("macho", tool), tool)],
      [`${tool} silent`, ...given(put("silent", tool, "#!/bin/sh\nexit 0\n"), `did not run as ${tool}: it printed nothing and exited with 0`)],
      [`${tool} saying its version on its error output`, ...given(toError, printed(toError, tool))],
      [`${tool} stopped by a signal as it is asked`, ...given(term, `did not run as ${tool}: it was stopped by SIGTERM`)],
      [`${tool} the other tool`, ...given(real[other], printed(real[other], tool))],
    );
    // What the program printed names the cause: env the program it did not
    // find, the shell the program that is not there.
    assert.match(printed(viaEnv, tool), /^did not run as \w+: it printed "[^"]*nothing-such-program/);
    assert.match(printed(bare, tool), /^did not run as \w+: it printed "[^"]*\/nonexistent\/bin\/ffmpeg[^"]*" and exited with 127$/);
    assert.match(printed(real[other], tool), new RegExp(`^did not run as ${tool}: it printed "${other} version `));
    // Execute bits this user may not use, and a folder this user may not
    // enter, which hold nothing back from root.
    if (!root0) {
      cases.push([`${tool} with execute bits for others only`, ...given(put("others", tool, "#!/bin/sh\n", 0o055), "may not be run by this user")]);
      put("locked", tool, "#!/bin/sh\n");
    }
    // The system's own ffmpeg and ffprobe, an ELF program each, made for
    // other processors, with a loader that is not there, and needing a
    // library that is not there, the last also behind a wrapper script:
    // the loader's own line names the program that cannot start.
    const program = fs.readFileSync(real[tool]);
    if (program.readUInt32BE(0) === 0x7f454c46) {
      const foreign = { x64: 183, arm64: 62 }[process.arch];
      if (foreign && !handled("7f454c46")) {
        const made = Buffer.from(program);
        made.writeUInt16LE(foreign, 18);
        put("arm", tool, made);
        cases.push([`${tool} for other processors`, { ...env, [variable]: at("arm", tool) }, shellRead(variable, at("arm", tool), tool)]);
      }
      const head = program.toString("latin1", 0, 8192);
      const loader = /\/lib[\w/.-]*\/ld-[\w.-]+\.so\.\d+/.exec(head);
      if (loader) {
        const made = Buffer.from(program);
        made.write(`${loader[0].slice(0, -1)}${loader[0].endsWith("9") ? "8" : "9"}`, loader.index, "latin1");
        cases.push([`${tool} with a loader that is not there`, ...given(put("noloader", tool, made), lacking(tool, null))]);
      }
      const needed = /libavdevice\.so\.\d+/.exec(program.toString("latin1"));
      if (needed) {
        const made = Buffer.from(program);
        made.write(needed[0].replace("libavdevice", "libavdevicX"), needed.index, "latin1");
        const missing = put("libmiss", tool, made);
        const wrapper = put("wrap", tool, `#!/bin/sh\nexec "${missing}" "$@"\n`);
        assert.match(printed(wrapper, tool), new RegExp(`it printed "${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: error while loading shared libraries: libavdevicX`));
        cases.push([`${tool} needing a library that is not there`, ...given(missing, printed(missing, tool))], [`${tool} behind a wrapper, needing a library that is not there`, ...given(wrapper, printed(wrapper, tool))]);
      }
    }
  }
  if (!root0) {
    fs.chmodSync(at("locked"), 0o000);
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const variable = tool === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
      cases.push([`${tool} in a folder this user may not enter`, { ...process.env, FFMPEG_PATH: real.ffmpeg, FFPROBE_PATH: real.ffprobe, [variable]: at("locked", tool) }, pointsTo(variable, at("locked", tool), `is in ${at("locked")}, a folder this user may not enter`)]);
    }
  }
  // Named in the other ways: by launch-film's variables, as the ffprobe
  // next to the ffmpeg given, by a name, found on PATH or not, and on
  // PATH, where the system passes over a folder, a file it may not run, a
  // link that leads nowhere and a script whose #! program is not there,
  // and the first of them is named when no tool comes after them; it stops
  // at a loop of links, and runs the first file it may run, though a good
  // one comes after it.
  const { FFMPEG_PATH, FFPROBE_PATH, LAUNCH_FILM_FFMPEG, LAUNCH_FILM_FFPROBE, PATH, ...rest } = process.env;
  fs.mkdirSync(at("probe-only"), { recursive: true });
  fs.symlinkSync(real.ffprobe, at("probe-only", "ffprobe"));
  fs.mkdirSync(at("ffmpeg-only"), { recursive: true });
  fs.symlinkSync(real.ffmpeg, at("ffmpeg-only", "ffmpeg"));
  fs.mkdirSync(at("beside", "ffprobe"), { recursive: true });
  fs.symlinkSync(real.ffmpeg, at("beside", "ffmpeg"));
  fs.mkdirSync(at("static", "ffmpeg-7.0.2-amd64-static"), { recursive: true });
  fs.symlinkSync(real.ffmpeg, at("static", "ffmpeg-7.0.2-amd64-static", "ffmpeg"));
  const crlf = at("crlf", "ffmpeg");
  cases.push(
    ["LAUNCH_FILM_FFMPEG", { ...rest, PATH, LAUNCH_FILM_FFMPEG: at("empty", "ffmpeg"), FFPROBE_PATH: real.ffprobe }, pointsTo("LAUNCH_FILM_FFMPEG", at("empty", "ffmpeg"), "did not run as ffmpeg: it printed nothing and exited with 0")],
    ["LAUNCH_FILM_FFPROBE", { ...rest, PATH, FFMPEG_PATH: real.ffmpeg, LAUNCH_FILM_FFPROBE: at("folder", "ffprobe") }, pointsTo("LAUNCH_FILM_FFPROBE", at("folder", "ffprobe"), "is a folder")],
    ["a folder next to the ffmpeg given", { ...rest, PATH, FFMPEG_PATH: at("beside", "ffmpeg") }, `reframekit needs ffmpeg and ffprobe, and the ffprobe next to the ffmpeg FFMPEG_PATH points to, ${at("beside", "ffprobe")}, is a folder. ${toGet.beside}`],
    ["a static build's folder", { ...rest, PATH, FFMPEG_PATH: at("static", "ffmpeg-7.0.2-amd64-static") }, pointsTo("FFMPEG_PATH", at("static", "ffmpeg-7.0.2-amd64-static"), `is a folder, with ${at("static", "ffmpeg-7.0.2-amd64-static", "ffmpeg")} in it`)],
    ["a name not on PATH", { ...rest, PATH, FFMPEG_PATH: "ffmpeg-not-there" }, `reframekit needs ffmpeg and ffprobe, and FFMPEG_PATH names ffmpeg-not-there, which is not on your PATH. ${toGet.FFMPEG_PATH}`],
    ["a name found on PATH whose #! line ends in a carriage return", { ...rest, PATH: `${at("crlf")}:${at("probe-only")}`, FFMPEG_PATH: "ffmpeg" }, `reframekit needs ffmpeg and ffprobe, and the ffmpeg on your PATH that FFMPEG_PATH names, ${crlf}, ${lacking("ffmpeg", "#!/bin/sh\r")}. ${toGet.FFMPEG_PATH}`],
    ["no ffmpeg on PATH", { ...rest, PATH: at("probe-only") }, `reframekit needs ffmpeg and ffprobe. Install ffmpeg (${INSTALL}), or set FFMPEG_PATH and FFPROBE_PATH to them.`],
    ["no ffprobe on PATH", { ...rest, PATH: at("ffmpeg-only") }, `reframekit needs ffmpeg and ffprobe, and there is no ffprobe on your PATH. ${toGet.ffprobe}`],
    ["a folder first on PATH", { ...rest, PATH: `${at("folder")}:${at("probe-only")}` }, onPathIs("ffmpeg", at("folder", "ffmpeg"), "is a folder")],
    ["a file that may not be run on PATH", { ...rest, PATH: `${at("ffmpeg-only")}:${at("plain")}` }, onPathIs("ffprobe", at("plain", "ffprobe"), "is not executable")],
    ["a link that leads nowhere on PATH", { ...rest, PATH: `${at("dangling")}:${at("probe-only")}` }, onPathIs("ffmpeg", at("dangling", "ffmpeg"), `is a link to ${at("nowhere", "ffmpeg")}, which is not there`)],
    ["a #! line ending in a carriage return on PATH", { ...rest, PATH: `${at("crlf")}:${at("probe-only")}` }, onPathIs("ffmpeg", crlf, lacking("ffmpeg", "#!/bin/sh\r"))],
    ["a #! of a script whose #! program is missing on PATH", { ...rest, PATH: `${at("nested")}:${at("probe-only")}` }, onPathIs("ffmpeg", at("nested", "ffmpeg"), lacking("ffmpeg", `#!${at("badinterp", "ffmpeg")}`))],
    ["a folder, then a loop of links on PATH", { ...rest, PATH: `${at("folder")}:${at("loop")}:${path.dirname(real.ffmpeg)}` }, onPathIs("ffmpeg", at("loop", "ffmpeg"), "is a link that leads back to itself")],
    ["a text file first on PATH", { ...rest, PATH: `${at("text")}:${path.dirname(real.ffmpeg)}` }, onPathIs("ffmpeg", at("text", "ffmpeg"), printed(at("text", "ffmpeg")))],
  );
  if (fs.existsSync(at("libmiss", "ffmpeg"))) cases.push(["a broken ffmpeg first on PATH, a good one after it", { ...rest, PATH: `${at("libmiss")}:${path.dirname(real.ffmpeg)}` }, onPathIs("ffmpeg", at("libmiss", "ffmpeg"), printed(at("libmiss", "ffmpeg")))]);
  if (!root0) cases.push(["a folder on PATH this user may not enter", { ...rest, PATH: `${at("locked")}:${at("probe-only")}` }, `reframekit needs ffmpeg and ffprobe, and there is no ffmpeg on your PATH, unless it is in ${at("locked")}, a folder on it that this user may not enter. ${toGet.ffmpeg}`]);
  // Every case in one of a render, a plan, a check and a run with --json,
  // in turn, and the first few in all four. The folder this user may not
  // enter is opened again after, so the test's folder can be removed.
  try {
    cases.forEach(([name, env, message], i) => stopsBeforeWork(name.replace(/\W+/g, "-"), env, message, i < 4 ? null : ["render", "plan", "check", "json"][i % 4]));
  } finally {
    if (fs.existsSync(at("locked"))) fs.chmodSync(at("locked"), 0o755);
  }
  // A good one after a folder, a script whose #! program is not there, or
  // one whose #! line ends in a carriage return, is the one that runs, as
  // the system passes over those. A wrapper with no #! line, which the
  // system gives to /bin/sh, and one whose first words are a warning of
  // the shell's, answer as ffmpeg does, and run.
  for (const first of ["folder", "badinterp", "crlf"]) {
    const r = cli([fixture("twoShots"), "--for", "180x320", "--plan", "--out", outDir(`unstarted-after-${first}`)], { env: { ...rest, PATH: `${at(first)}:${path.dirname(real.ffmpeg)}:${path.dirname(real.ffprobe)}` } });
    assert.equal(r.status, 0, `${first}: ${r.stderr}`);
  }
  const wrappers = { "no-bang": `exec "${real.ffmpeg}" "$@"\n`, warning: `#!/bin/sh\necho "sh: warning: setlocale: LC_ALL: cannot change locale (xx_XX.UTF-8)" >&2\nexec "${real.ffmpeg}" "$@"\n` };
  for (const [name, body] of Object.entries(wrappers)) {
    const wrapper = put(`wrapper-${name}`, "ffmpeg", body);
    const r = cli([fixture("twoShots"), "--for", "180x320", "--out", outDir(`unstarted-wrapper-${name}`), "--json"], { env: { ...rest, PATH, FFMPEG_PATH: wrapper, FFPROBE_PATH: real.ffprobe } });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).files.length, 1, name);
  }
});

test("an ffmpeg or an ffprobe that gives no answer when asked its version is stopped and named once the time is up", { skip: process.platform === "win32" }, () => {
  const { find, ffmpegSource } = require("../skills/reframekit/scripts/lib/tools");
  const standIn = path.join(outDir("no-answer"), "ffmpeg");
  fs.mkdirSync(path.dirname(standIn), { recursive: true });
  fs.writeFileSync(standIn, "#!/bin/sh\nexec sleep 30\n");
  fs.chmodSync(standIn, 0o755);
  const was = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = standIn;
  const began = Date.now();
  try {
    assert.throws(() => find(ffmpegSource(), () => {}, 500), (err) => {
      assert.equal(err.message, pointsTo("FFMPEG_PATH", standIn, "did not run as ffmpeg: it gave no answer in 0.5 s"));
      assert.ok(err.unstarted);
      return true;
    });
  } finally {
    if (was === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = was;
  }
  assert.ok(Date.now() - began < 10000, `${Date.now() - began} ms`);
});

test("a line a program printed is quoted as it is, its control characters written out, and a long one keeps its start and its end", () => {
  const { quoted } = require("../skills/reframekit/scripts/lib/tools");
  assert.equal(quoted("#!/bin/sh\r"), '"#!/bin/sh\\r"');
  assert.equal(quoted("a\tb\x1b[31mc\x7f\u0085﻿d‮"), '"a\\tb\\x1b[31mc\\x7f\\x85\\ufeffd\\u202e"');
  assert.equal(quoted("env: ‘runner’: No such file or directory"), '"env: ‘runner’: No such file or directory"');
  const long = `${"a".repeat(150)}${"b".repeat(100)}`;
  assert.equal(quoted(long), `"${"a".repeat(120)}...${"b".repeat(80)}"`);
  assert.equal(quoted("x".repeat(200)), `"${"x".repeat(200)}"`);
});

test("an ffmpeg on a mount where no program may be run (noexec) is named so before any work", { skip: process.platform !== "linux" ? "it takes Linux's mount namespaces" : false }, (t) => {
  // A tmpfs mounted noexec in a mount namespace of a user namespace of its
  // own, where this user may mount one, with a copy of the tool in it, as
  // large as a static build may be.
  const mount = outDir("noexec");
  fs.mkdirSync(mount, { recursive: true });
  const can = spawnSync("unshare", ["-rm", "sh", "-c", 'mount -t tmpfs -o noexec tmpfs "$0"', mount], { encoding: "utf8" });
  if (can.error || can.status !== 0) return t.skip(`no mount namespace here: ${(can.stderr || String(can.error)).trim()}`);
  const script = 'mount -t tmpfs -o noexec,size=1g tmpfs "$1" && cp "$2" "$1/$3" && chmod 755 "$1/$3" && shift 3 && exec "$@"';
  for (const [tool, variable] of [["ffmpeg", "FFMPEG_PATH"], ["ffprobe", "FFPROBE_PATH"]]) {
    for (const mode of ["plan", "check"]) {
      const folder = outDir(`noexec-${tool}-${mode}`);
      const args = mode === "check" ? ["check", fixture("twoShots"), "--for", "youtube"] : [fixture("twoShots"), "--for", "180x320", "--plan"];
      const env = { ...process.env, FFMPEG_PATH: realTool("ffmpeg"), FFPROBE_PATH: realTool("ffprobe"), [variable]: path.join(mount, tool) };
      const r = spawnSync("unshare", ["-rm", "sh", "-c", script, "sh", mount, realTool(tool), tool, process.execPath, CLI, ...args, "--out", folder], { encoding: "utf8", env });
      assert.equal(r.status, 1, `${tool} ${mode}: ${r.stderr}`);
      assert.equal(r.stderr, `reframekit: ${pointsTo(variable, path.join(mount, tool), `is on ${fs.realpathSync(mount)}, a mount where no program may be run (noexec)`)}\n`, `${tool} ${mode}`);
      assert.ok(!fs.existsSync(folder), `${tool} ${mode}`);
    }
  }
});

test("a run with no file descriptor left to start ffmpeg with says so before any work, in plain words", { skip: process.platform === "win32" ? "it takes sh to lower the limit" : false }, () => {
  // A node whose modules are loaded, holding every file descriptor it may
  // open but one, too few for ffmpeg's pipes.
  const hold = path.join(dir, "hold-descriptors.js");
  const lib = path.join(__dirname, "..", "skills", "reframekit", "scripts", "lib");
  fs.writeFileSync(hold, `"use strict";
const fs = require("node:fs");
for (const name of ["reframe", "check", "ffmpeg", "folder", "tools"]) require(${JSON.stringify(lib)} + "/" + name);
const held = [];
try {
  for (;;) held.push(fs.openSync(__filename, "r"));
} catch {}
fs.closeSync(held.pop());
`);
  for (const args of [[fixture("twoShots"), "--for", "180x320"], ["check", fixture("twoShots"), "--for", "youtube"]]) {
    const out = outDir(`no-descriptors-${args[0] === "check" ? "check" : "render"}`);
    const r = spawnSync("sh", ["-c", 'ulimit -n 256 && exec "$@"', "sh", process.execPath, "--require", hold, CLI, ...args, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, "reframekit: reframekit could not start ffmpeg, as this process has as many files open as it may (too many open files). Raise that limit, as ulimit -n does, and run it again.\n");
    assert.ok(!fs.existsSync(out));
  }
});

test("an ffmpeg run that cannot start for want of file descriptors once the run is under way fails in plain words, not on the pipe Node did not make", { skip: process.platform === "win32" ? "it takes sh to lower the limit" : false }, () => {
  // A node holding every file descriptor it may open but one, too few for
  // ffmpeg's pipes, that starts ffmpeg as a run does part way.
  const lib = path.join(__dirname, "..", "skills", "reframekit", "scripts", "lib", "ffmpeg");
  const script = `
    const fs = require("node:fs");
    const { run } = require(${JSON.stringify(lib)});
    const held = [];
    try {
      for (;;) held.push(fs.openSync(${JSON.stringify(__filename)}, "r"));
    } catch {}
    fs.closeSync(held.pop());
    run(["-version"]).then(() => console.log("ran"), (err) => console.log(err.message));
  `;
  const r = spawnSync("sh", ["-c", 'ulimit -n 256 && exec "$0" -e "$1"', process.execPath, script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "reframekit could not start ffmpeg, as this process has as many files open as it may (too many open files). Raise that limit, as ulimit -n does, and run it again.\n");
});

test("a run left no file descriptor to start ffmpeg with once it has taken its folder leaves the folder as it was, one it made too", { skip: process.platform === "win32" ? "it takes sh to lower the limit" : false }, () => {
  // A preload that, as the run starts its first ffmpeg in its work folder,
  // holds every file descriptor it may open but HOLD_FREE, and keeps them.
  const hold = path.join(dir, "hold-at-first-run.js");
  fs.writeFileSync(hold, `"use strict";
const fs = require("node:fs");
const cp = require("node:child_process");
const real = cp.spawn;
let n = 0;
const held = [];
cp.spawn = function (...args) {
  if (++n === 1) {
    try {
      for (;;) held.push(fs.openSync(__filename, "r"));
    } catch {}
    for (let i = 0; i < Number(process.env.HOLD_FREE); i++) fs.closeSync(held.pop());
  }
  return real.apply(this, args);
};
`);
  const said = "reframekit: reframekit could not start ffmpeg, as this process has as many files open as it may (too many open files). Raise that limit, as ulimit -n does, and run it again.\n";
  const held = (args, out, free) => spawnSync("sh", ["-c", 'ulimit -n 256 && exec "$@"', "sh", process.execPath, "--require", hold, CLI, ...args, "--out", out], { encoding: "utf8", env: { ...process.env, HOLD_FREE: String(free) } });
  const listing = (folder) => fs.readdirSync(folder, { recursive: true }).sort();
  for (const free of [0, 1, 2]) {
    for (const [mode, args] of [["render", [fixture("twoShots"), "--for", "180x320"]], ["plan", [fixture("twoShots"), "--for", "180x320", "--plan"]]]) {
      const out = outDir(`descriptors-part-way-${free}-${mode}`);
      const r = held(args, out, free);
      assert.equal(r.status, 1, `${free} ${mode}: ${r.stderr}`);
      assert.ok(r.stderr.endsWith(said), `${free} ${mode}: ${r.stderr}`);
      assert.ok(!fs.existsSync(out), `${free} ${mode}: ${fs.existsSync(out) ? listing(out).join(" ") : ""}`);
    }
  }
  // A folder an earlier run made keeps what it held.
  const kept = outDir("descriptors-part-way-kept");
  assert.equal(cli([fixture("twoShots"), "--for", "180x320", "--plan", "--out", kept]).status, 0);
  const before = listing(kept);
  const r = held([fixture("twoShots"), "--for", "180x320", "--plan"], kept, 0);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.endsWith(said), r.stderr);
  assert.deepEqual(listing(kept), before);
  // One left none as it takes its folder makes nothing there.
  const atTaking = path.join(dir, "hold-at-taking.js");
  fs.writeFileSync(atTaking, `"use strict";
const fs = require("node:fs");
const os = require("node:os");
const real = fs.openSync;
const held = [];
fs.openSync = function (file, ...rest) {
  if (file === os.devNull && !held.length) {
    try {
      for (;;) held.push(real.call(fs, __filename, "r"));
    } catch {}
  }
  return real.call(this, file, ...rest);
};
`);
  const taking = outDir("descriptors-at-taking");
  const t = spawnSync("sh", ["-c", 'ulimit -n 256 && exec "$@"', "sh", process.execPath, "--require", atTaking, CLI, fixture("twoShots"), "--for", "180x320", "--plan", "--out", taking], { encoding: "utf8" });
  assert.equal(t.status, 1, t.stderr);
  assert.ok(t.stderr.endsWith(`reframekit: Cannot take ${taking}: this process has as many files open as it may (too many open files). Raise that limit, as ulimit -n does, and run it again.\n`), t.stderr);
  assert.ok(!fs.existsSync(taking));
});

test("an ffmpeg that answered before any work and can no longer be started part way is named by its path with what the system said, and a start in a work folder that is gone is that folder's", { skip: process.platform === "win32" }, async () => {
  // A wrapper that answers what it is and has, then takes itself away as
  // the run reads the picture.
  const bin = outDir("gone-bin");
  fs.mkdirSync(bin, { recursive: true });
  const wrapper = path.join(bin, "ffmpeg");
  fs.writeFileSync(wrapper, `#!/bin/sh\ncase "$*" in *-version*|*-filters*|*-encoders*) exec "${realTool("ffmpeg")}" "$@";; esac\nrm -f "$0"\nexec "${realTool("ffmpeg")}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const env = { ...process.env, FFMPEG_PATH: wrapper, FFPROBE_PATH: realTool("ffprobe") };
  const out = outDir("gone-out");
  const r = cli([fixture("twoShots"), "--for", "180x320", "--plan", "--out", out], { env });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`(^|\\n)reframekit: reframekit could not start ffmpeg, ${wrapper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, again: no such file or directory\\.\\n$`));
  assert.ok(!fs.existsSync(out));
  const next = cli([fixture("twoShots"), "--for", "180x320", "--plan", "--out", out], { env });
  assert.equal(next.status, 1);
  assert.equal(next.stderr, `reframekit: ${pointsTo("FFMPEG_PATH", wrapper, "is not there")}\n`);
  assert.ok(!fs.existsSync(out));
  // In this process: one asked before, then taken away.
  const { run, checkTools } = require("../skills/reframekit/scripts/lib/ffmpeg");
  const standIn = path.join(bin, "stand-in");
  fs.symlinkSync(realTool("ffmpeg"), standIn);
  const was = { FFMPEG_PATH: process.env.FFMPEG_PATH, FFPROBE_PATH: process.env.FFPROBE_PATH };
  Object.assign(process.env, { FFMPEG_PATH: standIn, FFPROBE_PATH: realTool("ffprobe") });
  try {
    checkTools();
    fs.rmSync(standIn);
    await assert.rejects(run(["-version"]), (err) => {
      assert.equal(err.message, `reframekit could not start ffmpeg, ${standIn}, again: no such file or directory.`);
      assert.ok(err.unstarted);
      return true;
    });
    await assert.rejects(run(["-version"], { cwd: path.join(bin, "no-such-folder") }), { message: `Cannot start stand-in in ${path.join(bin, "no-such-folder")}: the folder is gone or may not be entered` });
  } finally {
    for (const [name, value] of Object.entries(was)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a file that is not a video, a picture, a missing file and a folder that is not ours are told before any work", () => {
  const notVideo = cli([__filename, "--out", outDir("not-video")]);
  assert.equal(notVideo.status, 1);
  assert.match(notVideo.stderr, /Cannot read .*cli\.test\.js|has no video stream/);
  const missing = cli([path.join(dir, "nothing.mp4")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot read .*nothing\.mp4: no such file/);
  const png = path.join(dir, "still.png");
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", png]);
  const still = cli([png, "--out", outDir("still")]);
  assert.equal(still.status, 1);
  assert.match(still.stderr, /still picture/);
  const theirs = outDir("theirs");
  fs.mkdirSync(theirs, { recursive: true });
  fs.writeFileSync(path.join(theirs, "notes.txt"), "mine");
  const refused = cli([fixture("twoShots"), "--out", theirs]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is not empty and holds no earlier reframekit run/);
  assert.doesNotMatch(refused.stderr, /Reading/);
  assert.deepEqual(fs.readdirSync(theirs), ["notes.txt"]);
  const blocked = cli([fixture("twoShots"), "--out", path.join(__filename, "out")]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Cannot write to .*: a file is in the way/);
});

test("a crop.json that does not fit the video is refused before any folder is made", () => {
  const file = fixture("twoShots");
  const crop = path.join(dir, "wrong-crop.json");
  fs.writeFileSync(crop, JSON.stringify({ reframekit: "0.1.0", width: 1280, height: 720, shots: [] }));
  const out = path.join(outDir("half"), "a", "b");
  const run = cli([file, "--crop", crop, "--out", out]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /crop\.json: it is for a 1280x720 picture/);
  assert.ok(!fs.existsSync(outDir("half")));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith(".reframekit-")), []);
});

// Runs the CLI with `args` into `out` and, once it encodes (or, as --json
// keeps it quiet, once its hidden folder holds a sound), sends `signal`
// to it, or with `group` to its whole process group, as makersmcp stops a
// job and Ctrl-C a terminal's. Resolves { code, signal, stdout, stderr }.
function stopWhileEncoding(args, out, { signal = "SIGTERM", group = false } = {}) {
  return new Promise((resolve) => {
    const child = require("node:child_process").spawn(process.execPath, [CLI, ...args, "--out", out], { stdio: ["ignore", "pipe", "pipe"], detached: group });
    let stdout = "";
    let stderr = "";
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      if (group) process.kill(-child.pid, signal);
      else child.kill(signal);
    };
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (/Encoding/.test(stderr)) send();
    });
    const look = setInterval(() => {
      try {
        for (const name of fs.readdirSync(out)) if (name.startsWith(".reframekit-") && fs.readdirSync(path.join(out, name, ".work")).some((n) => n.startsWith("sound-"))) send();
      } catch {
        // Not made yet.
      }
    }, 20);
    child.on("close", (code, ended) => {
      clearInterval(look);
      resolve({ code, signal: ended, stdout, stderr });
    });
  });
}

test("a run stopped half way stops its ffmpeg, leaves no folder behind, says so and ends by that signal, with --json too, and so does one whose whole process group is stopped", { skip: process.platform === "win32" }, async () => {
  const cases = [
    ["stopped", [], {}],
    ["stopped-json", ["--json"], {}],
    ["stopped-group-1", [], { group: true }],
    ["stopped-group-2", ["--json"], { group: true }],
    ["stopped-group-int", [], { group: true, signal: "SIGINT" }],
  ];
  for (const [name, extra, how] of cases) {
    const out = outDir(name);
    const r = await stopWhileEncoding([fixture("twoShots"), "--for", "tiktok,youtube", ...extra], out, how);
    const signal = how.signal || "SIGTERM";
    const said = `stopped by ${signal}, so ${out} is as it was`;
    assert.deepEqual([r.code, r.signal], [null, signal], `${name}: ${r.stderr}`);
    assert.ok(r.stderr.endsWith(`reframekit: ${said}\n`), `${name}: ${r.stderr}`);
    assert.equal(r.stdout, extra.includes("--json") ? `${JSON.stringify({ ok: false, error: said })}\n` : "", name);
    assert.ok(!fs.existsSync(out), `${name}: ${out} is still there`);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith(".reframekit-")), []);
});

test("a run whose ffmpeg the signal stops a moment before the run hears it, as a process group stopped while node is busy, says it was stopped and ends by that signal, not that ffmpeg failed", { skip: process.platform !== "linux" }, async () => {
  const out = outDir("stopped-late");
  const child = require("node:child_process").spawn(process.execPath, [CLI, fixture("twoShots"), "--for", "1080x1920", "--out", out], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let sent = false;
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (sent || !/Encoding/.test(stderr)) return;
    sent = true;
    const kids = spawnSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    for (const pid of kids) process.kill(Number(pid), "SIGTERM");
    setTimeout(() => child.kill("SIGTERM"), 300);
  });
  const [code, signal] = await new Promise((resolve) => child.on("close", (...ended) => resolve(ended)));
  assert.deepEqual([code, signal], [null, "SIGTERM"], stderr);
  assert.ok(stderr.endsWith(`reframekit: stopped by SIGTERM, so ${out} is as it was\n`), stderr);
  assert.doesNotMatch(stderr, /failed/);
  assert.ok(!fs.existsSync(out), `${out} is still there`);
});

test("a run stopped while ffprobe lists the packets of an MPEG-TS's copy stops at once and leaves no folder behind", { skip: process.platform === "win32" }, async () => {
  // An ffprobe that takes 8 s to list the packets, as one of a long
  // recording does, and a SIGTERM to node alone, as docker stop sends one.
  const bin = outDir("slow-list-bin");
  fs.mkdirSync(bin, { recursive: true });
  const listing = path.join(bin, "listing");
  const real = spawnSync("sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bin, "ffprobe"), `#!/bin/sh\ncase "$*" in *packet=stream_index,pts_time*) : > "${listing}"; sleep 8;; esac\nexec "${real}" "$@"\n`);
  fs.chmodSync(path.join(bin, "ffprobe"), 0o755);
  const ts = path.join(dir, "listed.ts");
  ffmpeg(["-i", fixture("twoShots"), "-c", "copy", "-f", "mpegts", ts]);
  const out = outDir("listed");
  const child = require("node:child_process").spawn(process.execPath, [CLI, ts, "--for", "180x320", "--plan", "--out", out], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, FFPROBE_PATH: path.join(bin, "ffprobe") } });
  let said = "";
  child.stderr.on("data", (chunk) => (said += chunk));
  const ended = new Promise((resolve) => child.on("close", (code, signal) => resolve(signal)));
  for (let i = 0; i < 400 && !fs.existsSync(listing); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(listing), `ffprobe never listed the packets: ${said}`);
  const sent = Date.now();
  child.kill("SIGTERM");
  assert.equal(await ended, "SIGTERM", said);
  assert.ok(Date.now() - sent < 4000, `the run took ${Date.now() - sent} ms to stop`);
  assert.ok(said.endsWith(`reframekit: stopped by SIGTERM, so ${out} is as it was\n`), said);
  assert.ok(!fs.existsSync(out), `${out} is still there`);
});

// An ffprobe that takes 3 s over a call whose arguments match `pattern`,
// a pattern of sh's case, as one on a slow disk reads a file, and marks
// when such a call starts.
function slowProbe(name, pattern) {
  const bin = outDir(`${name}-bin`);
  fs.mkdirSync(bin, { recursive: true });
  const mark = path.join(bin, "reading");
  const real = spawnSync("sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bin, "ffprobe"), `#!/bin/sh\ncase "$*" in ${pattern}) : > "${mark}"; sleep 3;; esac\nexec "${real}" "$@"\n`);
  fs.chmodSync(path.join(bin, "ffprobe"), 0o755);
  return { ffprobe: path.join(bin, "ffprobe"), mark };
}

// Runs the CLI with `args` and that ffprobe, in a process group of its
// own as makersmcp runs a kit, and once the slow call has started sends
// `signal` to the whole group, as Ctrl-C and makersmcp do, or with
// `alone` to node alone, as docker stop does. Resolves { code, signal,
// stdout, stderr }.
async function stopWhileProbing(args, { ffprobe, mark }, { signal = "SIGTERM", alone = false } = {}) {
  fs.rmSync(mark, { force: true });
  const child = require("node:child_process").spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, FFPROBE_PATH: ffprobe } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const ended = new Promise((resolve) => child.on("close", (code, ending) => resolve({ code, signal: ending, stdout, stderr })));
  for (let i = 0; i < 1200 && !fs.existsSync(mark); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(mark), `ffprobe never made the slow call: ${stderr}`);
  if (alone) child.kill(signal);
  else process.kill(-child.pid, signal);
  return ended;
}

// The names in a folder, each with a hash of what it holds.
const contents = (folder) => Object.fromEntries(fs.readdirSync(folder).sort().map((n) => [n, require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(folder, n))).digest("hex")]));

test("a check stopped while ffprobe reads a file, by a signal to its process group or to node alone, ends by that signal, says nothing was written, and leaves the folder's reports as they were", { skip: process.platform === "win32" }, async () => {
  const out = outDir("check-stopped");
  assert.equal(cli([fixture("twoShots"), "--for", "180x320,180x180", "--out", out]).status, 0);
  const slow = slowProbe("check-stopped", "*-show_format*");
  const said = (signal) => `stopped by ${signal}, so nothing was written`;
  // Ctrl-C to its group stops the ffprobe reading the first file too,
  // which is never taken for a file that cannot be read.
  for (const extra of [[], ["--json"]]) {
    const r = await stopWhileProbing(["check", out, ...extra], slow, { signal: "SIGINT" });
    assert.deepEqual([r.code, r.signal], [null, "SIGINT"], r.stdout + r.stderr);
    assert.equal(r.stderr, `reframekit: ${said("SIGINT")}\n`);
    assert.equal(r.stdout, extra.length ? `${JSON.stringify({ ok: false, error: said("SIGINT") })}\n` : "");
    assert.deepEqual(fs.readdirSync(out).filter((n) => /check/i.test(n)), []);
  }
  // The reports of a check that passed stay as they were through a check
  // stopped by a SIGTERM to its group, and through one to node alone,
  // which the ffprobe reading a file never gets.
  assert.equal(cli(["check", out]).status, 0);
  const before = contents(out);
  const times = () => ["CHECK.md", "check.json"].map((n) => fs.statSync(path.join(out, n)).mtimeMs);
  const written = times();
  for (const how of [{}, { alone: true }]) {
    const r = await stopWhileProbing(["check", out], slow, how);
    assert.deepEqual([r.code, r.signal], [null, "SIGTERM"], r.stdout + r.stderr);
    assert.equal(r.stderr, `reframekit: ${said("SIGTERM")}\n`);
    assert.equal(r.stdout, "");
    assert.deepEqual(contents(out), before);
    assert.deepEqual(times(), written);
  }
});

test("a run stopped while ffprobe reads the video, or says which version it is, ends by that signal and says nothing was written, not that the video or ffprobe failed", { skip: process.platform === "win32" }, async () => {
  const cases = [
    ["reading", "*-show_format*", 3],
    ["version", "*-version*", 1],
  ];
  for (const [name, pattern, times] of cases) {
    const slow = slowProbe(`run-stopped-${name}`, pattern);
    for (let i = 1; i <= times; i++) {
      const out = outDir(`run-stopped-${name}-${i}`);
      const r = await stopWhileProbing([fixture("twoShots"), "--for", "180x320", "--plan", "--out", out], slow);
      assert.deepEqual([r.code, r.signal], [null, "SIGTERM"], `${name} ${i}: ${r.stderr}`);
      assert.equal(r.stderr, "reframekit: stopped by SIGTERM, so nothing was written\n", `${name} ${i}`);
      assert.ok(!fs.existsSync(out), `${out} is there`);
    }
  }
});

test("a run stopped while ffprobe reads a file it keeps from the run before ends by that signal and leaves the folder as it was, by a signal to its process group or to node alone", { skip: process.platform === "win32" }, async () => {
  const out = outDir("kept-stopped");
  assert.equal(cli([fixture("twoShots"), "--for", "180x180", "--out", out]).status, 0);
  const before = contents(out);
  // Slow only on 180x180.mp4 in the folder, which the run keeps.
  const slow = slowProbe("kept-stopped", `*-show_format*${path.basename(out)}/180x180.mp4*`);
  for (const how of [{}, { alone: true }]) {
    const r = await stopWhileProbing([fixture("twoShots"), "--for", "180x320", "--out", out], slow, how);
    assert.deepEqual([r.code, r.signal], [null, "SIGTERM"], r.stderr);
    assert.ok(r.stderr.endsWith(`reframekit: stopped by SIGTERM, so ${out} is as it was\n`), r.stderr);
    assert.deepEqual(contents(out), before);
  }
});

test("an ffprobe that crashes on a file of a checked folder, or that the system kills as it reads one, fails that file's row while the others are measured, and a run that keeps that file lists it as it was, failing, with a note, until a run measures it again", { skip: process.platform === "win32" }, () => {
  const out = outDir("probe-crash");
  assert.equal(cli([fixture("twoShots"), "--for", "180x320,180x180", "--out", out]).status, 0);
  // An ffprobe that crashes, or that is killed as when memory runs out, as
  // it reads 180x180.mp4 in a folder, or the video given.
  const bin = outDir("probe-crash-bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).stdout.trim();
  const tool = (name, signal, file) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\ncase "$*" in *-show_format*${file}*) kill -${signal} $$;; esac\nexec "${real}" "$@"\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
    return { ...process.env, FFPROBE_PATH: path.join(bin, name) };
  };
  const copy = (name) => {
    const to = outDir(name);
    fs.mkdirSync(to);
    for (const n of fs.readdirSync(out)) fs.copyFileSync(path.join(out, n), path.join(to, n));
    return to;
  };
  const said = { SEGV: "ffprobe crashed (SIGSEGV)", KILL: "ffprobe was killed (SIGKILL), as when the machine runs out of memory" };
  for (const [signal, words] of Object.entries(said)) {
    const folder = copy(`probe-crash-${signal}`);
    const r = cli(["check", folder], { env: tool(signal, signal, "/180x180.mp4") });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FAIL: 2 files against 2 places/);
    assert.ok(r.stdout.split("\n").includes(`  fail  180x180.mp4 for 180x180: file cannot be read: ${words} (asked for the file)`), r.stdout);
    const json = JSON.parse(fs.readFileSync(path.join(folder, "check.json"), "utf8"));
    assert.deepEqual(json.results.map((x) => [x.file, x.pass, x.checks.length > 1]), [["180x320.mp4", true, true], ["180x180.mp4", false, false]]);
    assert.equal(json.results[1].checks[0].found, `cannot be read: ${words}`);
    assert.match(fs.readFileSync(path.join(folder, "CHECK.md"), "utf8"), /^# FAIL \(180x180\.mp4 for 180x180\)/);
  }
  // A run that keeps 180x180.mp4 ends well, with that file in the folder
  // as it was, listed in formats.json as the run before listed it and
  // failing, and a note that says why, in the summary and FORMATS.md. The
  // next run, whose ffprobe reads it, measures it again, as a check does.
  for (const [signal, words] of Object.entries(said)) {
    const kept = copy(`probe-crash-kept-${signal}`);
    const before = fs.readFileSync(path.join(kept, "180x180.mp4"));
    const run = cli([fixture("twoShots"), "--for", "180x320", "--out", kept], { env: tool(`kept-${signal}`, signal, "/180x180.mp4") });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(fs.readFileSync(path.join(kept, "180x180.mp4")).equals(before));
    const formats = JSON.parse(fs.readFileSync(path.join(kept, "formats.json"), "utf8"));
    assert.deepEqual(formats.files.map((f) => [f.file, f.pass, f.earlier === true]), [["180x320.mp4", true, false], ["180x180.mp4", false, true]]);
    const entry = formats.files[1];
    assert.deepEqual(entry.checks, [{ name: "file", status: "fail", expected: "the file", found: `cannot be read: ${words}`, source: null }]);
    assert.deepEqual([entry.width, entry.height, entry.seconds], [180, 180, 4]);
    const note = `180x180.mp4, kept from an earlier run, could not be measured: ${words}. It is listed as before and fails until a run measures it; give 180x180 in --for to make it again.`;
    assert.ok(formats.notes.includes(note), formats.notes.join("\n"));
    const lines = run.stdout.split("\n");
    assert.ok(lines.includes("  180x180.mp4  kept from an earlier run, fails file") && lines.includes(`  Note: ${note}`), run.stdout);
    const md = fs.readFileSync(path.join(kept, "FORMATS.md"), "utf8");
    assert.ok(md.includes(`\n- ${note}\n`), md);
    assert.match(md, /^\| 180x180\.mp4 \| 180x180 \| 180x180 \| 4\.00 s \| \d+ KB \| .* \| fail: file \(from an earlier run\) \|$/m);
    assert.ok(md.includes(`- 180x180.mp4, file: fail, cannot be read: ${words} (asked for: the file).`), md);
    const again = cli([fixture("twoShots"), "--for", "180x320", "--out", kept, "--json"]);
    assert.equal(again.status, 0, again.stderr);
    const next = JSON.parse(again.stdout);
    assert.deepEqual(next.files.map((f) => [f.file, f.pass]), [["180x320.mp4", true], ["180x180.mp4", true]]);
    assert.ok(!next.notes.some((n) => /could not be measured/.test(n)), next.notes.join("\n"));
    assert.equal(cli(["check", kept]).status, 0);
  }
  // The video itself is named with what happened.
  const video = cli([fixture("twoShots"), "--for", "180x320", "--plan", "--out", outDir("probe-crash-video")], { env: tool("video", "SEGV", path.basename(fixture("twoShots"))) });
  assert.equal(video.status, 1);
  assert.equal(video.stderr, `reframekit: Cannot read ${fixture("twoShots")}: ffprobe crashed (SIGSEGV)\n`);
  assert.ok(!fs.existsSync(outDir("probe-crash-video")));
});

test("an ffmpeg named only by LAUNCH_FILM_FFMPEG and LAUNCH_FILM_FFPROBE is the one that runs", () => {
  const bin = outDir("guard-bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(bin, "calls");
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const real = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.join(bin, `guard-${tool}`), `#!/bin/sh\necho ${tool} >> "${log}"\nexec "${real}" "$@"\n`);
    fs.chmodSync(path.join(bin, `guard-${tool}`), 0o755);
  }
  const env = { ...process.env, LAUNCH_FILM_FFMPEG: path.join(bin, "guard-ffmpeg"), LAUNCH_FILM_FFPROBE: path.join(bin, "guard-ffprobe") };
  delete env.FFMPEG_PATH;
  delete env.FFPROBE_PATH;
  const r = cli([fixture("twoShots"), "--for", "360x640", "--plan", "--out", outDir("guarded")], { env });
  assert.equal(r.status, 0, r.stderr);
  const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.ok(calls.includes("ffmpeg") && calls.includes("ffprobe"), calls.join(" "));
});

test("an ffmpeg named by a path from the folder the run is started in, as ../bin/ffmpeg, runs for every ffmpeg run of the kit, those that start in its work folder too, with the ffprobe next to it", { skip: process.platform === "win32" }, () => {
  const top = outDir("relative-tools");
  const bin = path.join(top, "bin");
  const started = path.join(top, "here");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(started, { recursive: true });
  const log = path.join(top, "calls");
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const real = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho ${tool} >> "${log}"\nexec "${real}" "$@"\n`);
    fs.chmodSync(path.join(bin, tool), 0o755);
  }
  const env = { ...process.env };
  for (const name of ["FFMPEG_PATH", "FFPROBE_PATH", "LAUNCH_FILM_FFMPEG", "LAUNCH_FILM_FFPROBE"]) delete env[name];
  for (const name of ["FFMPEG_PATH", "LAUNCH_FILM_FFMPEG"]) {
    fs.writeFileSync(log, "");
    const r = cli([fixture("twoShots"), "--for", "180x320", "--plan", "--out", `by-${name}`], { cwd: started, env: { ...env, [name]: "../bin/ffmpeg" } });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    // More than the two that ask its version and its filters before any
    // work: the reading of the picture and the sheet run in the work folder.
    const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
    assert.ok(calls.filter((c) => c === "ffmpeg").length > 2 && calls.includes("ffprobe"), `${name}: ${calls.join(" ")}`);
  }
});

test("an ffmpeg named by a name on PATH, with no folder in it, runs with the ffprobe on PATH, never with a file named like its ffprobe in the folder the run is started in", { skip: process.platform === "win32" }, () => {
  const top = outDir("named-tools");
  const bin = path.join(top, "bin");
  const started = path.join(top, "here");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(started, { recursive: true });
  fs.symlinkSync(fs.realpathSync(spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim()), path.join(bin, "ffmpeg-named"));
  // A file named as the ffprobe next to ffmpeg-named would be, where the
  // run is started: no folder of PATH holds it.
  fs.writeFileSync(path.join(started, "ffprobe-named"), "not a program\n");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FFMPEG_PATH: "ffmpeg-named" };
  for (const name of ["FFPROBE_PATH", "LAUNCH_FILM_FFMPEG", "LAUNCH_FILM_FFPROBE"]) delete env[name];
  const r = cli([fixture("twoShots"), "--for", "180x320", "--plan", "--out", "planned"], { cwd: started, env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(started, "planned", "crop.json")));
});

test("an ffmpeg and an ffprobe found through an entry of PATH that is relative run for every run of the kit, those that start in its work folder too", { skip: process.platform === "win32" }, () => {
  const top = outDir("relative-path");
  fs.mkdirSync(path.join(top, "bin"), { recursive: true });
  for (const tool of ["ffmpeg", "ffprobe"]) fs.symlinkSync(realTool(tool), path.join(top, "bin", tool));
  // bin, read from the folder the run is started in, and nothing else, so
  // a run in the work folder finds no ffmpeg by that entry.
  const env = { ...process.env, PATH: "bin" };
  for (const name of ["FFMPEG_PATH", "FFPROBE_PATH", "LAUNCH_FILM_FFMPEG", "LAUNCH_FILM_FFPROBE"]) delete env[name];
  const r = cli([fixture("twoShots"), "--for", "180x320", "--plan", "--out", "planned"], { cwd: top, env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(top, "planned", "sheet.png")));
});

test("an ffmpeg killed half way is said to have been killed, not to have failed on the last stream it read", { skip: process.platform === "win32" }, () => {
  const bin = outDir("killed-bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  // Killed as the system kills a process when memory runs out: the
  // encode (the one run that reports its progress on stdout), or the
  // reading of the picture (the one with scdet).
  for (const [name, marker] of [["encode", "-progress pipe:1"], ["read", "scdet"]]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\ncase "$*" in *"${marker}"*) kill -9 $$;; esac\nexec "${real}" "$@"\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const encode = cli([fixture("twoShots"), "--for", "180x320", "--out", outDir("killed-encode")], { env: { ...process.env, FFMPEG_PATH: path.join(bin, "encode") } });
  assert.equal(encode.status, 1);
  assert.match(encode.stderr, /^reframekit: Encoding 180x320\.mp4 failed: ffmpeg was killed \(SIGKILL\), as when the machine runs out of memory$/m);
  assert.ok(!fs.existsSync(outDir("killed-encode")));
  const read = cli([fixture("twoShots"), "--for", "180x320", "--plan", "--out", outDir("killed-read")], { env: { ...process.env, FFMPEG_PATH: path.join(bin, "read") } });
  assert.equal(read.status, 1);
  assert.match(read.stderr, /^reframekit: Reading the picture failed: ffmpeg was killed \(SIGKILL\), as when the machine runs out of memory$/m);
});

test("a disk that fills up under ffmpeg is named as the cause, with the folder and in the words of Node's own writes, not ffmpeg's closing words", { skip: !fs.existsSync("/dev/full") }, () => {
  // An ffmpeg whose encode, or whose sound, is written to /dev/full,
  // where every write fails as on a full disk.
  const bin = outDir("full-bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  for (const [name, marker] of [["encode", " -progress pipe:1 "], ["sound", " -c:a aac "]]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh
case " $* " in *"${marker}"*)
  n=$#; i=0
  for a do
    i=$((i+1))
    if [ "$i" -lt "$n" ]; then set -- "$@" "$a"; else set -- "$@" -f mp4 /dev/full; fi
  done
  shift "$n";;
esac
exec "${real}" "$@"
`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const encode = cli([fixture("twoShots"), "--for", "180x320", "--out", "full-encode"], { cwd: dir, env: { ...process.env, FFMPEG_PATH: path.join(bin, "encode") } });
  assert.equal(encode.status, 1);
  assert.match(encode.stderr, /^reframekit: Cannot write to full-encode: no space is left on the disk$/m);
  assert.ok(!fs.existsSync(outDir("full-encode")));
  const sound = cli([fixture("twoShots"), "--for", "180x320", "--out", "full-sound"], { cwd: dir, env: { ...process.env, FFMPEG_PATH: path.join(bin, "sound") } });
  assert.equal(sound.status, 1);
  assert.match(sound.stderr, /^reframekit: Cannot write to full-sound: no space is left on the disk$/m);
  assert.ok(!fs.existsSync(outDir("full-sound")));
});

test("a disk or a quota that fills up as ffmpeg 4.4 writes a file's index, which it ends well, stops the run with the folder named, not the file it left cut short", { skip: process.platform === "win32" }, () => {
  // An ffmpeg that does as 4.4 does there: the encode, the sound or the
  // MPEG-TS's copy is written, then cut to half as a full disk leaves it,
  // and it says so and ends well.
  const bin = outDir("trailer-bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const runs = [
    ["encode", " -progress pipe:1 ", "No space left on device"],
    ["sound", " -c:a aac ", "No space left on device"],
    ["copy", " read/video.mp4 ", "Disk quota exceeded"],
  ];
  for (const [name, marker, why] of runs) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh
case " $* " in *"${marker}"*)
  "${real}" "$@" || exit $?
  for out do :; done
  n=$(wc -c < "$out"); head -c $((n / 2)) "$out" > "$out.cut" && mv "$out.cut" "$out"
  echo "[mp4 @ 0x55d0a1] Error writing trailer of $out: ${why}" >&2
  exit 0;;
esac
exec "${real}" "$@"
`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const ts = path.join(dir, "trailer.ts");
  ffmpeg(["-i", fixture("twoShots"), "-c", "copy", "-f", "mpegts", ts]);
  for (const [name, , why] of runs) {
    const out = `trailer-${name}`;
    const r = cli([name === "copy" ? ts : fixture("twoShots"), "--for", "180x320", "--out", out], { cwd: dir, env: { ...process.env, FFMPEG_PATH: path.join(bin, name), FFPROBE_PATH: spawnSync("sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).stdout.trim() } });
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    const said = why === "Disk quota exceeded" ? "the disk quota is used up" : "no space is left on the disk";
    assert.match(r.stderr, new RegExp(`^reframekit: Cannot write to ${out}: ${said}$`, "m"), `${name}: ${r.stderr}`);
    assert.ok(!fs.existsSync(outDir(out)), `${name}: ${out} is still there`);
  }
});

test("what ffmpeg says of a full disk or a quota is read in the system's own words, a Mac's as Linux's", () => {
  const { failure, refusal } = require("../skills/reframekit/scripts/lib/ffmpeg");
  // What ffmpeg 8 wrote when a disk filled up under an encode.
  const told = ["frame=   46 fps=0.0 q=28.0 size=     256KiB time=00:00:01.43", "[vost#0:0/libx264 @ 0x55d1] Error submitting a packet to the muxer: No space left on device", "[out#0/mp4 @ 0x55d0] Error writing trailer: No space left on device", "[out#0/mp4 @ 0x55d0] Task finished with error code: -28 (No space left on device)", "Conversion failed!"].join("\n");
  assert.deepEqual([failure(told), refusal(told)], ["no space is left on the disk", "ENOSPC"]);
  // A quota used up, as glibc words it and as a Mac does.
  assert.deepEqual([failure("[mp4 @ 0x1] Error writing trailer: Disk quota exceeded\nConversion failed!"), refusal("Disk quota exceeded")], ["the disk quota is used up", "EDQUOT"]);
  assert.deepEqual([failure("[mp4 @ 0x1] Error writing trailer: Disc quota exceeded\nConversion failed!"), refusal("[out#0/mp4 @ 0x1] Error writing trailer: Disc quota exceeded")], ["the disk quota is used up", "EDQUOT"]);
  assert.deepEqual([failure("out.mp4: Input/output error"), refusal("out.mp4: Input/output error")], ["Input/output error", "EIO"]);
  assert.equal(failure("[aac @ 0x1] Too many bits per frame requested\nConversion failed!"), "Too many bits per frame requested");
  assert.equal(failure("Some line\nInvalid argument\nConversion failed!", { telling: true }), "Invalid argument");
});

test("what ffmpeg says of a file it opens, its name, its title or a chapter's, is never taken for why a run failed, and its own words still are", () => {
  const { failure, refusal, unfinished } = require("../skills/reframekit/scripts/lib/ffmpeg");
  // ffmpeg's description of a video whose name, title of two lines,
  // comment and chapter hold the words of a full disk, as ffmpeg 4.4 and
  // 8 print it at -loglevel info.
  const described = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/films/Fix No space left on device: File too large.mp4':",
    "  Metadata:",
    "    title           : Is your video file too large for Instagram?",
    "                    : No space left on device",
    "    comment         : Disk quota exceeded",
    "  Chapters:",
    "    Chapter #0:0: start 0.000000, end 1.000000",
    "      Metadata:",
    "        title           : Error writing trailer of x.mp4: File too large",
    "Output #0, mp4, to 'square.mp4':",
    "  Metadata:",
    "    title           : Is your video file too large for Instagram?",
  ].join("\n");
  assert.equal(unfinished({ code: 0, stderr: described }), false);
  assert.equal(refusal(described), null);
  assert.equal(failure(`${described}\n[aac @ 0x1] Too many bits per frame requested\nConversion failed!`), "Too many bits per frame requested");
  assert.equal(failure(`${described}\n[libx264 @ 0x1] Error setting preset\nConversion failed!`, { telling: true }), "Error setting preset");
  // What ffmpeg 4.4 says of a trailer it could not write, after the same
  // description, and a write it was refused.
  assert.equal(unfinished({ code: 0, stderr: `${described}\n[mp4 @ 0x55d0a1] Error writing trailer of square.mp4: No space left on device` }), true);
  assert.equal(refusal(`${described}\nav_interleaved_write_frame(): File too large\nConversion failed!`), "EFBIG");
  assert.equal(failure(`${described}\n[out#0/mp4 @ 0x1] Task finished with error code: -122 (Disk quota exceeded)\nConversion failed!`), "the disk quota is used up");
});

test("a video whose name, title, comment or chapter holds the words of a full disk or a file too large renders, with its sound and without", () => {
  const here = outDir("worded");
  fs.mkdirSync(here, { recursive: true });
  const meta = path.join(here, "meta.txt");
  fs.writeFileSync(meta, ";FFMETADATA1\ntitle=Is your video file too large for Instagram?\\\nNo space left on device\ncomment=Disk quota exceeded\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Error writing trailer of x.mp4: File too large\n");
  const sounded = path.join(here, "Fix No space left on device: File too large.mp4");
  ffmpeg(["-i", fixture("twoShots"), "-i", meta, "-map_metadata", "1", "-map_chapters", "1", "-map", "0", "-c", "copy", sounded]);
  // With no sound, the encode is the one run that reads the title.
  const silent = path.join(here, "why is my video file too large.mp4");
  ffmpeg(["-i", sounded, "-map", "0:v", "-c", "copy", silent]);
  for (const [file, out] of [[sounded, "o-sounded"], [silent, "o-silent"]]) {
    const r = cli([path.basename(file), "--for", "180x320", "--out", out], { cwd: here });
    assert.equal(r.status, 0, `${path.basename(file)}: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(here, out, "180x320.mp4")), `${path.basename(file)}: no file`);
  }
});

test("notes of the reading of the picture that a full disk cut short stop the run, though ffmpeg ends well, and name the folder", { skip: process.platform === "win32" }, () => {
  // An ffmpeg that reads the picture, then cuts one of the notes it wrote
  // to half, as a disk that fills up leaves them: scdet's scores, the
  // small frames' times or cropdetect's words.
  const bin = outDir("cut-bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  for (const notes of ["scd.txt", "grid.txt", "crop.txt"]) {
    const name = notes.replace(".txt", "");
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\ncase "$*" in *scdet*) "${real}" "$@"; s=$?; n=$(wc -c < ${notes}); head -c $((n / 2)) ${notes} > cut && mv cut ${notes}; exit $s;; esac\nexec "${real}" "$@"\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
    const out = outDir(`cut-${name}`);
    const r = cli([fixture("twoShots"), "--for", "180x320", "--plan", "--out", out], { env: { ...process.env, FFMPEG_PATH: path.join(bin, name) } });
    assert.equal(r.status, 1, `${notes}: ${r.stderr}`);
    assert.ok(r.stderr.includes(`reframekit: Reading the picture failed: the notes ffmpeg wrote on it in ${out} stop short of its end, as when the disk or the quota is full\n`), `${notes}: ${r.stderr}`);
    assert.ok(!fs.existsSync(out), `${notes}: ${out} is still there`);
  }
});

// Runs a shell script in a namespace of its own with a disk of `kib` KiB
// mounted at $1, and $2, $3 the node and the CLI; null where this machine
// cannot (unprivileged namespaces turned off, or not Linux).
function onSmallDisk(name, kib, script, ...args) {
  if (process.platform !== "linux") return null;
  const at = outDir(name);
  fs.mkdirSync(at, { recursive: true });
  if (spawnSync("unshare", ["-rm", "true"], { timeout: 20_000 }).status !== 0) return null;
  return spawnSync("unshare", ["-rm", "sh", "-c", `mount -t tmpfs -o size=${kib}k tmpfs "$1" || exit 9\n${script}`, "sh", at, process.execPath, CLI, ...args], { encoding: "utf8", timeout: 600_000 });
}

test("a disk or a quota that fills up while the run writes is named as the cause, with the folder: in the reading of the picture, in Node's own writes and in the check's, which leaves neither report nor the folders it made", (t) => {
  // A disk too small for scdet's scores: before, the run planned from
  // the scores it got, with no word of what it lost.
  const plan = onSmallDisk("small-disk", 8, '"$2" "$3" "$4" --for 180x320 --plan --out "$1/out"; echo "exit $?"; ls -A "$1"', fixture("fourShots"));
  if (!plan) {
    t.skip("no small disk can be mounted here");
    return;
  }
  assert.match(plan.stdout, /^exit 1$/m, plan.stdout + plan.stderr);
  assert.match(plan.stderr, /^reframekit: Reading the picture failed: the notes ffmpeg wrote on it in .*small-disk\/out stop short of its end, as when the disk or the quota is full$/m);
  assert.doesNotMatch(plan.stdout, /out/);
  // An MPEG-TS whose copy, which ffmpeg makes, takes more room than the
  // disk has: in the words of Node's own writes, with the folder. The
  // disk holds half the copy, made here as the run makes it, since the
  // share of the MPEG-TS its copy takes differs from one ffmpeg to
  // another: a third of this one with ffmpeg 4.4, two thirds with 8.
  const ts = path.join(dir, "small-disk.ts");
  ffmpeg(["-i", fixture("fourShots"), "-c", "copy", "-f", "mpegts", ts]);
  const copied = path.join(dir, "small-disk-copy.mp4");
  ffmpeg(["-fflags", "+genpts", "-i", ts, "-map", "0:0", "-map", "0:1", "-c", "copy", "-f", "mp4", copied]);
  const copy = onSmallDisk("copy-disk", Math.max(16, Math.floor(fs.statSync(copied).size / 2048)), '"$2" "$3" "$4" --for 180x320 --plan --out "$1/out"; echo "exit $?"; ls -A "$1"', ts);
  assert.match(copy.stdout, /^exit 1$/m, copy.stdout + copy.stderr);
  assert.match(copy.stderr, /^reframekit: Cannot write to .*copy-disk\/out: no space is left on the disk$/m);
  assert.doesNotMatch(copy.stdout, /out/);
  // A disk that fills up once the picture is read: an ffmpeg that fills it
  // as the sheet's first frame is taken, so the sheet cannot be written.
  const bin = outDir("fill-bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in *-noaccurate_seek*) [ -e fill ] || cat /dev/zero > fill 2>/dev/null;; esac\nexec "${real}" "$@"\n`);
  fs.chmodSync(path.join(bin, "ffmpeg"), 0o755);
  const sheet = onSmallDisk("full-later", 4096, 'FFMPEG_PATH="$5" FFPROBE_PATH="$6" "$2" "$3" "$4" --for 180x320 --plan --out "$1/out"; echo "exit $?"; ls -A "$1"', fixture("twoShots"), path.join(bin, "ffmpeg"), spawnSync("sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).stdout.trim());
  assert.match(sheet.stdout, /^exit 1$/m, sheet.stdout + sheet.stderr);
  assert.match(sheet.stderr, /^reframekit: Cannot write to .*full-later\/out: no space is left on the disk$/m);
  assert.doesNotMatch(sheet.stdout, /out/);
  // The check's reports on a disk with no room left: the folders it made
  // for them go again.
  const check = onSmallDisk("full-check", 64, 'cat /dev/zero > "$1/fill" 2>/dev/null; "$2" "$3" check "$4" --out "$1/check/deep"; echo "exit $?"; ls -A "$1"', fixture("twoShots"));
  assert.match(check.stdout, /^exit 1$/m, check.stdout + check.stderr);
  assert.match(check.stderr, /^reframekit: Cannot write the check to .*full-check\/check\/deep: no space is left on the disk; give --out a folder that takes files$/m);
  assert.deepEqual(check.stdout.split("\n").slice(1).filter(Boolean), ["fill"]);
  // Room for one report and not the other: neither is left, so the check
  // goes once the disk has room again.
  const half = onSmallDisk("half-check", 16, 'head -c 12288 /dev/zero > "$1/fill"; "$2" "$3" check "$4" --for square --out "$1/chk"; echo "exit $?"; ls -A "$1"; rm "$1/fill"; "$2" "$3" check "$4" --for square --out "$1/chk" > /dev/null; echo "exit $?"; LC_ALL=C ls -A "$1/chk"', fixture("twoShots"));
  assert.match(half.stderr, /^reframekit: Cannot write the check to .*half-check\/chk: no space is left on the disk; give --out a folder that takes files$/m);
  assert.deepEqual(half.stdout.split("\n").filter(Boolean), ["exit 1", "fill", "exit 0", "CHECK.md", "check.json"], half.stderr);
});

test("a file ffmpeg cannot read is named as it was given", () => {
  const here = outDir("named-input");
  fs.mkdirSync(here, { recursive: true });
  fs.writeFileSync(path.join(here, "trunc.mp4"), "not a video at all\n");
  const r = cli(["trunc.mp4", "--for", "180x320", "--out", "o"], { cwd: here });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^reframekit: Cannot read trunc\.mp4: ffmpeg does not know this format$/m);
  const c = cli(["check", "trunc.mp4", "--for", "youtube"], { cwd: here });
  assert.equal(c.status, 1);
  assert.match(c.stderr, /^reframekit: Cannot read trunc\.mp4: ffmpeg does not know this format$/m);
  // A name that holds ffprobe's words is not read as what it says.
  fs.writeFileSync(path.join(here, "No such file here.mp4"), "not a video at all\n");
  const named = cli(["No such file here.mp4", "--for", "180x320", "--out", "o"], { cwd: here });
  assert.match(named.stderr, /^reframekit: Cannot read No such file here\.mp4: ffmpeg does not know this format$/m);
});
