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
  // picture takes, and volume.
  const bin = outDir("filters-bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const said = {
    "cropdetect|eq": "This ffmpeg lacks the cropdetect, eq filters, which come only in a build made with --enable-gpl, as Ubuntu's is. Install such a build of ffmpeg (4.4 or later) or point FFMPEG_PATH at one.",
    eq: "This ffmpeg lacks the eq filter, which comes only in a build made with --enable-gpl, as Ubuntu's is. Install such a build of ffmpeg (4.4 or later) or point FFMPEG_PATH at one.",
    scdet: "This ffmpeg lacks the scdet filter. Install a newer build of ffmpeg (4.4 or later) or point FFMPEG_PATH at one.",
    "scdet|eq": "This ffmpeg lacks the scdet, eq filters. Install a newer build of ffmpeg (4.4 or later), made with --enable-gpl, or point FFMPEG_PATH at one.",
    "bwdif|volume": "This ffmpeg lacks the bwdif, volume filters. Install a full build of ffmpeg (4.4 or later) or point FFMPEG_PATH at one.",
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

test("an ffmpeg or an ffprobe that does not answer is named with why it did not, and only one that is not there is to be installed", { skip: process.platform === "win32" }, () => {
  const { unanswered, MISSING } = require("../skills/reframekit/scripts/lib/ffmpeg");
  // One too slow to answer, as on a machine too busy, which spawnSync ends.
  const late = { error: Object.assign(new Error("spawnSync ffprobe ETIMEDOUT"), { code: "ETIMEDOUT" }), signal: "SIGTERM", status: null };
  assert.equal(unanswered("ffprobe", late, 120_000, "while it read film.mp4").message, "ffprobe did not answer within 120 s while it read film.mp4: the machine may be too busy. Run reframekit again when the machine is less busy.");
  assert.equal(unanswered("ffmpeg", late, 60_000, "when asked which version it is").message, "ffmpeg did not answer within 60 s when asked which version it is: the machine may be too busy. Run reframekit again when the machine is less busy.");
  assert.equal(unanswered("ffmpeg", { error: Object.assign(new Error("spawnSync ffmpeg ENOENT"), { code: "ENOENT" }) }, 60_000).message, MISSING);
  // A signal that stops a run, as Ctrl-C, is a stop (`stopped`); a crash,
  // or the system's kill when memory runs out, is not.
  const ended = (signal) => unanswered("ffprobe", { signal, status: null }, 120_000, "while it read film.mp4");
  assert.deepEqual([ended("SIGTERM").message, ended("SIGTERM").stopped], ["ffprobe was stopped (SIGTERM) while it read film.mp4", "SIGTERM"]);
  assert.deepEqual([ended("SIGINT").stopped, ended("SIGHUP").stopped], ["SIGINT", "SIGHUP"]);
  assert.deepEqual([ended("SIGSEGV").message, ended("SIGSEGV").stopped], ["ffprobe crashed (SIGSEGV) while it read film.mp4", undefined]);
  assert.deepEqual([ended("SIGABRT").message, ended("SIGBUS").message], ["ffprobe crashed (SIGABRT) while it read film.mp4", "ffprobe crashed (SIGBUS) while it read film.mp4"]);
  assert.deepEqual([ended("SIGKILL").message, ended("SIGKILL").stopped], ["ffprobe was killed (SIGKILL) while it read film.mp4, as when the machine runs out of memory", undefined]);
  assert.deepEqual([ended("SIGXCPU").message, ended("SIGXCPU").stopped], ["ffprobe was killed (SIGXCPU) while it read film.mp4", undefined]);
  // A program given for ffmpeg that is none, one that cannot be run, and
  // an ffmpeg killed, crashing, or failing, as it says what it is or lists
  // what it has.
  const bin = outDir("tool-bin");
  fs.mkdirSync(bin, { recursive: true });
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
    other: `${path.join(bin, "other")} failed when asked which version it is: not an ffmpeg. ${MISSING}`,
    shut: `${path.join(bin, "shut")} could not be run: permission denied`,
    killed: `${path.join(bin, "killed")} was killed (SIGKILL) when asked to list its filters, as when the machine runs out of memory`,
    crashing: `${path.join(bin, "crashing")} crashed (SIGSEGV) when asked which version it is`,
    failing: `${path.join(bin, "failing")} failed when asked to list its encoders: cannot list them`,
  };
  for (const [name, words] of Object.entries(said)) {
    const r = cli([fixture("twoShots"), "--for", "180x320", "--out", outDir(`tool-${name}`)], { env: { ...process.env, FFMPEG_PATH: path.join(bin, name), FFPROBE_PATH: probe } });
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.equal(r.stderr, `reframekit: ${words}\n`, name);
    assert.ok(!fs.existsSync(outDir(`tool-${name}`)), name);
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
