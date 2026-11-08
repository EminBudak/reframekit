"use strict";

// One pass over the picture, with ffmpeg doing the decoding:
//
//   - scdet scores every frame against the one before, on a 320 px copy
//     in RGB (given YUV, scdet reads only the brightness, and a cut
//     between two pictures of one brightness would score nothing), for
//     the shot changes;
//   - cropdetect finds black bars (a letterboxed film, a 4:3 clip in 16:9);
//   - every tenth of a second, a small copy (128 cells on its long side,
//     its brightness at full range, so the same as a gray copy, and its
//     color at half that) comes to Node as raw bytes. Node measures, cell
//     by cell, how much the brightness changed since the copy before (what
//     moves) and how much edge there is (detail), and keeps both summed
//     along each column and each row, which is all a window that slides
//     along one axis needs. The color only helps tell a cut between two
//     pictures of the same brightness.
//
// Nothing here knows about faces or objects: motion stands in for them.

const fs = require("node:fs");
const path = require("node:path");
const { run, failure, refusal, endedBy, openVideo, fromOrigin, shownPicture } = require("./ffmpeg");

const LONG_SIDE = 128;

// Both sides even, for the color at half size.
function gridOf(width, height) {
  const even = (n) => 2 * Math.round(n / 2);
  if (width >= height) return { gw: LONG_SIDE, gh: Math.max(8, even((LONG_SIDE * height) / width)) };
  return { gw: Math.max(8, even((LONG_SIDE * width) / height)), gh: LONG_SIDE };
}

// Frames a second for the gray copies: ten, five past twenty minutes and
// two and a half past an hour, so that a long video holds in memory.
const analysisFps = (duration) => (duration > 3600 ? 2.5 : duration > 1200 ? 5 : 10);

// Every line of a file ffmpeg wrote, a megabyte at a time, so the log of a
// long video is never held whole.
function eachLine(file, fn) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(1 << 20);
    let rest = "";
    for (;;) {
      const got = fs.readSync(fd, buf, 0, buf.length, null);
      if (got <= 0) break;
      const text = rest + buf.toString("latin1", 0, got);
      let from = 0;
      for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", from)) {
        fn(text.slice(from, nl));
        from = nl + 1;
      }
      rest = text.slice(from);
    }
    if (rest) fn(rest);
  } finally {
    fs.closeSync(fd);
  }
}

// The frames the metadata filter printed to a file: `frame(t)` at each
// frame, then `value(key, number)` for each of its values.
function eachFrame(file, frame, value = () => {}) {
  eachLine(file, (line) => {
    if (line.startsWith("frame:")) {
      const at = line.indexOf("pts_time:");
      frame(at >= 0 ? parseFloat(line.slice(at + 9)) : NaN);
    } else if (line.startsWith("lavfi.")) {
      const eq = line.indexOf("=");
      if (eq > 6) value(line.slice(6, eq), Number(line.slice(eq + 1)));
    }
  });
}

// scdet's numbers for every frame, in typed arrays: its time `t`, its mean
// difference from the frame before (`mafd`) and its `score`. Given a list
// of { t, "scd.mafd", "scd.score" }, as the tests give them, the file
// scdet wrote, or these arrays already.
function scoresOf(list) {
  if (!Array.isArray(list) && list && list.t instanceof Float64Array) return list;
  if (typeof list === "string") {
    const t = [];
    const mafd = [];
    const score = [];
    eachFrame(
      list,
      (at) => {
        t.push(at);
        mafd.push(0);
        score.push(0);
      },
      (key, n) => {
        if (key === "scd.mafd") mafd[mafd.length - 1] = n || 0;
        else if (key === "scd.score") score[score.length - 1] = n || 0;
      },
    );
    return { length: t.length, t: Float64Array.from(t), mafd: Float64Array.from(mafd), score: Float64Array.from(score) };
  }
  const n = list.length;
  const out = { length: n, t: new Float64Array(n), mafd: new Float64Array(n), score: new Float64Array(n) };
  list.forEach((f, i) => {
    out.t[i] = f.t;
    out.mafd[i] = f["scd.mafd"] || 0;
    out.score[i] = f["scd.score"] || 0;
  });
  return out;
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

function meanDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// The share of cells that changed by more than `by` between two copies.
function shareChanged(a, b, by) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > by) n++;
  return n / a.length;
}

