"use strict";

// sheet.png: every shot on a row, three frames of it (one for a short
// shot, and for every shot of a video with more than 24), with each
// shape's window drawn where it is at that moment. An agent looks at it
// before anything renders and moves a window in crop.json when it misses
// what matters. A long video gets more than one page: sheet.png,
// sheet-2.png and so on, twelve shots to a page, ten pages at most; a
// video of more shots than that shows 120 of them, spread evenly.

const { mustRun, openVideo, fromOrigin } = require("./ffmpeg");
const { canvas, png } = require("./draw");
const { windowPath } = require("./plan");

const SHOTS_PER_PAGE = 12;
const MAX_PAGES = 10;
const COLORS = ["#ff6a3d", "#2ec4b6", "#ffbe0b", "#9b8cff", "#f15bb5", "#4cc9f0", "#9ef01a"];
const INK = { ground: "#111114", text: "#f4f1ea", dim: "#8b8a93", panel: "#1c1c22" };

// One frame of the video at t, as RGB at w x h, t counted from the
// video's origin as every run that reads it counts (ffmpeg.js). ffmpeg
// seeks to the key frame before t, counting from the file's own start,
// and the graph keeps the first frame from t on: null when ffmpeg ends
// well with no frame there, as the picture has none of its own, or none
// ffmpeg can decode from that key frame on, as in a damaged end of the
// file. By itself ffmpeg fails a run when more than two thirds of the
// frames it decoded failed (exit code 69), as a grab there can, though
// the video as a whole reads well enough; -max_error_rate 1 keeps it
// from failing for that alone. It decodes with two threads: by itself
// ffmpeg takes one more than the cores it counts, up to 16, each with
// frames of its own, and ffmpeg 4.4.2 counts every core of the machine,
// so a grab of a 10-bit 3840x2160 video took 0.9 GB there, and 0.3 GB
// with two threads. A grab that fails otherwise, or that a signal ends,
// as when the system kills it as memory runs out, fails with how ffmpeg
// ended (ffmpeg.js mustRun()), never taken for a moment with no picture.
async function frameAt(info, t, w, h, work) {
  const at = Math.max(0, t);
  const seek = Math.max(0, Math.floor((at + (Number.isFinite(info.origin) ? info.origin : 0) - (info.startTime || 0)) * 1000) / 1000);
  const r = await mustRun(["-v", "error", "-max_error_rate", "1", "-threads", "2", "-noaccurate_seek", "-ss", seek.toFixed(3), ...openVideo(info), "-map", `0:${info.video.index}`, "-frames:v", "1", "-vf", `setpts=PTS-${fromOrigin(info)}/TB,trim=start=${at.toFixed(4)},scale=${w}:${h}:flags=area,format=rgb24`, "-f", "rawvideo", "pipe:1"], `Taking the frame at ${at.toFixed(2)} s for sheet.png`, { cwd: work, collect: true });
  return r.stdout && r.stdout.length >= w * h * 3 ? r.stdout.subarray(0, w * h * 3) : null;
}

