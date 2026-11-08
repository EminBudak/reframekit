"use strict";

// The plan on videos whose truth is known: the cut is found, the window
// keeps the moving box whole and near its middle, holds still when the
// box stays put, pads a still slide and two far apart subjects, and does
// not pad a camera pan. Also the path's interpolation.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { probe, checkTools } = require("../skills/reframekit/scripts/lib/ffmpeg");
const { analyze } = require("../skills/reframekit/scripts/lib/analyze");
const { shotsOf, planWindows, shapesFor, windowPath, pchip, keyframesOf, windowOf } = require("../skills/reframekit/scripts/lib/plan");
const { parsePlaces } = require("../skills/reframekit/scripts/lib/places");
const { fixture, dir, TWO_SHOTS } = require("./helpers");

async function planOf(name, places = "tiktok,feed,square") {
  checkTools();
  const file = fixture(name);
  const info = probe(file);
  const work = fs.mkdtempSync(path.join(dir, "work-"));
  const data = await analyze(file, info, { work });
  data.picture = data.picture || { x: 0, y: 0, w: data.width, h: data.height };
  const shots = shotsOf(info.duration, data.cuts.map((c) => ({ at: c.at, span: 0, from: "picture" })));
  const shapes = shapesFor(parsePlaces(places));
  return { info, data, shapes, shots: planWindows(data, shots, shapes, {}) };
}

test("two shots: the cut is found where it is, and each 9:16, 4:5 and 1:1 window keeps the moving box whole", async () => {
  const { data, shots } = await planOf("twoShots");
  assert.equal(data.cuts.length, 1);
  assert.ok(Math.abs(data.cuts[0].at - TWO_SHOTS.cut) < 0.05, `cut at ${data.cuts[0].at}`);
  assert.equal(shots.length, 2);
  for (const key of ["9:16", "4:5", "1:1"]) {
    const where = windowPath(shots, key);
    const w = shots[0].windows[key].w;
    let whole = 0;
    let n = 0;
    const off = [];
    for (let k = 0; k < 120; k++) {
      const t = k / 30;
      const box = TWO_SHOTS.box(t);
      const [x] = where(t);
      n++;
      if (box.x >= x - 1 && box.x + box.w <= x + w + 1) whole++;
      off.push(Math.abs(x + w / 2 - (box.x + box.w / 2)));
    }
    assert.ok(whole >= 117, `${key}: the box is whole in ${whole} of ${n} frames`);
    assert.equal(shots[0].windows[key].mode, "follow");
    // The second shot's box hardly moves sideways: the window holds still
    // and centers it.
    const second = shots[1].windows[key];
    assert.ok(second.path.every((k) => k[1] === second.path[0][1]), `${key}: the second shot's window moves`);
    // Centered on the box, as far as the picture's edge allows.
    const ideal = Math.min(640 - second.w, Math.max(0, 525 - second.w / 2));
    assert.ok(Math.abs(second.path[0][1] - ideal) < 30, `${key}: the window is at ${second.path[0][1]}, centered it would be at ${ideal}`);
  }
});

test("a still slide with words across 70% of the width is padded in 9:16, and so are two subjects far apart", async () => {
  const still = await planOf("wideStill", "tiktok");
  assert.equal(still.shots.length, 1);
  assert.equal(still.shots[0].windows["9:16"].mode, "pad");
  assert.match(still.shots[0].windows["9:16"].why, /nothing moves/);
  const two = await planOf("twoSubjects", "tiktok");
  assert.equal(two.shots[0].windows["9:16"].mode, "pad");
  assert.match(two.shots[0].windows["9:16"].why, /what moves spreads over/);
});

test("a camera pan is followed, not padded", async () => {
  const { shots } = await planOf("pan", "tiktok");
  const win = shots[0].windows["9:16"];
  assert.equal(win.mode, "follow");
  assert.match(win.why, /most of the picture moves/);
});

