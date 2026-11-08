"use strict";

// What the other kits wrote that helps place the windows:
//
//   launch-film     film.timeline.json next to film.mp4: where each clip
//                   starts. Its clips cross-fade for 0.4 s, so a window
//                   moves to the next clip's place during the fade.
//   easyscreenshotkit
//                   steps.json next to demo.mp4: where each page starts,
//                   the page's box inside the video, and where and when the
//                   pointer pressed, in the video's own pixels.
//   easybrandkit    brand.json or _brand.yml: the page's background color,
//                   for what goes behind a padded picture.
//
// And the cuts given by hand with --cuts.

const fs = require("node:fs");
const path = require("node:path");

// launch-film joins its clips with a crossfade this long (src/film.js).
const LAUNCH_FILM_FADE = 0.4;

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.code === "ENOENT" ? "no such file" : err.code === "EISDIR" ? "it is a folder" : err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not ${what}: ${err.message}`);
  }
}

// --cuts: seconds as "3.2,7.5", or a JSON file holding seconds ([3.2, 7.5]),
// frames ({ "fps": 30, "cuts": [96, 225] }), a launch-film timeline
// ({ "clips": [{ "start": 3.2 }] }) or easyscreenshotkit's steps.json
// (its pages' starts). Returns [{ at, span, from }].
const SECONDS_LIST = /^\s*\d+(?:\.\d+)?(?:\s*,\s*\d+(?:\.\d+)?)*\s*$/;

function parseCuts(given) {
  const text = String(given);
  if (SECONDS_LIST.test(text) && !fs.existsSync(text)) {
    return text.split(",").map((s) => ({ at: Number(s), span: 0, from: "given" }));
  }
  const raw = readJson(text, "a list of cuts");
  let cuts = null;
  if (Array.isArray(raw)) cuts = raw.map((s) => ({ at: Number(s), span: 0 }));
  else if (raw && Array.isArray(raw.clips)) cuts = raw.clips.map((c) => ({ at: Number(c && c.start), span: LAUNCH_FILM_FADE }));
  else if (raw && Array.isArray(raw.cuts) && Number(raw.fps) > 0) cuts = raw.cuts.map((f) => ({ at: Number(f) / Number(raw.fps), span: 0 }));
  else if (raw && raw.kind === "demo" && Array.isArray(raw.pages)) cuts = raw.pages.map((p) => ({ at: Number(p && p.start), span: 0 }));
  if (!cuts || cuts.some((c) => !Number.isFinite(c.at) || c.at < 0)) {
    throw new Error(`${text} holds no cuts: give seconds, { "fps", "cuts" } in frames, a launch-film timeline or easyscreenshotkit's steps.json`);
  }
  return cuts.map((c) => ({ ...c, from: "given" }));
}

// The launch-film timeline written next to a film: film.mp4 has
// film.timeline.json. Used when it describes this file (its length agrees).
function timelineFor(video, duration) {
  const file = video.replace(/\.[^./\\]+$/, "") + ".timeline.json";
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || !Array.isArray(raw.clips) || !raw.clips.length) return null;
  if (Number(raw.seconds) > 0 && Math.abs(Number(raw.seconds) - duration) > 0.5) return { file, ignored: `its length, ${raw.seconds} s, is not the video's` };
  const cuts = raw.clips.map((c) => Number(c && c.start)).filter((t) => Number.isFinite(t) && t > 0.05 && t < duration - 0.05);
  return { file, cuts: cuts.map((at) => ({ at, span: LAUNCH_FILM_FADE, from: "timeline" })), clips: raw.clips };
}

// A steps.json given with --steps, read: easyscreenshotkit's steps of a
// demo, or the words the run stops with.
function readSteps(given) {
  const raw = readJson(given, "easyscreenshotkit's steps.json");
  if (!raw || raw.kind !== "demo" || !raw.video) throw new Error(`${given} is not easyscreenshotkit's steps.json (a demo's steps, with "kind": "demo")`);
  return raw;
}