// The small copies on either side of a moment, the last one at least 0.06
// s before it and the first one `after` seconds or more after it: their
// brightness, then their colors.
function sidesOf(frames, t, after = 0.15) {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < t - 0.06 + 1e-9) lo = mid + 1;
    else hi = mid;
  }
  const before = frames[lo - 1];
  let k = lo;
  while (k < frames.length && frames[k].t < t + after - 1e-9) k++;
  const next = frames[k];
  return before && next && before.tiny && next.tiny ? [before.tiny, next.tiny, before.tinyColor, next.tinyColor] : null;
}

// Whether a cell of two tiny copies changed by more than `by`, in its
// brightness or either of its colors.
function shareChangedColor(a, b, ca, cb, by) {
  if (!ca || !cb) return shareChanged(a, b, by);
  const n = a.length;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(a[i] - b[i]) > by || Math.abs(ca[i] - cb[i]) > by || Math.abs(ca[n + i] - cb[n + i]) > by) changed++;
  }
  return changed / n;
}

// Hard cuts in scdet's scores: a frame that scores 2.5 or more (of 100)
// and three times its neighbours. A cut between two pictures of about the
// same brightness and color scores low (two dark shots, two takes of one
// scene, as video models make), so the floor is low. Under 10, where
// something small jumping across a still picture can score as much, the
// copies on either side have to differ over a third of the picture.
//
// scdet scores how much the mean difference between frames changes, so
// a fade or a camera move scores only where it starts; its mean
// difference then holds for the frames after, where a cut's falls back.
// Such a start, scoring under 10, is no cut (the dissolve test reads
// fades). A jump of 10 or more is a cut even when the difference holds
// after it, as after a cut into fast motion (sped up footage, a whip pan,
// a drone), whose frames change about as much as the cut. Nor is a flash,
// a picture that turns and comes back within a quarter second (FLASH):
// the frames after the jump change about as much again, all at once where
// a white frame ends or over a few frames where a camera flash fades, and
// the pictures before and after it are alike in brightness and color. The
// frames up to where it came back belong to the flash, and so do those
// just after, whose picture is the one from before the flash. Cuts closer
// than a quarter second are one. Returns { cuts, flashes }.
const FLASH = 0.25;

// Whether two small copies, given as sidesOf gives them, show about the
// same picture: their brightness, and their colors when they have them.
const alike = (sides) => Boolean(sides) && meanDiff(sides[0], sides[1]) < 6 && (!sides[2] || !sides[3] || meanDiff(sides[2], sides[3]) < 6);

function detectCuts(list, frames = []) {
  const found = [];
  const flashes = [];
  const scd = scoresOf(list);
  const { t: T, mafd: M, score: S } = scd;
  const n = scd.length;
  // The last flash: where the picture came back, and the picture before it.
  let flash = null;
  // From the third frame: the second one's score is all of its difference
  // from the first, as scdet has no difference before it to compare, so a
  // video that moves from its start would score a jump there.
  for (let i = 2; i < n; i++) {
    const s = S[i];
    if (s < 2.5) continue;
    const t = T[i];
    const sides = sidesOf(frames, t);
    if (flash && t <= flash.end + 1e-9) continue;
    if (flash && t <= flash.end + 0.15 && sides && alike([flash.before[0], sides[1], flash.before[1], sides[3]])) continue;
    const around = [...S.subarray(Math.max(1, i - 4), i), ...S.subarray(i + 1, i + 5)];
    if (s < 3 * Math.max(0.3, median(around))) continue;
    const mafd = M[i] || s;
    const after = [...M.subarray(i + 1, i + 4)];
    if (s < 10 && after.length === 3 && after.every((m) => m >= 0.7 * mafd)) continue;
    // Where the picture comes back: the frame by which the frames after
    // this one, within a quarter second (the next three at a low frame
    // rate), have changed by half as much as this one, counting only what
    // each changed above the frames before the jump.
    const base = median([...M.subarray(Math.max(1, i - 4), i)]);
    let back = -1;
    if (mafd > base) {
      let sum = 0;
      for (let j = i + 1; j < n && (j <= i + 3 || T[j] <= t + FLASH + 1e-9); j++) {
        sum += Math.max(0, M[j] - base);
        if (sum >= 0.5 * (mafd - base)) {
          back = j;
          break;
        }
      }
    }
    if (back >= 0) {
      const across = sidesOf(frames, t, T[back] - t + 0.15);
      if (alike(across)) {
        flashes.push(t);
        flash = { end: T[back], before: [across[0], across[2]] };
        continue;
      }
    }
    if (s < 10 && sides && shareChangedColor(sides[0], sides[1], sides[2], sides[3], 2) < 0.33) continue;
    found.push({ at: t, score: Math.round(s * 10) / 10 });
  }
  const cuts = [];
  for (const c of found) {
    const last = cuts[cuts.length - 1];
    if (last && c.at - last.at < 0.25) {
      if (c.score > last.score) Object.assign(last, c);
    } else cuts.push({ ...c });
  }
  return { cuts, flashes };
}