test("what the analysis keeps of a long video holds in memory: each small frame's numbers in a buffer shared by 256 frames, fewer small frames a second past twenty minutes and past an hour", async () => {
  const { analysisFps } = require("../skills/reframekit/scripts/lib/analyze");
  assert.deepEqual([analysisFps(600), analysisFps(1800), analysisFps(3600), analysisFps(4 * 3600)], [10, 5, 5, 2.5]);
  const { data } = await planOf("twoShots", "tiktok");
  const [a, b] = data.frames;
  for (const key of ["detailCols", "detailRows", "motionCols", "motionRows", "tiny", "tinyColor"]) {
    assert.ok(b[key] && b[key].buffer === a.detailCols.buffer, `${key} sits in the shared buffer`);
  }
  assert.equal(a.detailCols.buffer.byteLength % 256, 0);
  assert.ok(data.frames.every((f) => f.detailCols.length === data.gw && f.tiny.length === (data.gw >> 2) * (data.gh >> 2)));
});

test("windows fit the picture and slide along the free axis only", () => {
  const wide = windowOf({ x: 0, y: 0, w: 1920, h: 1080 }, 1080, 1920);
  assert.deepEqual([wide.axis, wide.w, wide.h, wide.lo, wide.hi], ["x", 608, 1080, 0, 1312]);
  const tall = windowOf({ x: 0, y: 0, w: 1080, h: 1920 }, 1920, 1080);
  assert.deepEqual([tall.axis, tall.w, tall.h, tall.lo, tall.hi], ["y", 1080, 608, 0, 1312]);
  const same = windowOf({ x: 0, y: 140, w: 1920, h: 800 }, 1920, 800);
  assert.equal(same.axis, null);
  const bars = windowOf({ x: 0, y: 140, w: 1920, h: 800 }, 1080, 1080);
  assert.deepEqual([bars.axis, bars.w, bars.h, bars.y], ["x", 800, 800, 140]);
});

test("paths: one key holds, two ease from one to the other, equal keys hold between moves", () => {
  assert.equal(pchip([[0, 100]])(5), 100);
  const ease = pchip([[0, 0], [2, 100]]);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 50);
  assert.equal(ease(2), 100);
  assert.ok(ease(0.1) < 2, "it starts slowly");
  const hold = pchip([[0, 10], [1, 10], [2, 50], [3, 50]]);
  assert.equal(hold(0.5), 10);
  assert.equal(hold(2.5), 50);
  for (let t = 0; t <= 3; t += 0.05) assert.ok(hold(t) >= 10 - 1e-9 && hold(t) <= 50 + 1e-9, `no overshoot: ${hold(t)} at ${t}`);
  const wave = (t) => 300 + 200 * Math.sin(t);
  const keys = keyframesOf(wave, 0, 6);
  const f = pchip(keys);
  for (let t = 0; t <= 6; t += 0.01) assert.ok(Math.abs(f(t) - wave(t)) < 2, `${t}: ${f(t)} against ${wave(t)}`);
  assert.ok(keys.length < 60, `${keys.length} keyframes`);
});

test("shots: cuts too close together are one, and a given cut wins over a found one", () => {
  const shots = shotsOf(10, [
    { at: 3, span: 0, from: "picture" },
    { at: 3.2, span: 0.4, from: "timeline" },
    { at: 9.8, span: 0, from: "picture" },
  ]);
  assert.deepEqual(shots.map((s) => [s.start, s.end, s.cut, s.fade]), [[0, 3.2, "start", 0], [3.2, 10, "timeline", 0.4]]);
});

