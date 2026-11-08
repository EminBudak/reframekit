"use strict";

// Rendering: one ffmpeg run per distinct file. Places that would get the
// same file (TikTok, Reels and Shorts, all 9:16 and inside each other's
// limits) share one encode, and the copies are made from it.
//
// The window path reaches ffmpeg's crop filter as a sendcmd file, one line
// for each frame where the window moves; a padded shot is drawn over the
// cropped stream for its own stretch of time. The sound is set to the
// loudness asked for with loudnorm in two passes.

const fs = require("node:fs");
const path = require("node:path");
const { run, mustRun, unfinished, pickEncoder, probe, failure, refusal, endedBy, openVideo, fromOrigin, shownPicture } = require("./ffmpeg");
const { windowPath, windowOf } = require("./plan");
const { shapeOf, OWNERS } = require("./places");

const r3 = (x) => Math.round(x * 1000) / 1000;
const even = (n) => 2 * Math.round(n / 2);
// The samples ffmpeg's AAC encoder puts before the sound.
const PRIMING = 1024;

// The frame rates platforms take, for snapping a variable or odd rate.
const RATES = [
  [24000, 1001],
  [24, 1],
  [25, 1],
  [30000, 1001],
  [30, 1],
  [48, 1],
  [50, 1],
  [60000, 1001],
  [60, 1],
];

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// The output frame rate: the video's own when it is one of RATES, halved
// while above 60, raised to 30 below 23 (the floor TikTok and Instagram
// set), and the nearest of RATES otherwise. A rate that varies, as a
// screen recording's does (60 fps while it scrolls, a few while it is
// idle), is taken at its fast rate, ffprobe's r_frame_rate, so the fast
// stretches keep every frame; when that is not a rate a camera or a
// screen has (a timebase such as 1000 or 90000), at its average. A rate
// given with --fps is one of RATES when it is near one, else its own, to
// the thousandth, as a fraction in its lowest terms: 15 is 15, 12.5 is
// 25/2.
function outputRate(video, given) {
  if (given) {
    const exact = RATES.find(([n, d]) => Math.abs(n / d - given) < 0.005);
    if (exact) return { num: exact[0], den: exact[1] };
    const num = Math.round(given * 1000);
    const g = gcd(num, 1000);
    return { num: num / g, den: 1000 / g };
  }
  let f = video.baseFps || video.fps;
  if (video.variable && !(video.baseFps >= 1 && video.baseFps <= 120)) f = video.fps;
  if (!(f > 0)) f = 30;
  while (f > 60.5) f /= 2;
  if (f < 23) return { num: 30, den: 1 };
  let best = RATES[0];
  for (const r of RATES) if (Math.abs(r[0] / r[1] - f) < Math.abs(best[0] / best[1] - f)) best = r;
  return { num: best[0], den: best[1] };
}

const rateText = (r) => (r.den === 1 ? `${r.num}` : `${r.num}/${r.den}`);
const rateValue = (r) => r.num / r.den;

// Where a place's file ends when the video is longer than the place takes
// or than --seconds: at the last shot change that keeps at least 70% of
// the time allowed, else at the limit itself with a short fade. A file
// ends a tenth of a second under a place's limit, so the sound's last
// block cannot carry it over; a shot change inside that tenth or on the
// limit itself, as cut points on round seconds land, ends it there, just
// before the change (`before`), so the next shot never shows and the shot
// before it loses that tenth alone. A shot change is on a frame of the
// video, which runs at `videoFps`: a cut on a round second falls on the
// first frame at or after it, at 140.007 s for 140 s in a video at 29.97
// fps, and counts as one on the limit. The shots' times are kept to the
// millisecond, so that frame is one less than a frame past the limit, or
// the frame of the rate's grid after it; the frame after that, as 140.04
// s at 25 fps, is past the limit. `fps` is the files' rate, which the end
// is on a frame of.
function trimFor(place, { duration, shots, seconds, trim, fps, videoFps = fps }) {
  const lim = place.limits && place.limits.seconds;
  let max = Infinity;
  let why = null;
  if (trim && lim && lim.max) {
    max = lim.max;
    why = "place";
  }
  if (seconds && seconds < max) {
    max = seconds;
    why = "asked";
  }
  if (!(duration > max + 0.0005)) return null;
  const room = why === "place" ? max - 0.1 : max;
  // The room on a frame of the files.
  const last = r3(Math.floor(room * fps + 1e-6) / fps);
  const frame = 1 / (videoFps > 0 ? videoFps : fps);
  const first = Math.ceil(max / frame - 1e-6) * frame;
  const onLimit = (t) => t <= max + 1e-6 || t < max + frame - 0.0005 || t <= first + 0.0005;
  const cut = shots
    .slice(1)
    .map((s) => s.start)
    .filter((t) => onLimit(t) && t >= 0.7 * room)
    .pop();
  if (cut !== undefined && cut <= room + 1e-6) return { end: r3(cut), atCut: true, why, limit: max };
  if (cut !== undefined) return { end: last, atCut: true, before: r3(cut), why, limit: max };
  return { end: last, atCut: false, why, limit: max };
}

