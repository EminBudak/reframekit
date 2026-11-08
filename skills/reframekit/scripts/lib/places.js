"use strict";

// The places a video goes to, the size reframekit makes for each, and the
// limits each place states on its own pages, with the page and the day it
// was read. Guides on the web disagree (60 s or 3 min for Shorts, 140 s
// or 20 min for X), so only a place's own pages count here, and where two
// of them disagree the stricter one is kept and both are named.
//
// A limit with `hard` is one the place refuses a file over; the others are
// what it recommends, and a file that misses them is warned about, not
// failed.

const READ = "2026-11-07";

const SOURCES = {
  tiktok: {
    name: "TikTok's media transfer guide",
    title: "TikTok for Developers, Content Posting API, media transfer guide",
    url: "https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide",
    read: READ,
  },
  instagram: {
    name: "Instagram's Graph API reference",
    title: "Instagram Platform, Graph API reference, IG User Media (reels)",
    url: "https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media",
    read: READ,
  },
  metaReels: {
    name: "Meta's ads guide for Reels",
    title: "Meta Ads Guide, video ads on Instagram Reels",
    url: "https://www.facebook.com/business/ads-guide/update/video/instagram-reels",
    read: READ,
  },
  shorts: {
    name: "YouTube Help on Shorts",
    title: "YouTube Help, three-minute YouTube Shorts",
    url: "https://support.google.com/youtube/answer/15424877",
    read: READ,
  },
  youtube: {
    name: "YouTube Help on encoding",
    title: "YouTube Help, recommended upload encoding settings",
    url: "https://support.google.com/youtube/answer/1722171",
    read: READ,
  },
  youtubeLength: {
    name: "YouTube Help on long uploads",
    title: "YouTube Help, upload videos longer than 15 minutes",
    url: "https://support.google.com/youtube/answer/71673",
    read: READ,
  },
  x: {
    name: "X Help Center",
    title: "X Help Center, how to share and watch videos on X (the page refuses direct reads, so it was read through a search engine)",
    url: "https://help.x.com/en/using-x/x-videos",
    read: READ,
  },
  xApi: {
    name: "X API docs",
    title: "X API, media upload introduction",
    url: "https://docs.x.com/x-api/media/introduction",
    read: READ,
  },
  linkedin: {
    name: "LinkedIn Help",
    title: "LinkedIn Help, video sharing troubleshooting",
    url: "https://www.linkedin.com/help/linkedin/answer/a548372",
    read: READ,
  },
};

// Whose limit each page gives, as the notes name it: "the 300 MB
// Instagram takes".
const OWNERS = { tiktok: "TikTok", instagram: "Instagram", metaReels: "Instagram", shorts: "YouTube", youtube: "YouTube", youtubeLength: "YouTube", x: "X", xApi: "X", linkedin: "LinkedIn" };

// A place's "300 MB" or "4 GB" is read as millions and billions of bytes,
// the stricter reading, so a file that passes here passes either way.
const GB = 1e9;
const MB = 1e6;
const KB = 1e3;

// What Instagram's API asks of a reel, for reels and the 4:5 feed version.
const INSTAGRAM = {
  seconds: { min: 3, max: 900, hard: true, source: "instagram" },
  bytes: { max: 300 * MB, hard: true, source: "instagram" },
  fps: { min: 23, max: 60, hard: true, source: "instagram" },
  width: { max: 1920, hard: true, source: "instagram" },
  videoBitrate: { max: 25_000_000, hard: true, source: "instagram" },
  videoCodec: { allowed: ["h264", "hevc"], hard: true, source: "instagram" },
  audioCodec: { allowed: ["aac"], hard: true, source: "instagram" },
  sampleRate: { max: 48000, hard: true, source: "instagram" },
  channels: { max: 2, hard: true, source: "instagram" },
  pixFmt: { allowed: ["yuv420p", "yuvj420p"], hard: true, source: "instagram" },
  progressive: { hard: true, source: "instagram" },
  faststart: { hard: true, source: "instagram" },
  editList: { hard: true, source: "instagram" },
};

// What YouTube recommends for any upload. Recommendations, so a miss is a
// warning.
const YOUTUBE = {
  videoCodec: { allowed: ["h264"], source: "youtube" },
  audioCodec: { allowed: ["aac", "opus"], source: "youtube" },
  sampleRate: { equals: 48000, source: "youtube" },
  pixFmt: { allowed: ["yuv420p", "yuvj420p"], source: "youtube" },
  progressive: { source: "youtube" },
  faststart: { source: "youtube" },
  editList: { source: "youtube" },
  bytes: { max: 256 * GB, hard: true, source: "youtubeLength" },
};