test("a cut between two dark shots of one brightness is found, and a white flash is not a cut", async () => {
  // Three shots of 2 s: blue gray, then a plum of the same brightness,
  // then a lighter one; a box moves through all of them, and the frame at
  // 1 s is white.
  const file = path.join(dir, "dark-cuts.mp4");
  const shot = (color) => ["-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=30:d=2`];
  require("./helpers").ffmpeg([
    ...shot("0x203040"), ...shot("0x402030"), ...shot("0x506070"),
    "-f", "lavfi", "-i", "color=c=white:s=30x30:r=30:d=6",
    "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0[bg];[bg][3]overlay=x='20+40*t':y=70:shortest=1,format=yuv420p,geq=lum='if(between(T,0.99,1.02),235,lum(X,Y))':cb='cb(X,Y)':cr='cr(X,Y)'[v]",
    "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", file,
  ]);
  checkTools();
  const info = probe(file);
  const data = await analyze(file, info, { work: fs.mkdtempSync(path.join(dir, "work-")) });
  assert.deepEqual(data.cuts.map((c) => Math.round(c.at * 10) / 10), [2, 4], JSON.stringify(data.cuts));
  assert.deepEqual(data.flashes.map((t) => Math.round(t * 10) / 10), [1]);
});

test("a flash of two or three frames is no cut either, at 30 or 60 fps, nor one that fades back over a few frames; two white frames between two shots are a cut", async () => {
  checkTools();
  // A box moving on dark blue, the whole frame white from 2 s for `long`
  // seconds; or, with `fade`, white at 2 s and back over four frames; or
  // two white frames between the blue shot and a beige one.
  const make = (name, rate, white, { fade = false, second = null } = {}) => {
    const file = path.join(dir, `${name}.mp4`);
    const lit = `between(T,1.999,${(2 + white - 0.001).toFixed(4)})`;
    const lum = fade ? `if(between(T,1.999,2.14),lum(X,Y)+(235-lum(X,Y))*max(0\\,1-(T-2)*7),lum(X,Y))` : `if(${lit},235,lum(X,Y))`;
    const chroma = (p) => (fade ? `${p}(X,Y)` : `if(${lit},128,${p}(X,Y))`);
    const ground = second ? `color=c=0x203050:s=320x180:r=${rate}:d=2[a];color=c=${second}:s=320x180:r=${rate}:d=3[b];[a][b]concat=n=2:v=1:a=0[g]` : `color=c=0x203050:s=320x180:r=${rate}:d=5[g]`;
    require("./helpers").ffmpeg(["-filter_complex", `${ground};color=c=white:s=20x20:r=${rate}:d=5[box];[g][box]overlay=x='20+40*t':y=80:shortest=1,format=yuv420p,geq=lum='${lum}':cb='${chroma("cb")}':cr='${chroma("cr")}'[v]`, "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", file]);
    return file;
  };
  const found = async (file) => {
    const data = await analyze(file, probe(file), { work: fs.mkdtempSync(path.join(dir, "work-")) });
    return { cuts: data.cuts.map((c) => Math.round(c.at * 100) / 100), flashes: data.flashes.map((t) => Math.round(t * 100) / 100) };
  };
  for (const [name, rate, white] of [["flash-2-of-30", 30, 2 / 30], ["flash-3-of-30", 30, 3 / 30], ["flash-2-of-60", 60, 2 / 60], ["flash-4-of-60", 60, 4 / 60]]) {
    assert.deepEqual(await found(make(name, rate, white)), { cuts: [], flashes: [2] }, name);
  }
  assert.deepEqual(await found(make("flash-fading", 30, 0, { fade: true })), { cuts: [], flashes: [2] }, "a flash that fades back");
  assert.deepEqual((await found(make("flash-between", 30, 2 / 30, { second: "0xd8c8a0" }))).cuts, [2], "two white frames between two shots");
});

test("a hard cut into fast motion is a cut, though the frames after it change as much as the cut; the start of a scroll is not", async () => {
  const { detectCuts } = require("../skills/reframekit/scripts/lib/analyze");
  // scdet's numbers at 30 fps: still, then a jump at 2 s and what follows.
  const scd = (jump, after) => Array.from({ length: 120 }, (_, k) => {
    const t = k / 30;
    const mafd = k < 60 ? 0.3 : k === 60 ? jump : after;
    return { t, "scd.mafd": mafd, "scd.score": k === 60 ? jump - 0.3 : k === 61 ? Math.abs(after - jump) : 0.05 };
  });
  assert.deepEqual(detectCuts(scd(18.1, 19.6)).cuts.map((c) => c.at), [2]);
  assert.deepEqual(detectCuts(scd(5.1, 6.2)).cuts, []);
  // A pan from the first frame: scdet scores the second frame's whole
  // difference, which is no cut.
  const pan = Array.from({ length: 60 }, (_, k) => ({ t: k / 30, "scd.mafd": k ? 19.6 : 0, "scd.score": k === 1 ? 19.6 : 0.05 }));
  assert.deepEqual(detectCuts(pan).cuts, []);
  // A slow pan cut to a fast pan of another picture, as ffmpeg makes it.
  const file = path.join(dir, "slow-to-fast.mp4");
  require("./helpers").ffmpeg([
    "-f", "lavfi", "-i", "color=c=gray:s=2400x270:r=30:d=2,format=gray,geq=lum='128+30*sin(X/9)*cos(Y/7)',format=yuv420p",
    "-f", "lavfi", "-i", "color=c=gray:s=2400x270:r=30:d=2,format=gray,geq=lum='128+110*sin(X/3+Y/5)*cos(Y/4-X/7)',format=yuv420p",
    "-filter_complex", "[0]crop=480:270:'10*t':0[a];[1]crop=480:270:'900*t':0[b];[a][b]concat=n=2:v=1:a=0[v]",
    "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", file,
  ]);
  checkTools();
  const data = await analyze(file, probe(file), { work: fs.mkdtempSync(path.join(dir, "work-")) });
  assert.deepEqual(data.cuts.map((c) => Math.round(c.at * 10) / 10), [2], JSON.stringify(data.cuts));
});

test("a dissolve of one to two seconds between two pictures is found at its middle, and a box that comes into a still picture and stays is none", async () => {
  checkTools();
  const found = async (file) => {
    const data = await analyze(file, probe(file), { work: fs.mkdtempSync(path.join(dir, "work-")) });
    return { cuts: data.cuts.map((c) => c.at), dissolves: data.dissolves.map((c) => c.at) };
  };
  // Dark blue with a white bar, cross-faded from 3 s into beige with a
  // brown box.
  for (const seconds of [1, 1.5, 2]) {
    const file = path.join(dir, `dissolve-${seconds}.mp4`);
    require("./helpers").ffmpeg(["-f", "lavfi", "-i", "color=c=0x203050:s=320x180:r=30:d=7,drawbox=x=60:y=80:w=200:h=24:color=white:t=fill", "-f", "lavfi", "-i", "color=c=0xe0d0b0:s=320x180:r=30:d=7,drawbox=x=190:y=60:w=80:h=60:color=0x704020:t=fill", "-filter_complex", `[0][1]xfade=transition=fade:duration=${seconds}:offset=3,format=yuv420p[v]`, "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", file]);
    const got = await found(file);
    assert.deepEqual(got.cuts, [], `${seconds} s: ${JSON.stringify(got)}`);
    assert.equal(got.dissolves.length, 1, `${seconds} s: ${JSON.stringify(got)}`);
    assert.ok(Math.abs(got.dissolves[0] - (3 + seconds / 2)) <= 0.2, `${seconds} s: the dissolve is at ${got.dissolves[0]}`);
  }
  // A white box that slides in over a second, or fades in, and stays.
  const slide = path.join(dir, "slide-in.mp4");
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "color=c=0x203050:s=320x180:r=30:d=7", "-f", "lavfi", "-i", "color=c=0xf0f0f0:s=120x100:r=30:d=7", "-filter_complex", "[0][1]overlay=x='if(lt(t,3),-120,min(150,-120+270*(t-3)))':y=40,format=yuv420p[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", slide]);
  assert.deepEqual(await found(slide), { cuts: [], dissolves: [] });
  const fade = path.join(dir, "fade-in.mp4");
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "color=c=0x203050:s=320x180:r=30:d=7", "-f", "lavfi", "-i", "color=c=0xf0f0f0:s=160x120:r=30:d=7,format=yuva420p,fade=t=in:st=3:d=1:alpha=1", "-filter_complex", "[0][1]overlay=x=80:y=30,format=yuv420p[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", fade]);
  assert.deepEqual(await found(fade), { cuts: [], dissolves: [] });
});

