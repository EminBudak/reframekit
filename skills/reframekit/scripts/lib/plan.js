"use strict";

// The plan: the shots, and for every shot and shape the window a place's
// video is cut from. A window follows what moves in its shot, holds still
// while that stays inside it, and moves in eased glides when it does not.
// Where what moves spreads wider than the window, so a crop would cut part
// of it off, the shot is padded instead: the whole picture, smaller, on a
// blurred copy of itself or a color. The plan is crop.json, which a person
// or an agent can edit and render again.

const { shapeOf } = require("./places");

const even = (n) => 2 * Math.round(n / 2);
const r3 = (x) => Math.round(x * 1000) / 1000;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Below this mean motion a cell changes by on a 0 to 255 scale (above
// the noise floor) per tenth of a second, a shot counts as still.
const STILL = 0.12;
// A shot whose window would keep less than this share of what moves, while
// what moves is wider than the window and the camera holds still, is
// padded instead of cropped.
const KEEP = 0.9;
// Moving the window costs this much for the whole range, plus a fixed
// amount for each move, against losing what moves (1 for all of it for a
// tenth of a second).
const MOVE_RANGE = 1.5;
const MOVE_EACH = 0.4;
// What it costs, for a tenth of a second, to have the middle of what moves
// a whole window away from the window's middle (half that for half a
// window).
const CENTER = 0.24;
// What moves within this share of the window's length from its edges
// counts as half out.
const MARGIN = 0.04;

// ─── shots ─────────────────────────────────────────────────────────────────

// The shots between the cuts, the first from 0. A shot shorter than 0.4 s
// (a flash frame, two cuts found for one) joins the one before it.
function shotsOf(duration, cuts) {
  const sorted = [...cuts].filter((c) => c.at > 0.05 && c.at < duration - 0.05).sort((a, b) => a.at - b.at);
  const starts = [{ at: 0, span: 0, from: "start" }];
  // Two cuts this close are one: a given one (or a kit's) wins over a hard
  // cut found in the picture, and that over a dissolve.
  const rank = (c) => ({ start: 4, picture: 2, dissolve: 1 })[c.from] || 3;
  for (const c of sorted) {
    const last = starts[starts.length - 1];
    if (c.at - last.at < 0.4) {
      if (rank(c) > rank(last)) Object.assign(last, c);
      continue;
    }
    starts.push({ ...c });
  }
  if (starts.length > 1 && duration - starts[starts.length - 1].at < 0.4) starts.pop();
  return starts.map((s, i) => ({
    n: i + 1,
    start: r3(s.at),
    end: r3(i + 1 < starts.length ? starts[i + 1].at : duration),
    cut: s.from,
    fade: r3(s.span || 0),
  }));
}

// ─── geometry ──────────────────────────────────────────────────────────────

// The biggest window of a shape inside the picture, and how it can slide:
// along x when the picture is wider than the shape, along y when it is
// taller, not at all when they are the same shape.
function windowOf(picture, width, height) {
  const want = width / height;
  const has = picture.w / picture.h;
  if (Math.abs(has - want) / want < 0.01) return { axis: null, w: picture.w, h: picture.h, x: picture.x, y: picture.y };
  if (has > want) {
    const w = Math.min(picture.w, even(picture.h * want));
    return { axis: "x", w, h: picture.h, x: picture.x, y: picture.y, lo: picture.x, hi: picture.x + picture.w - w };
  }
  const h = Math.min(picture.h, even(picture.w / want));
  return { axis: "y", w: picture.w, h, x: picture.x, y: picture.y, lo: picture.y, hi: picture.y + picture.h - h };
}

// ─── paths ─────────────────────────────────────────────────────────────────

// Monotone cubic interpolation through keyframes (Fritsch and Carlson),
// at rest at the first and the last: two keyframes ease from one to the
// other, a run of equal ones holds, and many close ones follow smoothly.
function pchip(keys) {
  const n = keys.length;
  if (n === 1) return () => keys[0][1];
  const t = keys.map((k) => k[0]);
  const y = keys.map((k) => k[1]);
  const h = [];
  const s = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(Math.max(1e-6, t[i + 1] - t[i]));
    s.push((y[i + 1] - y[i]) / h[i]);
  }
  const m = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (s[i - 1] * s[i] <= 0) continue;
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / s[i - 1] + w2 / s[i]);
  }
  return (at) => {
    if (at <= t[0]) return y[0];
    if (at >= t[n - 1]) return y[n - 1];
    let i = 0;
    let lo = 0;
    let hi = n - 2;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= at) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const u = (at - t[i]) / h[i];
    const u2 = u * u;
    const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * y[i] + (u3 - 2 * u2 + u) * h[i] * m[i] + (-2 * u3 + 3 * u2) * y[i + 1] + (u3 - u2) * h[i] * m[i + 1];
  };
}

