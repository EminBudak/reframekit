"use strict";

// How an MP4 is laid out, read box by box from the file, never the whole
// of it: its top-level boxes, the edit lists in its index (the moov box),
// and whether the file was cut short, as when a copy or a recording
// stopped part way: a box that runs past its end, media its index lists
// that is not there, or the header of a box cut off; else whether bytes
// that make no box follow its last one.

const fs = require("node:fs");

// The boxes inside buf[from, to), each whole within it: { type, start,
// end } of its contents. A box that runs past its parent ends the list.
function boxesIn(buf, from, to) {
  const out = [];
  let p = from;
  while (p + 8 <= to && out.length < 10_000) {
    let len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    let header = 8;
    if (len === 1) {
      if (p + 16 > to) break;
      len = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (len === 0) len = to - p;
    if (len < header || p + len > to) break;
    out.push({ type, start: p + header, end: p + len });
    p += len;
  }
  return out;
}

// The boxes an MP4 or a QuickTime file has at its top level. A file is
// taken for one only when its first box is one of them, so the bytes of
// another kind of file are never read as a box cut short.
const TOP = new Set(["ftyp", "styp", "moov", "moof", "mfra", "mdat", "free", "skip", "wide", "uuid", "meta", "pdin", "sidx", "ssix", "prft", "emsg", "pnot", "udta"]);

// Where the media a track lists ends in the file, from its sample table
// (stbl): the end of its last chunk, each chunk where its offset says
// (stco, or co64 for a large file), holding as many samples as stsc says,
// of the sizes stsz gives; and where its first sample, the first of its
// first chunk, ends. { end, first }, both 0 for a track that lists none,
// as each track of a fragmented MP4 does, whose media is in its
// fragments. The work is in step with the size of the tables, never with
// the counts they claim: a file of a few KB can claim four billion samples
// a track.
function chunksEnd(buf, stbl) {
  const kids = boxesIn(buf, stbl.start, stbl.end);
  const one = (type) => kids.find((b) => b.type === type);
  const table = one("stco") || one("co64");
  if (!table || table.start + 8 > table.end) return { end: 0, first: 0 };
  const wide = table.type === "co64" ? 8 : 4;
  const count = Math.min(buf.readUInt32BE(table.start + 4), Math.floor((table.end - table.start - 8) / wide));
  // The samples' sizes: one size for all, or one each, as many as the box
  // holds.
  const stsz = one("stsz");
  let samples = 0;
  let all = 0;
  let sizeOf = () => 0;
  if (stsz && stsz.start + 12 <= stsz.end) {
    all = buf.readUInt32BE(stsz.start + 4);
    samples = buf.readUInt32BE(stsz.start + 8);
    if (!all) samples = Math.min(samples, Math.floor((stsz.end - stsz.start - 12) / 4));
    sizeOf = (k) => buf.readUInt32BE(stsz.start + 12 + 4 * k);
  }
  // The runs of chunks that hold the same number of samples: [first
  // chunk, from 1, samples in each].
  const stsc = one("stsc");
  const runs = [];
  if (stsc && stsc.start + 8 <= stsc.end) {
    const n = buf.readUInt32BE(stsc.start + 4);
    for (let i = 0; i < n && stsc.start + 8 + 12 * i + 12 <= stsc.end; i++) runs.push([buf.readUInt32BE(stsc.start + 8 + 12 * i), buf.readUInt32BE(stsc.start + 12 + 12 * i)]);
  }
  let end = 0;
  let first = 0;
  let sample = 0;
  let run = 0;
  for (let c = 0; c < count; c++) {
    while (run + 1 < runs.length && runs[run + 1][0] <= c + 1) run++;
    const each = Math.min(runs.length ? runs[run][1] : 1, samples - sample);
    let bytes = 0;
    if (all) bytes = each * all;
    else for (let k = 0; k < each; k++) bytes += sizeOf(sample + k);
    sample += each;
    const offset = wide === 8 ? Number(buf.readBigUInt64BE(table.start + 8 + 8 * c)) : buf.readUInt32BE(table.start + 8 + 4 * c);
    if (c === 0 && each > 0) first = offset + (all || sizeOf(0));
    end = Math.max(end, offset + bytes);
  }
  return { end, first };
}

// What an index (a moov box's contents) lists of the media in this file,
// as its data references (dref) say, not in another one, as a QuickTime
// reference movie's is: where the last chunk of any of its tracks ends
// (`media`, 0 when it lists none), and its tracks: [{ id, picture (its
// handler is vide), first (where its first sample ends, 0 when it lists
// none), size (the size its fragments give a sample when they give none,
// from trex) }].
function indexOf(moov) {
  const inside = (box, type) => boxesIn(moov, box.start, box.end).filter((b) => b.type === type);
  // A data reference whose flags say "in this file" (1), or none at all.
  const here = (minf) =>
    inside(minf, "dinf").every((dinf) =>
      inside(dinf, "dref").every((dref) => boxesIn(moov, dref.start + 8, dref.end).every((entry) => entry.start + 4 <= entry.end && (moov.readUInt32BE(entry.start) & 1) === 1)),
    );
  const whole = { start: 0, end: moov.length };
  const sizes = new Map();
  for (const mvex of inside(whole, "mvex")) for (const trex of inside(mvex, "trex")) if (trex.start + 20 <= trex.end) sizes.set(moov.readUInt32BE(trex.start + 4), moov.readUInt32BE(trex.start + 16));
  let media = 0;
  const tracks = [];
  for (const trak of inside(whole, "trak")) {
    // Its id, after the times, which version 1 gives in 64 bits.
    const tkhd = inside(trak, "tkhd")[0];
    const idAt = tkhd ? tkhd.start + (moov[tkhd.start] === 1 ? 20 : 12) : 0;
    const id = tkhd && idAt + 4 <= tkhd.end ? moov.readUInt32BE(idAt) : 0;
    const track = { id, picture: false, first: 0, size: sizes.get(id) || 0 };
    for (const mdia of inside(trak, "mdia")) {
      for (const hdlr of inside(mdia, "hdlr")) if (hdlr.start + 12 <= hdlr.end && moov.toString("latin1", hdlr.start + 8, hdlr.start + 12) === "vide") track.picture = true;
      for (const minf of inside(mdia, "minf")) {
        if (!here(minf)) continue;
        for (const stbl of inside(minf, "stbl")) {
          const listed = chunksEnd(moov, stbl);
          media = Math.max(media, listed.end);
          if (!track.first) track.first = listed.first;
        }
      }
    }
    tracks.push(track);
  }
  return { media, tracks };
}

// Where the first sample of the picture ends in the file, from the index
// of a fragment (a moof box's contents, `moof`, the box starting at `at`):
// the first sample of the first run (trun) of the first track fragment
// (traf) of a picture track, as the index of the file says which tracks
// are (`tracks`, indexOf()), or of any track when it names none. Its
// offset counts from the base its fragment header (tfhd) gives, else from
// the fragment's first byte, as for the first track fragment; its size is
// the run's, else the header's, else the one trex gives. null when the
// fragment has no such track fragment, undefined when where its sample
// ends cannot be told, as a later track fragment that gives no base,
// whose base is where the one before it ends.
function fragmentFirst(moof, at, tracks) {
  const pictures = new Set(tracks.filter((t) => t.picture).map((t) => t.id));
  const trafs = boxesIn(moof, 0, moof.length).filter((b) => b.type === "traf");
  for (const [k, traf] of trafs.entries()) {
    const kids = boxesIn(moof, traf.start, traf.end);
    const tfhd = kids.find((b) => b.type === "tfhd");
    const trun = kids.find((b) => b.type === "trun");
    if (!tfhd || tfhd.start + 8 > tfhd.end) continue;
    const id = moof.readUInt32BE(tfhd.start + 4);
    if ((pictures.size && !pictures.has(id)) || !trun || trun.start + 8 > trun.end || moof.readUInt32BE(trun.start + 4) === 0) continue;
    const flags = moof.readUInt32BE(tfhd.start) & 0xffffff;
    let p = tfhd.start + 8;
    let base = at;
    if (flags & 0x1) {
      if (p + 8 > tfhd.end) return undefined;
      base = Number(moof.readBigUInt64BE(p));
      p += 8;
    } else if (!(flags & 0x20000) && k > 0) return undefined;
    if (flags & 0x2) p += 4;
    if (flags & 0x8) p += 4;
    let size = (tracks.find((t) => t.id === id) || { size: 0 }).size;
    if (flags & 0x10) size = p + 4 <= tfhd.end ? moof.readUInt32BE(p) : 0;
    const runFlags = moof.readUInt32BE(trun.start) & 0xffffff;
    let q = trun.start + 8;
    let offset = 0;
    if (runFlags & 0x1) {
      if (q + 4 > trun.end) return undefined;
      offset = moof.readInt32BE(q);
      q += 4;
    }
    if (runFlags & 0x4) q += 4;
    if (runFlags & 0x100) q += 4;
    if (runFlags & 0x200) size = q + 4 <= trun.end ? moof.readUInt32BE(q) : 0;
    return size > 0 ? base + offset + size : undefined;
  }
  return null;
}

// Where the first sample of the picture ends, as the file's own index
// lists it (indexOf()): the earliest of its picture tracks, or of any
// track when it names none a picture; 0 when it lists none.
function listedFirst(tracks) {
  const pictures = tracks.filter((t) => t.picture);
  const ends = (pictures.length ? pictures : tracks).map((t) => t.first).filter((n) => n > 0);
  return ends.length ? Math.min(...ends) : 0;
}

// How many top-level boxes are read at most. A fragmented MP4 has two to
// a fragment, so a long one, as OBS records with one fragment a frame,
// has many thousands; this many take a second or so to read, 16 bytes
// each. The first thousand are listed (`boxes`).
const MOST = 1_000_000;
const LISTED = 1000;

// The top-level boxes of an MP4, and the edit lists inside its moov box.
// An edit list that only plays the whole track from its start is
// harmless; one that skips or delays is what YouTube and Instagram ask to
// leave out. Edit lists sit in moov, trak, edts and nowhere deeper, so
// those three levels are read and no others, whatever a file nests inside
// them. `mp4` says whether the file starts with a box an MP4 starts with.
// `cut` says how such a file was cut short, or is null:
// - { box, by }: that box runs past the end of the file, by `by` bytes;
// - { box: "mdat", by, missing: true }: the index lists media up to `by`
//   bytes past the end, and the file has no media box (mdat) at all, as a
//   copy that stopped where its index ends;
// - { box: "mdat", missing: true, fragment: true }: a fragmented MP4 whose
//   last box is the index of a fragment (moof), the media after it gone;
// - { box: null, header: true }: fewer bytes than a box's header are left
//   after the last whole box, where a cut can fall: in a file whose index
//   was not read, as one cut in the header of its index, or in a
//   fragmented one after the index of a fragment, or after the media of a
//   fragment when those bytes can start the header of the box that comes
//   next.
// Each says whether media the file lists is not there (`lost`). It is
// there when no box of media or index is cut and what the index lists
// ends inside the file, as in a fragmented MP4 cut in the index of its
// fragments (mfra) that some writers put at its end, which holds no
// media, or where its next fragment starts. `someMedia` says whether as
// much of the media is in the file as a copy of what is there needs: the
// first sample of its picture whole, where the index lists it (indexOf(),
// or for a fragmented MP4 the first fragment that holds the picture,
// fragmentFirst()), as ffmpeg's copy of a picture whose first frame is cut
// holds no frame (ffmpeg 8) or that one broken (4.4); where the index does
// not tell, a byte of a media box's contents. `mediaByte` says whether a
// byte of a media box's contents is in the file at all: one cut inside the
// first frame of its picture holds part of that frame, and whole samples
// of its sound when they come first, as in an MP4 that puts its sound
// before its picture. `stray` is how many bytes after the last whole box
// of a file that is not cut make no box, too few for a box's header or a
// header that names none, as the line break, the zeros or the text an
// upload can leave, else 0. `count` is how many top-level boxes were read,
// and `partial` whether the walk stopped at MOST before the end of the
// file. null when the file cannot be read as boxes at all.
function layoutOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const order = [];
    let count = 0;
    let first = null;
    let last = null;
    const has = new Set();
    let at = 0;
    let moov = null;
    let media = 0;
    // The tracks of the index (indexOf()), and where the first sample of
    // the picture ends as the first fragment that holds it gives it: null
    // until such a fragment is read, undefined when it cannot be told.
    let tracks = [];
    let fromFragment = null;
    let fragments = 0;
    let cut = null;
    // Whether a byte of the contents of a media box (mdat) is in the file.
    let mediaByte = false;
    let tail = false;
    // The walk stopped at a header that names no box.
    let loose = false;
    // The bytes of a header cut off, the walk's `tail`.
    let rest = Buffer.alloc(0);
    const head = Buffer.alloc(16);
    while (at < size && count < MOST) {
      // A header cut off: fewer than its 8 bytes, or than the 16 of one
      // that gives its size in 64 bits.
      if (at + 8 > size) {
        rest = head.subarray(0, fs.readSync(fd, head, 0, size - at, at));
        tail = true;
        break;
      }
      const got = fs.readSync(fd, head, 0, 16, at);
      let len = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      let header = 8;
      if (len === 1) {
        if (got < 16) {
          rest = head.subarray(0, got);
          tail = true;
          break;
        }
        len = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (len === 0) len = size - at;
      // A header that names no box: a size under its own header's, a type
      // that is no text, or, after the first box, a type an MP4 does not
      // have at its top level that runs past the end of the file, as a
      // line of text read as a size and a type.
      if (len < header || !/^[\x20-\x7e]{4}$/.test(type) || (first !== null && at + len > size && !TOP.has(type))) {
        loose = true;
        break;
      }
      if (first === null) first = type;
      if (at + len > size && TOP.has(type) && TOP.has(first) && !cut) cut = { box: type, by: at + len - size };
      if (order.length < LISTED) order.push(type);
      count++;
      last = type;
      has.add(type);
      if (type === "mdat" && len > header && at + header < size) mediaByte = true;
      if (type === "moov" && len < 256 * 1024 * 1024 && at + len <= size) {
        moov = Buffer.alloc(len - header);
        fs.readSync(fd, moov, 0, moov.length, at + header);
        const index = indexOf(moov);
        media = Math.max(media, index.media);
        tracks = index.tracks;
      }
      // The index of a fragment, read until one holds the picture, when
      // the file's own index lists none of its samples; a hundred at most
      // that hold none.
      if (type === "moof" && fromFragment === null && at + len <= size && len < 16 * 1024 * 1024 && !listedFirst(tracks)) {
        const moof = Buffer.alloc(len - header);
        fs.readSync(fd, moof, 0, moof.length, at + header);
        fromFragment = fragmentFirst(moof, at, tracks);
        if (fromFragment === null && ++fragments >= 100) fromFragment = undefined;
      }
      at += len;
    }
    const mp4 = first !== null && TOP.has(first);
    const firstEnd = listedFirst(tracks) || fromFragment;
    const someMedia = typeof firstEnd === "number" ? firstEnd <= size : mediaByte;
    // Whether the bytes of a header cut off after a fragment's media can
    // start the header of the box that comes next: the index of the next
    // fragment, or a box as small (moof, styp, sidx, mfra), whose size,
    // under 16 MB, starts with a 0 byte and, where its 4 bytes are there,
    // is 8 or more, or 1 for a size in 64 bits. A line break or text
    // cannot; the media after a fragment's index can be any size.
    const opens = rest.length > 0 && rest[0] === 0 && (rest.length < 4 || rest.readUInt32BE(0) >= 8 || rest.readUInt32BE(0) === 1);
    if (mp4 && !cut) {
      if (media > size && !has.has("mdat")) cut = { box: "mdat", by: media - size, missing: true };
      else if (media > size) cut = { box: "mdat", by: media - size };
      else if (last === "moof" && !tail) cut = { box: "mdat", missing: true, fragment: true };
      else if (tail && (!moov || (has.has("moof") && (last === "moof" || (last === "mdat" && opens))))) cut = { box: null, header: true };
    }
    // Media the file lists is not there when a box of media is cut, or the
    // index of the file or of a fragment, or the header after a fragment's
    // index, when its index was not read, or when it lists media past the
    // end.
    if (cut) cut.lost = ["mdat", "moov", "moof"].includes(cut.box) || (cut.header === true && last === "moof") || !moov || media > size;
    const stray = mp4 && !cut && (tail || loose) ? size - at : 0;
    const edits = [];
    const inside = (box, type) => boxesIn(moov, box.start, box.end).filter((b) => b.type === type);
    if (moov) {
      for (const trak of inside({ start: 0, end: moov.length }, "trak")) {
        for (const edts of inside(trak, "edts")) {
          for (const elst of inside(edts, "elst")) {
            // Its version and flags, its count, then the entries; one too
            // short for its count holds none.
            const entries = [];
            if (elst.start + 8 <= elst.end) {
              const version = moov[elst.start];
              const count = moov.readUInt32BE(elst.start + 4);
              const each = version ? 20 : 12;
              for (let i = 0; i < count && i < 64; i++) {
                const o = elst.start + 8 + i * each;
                if (o + each > elst.end) break;
                entries.push({ duration: Number(version ? moov.readBigUInt64BE(o) : moov.readUInt32BE(o)), mediaTime: Number(version ? moov.readBigInt64BE(o + 8) : moov.readInt32BE(o + 4)) });
              }
            }
            edits.push(entries);
          }
        }
      }
    }
    const shifting = edits.filter((entries) => entries.length > 1 || entries.some((e) => e.mediaTime !== 0));
    return {
      faststart: order.includes("moov") && order.includes("mdat") ? order.indexOf("moov") < order.indexOf("mdat") : null,
      editLists: edits.length,
      shiftingEdits: shifting.length,
      boxes: order,
      count,
      partial: count >= MOST && at < size,
      mp4,
      cut,
      someMedia,
      mediaByte,
      stray,
    };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// A thousand bytes to a KB and a million to a MB, as the limits are read;
// under a KB, the bytes.
const bytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} byte${n === 1 ? "" : "s"}`);
const BOXES = { moov: "its index (the moov box)", mdat: "its media (the mdat box)", moof: "the index of a fragment (a moof box)", mfra: "the index of its fragments (the mfra box)" };

// What a cut says: "cut short, its media (the mdat box) running 150 KB
// past its end", "cut short, its media (the mdat box) missing".
function cutText(cut) {
  if (cut.header) return "cut short in the header of its last box";
  if (cut.fragment) return "cut short, the media of its last fragment (an mdat box) missing";
  const box = BOXES[cut.box] || `its ${cut.box} box`;
  return cut.missing ? `cut short, ${box} missing` : `cut short, ${box} running ${bytes(cut.by)} past its end`;
}

// What the bytes after the last box (layoutOf()'s `stray`) come to: "3
// bytes after its last box".
const strayText = (n) => `${bytes(n)} after its last box`;

module.exports = { boxesIn, layoutOf, cutText, strayText, MOST };