test("light that comes up over a second or two is no dissolve: over a subject that moves, or over a still scene", async () => {
  checkTools();
  const found = async (file) => {
    const data = await analyze(file, probe(file), { work: fs.mkdtempSync(path.join(dir, "work-")) });
    return { cuts: data.cuts.map((c) => c.at), dissolves: data.dissolves.map((c) => c.at) };
  };
  const encode = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"];
  // A white box crossing a gray ground at 45 px a second while the
  // exposure comes up from 3 s to 4 s, as eq's brightness adds light.
  const exposure = path.join(dir, "exposure.mp4");
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "color=c=0x606060:s=640x360:r=30:d=8", "-f", "lavfi", "-i", "color=c=white:s=80x150:r=30:d=8", "-filter_complex", "[0][1]overlay=x='40+45*t':y=100,eq=brightness='-0.25+0.35*clip(t-3\\,0\\,1)':eval=frame[v]", "-map", "[v]", ...encode, exposure]);
  assert.deepEqual(await found(exposure), { cuts: [], dissolves: [] });
  // A still room whose light comes up over 1.5 s from 3 s, as a lamp's
  // does: every value in step with it.
  const lamp = path.join(dir, "lamp.mp4");
  const k = "(0.45+0.55*clip((T-3)/1.5\\,0\\,1))";
  require("./helpers").ffmpeg(["-f", "lavfi", "-i", "color=c=0x705040:s=640x360:r=30:d=8,drawbox=x=60:y=60:w=160:h=120:color=0xd0c0a0:t=fill,drawbox=x=300:y=200:w=240:h=100:color=0x304060:t=fill,drawbox=x=420:y=40:w=120:h=120:color=0xe0e0e0:t=fill,format=yuv420p", "-vf", `geq=lum='lum(X,Y)*${k}':cb='128+(cb(X,Y)-128)*${k}':cr='128+(cr(X,Y)-128)*${k}'`, ...encode, lamp]);
  assert.deepEqual(await found(lamp), { cuts: [], dissolves: [] });
});

