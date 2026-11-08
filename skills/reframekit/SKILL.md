---
name: reframekit
description: Make the versions of a finished video that each place takes, such as a launch film, a product demo, a screen recording or a clip from a video model going to TikTok, Reels, Shorts, the feeds, YouTube, X or LinkedIn. Writes 9:16, 4:5, 1:1 and 16:9 files with a crop that follows what moves in each shot (or the whole picture on a blurred copy where a crop would cut too much), each cut at a shot change to the place's length, kept under its file size limit and set to -14 LUFS, with a cover, crop.json and sheet.png to check and move the windows, and a check of any file against a place's limits. Use it whenever a video has to go somewhere in another shape or within a place's limits.
---

# reframekit

A video is made in one shape and every place wants another. reframekit finds the shots and where things move in each, plans a window per shot and shape, and renders each place's file within the limits the place publishes. The crop follows motion, not faces: nothing in it recognizes people or objects, so look at the windows before the files go out.

## Reframe a video

```bash
node <skill>/scripts/reframekit.js film.mp4 --for tiktok,reels,square --out video/formats
```

`<skill>` is this skill's folder. The script needs Node 22 or newer and ffmpeg 4.4 or newer on the machine; it installs nothing and needs no API key. Rendering is the slow part: a 20 second 1080p film takes about half a minute for all eight places on a fast machine, and a long video longer.

- `--for` takes tiktok, reels, shorts, youtube, x, linkedin, feed (4:5), square, all (the default) or a size such as 1080x1350.
- `--mode pad` shows every shot whole on a blurred copy of itself; `--mode fit` keeps the picture's own shape and only fits each place's limits; `--mode center` crops from the middle.
- `--pad '#0f172a'` puts padded pictures on a color (quote it: a shell drops an unquoted `#` and what follows, or write `0f172a`), and `--brand <easybrandkit folder>` on the brand's page background.
- `--seconds 30` keeps at most 30 seconds in every file, cut at a shot change. `--no-trim` never cuts to a place's length.
- A launch-film film is read with its `film.timeline.json`, whose clips are its shots, and an easyscreenshotkit demo with its `steps.json`, when they sit next to the video. `--cuts 3.2,7.5` gives the shots by hand and replaces the cuts found, so list every cut.
- A folder of an earlier run of the same video is used again: the files the run makes are replaced, and the files of places it was not asked for are kept (FORMATS.md marks them, and says when the video changed since they were made). Another video of the same name, such as the film.mp4 of another folder, gets a folder of its own when `--out` is left out; with `--out` the run stops, so give it another folder. A file reframekit did not write is never replaced; the run stops first and names it.

## Look before it renders

For anything that matters, plan first:

```bash
node <skill>/scripts/reframekit.js film.mp4 --for tiktok,reels,square --plan --out video/formats
```

1. Look at `video/formats/sheet.png` (and `sheet-2.png` and on, twelve shots to a page, ten pages at most): every shot with three of its frames (one, for a shot under 1.2 s or a video of more than 24 shots), each shape's window drawn on them in its color. A solid outline is the crop at that moment; a dashed one means the shot is padded. A video of more than 120 shots shows 120 of them, spread evenly.
2. Check that each crop holds what matters: the person, the product, the words. Words cut at a window's edge are the usual miss.
3. Fix a window in `video/formats/crop.json`: its `path` is a list of `[seconds, x, y]`, the window's top left corner in the video's pixels. One point holds it still; more points glide through them. Set `mode` to `pad` to show the shot whole, or to `follow` to crop it. To crop part of a shot and pad the rest, split it into two shots of at least 0.4 s, each with its own windows.
4. Render with the edited plan, using the command the plan printed (FORMATS.md gives it too), which starts with node and this script's path and carries the options the plan was given: `node <skill>/scripts/reframekit.js film.mp4 --crop video/formats/crop.json --for tiktok,reels,square --out video/formats`. A render prints the same kind of command, with its `--pad`, `--seconds`, `--lufs` and the rest, for the next edit. Rendered for fewer places than planned, crop.json keeps the other shapes' windows; given a place of a shape it has no windows of, the run plans that shape's windows for its shots and keeps the rest (add `--plan` to look at them first). A run without `--crop` plans again, and stops when crop.json was edited by hand.

## Use the result

1. Read `FORMATS.md` first. It lists every file with its size, length, loudness and whether it passed its place's limits, the shots and what each window did, what was cut to length and why, and every limit with the page it comes from.
2. Show `sheet.png` to the user before the files go out.
3. Each file is ready for its place as it is: `tiktok.mp4` to TikTok, `feed.mp4` to a 4:5 feed post. Its cover is next to it (`tiktok-cover.jpg`).
4. Captions go on after reframing, one file per place, so they can stay clear of each app's buttons. To check burned captions, give their ASS file: `node <skill>/scripts/reframekit.js check video/formats --captions captions.ass`. The check estimates each line's box from the ASS styles and errs wide, so look at a frame of the file before moving a caption that fails by a little.
5. For loudness, black, still and silent stretches of a finished file, use launch-film's check.

## Check files

```bash
node <skill>/scripts/reframekit.js check video/formats
node <skill>/scripts/reframekit.js check clip.mp4 --for reels,shorts
```

