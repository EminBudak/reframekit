"use strict";

// Test videos made by ffmpeg from its own sources (lavfi): colored
// grounds, boxes that move on known paths, tones and clicks. Each is made
// once per test file into a temporary folder, small so the tests run in
// seconds, with its truth (where the boxes are) beside it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reframekit-test-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

const CLI = path.resolve(__dirname, "../skills/reframekit/scripts/reframekit.js");

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}\n${r.stderr}`);
}

const ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
const SOUND = ["-c:a", "aac", "-b:a", "128k"];

// Two shots of 2 s each, 640x360 at 30 fps. In the first a 60 px white box
// crosses from x 40 to x 520 (240 px a second); in the second a 50 px
// yellow box at x 500 moves down. A 440 Hz tone at about -20 dBFS.
const TWO_SHOTS = {
  box: (t) => (t < 2 ? { x: 40 + 240 * t, y: 150, w: 60, h: 60 } : { x: 500, y: 60 + 60 * (t - 2), w: 50, h: 50 }),
  cut: 2,
};

const MAKERS = {
  twoShots(file) {
    ffmpeg([
      "-f", "lavfi", "-i", "color=c=0x202830:s=640x360:r=30:d=2",
      "-f", "lavfi", "-i", "color=c=white:s=60x60:r=30:d=2",
      "-f", "lavfi", "-i", "color=c=0x305070:s=640x360:r=30:d=2",
      "-f", "lavfi", "-i", "color=c=0xffcc00:s=50x50:r=30:d=2",
      "-f", "lavfi", "-i", "sine=f=440:r=48000:d=4,volume=0.14",
      "-filter_complex", "[0][1]overlay=x='40+240*t':y=150[s1];[2][3]overlay=x=500:y='60+60*t'[s2];[s1][s2]concat=n=2:v=1:a=0[v];[4]aformat=channel_layouts=stereo[a]",
      "-map", "[v]", "-map", "[a]", ...ENCODE, ...SOUND, "-shortest", file,
    ]);
  },
  // A still slide: eight boxes across 70% of the width, nothing moving.
  wideStill(file) {
    const boxes = Array.from({ length: 8 }, (_, i) => `drawbox=x=${100 + i * 56}:y=150:w=40:h=60:color=white:t=fill`).join(",");
    ffmpeg(["-f", "lavfi", "-i", `color=c=0x202830:s=640x360:r=30:d=2,${boxes}`, "-f", "lavfi", "-i", "sine=f=330:r=48000:d=2", ...ENCODE, ...SOUND, "-shortest", file]);
  },
  // Two boxes bobbing at the far left and the far right.
  twoSubjects(file) {
    ffmpeg([
      "-f", "lavfi", "-i", "color=c=0x202830:s=640x360:r=30:d=3",
      "-f", "lavfi", "-i", "color=c=white:s=50x50:r=30:d=3",
      "-f", "lavfi", "-i", "color=c=white:s=50x50:r=30:d=3",
      "-filter_complex", "[0][1]overlay=x=40:y='150+80*sin(2*PI*t)'[a];[a][2]overlay=x=550:y='150-80*sin(2*PI*t)'[v]",
      "-map", "[v]", ...ENCODE, file,
    ]);
  },
  // A camera that pans across a busy picture.
  pan(file) {
    ffmpeg(["-f", "lavfi", "-i", "color=c=gray:s=1600x360:r=30:d=3,format=gray,geq=lum='128+60*sin(X/9)*cos(Y/7)+50*sin((X+2*Y)/23)',format=yuv420p", "-vf", "crop=640:360:'t*300':0", ...ENCODE, file]);
  },
  // Grain that changes every frame: costly to encode, for file limits.
  noisy(file) {
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=3,noise=alls=40:allf=t+u", ...ENCODE, file]);
  },
  // Twelve seconds in four shots, cut at 3, 6 and 9 s, with a click at 1 s
  // and a white flash on the frame at 1 s, for trims and sync.
  fourShots(file) {
    const colors = ["0x802020", "0x20a040", "0x2040c0", "0xc0c020"];
    const inputs = colors.flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=320x180:r=30:d=3`]);
    ffmpeg([
      ...inputs,
      "-f", "lavfi", "-i", "aevalsrc='0.1*sin(2*PI*330*t)+if(between(t,1.0,1.002),0.8,0)':s=48000:d=12",
      "-filter_complex", "[0][1][2][3]concat=n=4:v=1:a=0,format=yuv420p,geq=lum='if(between(T,0.99,1.02),235,lum(X,Y))':cb='cb(X,Y)':cr='cr(X,Y)'[v];[4]aformat=channel_layouts=stereo[a]",
      "-map", "[v]", "-map", "[a]", ...ENCODE, ...SOUND, file,
    ]);
  },
};

const made = new Map();

// Makes the named video (once) and returns its path.
function fixture(name, extra = null) {
  const key = extra ? `${name}-${extra.name}` : name;
  if (made.has(key)) return made.get(key);
  const file = path.join(dir, `${key}.${extra && extra.ext ? extra.ext : "mp4"}`);
  if (extra && extra.make) extra.make(file);
  else MAKERS[name](file);
  made.set(key, file);
  return file;
}

function probe(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  const info = JSON.parse(r.stdout);
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  const rate = (t) => {
    const [x, y] = String(t).split("/").map(Number);
    return y ? x / y : x;
  };
  return {
    duration: Number(info.format.duration),
    video: v && { width: v.width, height: v.height, fps: rate(v.avg_frame_rate), baseFps: rate(v.r_frame_rate), codec: v.codec_name, pixFmt: v.pix_fmt, sideData: v.side_data_list || [], color: [v.color_range, v.color_space, v.color_transfer, v.color_primaries].join(" ") },
    audio: a && { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels },
  };
}

// Integrated loudness and true peak, from ffmpeg's ebur128 meter, its
// frame lines at the verbose level (ffmpeg 4.4 has no framelog=quiet).
function loudness(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-loglevel", "info", "-i", file, "-vn", "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-"], { encoding: "utf8" });
  const tail = r.stderr.slice(r.stderr.lastIndexOf("Integrated loudness:"));
  const read = (label) => {
    const m = new RegExp(`${label}:\\s*(-?inf|-?[\\d.]+)`).exec(tail);
    return m ? (/inf/.test(m[1]) ? -Infinity : Number(m[1])) : null;
  };
  return { integrated: read("I"), truePeak: read("Peak") };
}

// A frame at t as RGB: { width, height, at(x, y) => [r, g, b] }.
function frameAt(file, t) {
  const info = probe(file);
  const { width, height } = info.video;
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: width * height * 3 + 1024 });
  const px = r.stdout;
  return { width, height, at: (x, y) => [px[(y * width + x) * 3], px[(y * width + x) * 3 + 1], px[(y * width + x) * 3 + 2]], count: (test) => {
    let n = 0;
    for (let i = 0; i < width * height; i++) if (test(px[i * 3], px[i * 3 + 1], px[i * 3 + 2])) n++;
    return n;
  } };
}

// Whether this ffmpeg takes an option, such as -fps_mode, which ffmpeg
// 4.4 does not have.
const known = new Map();
function knows(option) {
  if (!known.has(option)) {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-h", "full"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    known.set(option, new RegExp(`^\\s*${option}\\b`, "m").test(r.stdout || ""));
  }
  return known.get(option);
}

function cli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 600_000, ...options });
}

function outDir(name) {
  return path.join(dir, name);
}

module.exports = { dir, CLI, ffmpeg, fixture, probe, loudness, frameAt, cli, outDir, knows, TWO_SHOTS, ENCODE, SOUND };