// easyscreenshotkit's steps.json, given or found next to the video. Gives
// page starts (cuts), the page's box in the video and where the pointer
// pressed: [{ at, x, y, label }] in the video's pixels. One given is used
// as `read` holds it, when the run has read it already (reframe.js
// readArguments()), and read here otherwise. `name` is what the notes
// call it: its own name when that ends in .json, else steps.json, as for
// one given through a pipe, which <(...) names /dev/fd/63.
function stepsFor(video, { given = "", read = null, duration, width, height } = {}) {
  const file = given || path.join(path.dirname(video), "steps.json");
  const name = /\.json$/i.test(path.basename(file)) ? path.basename(file) : "steps.json";
  let raw;
  if (given) raw = read || readSteps(given);
  else {
    if (!fs.existsSync(file)) return null;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
    if (!raw || raw.kind !== "demo" || !raw.video) return null;
  }
  const notes = [];
  if (!given && raw.video.file && raw.video.file !== path.basename(video)) return null;
  const vw = Number(raw.video.width) || width;
  const vh = Number(raw.video.height) || height;
  if (Math.abs(Number(raw.video.duration) - duration) > 0.5) {
    if (!given) return { file, name, ignored: `its length, ${raw.video.duration} s, is not the video's` };
    notes.push(`${name} says the demo is ${raw.video.duration} s long, the video is ${duration.toFixed(2)} s; its times are used as they are.`);
  }
  // Its pixels scaled to the video's, when the video was resized since.
  const kx = width / vw;
  const ky = height / vh;
  const presses = [];
  // A press whose place is not two numbers, as ["left", "top"] in a
  // steps.json edited by hand, which easyscreenshotkit never writes: left
  // out, and said, as it names no place for the windows to go to.
  const unplaced = [];
  const coord = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN);
  for (const s of Array.isArray(raw.steps) ? raw.steps : []) {
    if (!s || !Array.isArray(s.at) || s.at.length < 2) continue;
    const at = Number.isFinite(Number(s.pressedAt)) ? Number(s.pressedAt) : Number(s.end);
    if (!Number.isFinite(at)) continue;
    const [x, y] = [coord(s.at[0]), coord(s.at[1])];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      unplaced.push(s.at);
      continue;
    }
    presses.push({ at, x: x * kx, y: y * ky, label: String(s.label || s.action || "") });
  }
  if (unplaced.length) {
    const shown = JSON.stringify(unplaced[0].slice(0, 2));
    notes.push(`${name} gives the place of ${unplaced.length === 1 ? "a press" : `${unplaced.length} presses`} as something other than two numbers of the video's pixels (${shown.length > 40 ? `${shown.slice(0, 39)}…` : shown}), so the windows do not go to ${unplaced.length === 1 ? "it" : "them"}.`);
  }
  const cuts = (Array.isArray(raw.pages) ? raw.pages : [])
    .map((p) => Number(p && p.start))
    .filter((t) => Number.isFinite(t) && t > 0.05 && t < duration - 0.05)
    .map((at) => ({ at, span: 0, from: "steps" }));
  let box = null;
  const b = raw.page && Array.isArray(raw.page.box) ? raw.page.box.map(Number) : null;
  if (b && b.length === 4 && b.every(Number.isFinite) && b[2] > 0 && b[3] > 0) box = { x: b[0] * kx, y: b[1] * ky, w: b[2] * kx, h: b[3] * ky };
  return { file, name, cuts, presses, box, notes };
}

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

function normHex(value) {
  const m = HEX.exec(String(value || "").trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}

// The background color of a brand kit: brand.json's surface color (the
// page's ground) or _brand.yml's color.background. Given the folder, the
// file or either file's path.
function brandColor(given) {
  let dir = given;
  let file = null;
  if (!fs.existsSync(given)) throw new Error(`Cannot read ${given}: no such file`);
  if (fs.statSync(given).isFile()) {
    file = given;
    dir = path.dirname(given);
  }
  const json = file && /\.json$/i.test(file) ? file : path.join(dir, "brand.json");
  const yml = file && /\.ya?ml$/i.test(file) ? file : path.join(dir, "_brand.yml");
  if (fs.existsSync(json) && (!file || file === json)) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(json, "utf8"));
    } catch (err) {
      throw new Error(`${json} is not easybrandkit's brand.json: ${err.message}`);
    }
    // A brand.json that holds no object, as null, names no color.
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
    const colors = (Array.isArray(raw.colors) ? raw.colors : []).map((c) => ({ hex: normHex(c && c.hex), role: String((c && c.role) || "") })).filter((c) => c.hex);
    const surface = colors.find((c) => c.role === "surface");
    if (surface) return { hex: surface.hex, from: `${path.basename(json)} (the page's background)` };
    const logo = (Array.isArray(raw.logos) ? raw.logos : []).map((l) => normHex(l && l.background)).find(Boolean);
    if (logo) return { hex: logo, from: `${path.basename(json)} (the ground its logo sits on)` };
  }
  if (fs.existsSync(yml) && (!file || file === yml)) {
    const text = fs.readFileSync(yml, "utf8");
    // color: ... background: "#f6f5f1", at the color block's own level.
    const block = /^color:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m.exec(text);
    const m = block && /^[ \t]{2}background:\s*["']?(#?[0-9a-fA-F]{3,6})["']?\s*$/m.exec(block[1]);
    const hex = m && normHex(m[1]);
    if (hex) return { hex, from: `${path.basename(yml)} (color.background)` };
  }
  throw new Error(`${given} names no background color: give --pad a color instead, such as --pad '#0f172a'`);
}

module.exports = { parseCuts, timelineFor, stepsFor, readSteps, brandColor, normHex, SECONDS_LIST, LAUNCH_FILM_FADE };