test("a change seen through the gray copies is a dissolve when it spreads over its frames, and a cut when one frame carries it", () => {
  const { detectDissolves } = require("../skills/reframekit/scripts/lib/analyze");
  // Ten small frames a second for 4 s, the picture turning from 20 to 120
  // around 2 s.
  const frames = (ramp) => Array.from({ length: 40 }, (_, k) => ({ t: k / 10, tiny: new Uint8Array(16).fill(Math.round(20 + 100 * ramp(k / 10))) }));
  const scd = (mafd) => Array.from({ length: 120 }, (_, k) => ({ t: k / 30, "scd.mafd": mafd(k / 30), "scd.score": 0 }));
  const cut = detectDissolves(frames((t) => (t >= 2 ? 1 : 0)), 10, [], scd((t) => (Math.abs(t - 2) < 0.01 ? 7.4 : 0.02)));
  assert.deepEqual([cut.cuts.map((c) => c.at), cut.dissolves.length], [[2], 0]);
  const fade = detectDissolves(frames((t) => Math.min(1, Math.max(0, (t - 1.8) / 0.4))), 10, [], scd((t) => (t > 1.8 && t <= 2.2 ? 1.2 + (t - 1.8) : 0.02)));
  assert.deepEqual([fade.cuts.length, fade.dissolves.length], [0, 1]);
});