// The size of a place's file in fit mode: the picture's own shape, as
// large as fits the place's frame.
function fitSize(picture, place) {
  const s = Math.min(place.width / picture.w, place.height / picture.h);
  return { width: Math.max(2, even(picture.w * s)), height: Math.max(2, even(picture.h * s)) };
}

// The sendcmd lines that move a shape's window, one for each frame where
// it lands on another even pixel. A command at (k - 0.5) / fps reaches
// frame k and none before it.
function cropCommands(shots, key, { fps, end, target }) {
  const where = windowPath(shots, key);
  const sizeAt = (t) => {
    let i = shots.length - 1;
    while (i > 0 && shots[i].start > t) i--;
    const w = shots[i].windows[key];
    return w && w.w ? [w.w, w.h] : null;
  };
  const lines = [];
  let last = null;
  const frames = Math.ceil(end * fps - 1e-6);
  let first = null;
  for (let k = 0; k < frames; k++) {
    const t = k / fps;
    const p = where(t);
    const size = sizeAt(t);
    if (!p || !size) continue;
    const now = [even(p[0]), even(p[1]), size[0], size[1]];
    if (!first) first = now;
    if (last && now.every((v, i) => v === last[i])) continue;
    const at = Math.max(0, (k - 0.5) / fps).toFixed(4);
    const parts = [];
    if (!last || now[2] !== last[2] || now[3] !== last[3]) parts.push(`${target} w ${now[2]}`, `${target} h ${now[3]}`);
    if (!last || now[0] !== last[0]) parts.push(`${target} x ${now[0]}`);
    if (!last || now[1] !== last[1]) parts.push(`${target} y ${now[1]}`);
    lines.push(`${at} ${parts.join(", ")};`);
    last = now;
  }
  return { text: lines.join("\n") + "\n", first };
}

// The stretches of time, as an ffmpeg expression, when a shape's shots
// are padded. A switch inside a cut's fade happens halfway through it.
function padExpression(shots, key) {
  const spans = [];
  shots.forEach((s, i) => {
    if (s.windows[key].mode !== "pad") return;
    const from = i === 0 ? 0 : s.start + s.fade / 2;
    const next = shots[i + 1];
    const to = next ? next.start + next.fade / 2 : 1e9;
    const last = spans[spans.length - 1];
    if (last && Math.abs(last[1] - from) < 1e-6) last[1] = to;
    else spans.push([from, to]);
  });
  return spans.map(([a, b]) => `gte(t,${a.toFixed(4)})*lt(t,${b.toFixed(4)})`).join("+");
}

const RGB_FORMATS = /^(rgb|bgr|argb|abgr|rgba|bgra|gbr|0rgb|0bgr|rgb0|bgr0|pal8|ya8|gray)/;
const SD_MATRICES = /^(bt470bg|smpte170m|bt601)/;

