# AnyDown — Design Document

**Date:** 2026-08-11
**Status:** Validated, ready for implementation

## 1. Purpose

A Chrome/Edge (Manifest V3) browser extension that detects streaming and direct video
resources on any page and downloads them as a single local file. Multi-threaded segment
fetching is the default behaviour, not a paid tier.

**Scope of v1:**

- Detect `.m3u8` (HLS), `.mp4`, `.ts`, `.webm`, `.mkv` and `video/*` responses.
- HLS: parse master playlist, let the user pick a quality variant, fetch segments in
  parallel, decrypt AES-128 segments, concatenate to a single `.ts` file.
- Direct files: hand off to `chrome.downloads`.
- Side panel UI with per-download progress (percent, speed, ETA), cancel, and history.

**Explicitly out of scope for v1 (YAGNI):**

- Transcoding or remuxing to `.mp4` (output is raw concatenated `.ts`).
- Live stream recording (streams without `#EXT-X-ENDLIST` are rejected with a message).
- Resume after browser restart.
- DASH (`.mpd`).
- Any attempt to circumvent DRM.

## 2. Legal and ethical boundary

The extension refuses DRM-protected content. When a playlist advertises
`SAMPLE-AES`, `SAMPLE-AES-CTR`, or a `#EXT-X-SESSION-KEY` naming a Widevine/PlayReady/
FairPlay system ID, the download is rejected with a clear message rather than attempted.
Clear-key AES-128 (`METHOD=AES-128`) is supported because the key is served in the clear
alongside the playlist; it is a transport integrity measure, not a rights-management
system.

## 3. Component architecture

| Component | File | Responsibility |
| --- | --- | --- |
| Service worker | `background/service-worker.js` | `webRequest` observation, per-tab detection state, badge, offscreen document lifecycle, message routing, `chrome.downloads` calls, DNR referer rules |
| Offscreen document | `offscreen/offscreen.js` | The download engine: playlist fetch, segment pool, AES decrypt, blob assembly |
| Content script | `content/detect.js` | DOM `<video>`/`<source>` scan, page title, MSE blob URL reporting |
| Side panel | `panel/panel.js` | Primary UI: detected list, quality picker, progress, history |
| Options page | `options/options.js` | Concurrency, retry count, filename template, clear history |

### Why an offscreen document

MV3 service workers are terminated after roughly 30 seconds of inactivity. A multi-hour
download would be killed mid-flight. A service worker also lacks `URL.createObjectURL`,
which is required to hand a large assembled file to `chrome.downloads`.

The offscreen document (reason: `BLOBS`) solves both. It stays alive while it has work,
has full DOM/Blob/`crypto.subtle` access, and fetches from the extension origin — so
`host_permissions` rather than the page's CORS policy governs access to segment URLs.

Offscreen documents may only call `chrome.runtime`. Every other extension API call
(storage, downloads) is routed to the service worker by message.

### Message graph

```
content/detect.js  ──sendMessage──▶  service-worker
panel  ◀──── port "anydown-panel" ────▶  service-worker
service-worker  ◀── port "anydown-engine" ──▶  offscreen
```

The panel port is long-lived so progress events stream without polling. The panel is a
pure view: closing it does not stop a download, and re-opening it re-subscribes to the
current job state.

## 4. Detection flow

1. `webRequest.onBeforeRequest` matches the URL path against known media extensions.
2. `webRequest.onHeadersReceived` matches `Content-Type` (`application/vnd.apple.mpegurl`,
   `application/x-mpegurl`, `video/*`) and records `Content-Length` when present. This
   catches extensionless URLs that the path matcher misses.
3. Individual HLS segments (`.ts` under a playlist we already know) are suppressed so the
   list shows the playlist, not 4000 fragments.
4. Results are deduplicated by URL and stored per `tabId` in `chrome.storage.session`.
   Navigating a tab clears its entries; closing a tab deletes them.
5. The toolbar badge shows the count for the active tab.

`onSendHeaders` captures the `Referer` for each detected media URL. `fetch` cannot set
`Referer` itself, so a scoped dynamic `declarativeNetRequest` rule injects it for the
duration of a download and is removed afterwards. Cookies come along automatically via
`credentials: 'include'` under `host_permissions`.

## 5. Download engine

### Direct file

`chrome.downloads.download({ url, filename })`. The browser handles it natively,
including range requests and its own resume.

### HLS

1. Fetch the playlist. If it contains `#EXT-X-STREAM-INF`, it is a master playlist:
   parse variants (resolution, bandwidth, codecs) and return them to the panel for the
   quality picker. Otherwise treat it as a media playlist directly.
2. Parse the chosen media playlist into an ordered segment list, resolving relative URIs
   against the playlist URL. Read `#EXT-X-KEY` (method, key URI, IV) and
   `#EXT-X-BYTERANGE`. Reject if `#EXT-X-ENDLIST` is absent (live) or the key method
   indicates DRM.
3. If encrypted, fetch the key once and import it with `crypto.subtle.importKey`. The IV
   is the explicit `IV` attribute, or the segment's media sequence number encoded as a
   128-bit big-endian integer when absent.
4. Run a bounded-concurrency pool (default 6, configurable 2–16) over the segment list.
   Each task: `fetch` → `arrayBuffer` → decrypt if needed → wrap in a per-segment `Blob`
   and release the `ArrayBuffer`.
5. Retry a failed segment up to N times with exponential backoff. After N failures the
   segment is recorded as missing and the download continues; the resulting file is
   flagged "partial" with a list of missing indices.