It writes `CHECK.md` and `check.json` into the folder it checks, or for one MP4 into a folder of its own next to it (`reframekit-check-clip/` for clip.mp4), and exits with 1 when a file fails a place's limits. A failed check is a result to read, not an error. It never replaces a `CHECK.md` or `check.json` it did not write, nor the check of another file: given with `--out` a folder that holds one, it stops and names that file.

## When it goes wrong

- A window on the wrong thing: motion stands in for the subject, so a still speaker can lose the window to something moving behind them. Move the window in `crop.json`.
- A shot padded that should be cropped, as a talking head next to a busy shelf: set its `mode` to `follow` in `crop.json`.
- Words cut by a crop: set that shot's `mode` to `pad`.
- Two shots planned as one, because a soft dissolve was not found: split the shot in `crop.json`, or give every cut with `--cuts`, which replaces the cuts found.
- A voice missing from the files: the video has more than one sound track and only the first is kept (FORMATS.md says so). Mix the tracks into one first.
- A file cut shorter than the account allows (TikTok gives some accounts 10 minutes, a verified YouTube account 12 hours): run again with `--no-trim`.
- "is not empty and holds no earlier reframekit run": pick an empty folder with `--out`.
- "is not a file reframekit wrote": a file of that name in the folder is someone's own, or was changed since reframekit wrote it (each run records every file's size and hash), or has the name of a file the run writes in other letters (Square.mp4 for square.mp4), which a disk that ignores letter case takes for the same file. Move it, or pick another folder with `--out`.
- "changed while the run went on" or "turned up while the run went on": a file the run writes or removes was saved or changed in the folder while the run rendered, so the run left the folder as it was. The finished files, made from the folder as it was before that, are in the hidden folder the error names, which stays until it is removed: look at the file, take what you need from the hidden folder, run again, then remove the hidden folder.
- "--cuts gives no cut inside the video": the cuts are another video's, or frame numbers given as seconds. Give this video's seconds, or the frames in a JSON file with their rate, as `{ "fps": 30, "cuts": [96, 225] }`. Cuts at or past the end of a video that has others inside it are left out, and FORMATS.md says so.
- "under N s of sound", as in "holds one picture under N s of sound": the file is a picture with a sound, as a cover with a talk. Hold its picture as long as the sound first, as `ffmpeg -i <video> -vf tpad=stop_mode=clone:stop_duration=N -c:v libx264 -pix_fmt yuv420p -c:a copy held.mkv` does, and reframe held.mkv. When the picture and the sound are files of their own, `ffmpeg -loop 1 -i cover.png -i talk.m4a -t N -c:v libx264 -pix_fmt yuv420p -c:a aac talk.mp4` makes the video.
- "cut short", as in "it is cut short, its media (the mdat box) running 207 KB past its end": the video was copied or downloaded only in part, or its recording stopped part way, so the media its index lists is not all there, and the run stopped before any work. Copy or download it again. When the error says to make a whole file of the part that is there, a recording that cannot be had again, as one a crash stopped, keeps that part in the file `ffmpeg -i <video> -c copy whole.mkv` makes; reframe whole.mkv. A Matroska file takes what ffmpeg cannot copy into an MP4, as an editor's ProRes, a browser's VP8 or, on ffmpeg 4.4, a camera's PCM sound. A file the error says holds none of its media, or not even the first frame of its picture whole, and one cut inside the index of a fragment (a moof box), which ffmpeg cannot open, keep nothing a copy could reframe. The check fails a finished file cut short in the same words.
- "stopped by SIGTERM, so <folder> is as it was" (or by SIGINT, SIGHUP): the run was stopped, by Ctrl-C or by whatever ran it, and left the folder as it was, as a run that fails or is refused does; run it again when it should go on. A check, or a run stopped before it took its folder, says "so nothing was written" and has written nothing. A run killed outright (kill -9, or the system when memory runs out) cannot tidy up: it leaves a hidden `.reframekit-` folder there, which for an MPEG-TS or MPEG-PS can hold a copy as large as the video, and the next run in that folder removes it once the killed run's process is gone.
- "crashed (SIGSEGV)" or "was killed (SIGKILL), as when the machine runs out of memory": ffmpeg or ffprobe ended on a file. A run stops when that file is the video or one the run makes; a file it keeps from an earlier run stays listed, failing, with a note, until a run measures it. A check of a folder fails that file's row and measures the others; a check of one MP4 stops with the error. After a crash, copy the video into a new file with another ffmpeg, such as a newer one (`ffmpeg -i <video> -c copy copy.mkv`), and reframe copy.mkv. After a kill, close what else takes memory and run again.
- "Another reframekit run (process N) is writing in": wait for that run to end. If none is going on, as after a crash, remove the hidden folder the error names.
- "no space is left on the disk", "the disk quota is used up", or "stop short of its end, as when the disk or the quota is full": the disk filled up while the run wrote, and the folder is as it was. Free some space, or give `--out` a folder on another disk. A run needs room for its files, and for an MPEG-TS or MPEG-PS a copy about as large as the video while it runs.
- "holds a run for <one video>, not for <another>": the folder given with `--out` is another video's. Give `--out` another folder.
- "was edited by hand": render that crop.json with `--crop`, or move it away to plan again. A crop.json rendered with `--crop` after an edit keeps counting as edited. To add a place of another shape, give it in `--for` with `--crop`.
- Never say a file is cleared for posting; reframekit does not check rights, and places change their limits. `FORMATS.md` says when each limit was read.