// The picture part of a run's filter graph, ending in [v].
function videoGraph(job, ctx) {
  const { info, picture, shots, pad } = ctx;
  const v = info.video;
  const { key, width: OW, height: OH, mode, trim, fps } = job;
  const parts = [];
  // Its times from the video's origin, as every run that reads it counts,
  // and every frame at the size it is shown, square pixels made of ones
  // that are not, and a frame of another size or format scaled to the
  // first's (ffmpeg.js); an interlaced picture field by field, before it
  // is deinterlaced.
  const interlaced = /^(tt|bb|tb|bt)$/.test(v.fieldOrder);
  const prep = [`setpts=PTS-${fromOrigin(info)}/TB`, shownPicture(info, `:flags=lanczos${interlaced ? ":interl=-1" : ""}`)];
  if (interlaced) prep.push("bwdif=mode=send_frame:parity=auto:deint=interlaced");
  // A picture that starts after the sound starts on its first frame,
  // held, so the two stay together, and one that ends before the sound
  // holds its last frame to the end of the sound (job.hold seconds).
  prep.push(`fps=${rateText(fps)}:start_time=0`);
  if (job.hold > 0) prep.push(`tpad=stop_mode=clone:stop_duration=${job.hold.toFixed(4)}`);
  if (trim) prep.push(`trim=end=${trim.end.toFixed(4)}`);
  // The last scale also turns the colors into BT.709, which every output
  // is tagged with, when the source is RGB or standard definition.
  const color = RGB_FORMATS.test(v.pixFmt) ? ":out_color_matrix=bt709:out_range=tv" : SD_MATRICES.test(v.colorSpace) ? ":in_color_matrix=bt601:out_color_matrix=bt709" : "";
  const scaleTo = (w, h, how = "") => `scale=${w}:${h}${how}:flags=lanczos${color}`;
  const bars = picture.x || picture.y || picture.w !== v.displayWidth || picture.h !== v.displayHeight ? `crop=${picture.w}:${picture.h}:${picture.x}:${picture.y},` : "";
  // Every file is tagged BT.709 in the graph itself: ffmpeg 8 takes a
  // frame's own tags over -color_primaries and -color_trc, and writes
  // them as unknown when the graph leaves them so.
  const finish = ["setsar=1", "format=yuv420p", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"];
  if (trim && !trim.atCut) finish.push(`fade=t=out:st=${Math.max(0, trim.end - 0.5).toFixed(4)}:d=0.5`);

  // A padded picture: the whole of it, as large as fits, on a blurred and
  // darkened copy of itself or on a color. The color is drawn in RGB and
  // turned into BT.709 by scale, as the files are tagged: ffmpeg 4.4's pad
  // filter turns its color into YUV by BT.601, which shows a brand's
  // background darker and greener than asked.
  const padChain = (input, output) => {
    if (pad.kind === "color") {
      return [
        `color=c=0x${pad.hex.slice(1)}:s=${OW}x${OH}:r=${rateText(fps)},format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[${output}c]`,
        `[${input}]${bars}${scaleTo(OW, OH, ":force_original_aspect_ratio=decrease")}[${output}s]`,
        `[${output}c][${output}s]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1[${output}]`,
      ];
    }
    // The blur runs on a small plane, and on one thread of its own: ffmpeg's
    // gblur, 4.4's and 8's, writes zeros into a plane that has fewer rows
    // than the threads it splits it among, which shows as green patches,
    // and ffmpeg gives a graph as many threads as the machine has.
    const bw = Math.max(16, even(OW / 8));
    const bh = Math.max(16, even(OH / 8));
    return [
      `[${input}]${bars}split=2[${output}f][${output}b]`,
      `[${output}b]scale=${bw}:${bh}:force_original_aspect_ratio=increase:flags=bilinear,crop=${bw}:${bh},gblur=sigma=5:threads=1,eq=brightness=-0.06:saturation=0.85,scale=${OW}:${OH}:flags=bicubic[${output}g]`,
      `[${output}f]${scaleTo(OW, OH, ":force_original_aspect_ratio=decrease")}[${output}s]`,
      `[${output}g][${output}s]overlay=x=(W-w)/2:y=(H-h)/2[${output}]`,
    ];
  };

  if (mode === "fit") {
    parts.push(`[0:${v.index}]${prep.join(",")},${bars}${scaleTo(OW, OH)},${finish.join(",")}[v]`);
    return { graph: parts.join(";"), commands: null };
  }
  const modes = new Set(shots.map((s) => s.windows[key].mode));
  if (modes.has("full")) {
    parts.push(`[0:${v.index}]${prep.join(",")},${bars}${scaleTo(OW, OH)},${finish.join(",")}[v]`);
    return { graph: parts.join(";"), commands: null };
  }
  const following = modes.has("follow");
  const padded = modes.has("pad");
  let commands = null;
  if (following) {
    const end = trim ? trim.end : info.duration;
    commands = cropCommands(shots, key, { fps: rateValue(fps), end, target: "crop@win" });
  }
  // The window, which a smaller one in crop.json zooms into. When a
  // command gives it another size, ffmpeg 4.4's crop sets the size of the
  // link after it to the new one, so a scale right after it sees no change
  // and goes on reading the frames as the old size. A filter between the
  // two keeps that link as it was, and scale starts again on the new size.
  const windowChain = (x, y, w, h) => `sendcmd=f=${job.cmdFile},crop@win=w=${w}:h=${h}:x=${x}:y=${y},setsar=1,${scaleTo(OW, OH)}`;
  if (following && !padded) {
    const [x, y, w, h] = commands.first;
    parts.push(`[0:${v.index}]${prep.join(",")},${windowChain(x, y, w, h)},${finish.join(",")}[v]`);
  } else if (padded && !following) {
    parts.push(`[0:${v.index}]${prep.join(",")}[p0]`, ...padChain("p0", "pd"), `[pd]${finish.join(",")}[v]`);
  } else {
    const [x, y, w, h] = commands.first;
    parts.push(`[0:${v.index}]${prep.join(",")},split=2[c0][p0]`);
    parts.push(`[c0]${windowChain(x, y, w, h)}[cf]`);
    parts.push(...padChain("p0", "pd"));
    parts.push(`[cf][pd]overlay=x=0:y=0:enable='${padExpression(shots, key)}',${finish.join(",")}[v]`);
  }
  return { graph: parts.join(";"), commands: commands && commands.text };
}

// The loudness of the sound over [0, end), measured by loudnorm's first
// pass. Returns its numbers, or null when there is no sound to measure.
async function measureLoudness(file, info, { end, lufs, work }) {
  if (!info.audio) return null;
  const chain = [`asetpts=PTS-${fromOrigin(info)}/TB`, ...(end ? [`atrim=end=${end.toFixed(4)}`] : []), "aformat=channel_layouts=stereo", `loudnorm=I=${lufs}:TP=-1:LRA=11:print_format=json`].join(",");
  const r = await mustRun(["-nostats", "-loglevel", "info", ...openVideo(info, file), "-vn", "-sn", "-dn", "-map", `0:${info.audio.index}`, "-af", chain, "-f", "null", "-"], "Measuring the sound", { cwd: work });
  const m = /\{\s*"input_i"[\s\S]*?\}/.exec(r.stderr.slice(r.stderr.lastIndexOf('"input_i"') - 20));
  if (!m) throw new Error("Measuring the sound: loudnorm printed no measurement");
  const raw = JSON.parse(m[0]);
  const num = (k) => (/inf/.test(String(raw[k])) ? -Infinity : Number(raw[k]));
  return { i: num("input_i"), tp: num("input_tp"), lra: num("input_lra"), thresh: num("input_thresh"), offset: Number(raw.target_offset) };
}

// EBU R128 loudness of a finished file, as ffmpeg's ebur128 meter reads
// it: integrated loudness (LUFS) and true peak (dBTP), the loudness null
// for silence. The meter logs a line for every tenth of a second at the
// level framelog names; verbose keeps them out of -loglevel info, in
// ffmpeg 4.4 as in 8 (4.4 has no framelog=quiet). A meter that fails or
// prints no summary stops the run: sound it could not measure is not
// silent. `what` names the file for the error.
async function loudnessOf(file, work, what = path.basename(file)) {
  const r = await run(["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-i", path.resolve(file), "-vn", "-sn", "-dn", "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-"], { cwd: work });
  const at = r.stderr.lastIndexOf("Integrated loudness:");
  if (r.code !== 0 || at < 0) {
    const said = failure(r.stderr);
    throw new Error(`Measuring the sound of ${what}: ffmpeg ${r.signal ? endedBy(r.signal) : r.code !== 0 ? `failed${said ? `: ${said}` : ""}` : "printed no loudness"}`);
  }
  const tail = r.stderr.slice(at);
  const read = (label) => {
    const m = new RegExp(`${label}:\\s*(-?inf|-?[\\d.]+)`).exec(tail);
    return m ? (/inf/.test(m[1]) ? -Infinity : Number(m[1])) : null;
  };
  const i = read("I");
  const tp = read("Peak");
  if (i === null) throw new Error(`Measuring the sound of ${what}: ffmpeg printed no loudness`);
  return { integrated: Number.isFinite(i) && i > -70 ? i : null, truePeak: Number.isFinite(tp) ? tp : null };
}

// What loudnorm's second pass is given for sound that measured
// `measured`, held under `ceiling` dBTP and asked for `aim` LUFS: the
// target (`target`, `ceiling`, `lra`, the range it keeps), and the
// measurement, `i`, `tp`, `thresh`, after the sound is turned down by
// `down` dB. loudnorm takes a measured loudness and gate of 0 at most, so
// sound measured louder, as a square wave at full scale is, is turned
// down first to -1 LUFS, and its measurement with it. null for sound too
// quiet to set, under -70 LUFS.
function loudnormInput(measured, ceiling, aim) {
  if (!measured || !Number.isFinite(measured.i) || !(measured.i > -70)) return null;
  const down = Math.max(0, measured.i > 0 ? measured.i + 1 : 0, measured.thresh > 0 ? measured.thresh + 1 : 0);
  return {
    down,
    target: Math.round(aim * 10) / 10,
    ceiling: Number(ceiling.toFixed(1)),
    lra: Math.min(20, Math.max(7, Math.ceil(measured.lra + 1))),
    i: Math.round((measured.i - down) * 100) / 100,
    tp: Number.isFinite(measured.tp) ? Math.round((measured.tp - down) * 100) / 100 : -99,
    thresh: Math.round((measured.thresh - down) * 100) / 100,
  };
}

// Why loudnorm sets a sound dynamically rather than with one gain, from
// what it is given (loudnormInput()), as ffmpeg's loudnorm decides, 4.4
// and 8 alike: "peaks" when one gain would put the true peak over the
// ceiling, "steady" when the loudness range measured 0 LU, as a steady
// tone's or a hum's does, "wide" when the range is wider than the most it
// keeps, which is 20 LU here; null for another reason, as a loudness
// measured at 0 LUFS exactly, or none.
function dynamicWhy(measured, ceiling, aim) {
  const n = loudnormInput(measured, ceiling, aim);
  if (!n) return null;
  if (n.tp + (n.target - n.i) > n.ceiling) return "peaks";
  if (measured.lra === 0) return "steady";
  if (measured.lra > n.lra) return "wide";
  return null;
}

// The sound's filter graph, ending in [a], or null. `ceiling` is the true
// peak loudnorm holds the sound under, in dBTP, and `aim` the loudness it
// is asked for, the target unless an earlier try missed it.
function audioGraph(job, ctx, measured, ceiling = -2, aim = ctx.lufs) {
  const { info } = ctx;
  if (!info.audio) return null;
  // Its times from the video's origin, as every run that reads it counts.
  const chain = [`asetpts=PTS-${fromOrigin(info)}/TB`];
  if (job.trim) chain.push(`atrim=end=${job.trim.end.toFixed(4)}`);
  // Sound that starts after the picture starts with silence, so the two
  // stay together.
  chain.push("aresample=first_pts=0", "aformat=channel_layouts=stereo");
  const n = loudnormInput(measured, ceiling, aim);
  if (n) {
    if (n.down > 0) chain.push(`volume=${(-n.down).toFixed(2)}dB`);
    chain.push(`loudnorm=I=${n.target}:TP=${ceiling.toFixed(1)}:LRA=${n.lra}:measured_I=${n.i}:measured_TP=${n.tp}:measured_LRA=${measured.lra}:measured_thresh=${n.thresh}:offset=${Number.isFinite(measured.offset) ? measured.offset : 0}:linear=true:print_format=json`);
  }
  // The AAC encoder starts with 1024 samples of its own (priming), which
  // an edit list would hide; without one they play first. So the first
  // 1024 samples of the sound go, and the rest lands on its frame, the
  // file no longer than its picture.
  // The sound also ends where the picture does, the priming counted.
  const end = job.trim ? job.trim.end : info.duration;
  // Timestamps are counted again from the samples, since loudnorm's
  // frames can leave gaps that would lengthen the track.
  chain.push("aresample=48000", `atrim=start_sample=${PRIMING}`, "asetpts=N/SR/TB", `atrim=end_sample=${Math.max(1, Math.floor(end * 48000) - PRIMING)}`);
  if (job.trim) {
    const d = job.trim.atCut ? 0.15 : 0.5;
    chain.push(`afade=t=out:st=${Math.max(0, job.trim.end - d - PRIMING / 48000).toFixed(4)}:d=${d}`);
  }
  return `[0:${info.audio.index}]${chain.join(",")}[a]`;
}

// The encoder's settings: x264 by quality with a ceiling on the bit rate,
// two B-frames and a closed GOP of two seconds, as YouTube recommends; the
// others by bit rate. -use_editlist 0 with negative composition offsets
// keeps the file free of edit lists (Instagram refuses them, YouTube asks
// for none) without moving the first frame.
// `floor` asks for a steady bit rate, padded where the picture needs
// less, for a file that has to reach a least size.
function videoArgs({ encoder, fps, maxrate, bitrate, floor = false, pass, passlog, height, width }) {
  const gop = String(Math.max(1, Math.round(rateValue(fps) * 2)));
  const pixels = width * height;
  const typical = pixels > 2_200_000 ? 16_000_000 : pixels > 1_000_000 ? 8_000_000 : 5_000_000;
  if (encoder.name === "libx264") {
    const args = ["-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-bf", "2", "-g", gop, "-keyint_min", String(Math.max(1, Math.round(rateValue(fps) / 2)))];
    if (floor) args.push("-b:v", String(bitrate), "-minrate", String(bitrate), "-maxrate", String(bitrate), "-bufsize", String(bitrate), "-x264-params", "nal-hrd=cbr");
    else if (bitrate) args.push("-b:v", String(bitrate), "-maxrate", String(Math.round(bitrate * 1.5)), "-bufsize", String(Math.round(bitrate * 2)));
    else args.push("-crf", "20", "-maxrate", String(maxrate), "-bufsize", String(maxrate * 2));
    if (pass) args.push("-pass", String(pass), "-passlogfile", passlog);
    return args;
  }
  const rate = String(bitrate || Math.min(maxrate, typical * (rateValue(fps) > 40 ? 1.5 : 1)));
  return ["-c:v", encoder.name, "-b:v", rate, "-maxrate", rate, ...(floor ? ["-minrate", rate] : []), "-bf", encoder.name === "h264_videotoolbox" ? "2" : "0", "-g", gop];
}

// Bytes as a person reads them: KB under a megabyte, MB, then GB, each a
// thousand times the one before, as the places' limits are read.
const bytesText = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

const COMMON = ["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-movflags", "+faststart+negative_cts_offsets", "-use_editlist", "0", "-map_metadata", "-1", "-map_chapters", "-1"];

// The sound on its own, as AAC in an MP4 of its own: set to the loudness
// asked for, measured, and set again when it missed, up to five times.
// Two misses happen. The AAC encoder rounds the waveform and its peaks
// come out up to 2 dB higher than loudnorm left them, more so at 128 kb/s:
// a true peak over -1 dBTP is set again under a lower ceiling. And sound
// whose sharp peaks stand far over its loudness (clicks in a quiet room,
// many a video model's clip) makes loudnorm work dynamically, where it
// falls short of its target: a file more than half a unit off, quieter
// or louder, is set again with the target moved by the miss. The try that
// keeps its peaks under -1 dBTP and comes nearest the target is kept, and
// with it what the first try at the target measured, and whether a try
// nearer the target was set aside for its peaks.
async function encodeSound(job, ctx) {
  const { info, work, log, lufs } = ctx;
  if (!info.audio) return null;
  const file = `sound-${job.id}.m4a`;
  const end = job.trim ? job.trim.end : info.duration;
  const loud = job.measured && Number.isFinite(job.measured.i) && job.measured.i > -70;
  let ceiling = -2;
  let aim = lufs;
  let firstTry = null;
  const tries = [];
  const off = (t) => (t.loudness && t.loudness.integrated !== null ? Math.abs(t.loudness.integrated - lufs) : 99);
  const peak = (t) => (t.loudness && t.loudness.truePeak !== null ? t.loudness.truePeak : 0);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const name = `sound-${job.id}-${attempt}.m4a`;
    const graph = audioGraph(job, ctx, job.measured, ceiling, aim);
    const r = await mustRun(["-nostats", "-loglevel", "info", ...openVideo(info), "-filter_complex", graph, "-map", "[a]", "-c:a", "aac", "-b:a", String(job.audioBitrate), "-ar", "48000", "-ac", "2", "-movflags", "+faststart+negative_cts_offsets", "-use_editlist", "0", "-t", end.toFixed(4), "-y", name], `Setting the sound of ${job.file}`, { cwd: work });
    // loudnorm says how it went at the end of what it printed.
    let normalization = null;
    const at = r.stderr.lastIndexOf('"normalization_type"');
    if (at >= 0) {
      const m = /"normalization_type"\s*:\s*"(\w+)"/.exec(r.stderr.slice(at));
      if (m) normalization = m[1];
    }
    const loudness = await loudnessOf(path.join(work, name), work, job.file);
    const t = { name, normalization, loudness, ceiling, aim, tries: attempt };
    tries.push(t);
    if (normalization === "dynamic") t.why = dynamicWhy(job.measured, ceiling, aim);
    if (!loud || loudness.truePeak === null || loudness.integrated === null) break;
    if (loudness.truePeak > -1 && ceiling > -9) {
      const next = Math.max(-9, ceiling - (loudness.truePeak + 1) - 0.3);
      log(`  the sound's true peak came out at ${loudness.truePeak.toFixed(1)} dBTP: setting it again under ${next.toFixed(1)} dBTP`);
      ceiling = next;
      continue;
    }
    const miss = lufs - loudness.integrated;
    if (Math.abs(miss) <= 0.5) break;
    const next = Math.min(-5, Math.max(lufs - 6, Math.min(lufs + 9, aim + miss)));
    if (Math.abs(next - aim) < 0.05) break;
    log(`  the sound came out at ${loudness.integrated.toFixed(1)} LUFS: setting it again, asking for ${next.toFixed(1)}`);
    if (!firstTry) firstTry = { lufs: loudness.integrated, normalization, why: t.why || null };
    aim = next;
  }
  // Under the peak ceiling first, then nearest the target.
  const under = tries.filter((t) => peak(t) <= -1);
  const pick = under.length ? under.reduce((a, b) => (off(b) < off(a) - 0.05 ? b : a)) : tries.reduce((a, b) => (peak(b) < peak(a) ? b : a));
  fs.renameSync(path.join(work, pick.name), path.join(work, file));
  for (const t of tries) if (t !== pick) fs.rmSync(path.join(work, t.name), { force: true });
  const held = tries.some((t) => peak(t) > -1 && off(t) < off(pick) - 0.05);
  return { file, normalization: pick.normalization, why: pick.why || null, loudness: pick.loudness, ceiling: pick.ceiling, aim: pick.aim, tries: tries.length, firstTry, held };
}