const PLACES = {
  tiktok: {
    label: "TikTok",
    width: 1080,
    height: 1920,
    limits: {
      // Every creator can post 3 minutes; some accounts 5 or 10.
      seconds: { max: 180, hard: true, source: "tiktok", note: "Every creator can post 3 minutes; TikTok lets some accounts post 5 or 10." },
      bytes: { max: 4 * GB, hard: true, source: "tiktok" },
      fps: { min: 23, max: 60, hard: true, source: "tiktok" },
      side: { min: 360, max: 4096, hard: true, source: "tiktok" },
      videoCodec: { allowed: ["h264", "hevc", "vp8", "vp9"], hard: true, source: "tiktok" },
    },
  },
  reels: {
    label: "Instagram Reels",
    width: 1080,
    height: 1920,
    limits: INSTAGRAM,
    safe: "metaReels",
  },
  shorts: {
    label: "YouTube Shorts",
    width: 1080,
    height: 1920,
    limits: {
      ...YOUTUBE,
      seconds: { max: 180, hard: true, source: "shorts", note: "Longer than 3 minutes, or wider than square, it is a regular video, not a Short." },
      shape: { maxAspect: 1, hard: true, source: "shorts", what: "square or vertical" },
    },
  },
  youtube: {
    label: "YouTube",
    width: 1920,
    height: 1080,
    limits: {
      ...YOUTUBE,
      seconds: { max: 900, hard: true, source: "youtubeLength", note: "15 minutes is the default; an account can verify itself to upload up to 12 hours." },
    },
  },
  x: {
    label: "X",
    width: 1920,
    height: 1080,
    limits: {
      seconds: { max: 140, hard: true, source: "x", note: "Without a subscription. X's API page gives 20 minutes and 8 GB for the same accounts and says they match the app; the stricter help page is kept." },
      bytes: { max: 512 * MB, hard: true, source: "x" },
    },
  },
  linkedin: {
    label: "LinkedIn",
    width: 1920,
    height: 1080,
    limits: {
      seconds: { min: 3, max: 900, hard: true, source: "linkedin", note: "From a computer; LinkedIn's app takes videos from 2 seconds." },
      bytes: { min: 75 * KB, max: 5 * GB, hard: true, source: "linkedin" },
      fps: { min: 10, max: 60, hard: true, source: "linkedin" },
      size: { minWidth: 256, minHeight: 144, maxWidth: 4096, maxHeight: 2304, hard: true, source: "linkedin" },
      shape: { minAspect: 1 / 2.4, maxAspect: 2.4, hard: true, source: "linkedin", what: "1:2.4 to 2.4:1" },
    },
  },
  feed: {
    label: "Feeds (4:5)",
    width: 1080,
    height: 1350,
    limits: INSTAGRAM,
    note: "The 4:5 cut for the Instagram, Facebook and LinkedIn feeds, checked against Instagram's limits, the strictest of them.",
  },
  square: {
    label: "Square",
    width: 1080,
    height: 1080,
    limits: {},
    note: "The 1:1 cut for any feed. No place's limits apply; it gets the general checks.",
  },
};

const NAMES = Object.keys(PLACES);

// A shape as its smallest ratio: 1080x1920 is 9:16.
function shapeOf(width, height) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(width, height);
  const w = width / g;
  const h = height / g;
  // Near shapes are named as the shape they are close to.
  for (const [name, ratio] of [["9:16", 9 / 16], ["16:9", 16 / 9], ["4:5", 4 / 5], ["1:1", 1], ["4:3", 4 / 3], ["3:4", 3 / 4], ["2:3", 2 / 3], ["3:2", 3 / 2], ["21:9", 64 / 27]]) {
    if (Math.abs(width / height - ratio) / ratio < 0.005) return name;
  }
  return w <= 64 && h <= 64 ? `${w}:${h}` : `${(width / height).toFixed(3)}:1`;
}

// At most this many places in one run: each is an encode of its own.
const MAX_PLACES = 12;

// --for: place names and WxH sizes, comma separated, in the order given,
// without repeats.
function parsePlaces(text) {
  const items = String(text)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!items.length) throw new Error(`--for takes places such as tiktok,reels or a size such as 1080x1350`);
  const out = [];
  for (const item of items) {
    let place;
    if (item === "all") {
      for (const name of NAMES) if (!out.some((p) => p.name === name)) out.push(placeFor(name));
      continue;
    }
    // Only the places' own names: constructor or __proto__ is no place.
    if (Object.hasOwn(PLACES, item)) place = placeFor(item);
    else {
      const m = /^(\d{2,5})x(\d{2,5})$/.exec(item);
      if (!m) throw new Error(`--for does not know ${item}. It takes ${NAMES.join(", ")}, all, or a size such as 1080x1350`);
      const width = Number(m[1]);
      const height = Number(m[2]);
      if (width % 2 || height % 2) throw new Error(`--for ${item}: width and height must be even, as H.264 in 4:2:0 needs`);
      if (width < 64 || height < 64 || width > 4096 || height > 4096) throw new Error(`--for ${item}: each side takes 64 to 4096 pixels`);
      if (width > 4 * height || height > 4 * width) throw new Error(`--for ${item}: a size takes a shape from 1:4 to 4:1`);
      place = { name: item, label: item, width, height, limits: {}, custom: true };
    }
    if (!out.some((p) => p.name === place.name)) out.push(place);
  }
  if (out.length > MAX_PLACES) throw new Error(`--for takes at most ${MAX_PLACES} places in one run, not ${out.length}`);
  return out;
}

function placeFor(name) {
  const p = PLACES[name];
  return { name, label: p.label, width: p.width, height: p.height, limits: p.limits, safe: p.safe || null, note: p.note || null, custom: false };
}

// The safe area for text, as shares of the frame, where a place publishes
// one. Meta's guide for Reels ads is the only one with numbers; TikTok
// publishes template files and YouTube nothing, so for their 9:16 feeds
// the same margins stand in, and the check says so.
const SAFE = {
  metaReels: { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06, source: "metaReels" },
};

function safeAreaFor(place) {
  if (place.safe && Object.hasOwn(SAFE, place.safe)) return { ...SAFE[place.safe], standIn: false };
  if (!place.custom && place.width * 16 === place.height * 9) return { ...SAFE.metaReels, standIn: true };
  return null;
}

module.exports = { PLACES, NAMES, SOURCES, OWNERS, SAFE, READ, MAX_PLACES, parsePlaces, placeFor, shapeOf, safeAreaFor };