// Dissolves and fades, which scdet does not see as cuts: a moment where
// the picture a third of a second before and the one a third of a second
// after differ far more than the picture changes within either side.
// That finds a dissolve of up to about half a second. A longer one
// changes each side by about as much as it changes across, so the same
// is asked again 0.6 s and 1 s either side, which finds dissolves of up
// to about two seconds; there most of the picture has to change (so that
// something coming into a still picture and staying is not taken for
// one), and a cut or a shorter dissolve found near is the same change,
// seen over a longer stretch. When one frame carries that change (of the
// frames' mean differences around it, above their median, it holds at
// least half), it is a hard cut the cut test missed, and is returned as
// one, on that frame; a dissolve spreads its change over its frames.
// Returns { dissolves, cuts }, each [{ at, score }], a dissolve at the
// middle of its change.
//
// A change of light is no dissolve: a lamp coming up, a camera's exposure
// settling or the sun coming out changes every cell, but leaves one
// picture a brightening of the other. So the picture after is brought to
// the light of the one before, its mean brightness and its spread made
// the same, before the two are compared. A plain ground (a title card's
// color, black) has only its brightness to tell a change by, and is
// compared as it is.
const DISSOLVE_GAPS = [0.3, 0.6, 1];
// The spread of brightness, on 0 to 255, under which a tiny copy is a
// plain ground.
const PLAIN = 8;

function lightOf(tiny) {
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < tiny.length; i++) {
    sum += tiny[i];
    squares += tiny[i] * tiny[i];
  }
  const mean = sum / Math.max(1, tiny.length);
  return { mean, spread: Math.sqrt(Math.max(0, squares / Math.max(1, tiny.length) - mean * mean)) };
}

// `b` in the light of `a`, given each one's lightOf.
function inLightOf(b, lb, la) {
  if (la.spread < PLAIN || lb.spread < PLAIN) return b;
  const k = la.spread / lb.spread;
  const out = new Float32Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = (b[i] - lb.mean) * k + la.mean;
  return out;
}