// Encodes one job: the video, its sound, and the cover.
async function encodeJob(job, ctx) {
  const { info, work, log, version } = ctx;
  const encoder = pickEncoder();
  const vg = videoGraph(job, ctx);
  if (vg.commands) fs.writeFileSync(path.join(work, job.cmdFile), vg.commands);
  const end = job.trim ? job.trim.end : info.duration;
  const out = path.join(work, job.file);
  log(`Encoding ${job.file} (${job.width}x${job.height}${job.places.length > 1 ? `, also for ${job.places.slice(1).map((p) => p.name).join(", ")}` : ""})`);
  const sound = await encodeSound(job, ctx);
  const graph = vg.graph;
  const maps = ["-map", "[v]", ...(sound ? ["-map", "1:a", "-c:a", "copy"] : ["-an"])];
  const tail = [...COMMON, "-metadata", `comment=Reframed with reframekit ${version}`, "-t", end.toFixed(4)];
  const progress = (what) => {
    let shown = 0;
    let buffer = "";
    return (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (!m) continue;
        const done = Number(m[1]) / 1e6 / Math.max(0.001, end);
        const step = Math.floor(done * 4);
        if (step > shown && step < 4) {
          shown = step;
          log(`  ${what}: ${step * 25}%`);
        }
      }
    };
  };
  const encode = async (extra, what, { pass = 0, bitrate = 0, floor = false } = {}) => {
    // A first pass only reads the picture and writes nothing.
    const first = pass === 1;
    const io = first ? ["-filter_complex", vg.graph, "-map", "[v]", "-an"] : ["-filter_complex", graph, ...maps];
    const after = first ? ["-t", end.toFixed(4), "-f", "null", "-"] : [...tail, ...extra];
    const inputs = [...openVideo(info), ...(sound && !first ? ["-i", sound.file] : [])];
    const args = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-progress", "pipe:1", ...inputs, ...io, ...videoArgs({ encoder, fps: job.fps, maxrate: job.maxrate, bitrate, floor, pass, passlog: `pass-${job.id}`, width: job.width, height: job.height }), ...after];
    const r = await run(args, { cwd: work, onStdout: progress(what) });
    // ffmpeg 4.4 ends well when the disk fills up as it writes the file's
    // index (unfinished()).
    if (r.code !== 0 || unfinished(r)) {
      // Ended by a signal, ffmpeg's last line is only a stream it was
      // reading, not why it ended.
      if (r.signal) throw new Error(`Encoding ${job.file} failed: ffmpeg ${endedBy(r.signal)}`);
      const said = failure(r.stderr, { telling: true });
      throw Object.assign(new Error(`Encoding ${job.file} failed: ${said || `ffmpeg exited with ${r.code}`}`), { refused: refusal(r.stderr) });
    }
    return r;
  };
  await encode(["-y", job.file], job.file);
  let twoPass = null;
  let raised = null;
  let size = fs.statSync(out).size;
  // What the first encode came to, for the reports.
  const firstBytes = size;
  // The bits a second the sound takes, by the size of its own file, which
  // goes into the MP4 as it is: a silent track takes far less than the
  // rate it was encoded at.
  const audioBits = sound ? (fs.statSync(path.join(work, sound.file)).size * 8) / Math.max(0.5, end) : 0;
  if (job.maxBytes && size > job.maxBytes * 0.98) {
    // Over the place's file limit: two passes at the bit rate that fits,
    // with 5% to spare. An encoder can still go past the rate it was
    // asked for (x264 of ffmpeg 4.4 does, on grain), so a file still over
    // the limit is encoded again at a rate lowered by as much as it went
    // over, up to three rounds in all, and never under 200 kb/s.
    let bitrate = Math.max(200_000, Math.floor((job.maxBytes * 0.95 * 8) / end - audioBits));
    for (let round = 1; ; round++) {
      log(`  ${job.file} came out at ${bytesText(size)}, ${round > 1 ? "still " : ""}${size > job.maxBytes ? "over" : "within 2% of"} ${bytesText(job.maxBytes)}: encoding again at ${(bitrate / 1e6).toFixed(2)} Mb/s`);
      if (encoder.name === "libx264") {
        await encode([], `${job.file} pass 1`, { pass: 1, bitrate });
        await encode(["-y", job.file], `${job.file} pass 2`, { pass: 2, bitrate });
      } else await encode(["-y", job.file], job.file, { bitrate });
      for (const name of fs.readdirSync(work)) if (name.startsWith(`pass-${job.id}`)) fs.rmSync(path.join(work, name), { force: true });
      size = fs.statSync(out).size;
      twoPass = { bitrate, rounds: round, passes: encoder.name === "libx264" ? 2 : 1, firstBytes, limit: job.maxBytes, place: job.maxFor, by: job.maxBy };
      if (size <= job.maxBytes || round === 3 || bitrate <= 200_000) break;
      bitrate = Math.max(200_000, Math.floor((bitrate * job.maxBytes * 0.95) / size));
    }
  } else if (job.minBytes && size < job.minBytes) {
    // Under the place's least file size (LinkedIn takes 75 KB at least),
    // as a short still title card comes out: encoded again at a steady
    // bit rate that comes to about 1.2 times that with the sound. One that
    // still comes out under is encoded again at a rate raised by as much
    // as it fell short, up to three rounds in all.
    let bitrate = Math.min(job.maxrate, Math.max(100_000, Math.ceil((job.minBytes * 1.2 * 8) / Math.max(0.5, end) - audioBits)));
    for (let round = 1; ; round++) {
      log(`  ${job.file} came out at ${bytesText(size)}, ${round > 1 ? "still " : ""}under ${bytesText(job.minBytes)}: encoding again at ${(bitrate / 1e6).toFixed(2)} Mb/s`);
      await encode(["-y", job.file], job.file, { bitrate, floor: true });
      size = fs.statSync(out).size;
      raised = { bitrate, rounds: round, firstBytes, limit: job.minBytes, place: job.minFor, by: job.minBy };
      if (size >= job.minBytes || round === 3 || bitrate >= job.maxrate) break;
      bitrate = Math.min(job.maxrate, Math.ceil((bitrate * job.minBytes * 1.2) / size));
    }
  }
  if (sound) fs.rmSync(path.join(work, sound.file), { force: true });
  // The file is the run's own: one ffprobe cannot read is named so, not
  // by the hidden folder it is in.
  let made;
  try {
    made = probe(out, job.file);
  } catch (err) {
    throw err.why ? new Error(`Encoding ${job.file}: ffmpeg ended well, but the file it wrote cannot be read: ${err.why}`) : err;
  }
  // The cover: the frame at the cover time, from the file itself, so it
  // shows the crop the file has. A file that ends before then has it from
  // before its end: from before the half second it fades out over when it
  // was cut where no shot changes, else from just before the shot change
  // or the end of the video it ends at. So does one whose fade the cover
  // time falls in, which would show the picture half dark. And none is
  // later than the file's last frame, as a picture can end before the
  // sound does: its last frame then.
  const fades = job.trim && !job.trim.atCut;
  const lastFrame = made.video && made.video.duration > 0 ? made.video.startTime + made.video.duration - 1.5 / rateValue(job.fps) : Infinity;
  const coverAt = Math.max(0, Math.min(ctx.cover, end - (fades ? 0.6 : 0.1), lastFrame));
  const takeCover = async (quality) => {
    await mustRun(["-loglevel", "error", "-ss", coverAt.toFixed(3), "-i", job.file, "-frames:v", "1", "-q:v", quality, "-y", job.cover], `Taking the cover of ${job.file}`, { cwd: work });
    // ffmpeg 4.4 writes nothing, and says nothing, when no frame comes.
    if (!fs.existsSync(path.join(work, job.cover))) throw new Error(`Taking the cover of ${job.file}: ffmpeg found no frame at ${coverAt.toFixed(2)} s`);
  };
  await takeCover("2");
  if (fs.statSync(path.join(work, job.cover)).size > 2_000_000) await takeCover("5");
  return { size, made, loudness: sound ? sound.loudness : null, normalization: sound ? sound.normalization : null, dynamicWhy: sound ? sound.why : null, ceiling: sound ? sound.ceiling : null, aim: sound ? sound.aim : null, firstTry: sound ? sound.firstTry : null, held: Boolean(sound && sound.held), soundTries: sound ? sound.tries : 0, twoPass, raised, coverAt: r3(coverAt) };
}