// The few keyframes that redraw a path within a pixel and a half: each
// round adds, between every two keyframes, the sample furthest off.
function keyframesOf(fn, start, end) {
  const step = 0.04;
  const samples = [];
  for (let t = start; t < end - step / 2; t += step) samples.push([t, fn(t)]);
  samples.push([end, fn(end)]);
  if (samples.length === 1) return [samples[0]];
  let keyIndex = [0, samples.length - 1];
  for (let round = 0; round < 60; round++) {
    const f = pchip(keyIndex.map((i) => samples[i]));
    const added = [];
    for (let k = 0; k + 1 < keyIndex.length; k++) {
      let worst = 1.5;
      let at = -1;
      for (let i = keyIndex[k] + 1; i < keyIndex[k + 1]; i++) {
        const e = Math.abs(f(samples[i][0]) - samples[i][1]);
        if (e > worst) {
          worst = e;
          at = i;
        }
      }
      if (at >= 0) added.push(at);
    }
    if (!added.length) break;
    keyIndex = [...keyIndex, ...added].sort((a, b) => a - b);
  }
  return keyIndex.map((i) => samples[i]);
}

const smoothstep = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

// The share of a profile inside [a, b) pixels, from its running sum.
function sums(profile, cellSize) {
  const cum = new Float64Array(profile.length + 1);
  for (let i = 0; i < profile.length; i++) cum[i + 1] = cum[i] + profile[i];
  const at = (px) => {
    const c = clamp(px / cellSize, 0, profile.length);
    const i = Math.min(profile.length - 1, Math.floor(c));
    return cum[i] + (c - i) * profile[i];
  };
  return { total: cum[profile.length], inside: (a, b) => at(b) - at(a) };
}

// The width of the smallest stretch holding 90% of a profile, in cells.
function spreadOf(profile, share = 0.9) {
  const total = profile.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return profile.length;
  const need = total * share;
  let best = profile.length;
  let sum = 0;
  let lo = 0;
  for (let hi = 0; hi < profile.length; hi++) {
    sum += profile[hi];
    while (lo <= hi && sum - profile[lo] >= need) sum -= profile[lo++];
    if (sum >= need) best = Math.min(best, hi - lo + 1);
  }
  return best;
}