6. Progress (`completed`, `total`, `bytes`, `bytesPerSecond`, `etaSeconds`) is emitted at
   most every 250 ms.
7. On completion, `new Blob(segmentBlobs)` concatenates by reference, an object URL is
   created, and the service worker is asked to run `chrome.downloads.download`. The URL
   is revoked once the download item reports completion.

**Memory:** wrapping each segment in a `Blob` immediately moves its bytes into Chrome's
blob storage, which spills to disk past its in-memory quota. Only blob handles stay in
the JS heap, so multi-gigabyte files do not grow the heap proportionally. This is the
reason `showSaveFilePicker` was rejected: it needs a user gesture in a visible document,
and its writable stream would die with the panel.

## 6. Error handling

| Condition | Behaviour |
| --- | --- |
| DRM key method | Reject before downloading, explain why |
| No `#EXT-X-ENDLIST` (live) | Reject, "live streams are not supported yet" |
| Segment fails after retries | Skip, continue, mark output partial, list missing indices |
| Playlist fetch 403/404 | Fail the job with the status code surfaced in the UI |
| Empty playlist | Fail with "no segments found" |
| User cancel | Abort in-flight fetches via `AbortController`, drop blobs, remove DNR rule |
| Extension reload mid-job | Job is lost and marked incomplete; no automatic resume in v1 |

## 7. UI

Side panel, roughly 380 px wide, following `prefers-color-scheme` in both directions.

**Visual direction.** The reference points are broadcast instruments rather than a
generic download manager: a dark slate-cyan face, hairline rules, and monospaced machine
data with tabular numerals for everything the machine produced (byte counts, bitrates,
segment indices). A humanist UI sans carries names and prose; the mono face carries data
and the wide-tracked uppercase micro-labels. There is no gradient anywhere.

**Colour carries state, not decoration.** Amber is the tally light — bytes are in
transit. Mint means bytes are on disk. Coral means a segment was lost for good. Those
three are the entire accent palette, and each appears only when its state is true.

> An earlier draft of this section specified a blue→violet gradient on primary actions.
> That is the default any project gets rather than a choice this one earns, and it says
> nothing about what the extension does. Replaced by the palette above.

**Signature element: the segment ribbon.** Progress is not a bar. It is a strip of
discrete cells along the foot of each card, one per group of segments. A cell is in
exactly one of four states: empty, amber for the working frontier, mint for on disk, and
coral for a segment that failed every retry.

Coral is the reason this is a ribbon rather than a bar. A failed segment keeps its
position for the rest of the download, so a file that finishes with gaps carries a map of
where in the video they fall — something a percentage cannot express. The ribbon is a
segment integrity map first and a progress indicator second.

> A draft of this section claimed cells "light scattered across the strip" and sold that
> as showing off parallelism. That is not what the code does: `runPool` dispatches
> segments in index order from a shared cursor, so the ribbon fills left to right with a
> frontier only as wide as the concurrency setting. Claim corrected rather than the
> implementation changed — in-order dispatch is what makes ordered assembly cheap.

Drawing real positions means the engine reports *which* segment indices settled, not just
how many. The service worker folds those indices into per-cell counts so a panel opened
halfway through a download still shows the true picture.

An earlier build encoded each cell's fill *amount* into its colour as well as its state,
via `color-mix`. On screen a half-filled amber cell and a coral fault became the same
muddy tan, and the strip read as noise. Four flat states, and no gap between cells so
contiguous runs merge into one bar, fixed it.

**Layout.** Each detected item is a channel strip: a left rail carrying the vertical type
label, then title, a mono metadata line, and a download action; the ribbon spans the full
card width at its foot. Choosing an HLS item expands an inline quality picker of mono
rows. A running download replaces the action with state, percent, segment count, speed
and ETA, plus cancel.

History lists completed downloads newest first with size, timestamp, a "show in folder"
action (`chrome.downloads.show`), and a remove-from-list action that does not touch the
file.

**Copy.** Actions keep one name through the flow: Download → Downloading → Downloaded.
Errors say what happened and what to do about it; empty states invite an action rather
than setting a mood.

## 8. Repository layout

```
anydown/
├── manifest.json
├── background/service-worker.js
├── offscreen/{offscreen.html,offscreen.js}
├── content/detect.js
├── panel/{panel.html,panel.css,panel.js}
├── options/{options.html,options.css,options.js}
├── lib/{constants.js,m3u8-parser.js,crypto-aes.js,downloader.js,format.js}
├── icons/{16,32,48,128}.png
├── tools/make-icons.mjs
├── tests/*.test.js
└── docs/plans/2026-08-11-anydown-design.md
```

## 9. Permissions

`webRequest`, `downloads`, `storage`, `offscreen`, `sidePanel`, `scripting`,
`declarativeNetRequest`, and `host_permissions: <all_urls>`.

`<all_urls>` is unavoidable: the extension must observe requests and fetch segments on
arbitrary sites. Chrome will warn about reading data on all sites at install time, which
is expected for this class of tool.

## 10. Testing

Pure logic — the playlist parser, the AES helpers, the concurrency pool, and the
formatting utilities — is covered by `node --test` (no dependencies, runs outside a
browser).

Browser behaviour is verified manually by loading the unpacked extension and working
through a matrix: a public HLS test stream, an AES-128 encrypted stream, a direct MP4, a
DRM stream (must refuse cleanly), and a live stream (must warn and refuse).