// The jobs: one per distinct file, with the places it serves.
function jobsFor(places, ctx) {
  const { info, picture, shots, mode, seconds, trim, lufs } = ctx;
  const fps = ctx.fps;
  const jobs = [];
  for (const place of places) {
    const key = shapeOf(place.width, place.height);
    const size = mode === "fit" ? fitSize(picture, place) : { width: place.width, height: place.height };
    const cut = trimFor(place, { duration: info.duration, shots, seconds, trim, fps: rateValue(fps), videoFps: info.video.fps });
    // The seconds a picture that ends before the sound (reframe.js
    // heldPicture()) holds its last frame for: to the end of the sound, or
    // of the file when it is cut before that.
    const holdTo = ctx.held ? Math.min(cut ? cut.end : info.duration, ctx.held.to) : 0;
    const hold = ctx.held && holdTo > ctx.held.from ? r3(holdTo - ctx.held.from) : 0;
    const limits = place.limits || {};
    const maxBytes = limits.bytes && limits.bytes.max ? limits.bytes.max : 0;
    const minBytes = limits.bytes && limits.bytes.min ? limits.bytes.min : 0;
    // Whose limit it is, as the notes name it.
    const by = (limits.bytes && Object.hasOwn(OWNERS, limits.bytes.source || "") && OWNERS[limits.bytes.source]) || place.label;
    const placeRate = limits.videoBitrate && limits.videoBitrate.max ? limits.videoBitrate.max : Infinity;
    const pixels = size.width * size.height;
    const maxrate = Math.round(Math.min(placeRate * 0.9, pixels > 2_200_000 ? 40_000_000 : pixels > 1_000_000 ? 20_000_000 : 12_000_000));
    // Instagram's API asks for 128 kb/s; the rest get 192.
    const audioBitrate = limits.audioCodec && limits.audioCodec.source === "instagram" ? 128_000 : 192_000;
    // Places that need the same picture share one file, made to the
    // strictest of their limits: the same window's shape, size and
    // length, or in fit mode, which uses no window, the same size and
    // length whatever the place's shape.
    const same = jobs.find((j) => (mode === "fit" || j.key === key) && j.width === size.width && j.height === size.height && (j.trim ? j.trim.end : null) === (cut ? cut.end : null));
    if (same) {
      same.places.push(place);
      if (maxBytes && (!same.maxBytes || maxBytes < same.maxBytes)) Object.assign(same, { maxBytes, maxFor: place.label, maxBy: by });
      if (minBytes > same.minBytes) Object.assign(same, { minBytes, minFor: place.label, minBy: by });
      same.maxrate = Math.min(same.maxrate, maxrate);
      same.audioBitrate = Math.min(same.audioBitrate, audioBitrate);
      continue;
    }
    const id = jobs.length + 1;
    jobs.push({ id, key, width: size.width, height: size.height, mode, trim: cut, hold, fps, maxrate, audioBitrate, maxBytes, minBytes, maxFor: maxBytes ? place.label : null, maxBy: maxBytes ? by : null, minFor: minBytes ? place.label : null, minBy: minBytes ? by : null, places: [place], file: `${place.name}.mp4`, cover: `${place.name}-cover.jpg`, cmdFile: `window-${id}.cmd`, lufs });
  }
  return jobs;
}

module.exports = { outputRate, rateText, rateValue, trimFor, fitSize, cropCommands, padExpression, videoGraph, audioGraph, loudnormInput, dynamicWhy, measureLoudness, loudnessOf, encodeSound, encodeJob, jobsFor, windowOf, bytesText };
