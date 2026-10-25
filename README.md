# AnyDown

A Chrome/Edge extension that finds the video on a page and saves it as one file.
HLS streams are fetched several segments at a time by default — the parallel
fetching is the whole point, not a paid tier.

Handles `.m3u8` (HLS), `.mp4`, `.ts`, `.webm` and `.mkv`, including HLS streams
encrypted with clear-key AES-128.

## Install

The extension is unpacked; there is no build step.

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.
4. Pin AnyDown to the toolbar. Clicking it opens the side panel.

Chrome 116 or newer is required, for the side panel API.

Chrome will warn that the extension can read data on all sites. It has to:
it watches network requests to spot streams, and fetches segments from
whatever CDN a site uses. Nothing is sent anywhere — there is no server, no
analytics, and no network traffic beyond the media you ask it to download.

## Use

1. Open the page and start playing the video. Streams only appear once the
   player requests them.
2. Open the side panel. Everything found on the current tab is listed.
3. Click **Download**. For HLS you are asked which quality you want first.
4. Watch the segment ribbon at the foot of the card fill in.

The panel is a view, not the download itself: closing it does not stop
anything, and reopening it shows the current state.

MissAV pages (`missav.ws`, `missav.ai`, `missav123.com` and siblings) are the
one exception to step 1: the stream's id is read from the page script, so the
playlist is listed before you press play.

### The segment ribbon

An HLS stream is not one file. It is thousands of small segments that have to
be fetched and stitched back together. The ribbon along the foot of each card
shows one cell per group of segments: grey for not yet fetched, amber for the
working frontier, mint for on disk.

The reason it is a ribbon and not a bar is coral. A coral cell is a segment
that failed every retry, and it stays coral for the rest of the download —
so when a file finishes with gaps, the ribbon tells you *where* in the video
they are. A percentage cannot. The file is also marked partial in the history,
with the exact count.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Parallel segments | 6 | Segments fetched at once. Higher is faster, but some servers start refusing requests. |
| Retries per segment | 3 | Attempts before a segment is skipped and the file is marked partial. |
| Save into | `AnyDown` | Subfolder of your browser's download directory. |
| Ask where to save | off | Shows the browser's save dialog for each file. |
| Send the page address | on | Sends the originating `Referer`, which many CDNs require. |

## What it will not do

- **DRM.** Streams protected by Widevine, PlayReady or FairPlay are refused
  with a message rather than half-downloaded. AnyDown does not attempt to
  break DRM. Clear-key AES-128 is supported because the key is served in the
  open next to the playlist; it is transport encryption, not rights
  management.
- **Live streams.** A playlist with no `#EXT-X-ENDLIST` has no end to download
  to, so it is refused.
- **Transcoding.** HLS output is the concatenated MPEG-TS stream, saved as
  `.ts`. It plays in VLC, mpv and most players; run it through ffmpeg if you
  need `.mp4`. Bundling a WebAssembly transcoder to remux would have cost
  ~30 MB and a slow pass over every file, for a container change.
- **Resume.** A download interrupted by a browser restart has to start again.

Whether you may download a given video is between you and whoever owns it.
This tool does not make that judgement for you.

## How it is put together

```
manifest.json
background/service-worker.js   detection, state, downloads API, message routing
offscreen/offscreen.js         the download engine: segment pool, decryption, assembly
content/detect.js              <video> elements and the page title
panel/                         the side panel
options/                       settings
lib/                           playlist parsing, AES, transfer primitives, formatting
tools/make-icons.mjs           draws the PNG icons
tests/                         node --test, no dependencies
```

Two constraints shaped this more than anything else.

**The engine cannot live in the service worker.** Manifest V3 terminates a
service worker after about 30 seconds idle, which would kill a long download
partway, and service workers have no `URL.createObjectURL` to hand the
finished file to the downloads API. Both problems go away in an offscreen
document, so that is where the work happens. The service worker keeps state
and makes the `chrome.*` calls an offscreen document is not allowed to make.

**Large files must not sit in the JS heap.** Each segment is wrapped in a
`Blob` the moment it arrives and its `ArrayBuffer` released, which moves the
bytes into Chrome's blob store — that spills to disk past its in-memory quota.
Assembling at the end is a `new Blob(parts)`, which joins by reference. The
obvious alternative, the File System Access API, needs a user gesture in a
visible document and its writable stream would die with the panel.

## Development

```bash
npm test          # node --test, no dependencies
npm run icons     # regenerate icons/*.png
```

The library layer is free of `chrome.*` and DOM access so it runs unchanged in
the browser and under Node. Everything else needs a browser, and is checked by
loading the unpacked extension against a public HLS test stream, an AES-128
stream, a direct MP4, a DRM stream (must refuse cleanly) and a live stream
(must refuse cleanly).

### Looking at the panel without a stream

`panel/preview.html` renders the panel against a stubbed `chrome.*` and a fixed
scenario — idle, quality picker, mid-download, finished-with-gaps — so the
visual states can be worked on without finding a real stream for each one.
Serve the project root and open `/panel/preview.html`:

```bash
npx http-server . -p 8731     # or any static server
```

It is a development harness, not part of the extension: nothing in
`manifest.json` refers to it, and it is not web-accessible from a page.

The design document is at
[`docs/plans/2026-08-11-anydown-design.md`](docs/plans/2026-08-11-anydown-design.md).

## License

MIT. See [LICENSE](LICENSE).