function detectDissolves(frames, fps, hard, list = []) {
  const dissolves = [];
  const cuts = [];
  const scd = scoresOf(list);
  const { t: T, mafd: M, score: S } = scd;
  const light = frames.map((f) => lightOf(f.tiny));
  // The indices of scdet's frames within `r` seconds of `at`.
  const within = (at, r) => {
    let lo = 0;
    let hi = scd.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (T[mid] < at - r) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < scd.length && T[i] <= at + r; i++) out.push(i);
    return out;
  };
  for (const seconds of DISSOLVE_GAPS) {
    const gap = Math.max(1, Math.round(fps * seconds));
    const long = seconds > 0.3;
    // How far from a cut or a dissolve found already this change is that
    // one again, and how far around its middle the frames are read.
    const reach = seconds + 0.3;
    const scores = new Array(frames.length).fill(0);
    for (let k = 2 * gap; k + 2 * gap < frames.length; k++) {
      const far = inLightOf(frames[k + gap].tiny, light[k + gap], light[k - gap]);
      const across = meanDiff(frames[k - gap].tiny, far);
      if (across < 12) continue;
      if (long && shareChanged(frames[k - gap].tiny, far, 8) < 0.5) continue;
      const before = meanDiff(frames[k - gap].tiny, frames[k - 2 * gap].tiny);
      const after = meanDiff(frames[k + gap].tiny, frames[k + 2 * gap].tiny);
      scores[k] = across / (Math.max(before, after) + 2);
    }
    const radius = Math.round(fps * Math.max(0.8, 1.5 * seconds));
    for (let k = 0; k < frames.length; k++) {
      if (scores[k] < 4) continue;
      // The highest score within 0.8 s on either side, more for the
      // longer stretches.
      let top = true;
      for (let j = Math.max(0, k - radius); j <= Math.min(frames.length - 1, k + radius); j++) {
        if (scores[j] > scores[k] || (scores[j] === scores[k] && j < k)) top = false;
      }
      if (!top) continue;
      // A step the copies see whole gives one score over several of them:
      // its middle is the middle of that run. Over the longer stretches
      // a dissolve scores about as high for a while around its middle:
      // the run of scores within a tenth of the highest.
      let first = k;
      let last = k;
      const holds = (j) => (long ? scores[j] >= 0.9 * scores[k] : scores[j] === scores[k]);
      if (long) while (first - 1 >= 0 && holds(first - 1)) first--;
      while (last + 1 < frames.length && holds(last + 1)) last++;
      const at = frames[Math.round((first + last) / 2)].t;
      if (hard.some((c) => Math.abs(c.at - at) < (long ? reach : 0.5))) continue;
      if (long && [...dissolves, ...cuts].some((c) => Math.abs(c.at - at) < reach)) continue;
      const near = within(at, long ? seconds + 0.1 : 0.4);
      if (near.length >= 3) {
        const peak = near.reduce((a, b) => (M[b] > M[a] ? b : a));
        const base = median(near.map((i) => M[i]));
        const excess = near.reduce((sum, i) => sum + Math.max(0, M[i] - base), 0);
        if (M[peak] - base > 0.2 && M[peak] - base >= 0.5 * excess) {
          if (!cuts.some((c) => Math.abs(c.at - T[peak]) < 0.25)) cuts.push({ at: T[peak], score: Math.round(S[peak] * 10) / 10 });
          continue;
        }
      }
      dissolves.push({ at, score: Math.round(scores[k] * 10) / 10 });
    }
  }
  dissolves.sort((a, b) => a.at - b.at);
  cuts.sort((a, b) => a.at - b.at);
  return { dissolves, cuts };
}

// The shift of a profile, in cells, that best lines it up with the one
// after it: b[i + s] is a[i].
function shiftOf(a, b, max) {
  let best = 0;
  let bestErr = Infinity;
  for (let s = -max; s <= max; s++) {
    let err = 0;
    let n = 0;
    for (let i = Math.max(0, -s); i < a.length && i + s < b.length; i++) {
      err += Math.abs(a[i] - b[i + s]);
      n++;
    }
    err /= Math.max(1, n);
    if (err < bestErr - 1e-9) {
      bestErr = err;
      best = s;
    }
  }
  return best;
}

// Whether the camera moved between two small frames: the whole picture
// shifted, so that shifting the one before explains most of the change.
// A pan or a scrolled page does; something moving in front of a still
// background does not.
function cameraMoved(prev, now, prevCols, nowCols, prevRows, nowRows, gw, gh) {
  const sx = shiftOf(prevCols, nowCols, 8);
  const sy = shiftOf(prevRows, nowRows, 5);
  if (!sx && !sy) return false;
  let shifted = 0;
  let still = 0;
  let n = 0;
  for (let y = Math.max(0, -sy); y < gh && y + sy < gh; y++) {
    for (let x = Math.max(0, -sx); x < gw && x + sx < gw; x++) {
      const before = prev[y * gw + x];
      shifted += Math.abs(now[(y + sy) * gw + x + sx] - before);
      still += Math.abs(now[y * gw + x] - before);
      n++;
    }
  }
  if (!n || still / n < 2) return false;
  return shifted < 0.6 * still;
}

// The bars cropdetect found, in shown pixels, kept only when they look
// like bars: black from start to end (the gray copies agree), at least 2%
// of the side, and about as deep on both sides. Returns the picture inside
// them, or null.
function barsOf(crop, { width, height, maxLuma, gw, gh }) {
  if (!crop || !(crop.x2 > crop.x1) || !(crop.y2 > crop.y1)) return null;
  const x1 = crop.x1;
  const x2 = crop.x2 + 1;
  const y1 = crop.y1;
  const y2 = crop.y2 + 1;
  const top = y1;
  const bottom = height - y2;
  const left = x1;
  const right = width - x2;
  const pair = (a, b, side) => a >= 0.02 * side && b >= 0.02 * side && Math.abs(a - b) <= 0.04 * side;
  const rows = pair(top, bottom, height);
  const cols = pair(left, right, width);
  if (!rows && !cols) return null;
  // Every cell of the gray copies wholly inside a bar stayed dark.
  const dark = (cx0, cx1, cy0, cy1) => {
    for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) if (maxLuma[y * gw + x] > 24) return false;
    return true;
  };
  const cell = (px, side, n) => (px / side) * n;
  if (rows && !(dark(0, gw, 0, Math.floor(cell(top, height, gh))) && dark(0, gw, Math.ceil(cell(height - bottom, height, gh)), gh))) return null;
  if (cols && !(dark(0, Math.floor(cell(left, width, gw)), 0, gh) && dark(Math.ceil(cell(width - right, width, gw)), gw, 0, gh))) return null;
  const even = (n) => 2 * Math.round(n / 2);
  const x = cols ? even(left) : 0;
  const y = rows ? even(top) : 0;
  const w = cols ? even(width - left - right) : width;
  const h = rows ? even(height - top - bottom) : height;
  if (w < 0.3 * width || h < 0.3 * height) return null;
  return { x, y, w, h };
}

