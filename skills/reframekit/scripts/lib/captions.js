"use strict";

// Caption files read for the safe-area check: an ASS file says where its
// text sits, so each line's box can be estimated from its style; an SRT or
// a WebVTT file only says when, and the platform places the text itself.
//
// The box is an estimate: no font is opened. A line is taken as wide as
// its characters as they are drawn (an emoji joined from several, or a
// letter with its accents, is one), 0.55 of the font size each and a
// whole size for the wide ones of Chinese, Japanese and Korean and for
// emoji, which errs on the wide side for most fonts (DejaVu Sans Bold
// measures 0.48), wrapped at its spaces within the margins as libass wraps
// (its rows evened out, as its default WrapStyle 0 does), and each line as
// tall as 1.25 times the size, plus the outline and the shadow. Erring
// wide, a caption close to a margin can be told to reach into it though
// it fits.
//
// libass sizes the text by the frame's height against the script's
// PlayResY, and places it by the frame's width against PlayResX. When the
// script's PlayRes has another shape than the video (ffmpeg writes 384x288
// for any SRT it turns into ASS), the text comes out wider or narrower
// than its PlayResX units say, and the boxes are measured that way.

const fs = require("node:fs");

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
// What adds no width of its own: joiners, variation selectors, combining
// marks, bidi and other format marks.
const ZERO = /^[\p{M}\p{Cf}\u200B-\u200F\uFE00-\uFE0F]+$/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// A line's width in font sizes, a drawn character at a time.
function widthOf(line) {
  let sum = 0;
  for (const { segment } of graphemes.segment(line)) {
    if (ZERO.test(segment)) continue;
    sum += WIDE.test(segment) ? 1 : 0.55;
  }
  return sum;
}

const time = (text) => {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$/.exec(String(text).trim());
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
};