// fn() for each item, `jobs` at a time, the results in the items' order.
// Once one fails no other starts, and the first failure is thrown when
// those under way have ended, so none is left running in the work
// folder the run then takes away.
async function pool(items, jobs, fn) {
  const out = new Array(items.length);
  let next = 0;
  let failed = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        failed = failed || { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
  if (failed) throw failed.err;
  return out;
}

// How many frames of the sheet are taken at once: four, or two for a video
// whose frames are over 8 megapixels, as 3840x2160 is. Held to 2 cores,
// four frames of a 10-bit 3840x2160 video took about 1.1 GB at once, more
// than reading the whole video took: 0.5 GB with ffmpeg 8.0, and 0.94 GB
// with Ubuntu 22.04's 4.4.2, which counts every core of the machine.
const BIG_FRAME = 8_000_000;
const grabsAtOnce = (video) => (video.width * video.height > BIG_FRAME ? 2 : 4);

// The frames of `wanted`, `jobs` at once. A grab the system killed
// (SIGKILL), as it does when memory runs out, is taken again alone once
// the others are done, so a run near the memory it may take still draws
// every frame; a second kill, or any other failure, stops the run.
const KILLED = Symbol("killed");
async function grabAll(wanted, grab, jobs) {
  const got = await pool(wanted, jobs, (item) =>
    grab(item).catch((err) => {
      if (err.signal === "SIGKILL") return KILLED;
      throw err;
    }),
  );
  for (const [k, frame] of got.entries()) if (frame === KILLED) got[k] = await grab(wanted[k]);
  return got;
}

const pct = (x) => `${Math.round(x * 100)}%`;

// What a row says about one shape's window in one shot.
function windowLabel(win) {
  if (!win) return "";
  if (win.mode === "full") return "FULL";
  if (win.mode === "pad") return "PAD";
  const moves = win.path && win.path.length > 1 && win.path.some((k) => k[1] !== win.path[0][1] || k[2] !== win.path[0][2]);
  const keeps = win.keeps === null || win.keeps === undefined ? "" : ` ${pct(win.keeps)}`;
  return `${moves ? "FOLLOWS" : "HOLDS"}${keeps}`;
}

// Draws the sheets, one page at a time, fetching only that page's frames.
// `held` is the moment the picture ends at, when it ends before the sound
// and a file that runs that far holds its last frame from there
// (reframe.js): a moment past it shows that frame, marked HELD. Returns { pages: [{ file, png,
// shots: [first, last] }], drawn, note }: the shots drawn, and what the
// sheets leave out, if anything.
async function drawSheets({ info, picture, shots: all, shapes, work, title, held = null }) {
  const video = info.video;
  const isHeld = (t) => held !== null && t >= held - 1e-6;
  // The picture's last frame, from a frame and a half before its end.
  const lastAt = held !== null ? Math.max(0, held - 1.5 / (video.fps > 0 ? video.fps : 30)) : 0;
  // At most ten pages: past 120 shots, 120 of them, the first and the last
  // among them, spread evenly.
  const room = SHOTS_PER_PAGE * MAX_PAGES;
  const shots = all.length <= room ? all : Array.from({ length: room }, (_, i) => all[Math.round((i * (all.length - 1)) / (room - 1))]);
  const note = all.length > room ? `The video has ${all.length} shots; the sheets show ${room} of them, spread evenly, and crop.json holds them all.` : null;
  const W = video.displayWidth;
  const H = video.displayHeight;
  // Thumbnails: 320 wide for a wide picture, 240 tall for a tall one.
  const tw = W >= H ? 320 : Math.max(64, 2 * Math.round((240 * W) / H / 2));
  const th = W >= H ? Math.max(64, 2 * Math.round((320 * H) / W / 2)) : 240;
  const k = tw / W;
  const keys = Object.keys(shapes);
  const paths = Object.fromEntries(keys.map((key) => [key, windowPath(all, key)]));
  // Three frames of a shot, or its middle one for a short shot and for a
  // video of many shots, which would take long to draw.
  const many = shots.length > 24;
  const moments = shots.map((s) => {
    const len = s.end - s.start;
    return len >= 1.2 && !many ? [s.start + 0.15 * len, s.start + 0.5 * len, s.end - 0.15 * len] : [s.start + 0.5 * len];
  });
  // The frames of the page being drawn, by shot and moment.
  let frames = new Map();
  // One frame with each shape's window drawn on it.
  const drawFrame = (c, s, i, t, fx, fy) => {
    const pixels = frames.get(`${i} ${t}`);
    if (pixels) c.blit(pixels, tw, th, fx, fy);
    else c.rect(fx, fy, tw, th, INK.panel);
    for (const [j, key] of keys.entries()) {
      const win = s.windows[key];
      const color = COLORS[j % COLORS.length];
      if (!win || win.mode === "full") continue;
      // Each shape's outline sits a little inside the one before, so
      // edges that meet stay apart.
      const inset = 3 * j;
      if (win.mode === "pad") {
        c.frame(fx + picture.x * k + inset, fy + picture.y * k + inset, picture.w * k - 2 * inset, picture.h * k - 2 * inset, color, { thick: 2, dash: 6 });
        continue;
      }
      const p = paths[key](t);
      if (!p) continue;
      c.frame(fx + p[0] * k + inset, fy + p[1] * k + inset, win.w * k - 2 * inset, win.h * k - 2 * inset, color, { thick: 2 });
    }
    // Its moment, on a patch of the ground drawn over the frame and the
    // outlines, so it reads on a light picture too, and what the frame is
    // when the picture has none of its own there.
    const label = `${t.toFixed(2)} S${isHeld(t) ? " HELD" : pixels ? "" : " NO PICTURE"}`;
    c.rect(fx + 2, fy + th - 14, c.textWidth(label, 1) + 5, 11, INK.ground);
    c.text(fx + 4, fy + th - 12, label, INK.text, 1);
  };
  // What each shape's window does, in its color, from x on.
  const drawLabels = (c, s, x, y, scale) => {
    for (const [j, key] of keys.entries()) {
      const text = windowLabel(s.windows[key]);
      if (!text) continue;
      c.rect(x, y + scale, 5 * scale, 5 * scale, COLORS[j % COLORS.length]);
      x = c.text(x + 8 * scale, y, text, INK.text, scale) + 11 * scale;
    }
  };
  const pages = [];
  const pad = 24;
  const head = 92;
  const gap = 14;
  const width = Math.max(pad * 2 + 3 * tw + 2 * gap, 960);
  for (let first = 0; first < shots.length; first += SHOTS_PER_PAGE) {
    const rows = shots.slice(first, first + SHOTS_PER_PAGE);
    const wanted = rows.flatMap((s, r) => (many ? [moments[first + r][0]] : moments[first + r]).map((t) => ({ i: first + r, t })));
    const got = await grabAll(wanted, ({ t }) => frameAt(info, isHeld(t) ? lastAt : t, tw, th, work), grabsAtOnce(video));
    frames = new Map(wanted.map((w, k) => [`${w.i} ${w.t}`, got[k]]));
    // A row per shot, or, for a video of many shots, three shots to a row.
    const perRow = many ? 3 : 1;
    const cellH = many ? 26 + th + 22 : 30 + th + 22;
    const height = head + Math.ceil(rows.length / perRow) * cellH + 40;
    const c = canvas(width, height, INK.ground);
    c.text(pad, 22, title.slice(0, Math.floor((width - 2 * pad) / 18)), INK.text, 3);
    // The legend: one color per shape.
    let lx = pad;
    for (const [j, key] of keys.entries()) {
      c.rect(lx, 62, 18, 10, COLORS[j % COLORS.length]);
      lx = c.text(lx + 26, 60, `${key} ${shapes[key].places.join(" ").toUpperCase()}`, INK.text, 2) + 28;
    }
    rows.forEach((s, r) => {
      const i = first + r;
      if (many) {
        const fx = pad + (r % perRow) * (tw + gap);
        const y0 = head + Math.floor(r / perRow) * cellH;
        const x = c.text(fx, y0 + 4, `${s.n}`, INK.text, 2) + 12;
        c.text(x, y0 + 4, `${s.start.toFixed(1)}-${s.end.toFixed(1)} S`, INK.dim, 2);
        drawFrame(c, s, i, moments[i][0], fx, y0 + 26);
        drawLabels(c, s, fx, y0 + 26 + th + 6, 1);
        return;
      }
      const y0 = head + r * cellH;
      let x = c.text(pad, y0 + 6, `${s.n}`, INK.text, 2) + 16;
      x = c.text(x, y0 + 6, `${s.start.toFixed(2)}-${s.end.toFixed(2)} S`, INK.dim, 2) + 24;
      drawLabels(c, s, x, y0 + 6, 2);
      moments[i].forEach((t, m) => drawFrame(c, s, i, t, pad + m * (tw + gap), y0 + 30));
    });
    c.text(pad, height - 26, "SOLID: THE WINDOW AT THAT MOMENT. DASHED: THE SHOT IS PADDED, THE WHOLE PICTURE SHOWS.", INK.dim, 1);
    if (wanted.some(({ t }) => isHeld(t))) c.text(pad, height - 14, "HELD: THE PICTURE HAS ENDED BY THEN, AND A FILE THAT RUNS THAT FAR HOLDS ITS LAST FRAME.", INK.dim, 1);
    const name = first === 0 ? "sheet.png" : `sheet-${first / SHOTS_PER_PAGE + 1}.png`;
    pages.push({ file: name, png: png(c, { Software: "reframekit" }), shots: [rows[0].n, rows[rows.length - 1].n] });
  }
  frames = null;
  return { pages, drawn: shots.length, note, many };
}

module.exports = { drawSheets, windowLabel, COLORS };