// Whether the notes ffmpeg wrote as it read the picture stop short of
// all it read. A disk or a quota that fills up stops them there, and
// ffmpeg still ends well, so a plan would be made from part of the video:
// fewer and longer shots, and no word of it. They are whole when scdet
// scored as many frames as ffmpeg counted out of it (-progress gives the
// count of the first output, scdet's), when every small frame that came
// through the pipe has its time, and when cropdetect's last word is
// within a second of the last small frame (it speaks twice a second, from
// a second in).
function cutShort({ scores, counted, piped, times, cropLast }) {
  if (counted !== null && scores < counted) return true;
  if (times.length < piped) return true;
  const last = times.length ? times[times.length - 1] : 0;
  const first = times.length ? times[0] : 0;
  return cropLast === null ? last - first >= 1.5 : cropLast < last - 1;
}

// A picture that lasts less than a fifth of a second under a sound that
// goes on, as ffmpeg makes of a cover and a talk without -loop 1, which a
// container can leave unsaid: a WebM or a Matroska file from another
// muxer than ffmpeg's states no length for its picture. What scdet scored
// tells it: { frames, seconds } of the picture, or null for one that is
// longer, or that has no frame at all. ffmpeg 8 fails such a reading, as
// its fps filters get no frame, and 4.4 reads a frame or none.
function briefPicture(scd, info) {
  if (!info.audio || !(info.duration > 0.2) || !scd.length) return null;
  const frame = info.video.fps > 0 ? 1 / info.video.fps : 0.04;
  const seconds = scd.length ? scd.t[scd.length - 1] - scd.t[0] + frame : 0;
  return seconds < 0.2 ? { frames: scd.length, seconds } : null;
}

// The frames of the first output that -progress counted, from its last
// block, or null when there is none.
function countedFrames(stderr) {
  const end = stderr.lastIndexOf("progress=end");
  if (end < 0) return null;
  const counts = [...stderr.slice(0, end).matchAll(/^frame=(\d+)\r?$/gm)];
  return counts.length ? Number(counts[counts.length - 1][1]) : null;
}