function readCaptions(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.code === "ENOENT" ? "no such file" : err.message}`);
  }
  if (/^\s*\[Script Info\]/i.test(text) || /\.(ass|ssa)$/i.test(file)) return readAss(text, file);
  if (/^\s*WEBVTT/.test(text) || /\.vtt$/i.test(file)) return { kind: "vtt", cues: readTimed(text), placed: false };
  if (/-->/.test(text)) return { kind: "srt", cues: readTimed(text), placed: false };
  throw new Error(`${file} is not a caption file reframekit reads (ASS, SRT or WebVTT)`);
}

// SRT and WebVTT cues: their times and text.
function readTimed(text) {
  const cues = [];
  for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    const at = lines.findIndex((l) => /-->/.test(l));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->").map((s) => s.trim().split(/\s+/)[0]);
    const norm = (s) => (s.split(":").length === 2 ? `0:${s}` : s);
    const start = time(norm(a));
    const end = time(norm(b));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    cues.push({ start, end, text: lines.slice(at + 1).join("\n").replace(/<[^>]+>/g, "") });
  }
  return cues;
}

function fields(line, format) {
  const body = line.slice(line.indexOf(":") + 1).trim();
  const parts = [];
  let rest = body;
  for (let i = 0; i < format.length - 1; i++) {
    const comma = rest.indexOf(",");
    if (comma < 0) {
      parts.push(rest);
      rest = "";
      continue;
    }
    parts.push(rest.slice(0, comma).trim());
    rest = rest.slice(comma + 1);
  }
  parts.push(rest);
  return Object.fromEntries(format.map((name, i) => [name.toLowerCase(), parts[i] === undefined ? "" : parts[i]]));
}

function readAss(text, file) {
  let section = "";
  const info = {};
  let styleFormat = null;
  let eventFormat = null;
  // The styles by name, in the order they are given, a later one of a name
  // in place of an earlier. A Map, so a style named as what every object
  // has, as constructor, toString or __proto__, is a style like any other.
  const styles = new Map();
  const events = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].toLowerCase();
      continue;
    }
    if (!line || line.startsWith(";")) continue;
    if (section === "script info") {
      const m = /^([^:]+):\s*(.*)$/.exec(line);
      if (m) info[m[1].trim().toLowerCase()] = m[2].trim();
    } else if (/styles/.test(section)) {
      if (/^Format:/i.test(line)) styleFormat = line.slice(7).split(",").map((s) => s.trim());
      else if (/^Style:/i.test(line) && styleFormat) {
        const s = fields(line, styleFormat);
        styles.set(s.name, s);
      }
    } else if (section === "events") {
      if (/^Format:/i.test(line)) {
        eventFormat = line.slice(line.indexOf(":") + 1).split(",").map((s) => s.trim());
        // A caption's times and its words, which a check needs of each.
        const lacking = ["Start", "End", "Text"].filter((name) => !eventFormat.some((f) => f.toLowerCase() === name.toLowerCase()));
        if (lacking.length) throw new Error(`${file} has no ${lacking.length > 1 ? `${lacking.slice(0, -1).join(", ")} and ${lacking[lacking.length - 1]}` : lacking[0]} in its [Events] Format line, so its captions cannot be read`);
      } else if (/^Dialogue:/i.test(line) && eventFormat) events.push(fields(line, eventFormat));
    }
  }
  const playX = Number(info.playresx) || (Number(info.playresy) ? Math.round((Number(info.playresy) * 4) / 3) : 384);
  const playY = Number(info.playresy) || (Number(info.playresx) ? Math.round((Number(info.playresx) * 3) / 4) : 288);
  const wrap = Number(info.wrapstyle) || 0;
  const cues = [];
  for (const e of events) {
    // A line's own style, else Default, as libass takes for a name it does
    // not know, else the first.
    const style = styles.get(e.style) || styles.get("Default") || styles.values().next().value || {};
    const start = time(e.start);
    const end = time(e.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const tags = (e.text.match(/\{[^}]*\}/g) || []).join("");
    // Drawings ({\p1}) are shapes, not text.
    if (/\\p[1-9]/.test(tags)) continue;
    const plain = e.text.replace(/\{[^}]*\}/g, "").replace(/\\h/g, " ");
    const lines = plain.split(/\\N|\\n/).map((l) => l.trim());
    if (!lines.some(Boolean)) continue;
    const num = (v, fallback) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : fallback);
    const fsTag = /\\fs(\d+(?:\.\d+)?)/.exec(tags);
    const size = fsTag ? Number(fsTag[1]) : num(style.fontsize, 20);
    const sx = (/\\fscx(\d+(?:\.\d+)?)/.exec(tags) ? Number(/\\fscx(\d+(?:\.\d+)?)/.exec(tags)[1]) : num(style.scalex, 100)) / 100;
    const sy = (/\\fscy(\d+(?:\.\d+)?)/.exec(tags) ? Number(/\\fscy(\d+(?:\.\d+)?)/.exec(tags)[1]) : num(style.scaley, 100)) / 100;
    const border = num(style.outline, 2) + num(style.shadow, 0);
    const marginL = num(e.marginl, 0) || num(style.marginl, 10);
    const marginR = num(e.marginr, 0) || num(style.marginr, 10);
    const marginV = num(e.marginv, 0) || num(style.marginv, 10);
    let align = num(style.alignment, 2);
    const an = /\\an([1-9])/.exec(tags);
    if (an) align = Number(an[1]);
    const pos = /\\(?:pos|move)\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(tags);
    cues.push({ start, end, text: lines.join(" / "), lines, size, sx, sy, border, marginL, marginR, marginV, align, pos: pos ? [Number(pos[1]), Number(pos[2])] : null });
  }
  if (!events.length) throw new Error(`${file} has no Dialogue lines`);
  const captions = { kind: "ass", placed: true, playX, playY, wrap, cues };
  // The boxes on a frame of the script's own shape, until a check gives
  // the video's size.
  captions.cues = boxesFor(captions, playX, playY);
  return captions;
}

// A line wrapped as libass wraps it, at its spaces, to fit `room`: the
// rows it takes and the width of the widest. WrapStyle 0 (the default)
// and 3 even the rows out, so a line a little too long for one row
// becomes two of about half its width; 1 fills each row before the next;
// 2 never wraps. A word wider than the room has a row of its own and
// reaches past the margins, as libass draws it. `unit` is the width of
// one font size.
function wrapped(line, unit, room, wrap) {
  const whole = widthOf(line) * unit;
  const words = line.split(/\s+/).filter(Boolean).map((w) => widthOf(w) * unit);
  if (wrap === 2 || whole <= room || words.length < 2) return { rows: 1, wide: whole };
  const space = 0.55 * unit;
  const pack = (limit) => {
    let rows = 1;
    let at = 0;
    let widest = 0;
    for (const w of words) {
      if (at > 0 && at + space + w > limit) {
        widest = Math.max(widest, at);
        rows++;
        at = w;
      } else at = at > 0 ? at + space + w : w;
    }
    return { rows, wide: Math.max(widest, at) };
  };
  const greedy = pack(room);
  if (wrap === 1) return greedy;
  // The narrowest rows that still take no more of them.
  let lo = Math.max(...words, whole / greedy.rows);
  let hi = Math.max(lo, greedy.wide);
  for (let i = 0; i < 30 && hi - lo > 0.01; i++) {
    const mid = (lo + hi) / 2;
    if (pack(mid).rows <= greedy.rows) hi = mid;
    else lo = mid;
  }
  return { rows: greedy.rows, wide: pack(hi).wide };
}

// Each cue's box on a frame of `width` x `height`, in shares of it.
function boxesFor(captions, width, height) {
  if (!captions.placed) return captions.cues;
  const { playX, playY, wrap } = captions;
  // How much wider the text is drawn than its PlayResX units: libass
  // scales it by height / playY, and places it by width / playX.
  const k = height / playY / (width / playX);
  return captions.cues.map((c) => {
    const room = Math.max(1, playX - c.marginL - c.marginR);
    let rows = 0;
    let wide = 0;
    for (const l of c.lines) {
      const w = wrapped(l, c.size * c.sx * k, room, wrap);
      rows += w.rows;
      wide = Math.max(wide, w.wide);
    }
    wide += 2 * c.border * k;
    const tall = rows * c.size * 1.25 * c.sy + 2 * c.border;
    const col = (c.align - 1) % 3; // 0 left, 1 center, 2 right
    const row = c.align >= 7 ? "top" : c.align >= 4 ? "middle" : "bottom";
    let x;
    let y;
    if (c.pos) {
      const [px, py] = c.pos;
      x = col === 0 ? px : col === 1 ? px - wide / 2 : px - wide;
      y = row === "top" ? py : row === "middle" ? py - tall / 2 : py - tall;
    } else {
      x = col === 0 ? c.marginL : col === 1 ? c.marginL + (room - wide) / 2 : playX - c.marginR - wide;
      y = row === "top" ? c.marginV : row === "middle" ? (playY - tall) / 2 : playY - c.marginV - tall;
    }
    return { ...c, box: { x: x / playX, y: y / playY, w: wide / playX, h: tall / playY } };
  });
}

module.exports = { readCaptions, boxesFor, widthOf };