// One shot, one shape: where its window goes over time.
//
// The windows considered sit every few pixels along the free axis. A
// dynamic program picks one for each small frame of the shot, paying for
// what moves and falls outside it and for each move, so the window holds
// still until holding costs more than moving. Each move then becomes an
// eased glide, longer for a longer way.
function follow(shot, geo, data, { presses = [], box = null, afps = 10 } = {}) {
  const { axis, w, h } = geo;
  const along = axis === "x" ? data.width : data.height;
  const cells = axis === "x" ? data.gw : data.gh;
  const cellSize = along / cells;
  const L = axis === "x" ? w : h;
  // The picture's own stretch of the axis (inside bars), and the page's
  // box in a demo when there is one: windows stay within it when they fit.
  let lo = geo.lo;
  let hi = geo.hi;
  if (box) {
    const b0 = axis === "x" ? box.x : box.y;
    const b1 = b0 + (axis === "x" ? box.w : box.h);
    if (b1 - b0 >= L) {
      lo = clamp(Math.ceil(b0), geo.lo, geo.hi);
      hi = clamp(Math.floor(b1 - L), geo.lo, geo.hi);
    }
  }
  const areaFrom = axis === "x" ? data.picture.x : data.picture.y;
  const areaTo = areaFrom + (axis === "x" ? data.picture.w : data.picture.h);
  const center = clamp((areaFrom + areaTo) / 2 - L / 2, lo, hi);
  const range = Math.max(1, hi - lo);
  const N = hi - lo < 1 ? 1 : clamp(Math.round(range / 6) + 1, 2, 161);
  const posOf = (i) => (N === 1 ? lo : lo + (i * range) / (N - 1));

  // The shot's small frames, without the one whose change spans the cut
  // and those inside the fade from the shot before, found by halving, as
  // the frames are in time order and a long video has many shots.
  const from = (t) => {
    let lo = 0;
    let hi = data.frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (data.frames[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const frames = data.frames.slice(from(shot.start + (shot.fade || 0) + 1 / afps - 0.001), from(shot.end - 0.001));
  const used = frames.length ? frames : data.frames.slice(from(shot.start - 0.001), from(shot.end)).slice(0, 1);
  if (!used.length) {
    // No small frame falls in the shot: the window holds in the middle.
    const p = Math.round(center);
    return { mode: "follow", w, h, path: [[shot.start, axis === "x" ? p : geo.x, axis === "x" ? geo.y : p]], keeps: null, spread: null, why: "the shot is too short to read, so it holds in the middle" };
  }
  // Cells outside the picture (bars) count for nothing: a profile with
  // such cells is copied with them at 0, one without is read as it is.
  const outside = [];
  for (let i = 0; i < cells; i++) if ((i + 1) * cellSize <= areaFrom || i * cellSize >= areaTo) outside.push(i);
  const inPicture = (profile) => {
    if (!outside.length) return profile;
    const out = Float32Array.from(profile);
    for (const i of outside) out[i] = 0;
    return out;
  };
  const none = new Float32Array(cells);
  const motionOf = (f) => (f.motionCols ? inPicture(axis === "x" ? f.motionCols : f.motionRows) : none);
  const detailOf = (f) => inPicture(axis === "x" ? f.detailCols : f.detailRows);

  const profiles = used.map(motionOf);
  const detail = new Float64Array(cells);
  for (const f of used) detailOf(f).forEach((v, i) => (detail[i] += v / used.length));
  const D = sums(detail, cellSize);
  const energies = profiles.map((p) => p.reduce((a, b) => a + b, 0));
  const pictureCells = (data.picture.w / data.width) * data.gw * (data.picture.h / data.height) * data.gh;
  const meanMotion = energies.reduce((a, b) => a + b, 0) / Math.max(1, energies.length) / Math.max(1, pictureCells);

  // Where the pointer pressed in a demo counts as something moving there,
  // from a little before the press to a second after.
  const pressAt = presses.filter((p) => p.at >= shot.start && p.at < shot.end);
  if (pressAt.length) {
    const typical = Math.max(1, energies.reduce((a, b) => a + b, 0) / Math.max(1, energies.length));
    used.forEach((f, k) => {
      let own = false;
      for (const p of pressAt) {
        if (f.t < p.at - 0.7 || f.t > p.at + 1) continue;
        // A copy of the frame's motion to add the press to, not the frame's
        // own numbers.
        if (!own) {
          profiles[k] = Float64Array.from(profiles[k]);
          own = true;
        }
        const c = (axis === "x" ? p.x : p.y) / cellSize;
        const sigma = Math.max(1, cells * 0.04);
        let mass = 0;
        const bump = new Float64Array(cells);
        for (let i = 0; i < cells; i++) {
          bump[i] = Math.exp(-0.5 * ((i + 0.5 - c) / sigma) ** 2);
          mass += bump[i];
        }
        const scale = (Math.max(energies[k], typical) * 1.5) / Math.max(1e-9, mass);
        for (let i = 0; i < cells; i++) profiles[k][i] += bump[i] * scale;
        energies[k] = profiles[k].reduce((a, b) => a + b, 0);
      }
    });
  }

  const still = meanMotion < STILL && !pressAt.length;
  const centroidOf = (profile) => {
    let sum = 0;
    let moment = 0;
    for (let i = 0; i < profile.length; i++) {
      sum += profile[i];
      moment += (i + 0.5) * cellSize * profile[i];
    }
    return sum > 0 ? moment / sum : null;
  };
  const detailCentroid = centroidOf(detail);
  const why = [];
  let positions;
  if (still || N === 1) {
    // Nothing moves: the window holds where the picture has the most
    // detail, centered on it when it fits.
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < N; i++) {
      const p = posOf(i);
      const share = D.total > 0 ? D.inside(p, p + L) / D.total : 0;
      const off = detailCentroid === null ? Math.abs(p - center) / range : Math.abs(p + L / 2 - detailCentroid) / L;
      const score = share - 0.1 * off - 0.01 * (Math.abs(p - center) / range);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    positions = used.map(() => best);
    if (still) why.push("nothing moves, so it holds on the part with the most detail");
  } else {
    const perFrame = 10 / afps;
    const mean = energies.filter((e) => e > 0).reduce((a, b) => a + b, 0) / Math.max(1, energies.filter((e) => e > 0).length);
    const a = MOVE_RANGE / Math.max(1, N - 1);
    let cost = new Float64Array(N);
    let next = new Float64Array(N);
    const g = new Float64Array(N);
    const arg = new Int32Array(N);
    const back = used.map(() => new Int16Array(N));
    const frameCost = (k, out) => {
      const S = sums(profiles[k], cellSize);
      const weight = energies[k] > 0 ? Math.min(3, energies[k] / Math.max(1e-9, mean)) * perFrame : 0;
      const middle = weight > 0 ? centroidOf(profiles[k]) : null;
      for (let i = 0; i < N; i++) {
        const p = posOf(i);
        let c = 0;
        if (weight > 0) {
          // What moves and falls outside, and how far its middle is from
          // the window's: a window keeps it whole first, then centered.
          const m = MARGIN * L;
          c += weight * (1 - (S.inside(p, p + L) + S.inside(p + m, p + L - m)) / (2 * S.total));
          c += weight * CENTER * Math.min(1, Math.abs(p + L / 2 - middle) / L);
        }
        // Ties go to detail, then to the middle of the picture.
        if (D.total > 0) c += 0.05 * perFrame * (1 - D.inside(p, p + L) / D.total);
        c += 0.01 * perFrame * (Math.abs(p - center) / range);
        out[i] += c;
      }
    };
    frameCost(0, cost);
    for (let k = 1; k < used.length; k++) {
      // The cheapest way into each window: stay, or move from the best
      // one nearby (an L1 distance transform, both ways).
      g[0] = cost[0];
      arg[0] = 0;
      for (let i = 1; i < N; i++) {
        if (g[i - 1] + a < cost[i]) {
          g[i] = g[i - 1] + a;
          arg[i] = arg[i - 1];
        } else {
          g[i] = cost[i];
          arg[i] = i;
        }
      }
      for (let i = N - 2; i >= 0; i--) {
        if (g[i + 1] + a < g[i]) {
          g[i] = g[i + 1] + a;
          arg[i] = arg[i + 1];
        }
      }
      for (let i = 0; i < N; i++) {
        if (arg[i] === i || cost[i] <= g[i] + MOVE_EACH) {
          next[i] = cost[i];
          back[k][i] = i;
        } else {
          next[i] = g[i] + MOVE_EACH;
          back[k][i] = arg[i];
        }
      }
      frameCost(k, next);
      [cost, next] = [next, cost];
      next.fill(0);
    }
    let end = 0;
    for (let i = 1; i < N; i++) if (cost[i] < cost[end]) end = i;
    positions = new Array(used.length);
    positions[used.length - 1] = end;
    for (let k = used.length - 1; k > 0; k--) positions[k - 1] = back[k][positions[k]];
  }

  // The moves as eased glides around the frames where the program moved.
  const first = posOf(positions[0]);
  const moves = [];
  for (let k = 1; k < positions.length; k++) {
    if (positions[k] === positions[k - 1]) continue;
    const delta = posOf(positions[k]) - posOf(positions[k - 1]);
    moves.push({ at: (used[k - 1].t + used[k].t) / 2, delta, d: clamp(0.35 + (1.0 * Math.abs(delta)) / range, 0.35, 1.3) });
  }
  const path = (t) => {
    let p = first;
    for (const m of moves) p += m.delta * smoothstep((t - m.at) / m.d + 0.5);
    return clamp(p, lo, hi);
  };
  const keys = keyframesOf(path, shot.start, shot.end).map(([t, p]) => (axis === "x" ? [r3(t), Math.round(p), geo.y] : [r3(t), geo.x, Math.round(p)]));

  // How much of what moves the window keeps, how wide what moves is (the
  // stretch holding 90% of it), and how much of the picture changes at
  // all: a camera that moves changes most of it.
  let kept = 0;
  let all = 0;
  const spreads = [];
  const areaLen = Math.max(1, areaTo - areaFrom);
  used.forEach((f) => {
    const raw = motionOf(f);
    const S = sums(raw, cellSize);
    if (!(S.total > 0)) return;
    const p = path(f.t);
    kept += S.inside(p, p + L);
    all += S.total;
    spreads.push({ s: (spreadOf(raw) * cellSize) / areaLen, c: (f.moving || 0) / Math.max(1, pictureCells), m: f.camera ? 1 : 0, e: S.total });
  });
  const weightedMedian = (key) => {
    const sorted = [...spreads].sort((x, y) => x[key] - y[key]);
    const half = sorted.reduce((a, b) => a + b.e, 0) / 2;
    let acc = 0;
    for (const s of sorted) {
      acc += s.e;
      if (acc >= half) return s[key];
    }
    return null;
  };
  const share = L / areaLen;
  const p0 = path(shot.start);
  const detailKeeps = D.total > 0 ? D.inside(p0, p0 + L) / D.total : 1;
  const keeps = all > 0 ? kept / all : detailKeeps;
  const spread = spreads.length ? weightedMedian("s") : null;
  // The camera moves when most frames (by what moves in them) show the
  // whole picture shifting, or when most of the picture changes.
  const camera = spreads.length ? weightedMedian("m") > 0.5 || weightedMedian("c") > 0.6 : false;
  const detailSpread = (spreadOf(detail) * cellSize) / areaLen;
  // Detail, frame by frame: how much of it the window keeps as it moves,
  // and how wide it is. Words on a slide or a page are all edges.
  let detailKept = 0;
  let detailAll = 0;
  const detailSpreads = [];
  used.forEach((f) => {
    const raw = detailOf(f);
    const S = sums(raw, cellSize);
    if (!(S.total > 0)) return;
    const p = path(f.t);
    detailKept += S.inside(p, p + L);
    detailAll += S.total;
    detailSpreads.push({ s: (spreadOf(raw) * cellSize) / areaLen, e: S.total });
  });
  // The middle by detail: frames with more of it (words shown, not yet
  // faded in) count for more.
  let detailWide = detailSpread;
  if (detailSpreads.length) {
    detailSpreads.sort((a, b) => a.s - b.s);
    const half = detailSpreads.reduce((a, b) => a + b.e, 0) / 2;
    let acc = 0;
    for (const d of detailSpreads) {
      acc += d.e;
      if (acc >= half) {
        detailWide = d.s;
        break;
      }
    }
  }
  const detailShare = detailAll > 0 ? detailKept / detailAll : 1;
  if (process.env.REFRAMEKIT_DEBUG) console.error(`shot ${shot.n} ${axis} L=${L}: motion ${meanMotion.toFixed(3)} keeps ${keeps.toFixed(2)} spread ${spread === null ? "-" : spread.toFixed(2)} camera ${camera} detail spread ${detailWide.toFixed(2)} keeps ${detailShare.toFixed(2)}`);
  const side = axis === "x" ? "width" : "height";
  let mode = "follow";
  // Detail wider than the window but not all over the picture, like the
  // words of a title, a page or a slide, would be cut by a crop.
  const cutsDetail = detailWide > share * 0.9 && detailWide < 0.85 && detailShare < KEEP;
  if (!still && !camera && spread !== null && spread > share && keeps < KEEP) {
    mode = "pad";
    why.push(`what moves spreads over ${Math.round(spread * 100)}% of the ${side}, and a ${Math.round(share * 100)}% window would keep ${Math.round(keeps * 100)}% of it`);
  } else if (cutsDetail) {
    mode = "pad";
    why.length = 0;
    why.push(`${still ? "nothing moves, and " : ""}its detail (edges, as of words) spreads over ${Math.round(detailWide * 100)}% of the ${side}, and a ${Math.round(share * 100)}% window would keep ${Math.round(detailShare * 100)}% of it`);
  } else if (!still) {
    if (camera) why.push("most of the picture moves, as when the camera moves");
    const kept = keeps >= 0.98 ? "" : `, keeping ${Math.round(keeps * 100)}% of it`;
    if (moves.length) why.push(`it follows what moves, in ${moves.length} ${moves.length === 1 ? "move" : "moves"}${kept}`);
    else if (!kept) why.push("what moves stays inside it, so it holds still");
    else why.push(`it holds still on what moves${kept}`);
    if (pressAt.length) why.push(`it goes to ${pressAt.length === 1 ? "the press" : `${pressAt.length} presses`} in steps.json`);
  }
  return {
    mode,
    w,
    h,
    path: keys,
    keeps: Math.round(keeps * 100) / 100,
    spread: spread === null ? null : Math.round(spread * 100) / 100,
    why: why.join("; "),
  };
}

// Every shot's windows for every shape asked. `mode` is follow, center,
// pad or fit (fit plans nothing: it keeps the picture's shape).
function planWindows(data, shots, shapes, { mode = "follow", presses = [], box = null } = {}) {
  const out = shots.map((s) => ({ ...s, windows: {} }));
  for (const [key, shape] of Object.entries(shapes)) {
    const geo = windowOf(data.picture, shape.width, shape.height);
    for (const shot of out) {
      if (!geo.axis) {
        shot.windows[key] = { mode: "full" };
        continue;
      }
      if (mode === "center" || mode === "pad") {
        const mid = Math.round(geo.lo + (geo.hi - geo.lo) / 2);
        const at = geo.axis === "x" ? [mid, geo.y] : [geo.x, mid];
        shot.windows[key] = { mode: mode === "pad" ? "pad" : "follow", w: geo.w, h: geo.h, path: [[shot.start, ...at]], keeps: null, spread: null, why: mode === "pad" ? "--mode pad" : "--mode center" };
        continue;
      }
      shot.windows[key] = follow(shot, geo, data, { presses, box, afps: data.fps });
    }
  }
  return out;
}

// The moment the covers are taken at: a frame with detail that is not
// dark, moving or near a cut, early rather than late; when none is, the
// middle one of the frames read, which a picture that ends before its
// sound holds, where the middle of the video's length may be past it.
function coverTime(data, shots, duration) {
  const cuts = shots.slice(1).map((s) => s.start);
  let best = null;
  let bestScore = -Infinity;
  const motion = data.frames.map((f) => f.energy || 0);
  const typical = motion.reduce((a, b) => a + b, 0) / Math.max(1, motion.length) || 1;
  for (const f of data.frames) {
    if (f.t < Math.min(0.5, duration / 4) || f.t > duration - Math.min(0.5, duration / 4)) continue;
    if (cuts.some((c) => Math.abs(f.t - c) < 0.5)) continue;
    if (f.luma < 24) continue;
    const score = f.detail * (1 - 0.5 * Math.min(1, (f.energy || 0) / (2 * typical))) * (1 - 0.3 * (f.t / duration));
    if (score > bestScore) {
      bestScore = score;
      best = f.t;
    }
  }
  if (best === null) best = data.frames.length ? data.frames[Math.floor(data.frames.length / 2)].t : duration / 2;
  return r3(Number.isFinite(best) ? best : duration / 2);
}

// ─── crop.json ─────────────────────────────────────────────────────────────

function cropJson({ version, video, source = null, info, data, shots, shapes, cover, mode = "follow", notes = [] }) {
  return {
    reframekit: version,
    video,
    ...(source ? { source } : {}),
    width: data.width,
    height: data.height,
    duration: r3(info.duration),
    picture: [data.picture.x, data.picture.y, data.picture.w, data.picture.h],
    cover,
    // fit keeps the picture's shape and uses no window; every other mode
    // is in the windows themselves.
    mode: mode === "fit" ? "fit" : "windows",
    shapes: Object.fromEntries(Object.entries(shapes).map(([key, s]) => [key, { places: s.places, width: s.width, height: s.height }])),
    shots,
    notes,
    help: "Each window's path is [seconds, x, y] of its top left corner in the video's pixels. One point holds it still; more points glide through them. mode is follow, pad (the whole picture on a blurred copy or a color) or full (the picture already has the shape). A shot lasts at least 0.4 s. The top mode is windows, or fit to keep the picture's shape in every file. FORMATS.md, written with it, gives the command that renders it again. source is where the video is from this folder, and its size; written gives the other files of this folder reframekit made, with their sizes, and hashes a digest of each, so a run replaces only those still as it made them; digest tells whether this file was edited since, and edited that a render of an edited crop.json wrote it, so that no run without --crop plans over it.",
  };
}

// Reads an edited crop.json against the video it is for. Returns the
// shots and shapes to render, or says what is wrong with it.
// A shot of a crop.json lasts at least this long, as shotsOf makes them,
// and a window's path has at most this many points a second, more than
// the planner writes (one each 0.04 s at most).
const MIN_SHOT = 0.4;
const POINTS_PER_SECOND = 30;

function readCrop(raw, { width, height, duration, shapes }) {
  const fail = (why) => {
    throw new Error(`crop.json: ${why}`);
  };
  if (!raw || typeof raw !== "object" || !("reframekit" in raw)) fail("this is not a crop.json reframekit wrote");
  const top = raw.mode === undefined ? "windows" : String(raw.mode);
  if (!["windows", "fit"].includes(top)) fail(`the top mode is windows or fit, not ${top}`);
  if (Number(raw.width) !== width || Number(raw.height) !== height) fail(`it is for a ${raw.width}x${raw.height} picture, and this video shows ${width}x${height}`);
  const pic = Array.isArray(raw.picture) ? raw.picture.map(Number) : [0, 0, width, height];
  if (pic.length !== 4 || pic.some((n) => !Number.isFinite(n)) || pic[0] < 0 || pic[1] < 0 || pic[2] < 16 || pic[3] < 16 || pic[0] + pic[2] > width + 1 || pic[1] + pic[3] > height + 1) fail("picture is [x, y, width, height] inside the video");
  const picture = { x: even(pic[0]), y: even(pic[1]), w: Math.min(width - even(pic[0]), even(pic[2])), h: Math.min(height - even(pic[1]), even(pic[3])) };
  const shots = Array.isArray(raw.shots) ? raw.shots : fail("shots is missing");
  if (!shots.length) fail("shots is empty");
  // Shots of at least 0.4 s, so their number has a ceiling: a video of
  // 4 s holds 10.
  if (shots.length > Math.max(1, Math.floor(duration / MIN_SHOT) + 1)) fail(`it has ${shots.length} shots, and a ${r3(duration)} s video holds at most ${Math.max(1, Math.floor(duration / MIN_SHOT))} of at least ${MIN_SHOT} s`);
  let at = 0;
  const out = shots.map((s, i) => {
    const start = Number(s && s.start);
    const end = Number(s && s.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) fail(`shot ${i + 1} needs a start before its end`);
    if (Math.abs(start - at) > 0.05) fail(`shot ${i + 1} starts at ${start}, where shot ${i} ${i ? "ends" : "should start"} (${r3(at)})`);
    if (shots.length > 1 && end - start < MIN_SHOT - 0.002) fail(`shot ${i + 1} lasts ${r3(end - start)} s; a shot lasts at least ${MIN_SHOT} s, so join it to the one next to it`);
    // The cross-fade from the shot before: the switch to a padded shot
    // falls halfway through it, so it lasts at most the shot itself.
    const fade = s && s.fade !== undefined && s.fade !== null ? Number(s.fade) : 0;
    if (!Number.isFinite(fade) || fade < 0 || fade > end - start + 0.0005) fail(`shot ${i + 1}'s fade, the cross-fade from the shot before, is ${s.fade}; it takes 0 to ${r3(end - start)} s, the shot's length`);
    at = end;
    const windows = {};
    for (const [key, shape] of Object.entries(shapes)) {
      const win = s.windows && s.windows[key];
      if (!win) fail(`shot ${i + 1} has no ${key} window, though other shots have one; give it one`);
      const geo = windowOf(picture, shape.width, shape.height);
      const mode = String(win.mode || "follow");
      if (!["follow", "pad", "full"].includes(mode)) fail(`shot ${i + 1}, ${key}: mode is follow, pad or full, not ${mode}`);
      if (mode === "full") {
        if (geo.axis) fail(`shot ${i + 1}, ${key}: full needs a picture of that shape; use follow or pad`);
        windows[key] = { mode };
        continue;
      }
      if (!geo.axis) {
        windows[key] = { mode: mode === "pad" ? "pad" : "full" };
        continue;
      }
      const w = even(Number(win.w) || geo.w);
      const h = even(Number(win.h) || geo.h);
      if (w < 2 || h < 2) fail(`shot ${i + 1}, ${key}: the window ${w}x${h} is too small`);
      if (w > picture.w || h > picture.h) fail(`shot ${i + 1}, ${key}: the window ${w}x${h} is larger than the picture (${picture.w}x${picture.h})`);
      if (Math.abs(w / h - shape.width / shape.height) / (shape.width / shape.height) > 0.01 && Math.abs(Math.round((w * shape.height) / shape.width / 2) * 2 - h) > 2) fail(`shot ${i + 1}, ${key}: a ${w}x${h} window is not ${key}`);
      const path = Array.isArray(win.path) && win.path.length ? win.path : [[start, geo.x, geo.y]];
      const most = Math.ceil(POINTS_PER_SECOND * (end - start)) + 2;
      if (path.length > most) fail(`shot ${i + 1}, ${key}: its path has ${path.length} points; a ${r3(end - start)} s shot takes at most ${most}`);
      const keys = path.map((k, j) => {
        if (!Array.isArray(k) || k.length < 3 || k.slice(0, 3).some((n) => !Number.isFinite(Number(n)))) fail(`shot ${i + 1}, ${key}: path point ${j + 1} is [seconds, x, y]`);
        return [clamp(Number(k[0]), start, end), clamp(Math.round(Number(k[1])), picture.x, picture.x + picture.w - w), clamp(Math.round(Number(k[2])), picture.y, picture.y + picture.h - h)];
      });
      keys.sort((a, b) => a[0] - b[0]);
      windows[key] = { mode, w, h, path: keys, keeps: win.keeps ?? null, spread: win.spread ?? null, why: String(win.why || "") };
    }
    return { n: i + 1, start: r3(start), end: r3(end), cut: String((s && s.cut) || (i ? "given" : "start")), fade: r3(fade), windows };
  });
  if (Math.abs(at - duration) > 0.25) fail(`the shots end at ${r3(at)} s, the video at ${r3(duration)} s`);
  out[out.length - 1].end = r3(Math.max(out[out.length - 1].end, duration));
  const cover = Number.isFinite(Number(raw.cover)) ? clamp(Number(raw.cover), 0, duration) : duration / 2;
  return { picture, shots: out, cover: r3(cover), mode: top };
}

// Where a shape's window is over time: a function of t that returns
// [x, y]. Inside a cut's fade the window glides from where the shot before
// left it to where this one is once the fade is over.
function windowPath(shots, key) {
  const fns = shots.map((s) => {
    const w = s.windows[key];
    if (!w || !w.path) return null;
    const fx = pchip(w.path.map((k) => [k[0], k[1]]));
    const fy = pchip(w.path.map((k) => [k[0], k[2]]));
    return (t) => [fx(t), fy(t)];
  });
  return (t) => {
    let i = shots.length - 1;
    while (i > 0 && shots[i].start > t) i--;
    const shot = shots[i];
    if (!fns[i]) return null;
    if (i > 0 && shot.fade > 0 && t < shot.start + shot.fade && fns[i - 1] && shots[i - 1].windows[key].mode === "follow" && shot.windows[key].mode === "follow") {
      const from = fns[i - 1](shot.start);
      const to = fns[i](shot.start + shot.fade);
      const u = smoothstep((t - shot.start) / shot.fade);
      return [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u];
    }
    return fns[i](t);
  };
}

// The shapes the places need: "9:16" for tiktok, reels and shorts.
function shapesFor(places) {
  const shapes = {};
  for (const p of places) {
    const key = shapeOf(p.width, p.height);
    if (!shapes[key]) shapes[key] = { width: p.width, height: p.height, places: [] };
    shapes[key].places.push(p.name);
  }
  return shapes;
}

module.exports = { shotsOf, windowOf, follow, planWindows, coverTime, cropJson, readCrop, windowPath, shapesFor, pchip, keyframesOf, spreadOf, STILL, KEEP, MIN_SHOT };