// The pass. Returns the cuts, the bars and, for every gray copy, its time
// and its column and row sums of motion and of detail. `shown` names the
// output folder, where the notes go, in an error.
async function analyze(file, info, { work, log = () => {}, name = path.basename(file), shown = work }) {
  const v = info.video;
  const W = v.displayWidth;
  const H = v.displayHeight;
  const { gw, gh } = gridOf(W, H);
  const fps = analysisFps(info.duration);
  const cells = gw * gh;
  // Every frame at the size it is shown, so a picture that changes size
  // or format part way comes to each branch as the first frames did, and
  // cropdetect counts in shown pixels.
  const graph = [
    `[0:${v.index}]setpts=PTS-${fromOrigin(info)}/TB,${shownPicture(info)},split=3[a][b][c]`,
    `[a]scale=320:-2,format=gbrp,scdet=threshold=100,metadata=mode=print:file=scd.txt[ao]`,
    `[b]fps=${fps},scale=${gw}:${gh}:flags=area:out_range=full,format=yuv420p,metadata=mode=add:key=rk:value=1,metadata=mode=print:file=grid.txt[bo]`,
    `[c]fps=2,cropdetect=limit=0.07:round=2:reset=0,metadata=mode=print:file=crop.txt[co]`,
  ].join(";");

  // A frame as it comes: the brightness, then the two colors at half size.
  const half = (gw / 2) * (gh / 2);
  const frameBytes = cells + 2 * half;
  const frames = [];
  // What is kept of each frame sits in one stretch of a buffer shared by
  // 256 of them, so that the thousands of a long video take few
  // allocations: the sums of detail and of motion along its columns and
  // rows, then its tiny copy, a quarter of its size, and that copy's
  // colors.
  const tw = Math.max(1, gw >> 2);
  const th = Math.max(1, gh >> 2);
  const floats = 2 * (gw + gh);
  const stretch = 8 * Math.ceil((4 * floats + 3 * tw * th) / 8);
  let pool = null;
  let pooled = 256;
  const slot = () => {
    if (pooled === 256) {
      pool = new ArrayBuffer(256 * stretch);
      pooled = 0;
    }
    return pooled++ * stretch;
  };
  const maxLuma = new Uint8Array(cells);
  let prev = null;
  let prevCols = null;
  let prevRows = null;
  let pending = Buffer.alloc(0);
  const hist = new Uint32Array(256);
  const diff = new Uint8Array(cells);
  const take = (frame) => {
    const g = frame.subarray(0, cells);
    const at = slot();
    // Detail: how much each cell differs from its right and lower
    // neighbours.
    const detailCols = new Float32Array(pool, at, gw);
    const detailRows = new Float32Array(pool, at + 4 * gw, gh);
    let detail = 0;
    let luma = 0;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const here = g[i];
        luma += here;
        if (here > maxLuma[i]) maxLuma[i] = here;
        const dx = x + 1 < gw ? Math.abs(g[i + 1] - here) : x > 0 ? Math.abs(here - g[i - 1]) : 0;
        const dy = y + 1 < gh ? Math.abs(g[i + gw] - here) : y > 0 ? Math.abs(here - g[i - gw]) : 0;
        const d = dx + dy;
        detailCols[x] += d;
        detailRows[y] += d;
        detail += d;
      }
    }
    const entry = { motionCols: null, motionRows: null, energy: 0, detailCols, detailRows, detail, luma: luma / cells };
    // Mean brightness along each column and row, to find a camera's move.
    const lumaCols = new Float64Array(gw);
    const lumaRows = new Float64Array(gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        lumaCols[x] += g[y * gw + x] / gh;
        lumaRows[y] += g[y * gw + x] / gw;
      }
    }
    if (prev) {
      entry.camera = cameraMoved(prev, g, prevCols, lumaCols, prevRows, lumaRows, gw, gh);
      hist.fill(0);
      for (let i = 0; i < cells; i++) {
        const d = Math.abs(g[i] - prev[i]);
        diff[i] = d;
        hist[d]++;
      }
      // The noise floor: what a still cell changes by (compression, grain),
      // above the median change, so a picture that moves all over (a pan)
      // keeps only what moves most.
      let seen = 0;
      let median = 0;
      for (let k = 0; k < 256; k++) {
        seen += hist[k];
        if (seen >= cells / 2) {
          median = k;
          break;
        }
      }
      const floor = Math.max(3, median * 1.5);
      const motionCols = new Float32Array(pool, at + 4 * (gw + gh), gw);
      const motionRows = new Float32Array(pool, at + 4 * (2 * gw + gh), gh);
      let energy = 0;
      let moving = 0;
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          const raw = diff[y * gw + x];
          // How many cells changed at all, to tell a camera that moves
          // (most of the picture changes) from something moving in it.
          if (raw > 6) moving++;
          const d = raw - floor;
          if (d <= 0) continue;
          motionCols[x] += d;
          motionRows[y] += d;
          energy += d;
        }
      }
      Object.assign(entry, { motionCols, motionRows, energy, median, moving });
    }
    // A quarter size copy, kept for finding dissolves afterwards.
    const tiny = new Uint8Array(pool, at + 4 * floats, tw * th);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        let sum = 0;
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) sum += g[Math.min(gh - 1, y * 4 + dy) * gw + Math.min(gw - 1, x * 4 + dx)];
        tiny[y * tw + x] = sum >> 4;
      }
    }
    entry.tiny = tiny;
    // The colors at the same tiny size, each cell from 2 by 2 of theirs.
    const cw = gw / 2;
    const ch = gh / 2;
    const tinyColor = new Uint8Array(pool, at + 4 * floats + tw * th, 2 * tw * th);
    for (let plane = 0; plane < 2; plane++) {
      const from = cells + plane * half;
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          let sum = 0;
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) sum += frame[from + Math.min(ch - 1, y * 2 + dy) * cw + Math.min(cw - 1, x * 2 + dx)];
          tinyColor[plane * tw * th + y * tw + x] = sum >> 2;
        }
      }
    }
    entry.tinyColor = tinyColor;
    frames.push(entry);
    prev = Uint8Array.from(g);
    prevCols = lumaCols;
    prevRows = lumaRows;
  };

  const r = await run(["-hide_banner", "-nostdin", "-nostats", "-v", "error", "-progress", "pipe:2", ...openVideo(info, file), "-an", "-sn", "-dn", "-filter_complex", graph, "-map", "[ao]", "-f", "null", "-", "-map", "[co]", "-f", "null", "-", "-map", "[bo]", "-f", "rawvideo", "pipe:1"], {
    cwd: work,
    onStdout: (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        take(pending.subarray(0, frameBytes));
        pending = pending.subarray(frameBytes);
      }
    },
  });
  // What ffmpeg said, without the lines -progress writes among them.
  const said = r.stderr
    .split(/\r?\n/)
    .filter((line) => !/^\w+=/.test(line))
    .join("\n");
  // A brief picture (briefPicture()) is refused with what it is, in place
  // of what ffmpeg 8 says of the outputs its fps filters left empty.
  const brief = (scd) => {
    const b = briefPicture(scd, info);
    return b ? Object.assign(new Error(`${name} holds a brief picture under a longer sound`), { brief: b }) : null;
  };
  if (r.code !== 0) {
    if (!r.signal && /Nothing was written into output file/.test(said) && !refusal(said)) {
      const scored = scoresOf(path.join(work, "scd.txt"));
      const b = brief(scored);
      if (b) throw b;
      // ffmpeg 8 fails as well on a picture of no frame it could decode.
      if (!scored.length) throw new Error(`${name} has no frame ffmpeg could decode`);
    }
    throw Object.assign(new Error(`Reading the picture failed: ${r.signal ? `ffmpeg ${endedBy(r.signal)}` : failure(said) || `ffmpeg exited with ${r.code}`}`), { refused: r.signal ? null : refusal(said) });
  }
  const times = [];
  eachFrame(path.join(work, "grid.txt"), (t) => times.push(t));
  frames.forEach((f, i) => {
    f.t = i < times.length ? times[i] : i / fps;
  });
  const scd = scoresOf(path.join(work, "scd.txt"));
  // cropdetect's last word, which has seen the whole video.
  let lastCrop = null;
  let cropLast = null;
  eachFrame(
    path.join(work, "crop.txt"),
    (t) => {
      lastCrop = {};
      cropLast = t;
    },
    (key, n) => {
      if (lastCrop) lastCrop[key] = n;
    },
  );
  if (cutShort({ scores: scd.length, counted: countedFrames(r.stderr), piped: frames.length, times, cropLast })) {
    throw new Error(`Reading the picture failed: the notes ffmpeg wrote on it in ${shown} stop short of its end, as when the disk or the quota is full`);
  }
  const crop = lastCrop ? { x1: lastCrop["cropdetect.x1"], x2: lastCrop["cropdetect.x2"], y1: lastCrop["cropdetect.y1"], y2: lastCrop["cropdetect.y2"] } : null;
  // cropdetect counts in the shown frame's pixels, which the graph made
  // square.
  const picture = barsOf(crop, { width: W, height: H, maxLuma, gw, gh });
  for (const told of ["grid.txt", "scd.txt", "crop.txt"]) fs.rmSync(path.join(work, told), { force: true });
  const short = brief(scd);
  if (short) throw short;
  if (!frames.length) throw new Error(`${name} has no frame ffmpeg could decode`);
  const { cuts: hard, flashes } = detectCuts(scd, frames);
  const { dissolves, cuts: seen } = detectDissolves(frames, fps, hard, scd);
  log(`Read ${frames.length} small frames, ${scd.length} scores`);
  return {
    width: W,
    height: H,
    gw,
    gh,
    fps,
    frames,
    cuts: [...hard, ...seen].sort((a, b) => a.at - b.at),
    dissolves,
    flashes,
    scores: scd.length,
    picture,
    lastFrameTime: scd.length ? scd.t[scd.length - 1] : info.duration,
  };
}

module.exports = { analyze, detectCuts, detectDissolves, barsOf, gridOf, analysisFps, cameraMoved, shiftOf, cutShort, countedFrames, briefPicture };
