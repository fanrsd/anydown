/**
 * Service worker: detection, state, and the bridge between the panel and the
 * offscreen engine.
 *
 * It deliberately does no downloading itself. MV3 terminates a service worker
 * after ~30 seconds idle, so anything long-running lives in the offscreen
 * document; the worker only routes messages and calls the extension APIs the
 * offscreen document is not allowed to touch.
 */

import {
  DEFAULT_SETTINGS,
  ENGINE_PORT,
  JobState,
  MediaKind,
  OUTPUT_EXTENSION,
  PANEL_PORT,
  STORAGE_HISTORY,
  STORAGE_SETTINGS,
  directoryOf,
  isAmbiguousContentType,
  kindFromContentType,
  kindFromUrl,
  mediaKey,
} from '../lib/constants.js';
import { buildDownloadPath, suggestFilename } from '../lib/format.js';
import { isPlaylist } from '../lib/m3u8-parser.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

/** Detected media per tab: `tabId -> Map<mediaKey, MediaItem>`. */
const mediaByTab = new Map();
/** Live panel ports, so every open panel sees the same events. */
const panelPorts = new Set();
/** The single port to the offscreen engine, when it is running. */
let enginePort = null;
/** Jobs the engine is working on or has finished: `jobId -> JobStatus`. */
const jobs = new Map();
/** `downloadId -> objectUrl`, so the URL is revoked once Chrome is done. */
const pendingObjectUrls = new Map();
/** Serialises offscreen document creation against concurrent callers. */
let offscreenCreating = null;
/** Rolling id for `declarativeNetRequest` session rules. */
let nextRuleId = 1;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_SETTINGS] ?? {}) };
}

async function saveSettings(patch) {
  const merged = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [STORAGE_SETTINGS]: merged });
  return merged;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Directories of playlists we already list, keyed by tab. */
const knownPlaylistPrefixes = new Map();

function tabMedia(tabId) {
  let media = mediaByTab.get(tabId);
  if (!media) {
    media = new Map();
    mediaByTab.set(tabId, media);
  }
  return media;
}

/**
 * Requests made by a page's own service worker, or by a frame Chrome cannot
 * attribute, arrive with `tabId` -1. They still belong to whatever the user
 * is looking at, so fall back to the active tab instead of dropping them.
 */
let activeTabId = -1;
chrome.tabs
  .query({ active: true, lastFocusedWindow: true })
  .then(([tab]) => {
    if (tab) activeTabId = tab.id;
  })
  .catch(() => {});

function resolveTabId(details) {
  return details.tabId >= 0 ? details.tabId : activeTabId;
}

/**
 * Does this URL belong to a stream already on the list?
 *
 * A playlist's own directory holds its segments, its per-quality variant
 * playlists, its audio renditions and its subtitle tracks — all of them parts
 * of one video. Listed separately they bury the entry the user actually
 * wants under dozens of near-identical ones.
 */
function isUnderKnownPlaylist(tabId, url) {
  const prefixes = knownPlaylistPrefixes.get(tabId);
  if (!prefixes) return false;
  for (const prefix of prefixes) {
    if (url.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Endpoints that served a playlist: `tabId -> Set<origin + pathname>`.
 *
 * Sites that proxy media through one path have no directory to suppress by —
 * `directoryOf` refuses a path like `/s`, and rightly so, since its directory
 * is the host root. The endpoint itself is the unit that works there.
 */
const knownPlaylistEndpoints = new Map();

/** Origin and path with the query dropped, or null when unparseable. */
function endpointOf(url) {
  try {
    const { origin, pathname } = new URL(url);
    return origin + pathname;
  } catch {
    return null;
  }
}

/** Remember where a playlist came from, so its parts stay hidden. */
function rememberPlaylistLocation(tabId, url) {
  const endpoint = endpointOf(url);
  if (endpoint) {
    let endpoints = knownPlaylistEndpoints.get(tabId);
    if (!endpoints) {
      endpoints = new Set();
      knownPlaylistEndpoints.set(tabId, endpoints);
    }
    endpoints.add(endpoint);
  }

  const prefix = directoryOf(url);
  // Unparseable, or a playlist at the host root whose directory would swallow
  // every other file on that host. Either way, no directory suppression.
  if (!prefix) return;

  let prefixes = knownPlaylistPrefixes.get(tabId);
  if (!prefixes) {
    prefixes = new Set();
    knownPlaylistPrefixes.set(tabId, prefixes);
  }
  prefixes.add(prefix);
}

/**
 * A non-playlist arriving from an endpoint that already served a playlist is
 * one of that playlist's segments. Listing it separately buries the entry the
 * user wants under one row per segment.
 */
function isSegmentOfKnownPlaylist(tabId, item) {
  if (item.kind === MediaKind.HLS) return false;
  const endpoint = endpointOf(item.url);
  return endpoint != null && (knownPlaylistEndpoints.get(tabId)?.has(endpoint) ?? false);
}

/**
 * Remove already-listed segments that belong to a playlist just discovered on
 * the same endpoint. Detection order is not ours to control: a segment seen
 * before its playlist earns a row that turns out to be part of another entry.
 */
function dropSegmentsOf(tabId, media, playlistUrl) {
  const endpoint = endpointOf(playlistUrl);
  if (!endpoint) return;

  for (const [key, listed] of media) {
    if (listed.kind === MediaKind.HLS) continue;
    if (endpointOf(listed.url) !== endpoint) continue;
    media.delete(key);
    broadcastToPanels({ type: 'media-removed', tabId, key });
  }
}

/** Record a detected media resource and tell any open panel about it. */
function recordMedia(tabId, item) {
  if (tabId < 0) return;

  const media = tabMedia(tabId);
  const key = mediaKey(item.url);
  const existing = media.get(key);

  if (existing) {
    // Once a key is known to be a playlist, a later sighting typed as a plain
    // segment must not take it over: its URL and kind together would send the
    // text file down the direct-download path and save it as if it were the
    // video.
    const downgrade =
      existing.kind === MediaKind.HLS && item.kind != null && item.kind !== MediaKind.HLS;

    // Later observations often carry detail the first one lacked.
    Object.assign(existing, {
      // The newest sighting carries the freshest signing token. Keeping the
      // first one would hand the engine a URL that has since expired.
      url: downgrade ? existing.url : item.url,
      size: item.size ?? existing.size,
      kind: downgrade ? MediaKind.HLS : (item.kind ?? existing.kind),
      referer: item.referer ?? existing.referer,
      title: existing.title || item.title,
    });
    broadcastToPanels({ type: 'media-updated', tabId, item: existing });
    return;
  }

  if (isUnderKnownPlaylist(tabId, item.url)) return;
  if (isSegmentOfKnownPlaylist(tabId, item)) return;
  if (item.kind === MediaKind.HLS) {
    rememberPlaylistLocation(tabId, item.url);
    // The panel is often opened mid-playback, so segments from this endpoint
    // may already be listed. They are parts of what we just found.
    dropSegmentsOf(tabId, media, item.url);
  }

  media.set(key, item);
  updateBadge(tabId);
  broadcastToPanels({ type: 'media-added', tabId, item });
}

/** Requests whose Referer is worth keeping for later segment fetches. */
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const tabId = resolveTabId(details);
    if (tabId < 0) return;
    if (!kindFromUrl(details.url)) return;
    const referer = details.requestHeaders?.find(
      (header) => header.name.toLowerCase() === 'referer',
    )?.value;
    if (!referer) return;
    const existing = tabMedia(tabId).get(mediaKey(details.url));
    if (existing && !existing.referer) existing.referer = referer;
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders'],
);

/** First pass: classify by URL, which catches most streaming CDNs. */
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const tabId = resolveTabId(details);
    if (tabId < 0) return;
    // Our own segment fetches must not feed back into the detected list.
    if (details.initiator?.startsWith('chrome-extension://')) return;

    const kind = kindFromUrl(details.url);
    if (!kind) return;

    recordMedia(tabId, {
      url: details.url,
      kind,
      size: null,
      title: null,
      referer: details.documentUrl ?? null,
      detectedAt: Date.now(),
      source: 'network',
    });
  },
  // No `types` filter: classification below already rejects everything that is
  // not media, and a filter only hides players that fetch under an unexpected
  // resource type.
  { urls: ['<all_urls>'] },
);

/** Media keys already sniffed, so one URL costs at most one extra request. */
const sniffed = new Set();

/** Bodies larger than this are not playlists; a playlist is small text. */
const MAX_SNIFF_SIZE = 4 * 1024 * 1024;

/**
 * Third pass: read the first bytes of an ambiguously typed response and see
 * whether it is really an HLS playlist.
 *
 * Costs one range request, only for responses whose `Content-Type` carried no
 * information at all, and only once per stream.
 *
 * The page's own Referer is injected for the duration: CDNs that gate on it
 * answer 403 to a bare fetch, which used to make this pass silently useless
 * on exactly the sites that need it most.
 */
async function sniffForPlaylist(tabId, url, size, referer) {
  if (size !== null && size > MAX_SNIFF_SIZE) return;

  const key = mediaKey(url);
  if (sniffed.has(key)) return;
  sniffed.add(key);

  const ruleId = await addRefererRule(referer);
  try {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Range: 'bytes=0-1023' },
    });
    if (!response.ok) {
      console.warn(`AnyDown: sniff of ${url} returned HTTP ${response.status}`);
      return;
    }
    if (!isPlaylist(await response.text())) return;

    recordMedia(tabId, {
      url,
      kind: MediaKind.HLS,
      size: null,
      title: null,
      referer: referer ?? null,
      detectedAt: Date.now(),
      source: 'sniff',
    });
  } catch (error) {
    // Offline, CORS, or the URL already expired. Detection carries on without
    // it, but a zero-result page should not be a mystery.
    console.warn(`AnyDown: sniff of ${url} failed:`, error);
  } finally {
    await removeRefererRule(ruleId);
  }
}

/** Second pass: classify by Content-Type, which catches extensionless URLs. */
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const tabId = resolveTabId(details);
    if (tabId < 0) return;
    if (details.initiator?.startsWith('chrome-extension://')) return;

    const headers = details.responseHeaders ?? [];
    const header = (name) =>
      headers.find((candidate) => candidate.name.toLowerCase() === name)?.value ?? null;

    const contentType = header('content-type');
    const length = Number(header('content-length'));
    const size = Number.isFinite(length) && length > 0 ? length : null;

    const referer = details.documentUrl ?? details.initiator ?? null;
    const kind = kindFromContentType(contentType) ?? kindFromUrl(details.url);
    if (!kind) {
      // Neither the type nor the URL said anything. If the type said *nothing
      // useful* rather than something unrelated, the body is worth a peek.
      if (isAmbiguousContentType(contentType)) {
        sniffForPlaylist(tabId, details.url, size, referer);
      }
      return;
    }

    recordMedia(tabId, {
      url: details.url,
      kind,
      size,
      title: null,
      referer,
      detectedAt: Date.now(),
      source: 'network',
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

/**
 * Navigating a tab invalidates everything found in it. `tabs.onUpdated` with
 * a URL change covers this without needing the `webNavigation` permission.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) clearTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaByTab.delete(tabId);
  knownPlaylistPrefixes.delete(tabId);
  knownPlaylistEndpoints.delete(tabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  updateBadge(tabId);
});

function clearTab(tabId) {
  mediaByTab.delete(tabId);
  knownPlaylistPrefixes.delete(tabId);
  knownPlaylistEndpoints.delete(tabId);
  // ponytail: cleared for every tab, not just this one. Costs at most one
  // repeat sniff after someone else navigates; key by tab if that ever shows.
  sniffed.clear();
  updateBadge(tabId);
  broadcastToPanels({ type: 'tab-cleared', tabId });
}

async function updateBadge(tabId) {
  const count = mediaByTab.get(tabId)?.size ?? 0;
  try {
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6366f1' });
  } catch {
    // The tab can disappear between the count and the call; nothing to do.
  }
}

// ---------------------------------------------------------------------------
// Offscreen engine lifecycle
// ---------------------------------------------------------------------------

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

// An offscreen document alive when the worker boots belongs to a previous
// worker life: its port died with that worker and it never reconnects, and
// this worker has no record of its jobs. Close it so the next send recreates
// a document that connects back.
const orphanSweep = chrome.offscreen.closeDocument().catch(() => {});

/**
 * Create the offscreen document if it is not already running. Concurrent
 * callers share one creation promise: `createDocument` throws if a document
 * already exists, and two downloads started together would race.
 */
async function ensureOffscreenDocument() {
  await orphanSweep;
  if (await hasOffscreenDocument()) return;

  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS'],
        justification:
          'Assembles downloaded video segments into a single Blob and keeps long downloads alive.',
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }

  try {
    await offscreenCreating;
  } catch (error) {
    // Losing the race is fine as long as the document ended up existing.
    if (!(await hasOffscreenDocument())) throw error;
  }
}

/** Send a command to the engine, starting it first if necessary. */
async function sendToEngine(message) {
  await ensureOffscreenDocument();
  if (!enginePort) {
    // The engine connects back on startup; wait briefly for that to land.
    await waitForEnginePort();
  }
  enginePort.postMessage(message);
}

function waitForEnginePort(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (enginePort) {
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('The download engine did not start'));
      } else {
        setTimeout(poll, 50);
      }
    };
    poll();
  });
}

/** Shut the engine down once nothing is in flight, to release its memory. */
async function closeEngineIfIdle() {
  const busy = [...jobs.values()].some((job) =>
    [JobState.QUEUED, JobState.PROBING, JobState.DOWNLOADING, JobState.ASSEMBLING, JobState.SAVING]
      .includes(job.state),
  );
  if (busy) return;
  if (pendingObjectUrls.size > 0) return;

  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument().catch(() => {});
    enginePort = null;
  }
}

// ---------------------------------------------------------------------------
// Referer injection
// ---------------------------------------------------------------------------

/**
 * Many CDNs reject segment requests without the originating page's Referer,
 * and `fetch` is not allowed to set that header itself. A session-scoped
 * declarativeNetRequest rule adds it to requests the extension itself
 * initiates, and removes it when the job ends.
 *
 * The rule is deliberately not narrowed to the playlist's host. Segments and
 * AES keys routinely live on a different host from the playlist that names
 * them, and those are exactly the requests a CDN rejects for a missing
 * Referer. `tabIds: [TAB_ID_NONE]` already confines this to our own fetches,
 * so no page request is touched.
 *
 * @returns {Promise<number|null>} the rule id to remove later
 */
async function addRefererRule(referer) {
  let origin;
  try {
    origin = new URL(referer).origin;
  } catch {
    return null;
  }

  const id = nextRuleId++;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            // Mirror what the page itself sends cross-origin: an origin-only
            // Referer and its Origin. Without Origin the request carries
            // chrome-extension://…, which CDNs like surrit.com answer with 403.
            requestHeaders: [
              { header: 'Referer', operation: 'set', value: `${origin}/` },
              { header: 'Origin', operation: 'set', value: origin },
            ],
          },
          condition: {
            resourceTypes: ['xmlhttprequest'],
            tabIds: [chrome.tabs.TAB_ID_NONE],
          },
        },
      ],
    });
    return id;
  } catch {
    // Referer injection is best-effort; the download still gets a chance.
    return null;
  }
}

/** Referer rules held for an in-flight `probe`, keyed by job id. */
const probeRules = new Map();

async function dropProbeRule(jobId) {
  const ruleId = probeRules.get(jobId);
  probeRules.delete(jobId);
  await removeRefererRule(ruleId);
}

async function removeRefererRule(ruleId) {
  if (ruleId == null) return;
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [ruleId] })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function getHistory() {
  const stored = await chrome.storage.local.get(STORAGE_HISTORY);
  return stored[STORAGE_HISTORY] ?? [];
}

async function addHistoryEntry(entry) {
  const { historyLimit } = await getSettings();
  const history = [entry, ...(await getHistory())].slice(0, historyLimit);
  await chrome.storage.local.set({ [STORAGE_HISTORY]: history });
  broadcastToPanels({ type: 'history-changed', history });
}

async function removeHistoryEntry(id) {
  const history = (await getHistory()).filter((entry) => entry.id !== id);
  await chrome.storage.local.set({ [STORAGE_HISTORY]: history });
  broadcastToPanels({ type: 'history-changed', history });
}

async function clearHistory() {
  await chrome.storage.local.set({ [STORAGE_HISTORY]: [] });
  broadcastToPanels({ type: 'history-changed', history: [] });
}

// ---------------------------------------------------------------------------
// Job orchestration
// ---------------------------------------------------------------------------

function updateJob(jobId, patch) {
  const job = { ...(jobs.get(jobId) ?? { id: jobId }), ...patch };
  jobs.set(jobId, job);
  broadcastToPanels({ type: 'job-updated', job });
  return job;
}

/**
 * Cells in the panel's segment ribbon. A stream can have thousands of
 * segments and the panel is 380px wide, so segments are grouped into cells.
 */
const RIBBON_CELLS = 48;

/** Which ribbon cell a segment index belongs to. */
function cellFor(index, total, cells) {
  return Math.min(cells - 1, Math.floor((index * cells) / total));
}

/**
 * How many segment indices land in each cell under {@link cellFor}.
 *
 * This has to be the exact inverse of `cellFor`, not merely close to it.
 * The obvious `floor((cell + 1) * total / cells) - floor(cell * total / cells)`
 * is not: with 1140 segments over 48 cells it puts index 23 in cell 0 while
 * claiming cell 0 holds 23 indices, so some cells overfill and their
 * neighbours never reach capacity — leaving cells stuck on the amber
 * "in flight" state for the whole download.
 *
 * The first index in cell c is ceil(c * total / cells), written with integer
 * arithmetic so no rounding can creep in.
 */
function ribbonCapacity(total, cells) {
  const firstIndexIn = (cell) => Math.floor((cell * total + cells - 1) / cells);
  return Array.from({ length: cells }, (_, cell) => firstIndexIn(cell + 1) - firstIndexIn(cell));
}

/**
 * Fold settled segment indices into per-cell counts.
 *
 * The engine reports indices rather than a running total because the panel
 * draws *where* progress happened, and a concurrent pool finishes segments
 * out of order. Accumulating here rather than in the panel means a panel
 * opened halfway through a download still sees the true picture.
 */
function foldIntoRibbon(job, message) {
  const total = message.total ?? 0;
  if (total <= 0) return null;

  const cells = Math.min(total, RIBBON_CELLS);
  const ribbon = job.ribbon?.cells === cells
    ? job.ribbon
    : {
        cells,
        // How many segments each cell stands for, so a cell only turns mint
        // once every segment behind it has actually landed.
        capacity: ribbonCapacity(total, cells),
        done: new Array(cells).fill(0),
        faulted: new Array(cells).fill(0),
      };

  for (const index of message.settled ?? []) ribbon.done[cellFor(index, total, cells)]++;
  for (const index of message.faulted ?? []) ribbon.faulted[cellFor(index, total, cells)]++;

  return ribbon;
}

/**
 * Start a download. Direct files go to `chrome.downloads`, which handles
 * ranges and resume natively; HLS goes to the offscreen engine.
 */
async function startDownload(request) {
  const settings = await getSettings();
  const jobId = request.jobId ?? crypto.randomUUID();
  const name = request.filename || suggestFilename({ title: request.title, url: request.url });

  if (request.kind !== MediaKind.HLS) {
    return startDirectDownload({ ...request, jobId, name, settings });
  }

  const ruleId = settings.sendReferer ? await addRefererRule(request.referer) : null;

  updateJob(jobId, {
    url: request.url,
    kind: request.kind,
    name,
    state: JobState.PROBING,
    completed: 0,
    total: 0,
    bytes: 0,
    ruleId,
    startedAt: Date.now(),
  });

  try {
    await sendToEngine({
      type: 'start',
      jobId,
      url: request.url,
      name,
      variantUrl: request.variantUrl ?? null,
      concurrency: settings.concurrency,
      maxRetries: settings.maxRetries,
    });
  } catch (error) {
    await removeRefererRule(ruleId);
    updateJob(jobId, { state: JobState.FAILED, error: error.message });
  }

  return jobId;
}

/**
 * `chrome.downloads.download` resolves as soon as the transfer *starts*, so
 * the job stays in flight until `onChanged` reports a terminal state. Marking
 * it done here would report 100% instantly for a file of any size.
 */
async function startDirectDownload({ url, kind, jobId, name, settings, referer }) {
  const ruleId = settings.sendReferer ? await addRefererRule(referer) : null;
  const extension = OUTPUT_EXTENSION[kind] ?? 'mp4';

  updateJob(jobId, {
    url,
    kind,
    name,
    state: JobState.SAVING,
    startedAt: Date.now(),
    ruleId,
  });

  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: buildDownloadPath(settings.subfolder, name, extension),
      saveAs: settings.saveAs,
    });
    directJobs.set(downloadId, { jobId, name, url, kind, extension });
    updateJob(jobId, { downloadId });
  } catch (error) {
    updateJob(jobId, { state: JobState.FAILED, error: error.message });
    await removeRefererRule(ruleId);
  }

  return jobId;
}

/** Direct downloads Chrome is still writing: `downloadId -> job details`. */
const directJobs = new Map();

/** Settle a direct download once Chrome reports it finished or gave up. */
async function finishDirectDownload(delta) {
  const entry = directJobs.get(delta.id);
  if (!entry) return;

  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  directJobs.delete(delta.id);

  const job = jobs.get(entry.jobId);
  await removeRefererRule(job?.ruleId);

  if (state === 'interrupted') {
    updateJob(entry.jobId, {
      state: JobState.FAILED,
      error: delta.error?.current ?? 'The download was interrupted',
    });
    return;
  }

  // `fileSize` is the bytes actually written; `totalBytes` may be unknown for
  // a chunked response, so the real size is worth reading back either way.
  const [record] = await chrome.downloads.search({ id: delta.id }).catch(() => []);
  const bytes = record?.fileSize || delta.fileSize?.current || null;

  updateJob(entry.jobId, { state: JobState.DONE, bytes, finishedAt: Date.now() });
  await addHistoryEntry({
    id: entry.jobId,
    name: `${entry.name}.${entry.extension}`,
    url: entry.url,
    kind: entry.kind,
    downloadId: delta.id,
    bytes,
    finishedAt: Date.now(),
    partial: false,
  });
}

/**
 * The engine finished assembling a file. Only the service worker may call
 * `chrome.downloads`, so the object URL crosses over here to be saved.
 */
async function saveAssembledFile(payload) {
  const settings = await getSettings();
  const job = jobs.get(payload.jobId) ?? {};
  // The engine names the container when it knows it: a muxed stream lands as
  // MP4, not as the raw transport stream the HLS default assumes.
  const extension = payload.extension ?? OUTPUT_EXTENSION[MediaKind.HLS];

  updateJob(payload.jobId, { state: JobState.SAVING });

  try {
    const downloadId = await chrome.downloads.download({
      url: payload.objectUrl,
      filename: buildDownloadPath(settings.subfolder, payload.name, extension),
      saveAs: settings.saveAs,
    });

    // The engine owns the object URL, so it must be told when to revoke it.
    pendingObjectUrls.set(downloadId, { jobId: payload.jobId, objectUrl: payload.objectUrl });

    updateJob(payload.jobId, {
      state: JobState.DONE,
      downloadId,
      bytes: payload.bytes,
      missing: payload.missing ?? [],
      finishedAt: Date.now(),
    });

    // A stream whose audio is a separate rendition produces a second file.
    // Muxing needs a demuxer/remuxer this extension does not carry, so both
    // land on disk rather than one of them being silently dropped.
    let audioName = null;
    if (payload.audio) {
      audioName = `${payload.name}.audio`;
      const audioDownloadId = await chrome.downloads.download({
        url: payload.audio.objectUrl,
        filename: buildDownloadPath(settings.subfolder, audioName, payload.audio.extension),
        saveAs: settings.saveAs,
      });
      pendingObjectUrls.set(audioDownloadId, {
        jobId: payload.jobId,
        objectUrl: payload.audio.objectUrl,
      });
      audioName = `${audioName}.${payload.audio.extension}`;
      updateJob(payload.jobId, { audioName, audioBytes: payload.audio.bytes });
    }

    await addHistoryEntry({
      id: payload.jobId,
      name: `${payload.name}.${extension}`,
      url: job.url ?? null,
      kind: MediaKind.HLS,
      downloadId,
      bytes: payload.bytes,
      finishedAt: Date.now(),
      partial: (payload.missing?.length ?? 0) > 0,
      missingCount: payload.missing?.length ?? 0,
      audioName,
    });
  } catch (error) {
    updateJob(payload.jobId, { state: JobState.FAILED, error: error.message });
    enginePort?.postMessage({ type: 'release', objectUrl: payload.objectUrl });
    if (payload.audio) {
      enginePort?.postMessage({ type: 'release', objectUrl: payload.audio.objectUrl });
    }
  } finally {
    await removeRefererRule(job.ruleId);
  }
}

/** Settle direct downloads, and revoke object URLs Chrome is done with. */
chrome.downloads.onChanged.addListener(async (delta) => {
  await finishDirectDownload(delta);

  const pending = pendingObjectUrls.get(delta.id);
  if (!pending) return;
  const finished = delta.state?.current === 'complete' || delta.state?.current === 'interrupted';
  if (!finished) return;

  pendingObjectUrls.delete(delta.id);
  enginePort?.postMessage({ type: 'release', objectUrl: pending.objectUrl });
  await closeEngineIfIdle();
});

async function cancelJob(jobId) {
  const job = jobs.get(jobId);
  updateJob(jobId, { state: JobState.CANCELLED });
  enginePort?.postMessage({ type: 'cancel', jobId });

  // A direct download lives in Chrome, not in the engine, so it needs telling.
  if (job?.downloadId != null && directJobs.delete(job.downloadId)) {
    await chrome.downloads.cancel(job.downloadId).catch(() => {});
  }

  await removeRefererRule(job?.ruleId);
  await closeEngineIfIdle();
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

function broadcastToPanels(message) {
  for (const port of panelPorts) {
    try {
      port.postMessage(message);
    } catch {
      panelPorts.delete(port);
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === ENGINE_PORT) {
    enginePort = port;
    port.onMessage.addListener(handleEngineMessage);
    port.onDisconnect.addListener(() => {
      enginePort = null;
      // Anything still running died with the document; say so rather than
      // leaving a progress bar frozen at whatever it last reported.
      for (const [jobId, job] of jobs) {
        if ([JobState.PROBING, JobState.DOWNLOADING, JobState.ASSEMBLING].includes(job.state)) {
          updateJob(jobId, { state: JobState.FAILED, error: 'The download engine stopped' });
        }
      }
    });
    return;
  }

  if (port.name === PANEL_PORT) {
    panelPorts.add(port);
    port.onMessage.addListener((message) => handlePanelMessage(message, port));
    port.onDisconnect.addListener(() => panelPorts.delete(port));
  }
});

async function handleEngineMessage(message) {
  switch (message.type) {
    case 'progress': {
      const job = jobs.get(message.jobId) ?? {};
      updateJob(message.jobId, {
        state: message.state ?? JobState.DOWNLOADING,
        completed: message.completed,
        total: message.total,
        bytes: message.bytes,
        bytesPerSecond: message.bytesPerSecond,
        etaSeconds: message.etaSeconds,
        failed: message.failed,
        ribbon: foldIntoRibbon(job, message) ?? job.ribbon,
      });
      break;
    }

    case 'variants':
      await dropProbeRule(message.jobId);
      updateJob(message.jobId, { state: JobState.PROBING, variants: message.variants });
      broadcastToPanels({ type: 'variants', jobId: message.jobId, variants: message.variants });
      break;

    case 'assembled':
      await saveAssembledFile(message);
      break;

    case 'failed': {
      const job = jobs.get(message.jobId);
      await dropProbeRule(message.jobId);
      updateJob(message.jobId, { state: JobState.FAILED, error: message.error });
      await removeRefererRule(job?.ruleId);
      await closeEngineIfIdle();
      break;
    }

    case 'cancelled':
      updateJob(message.jobId, { state: JobState.CANCELLED });
      await closeEngineIfIdle();
      break;

    default:
      break;
  }
}

async function handlePanelMessage(message, port) {
  switch (message.type) {
    case 'hello': {
      const tabId = message.tabId;
      port.postMessage({
        type: 'state',
        tabId,
        items: [...(mediaByTab.get(tabId)?.values() ?? [])],
        jobs: [...jobs.values()],
        history: await getHistory(),
        settings: await getSettings(),
      });
      break;
    }

    case 'start':
      await startDownload(message.request);
      break;

    case 'probe': {
      // Ask the engine for the variant list without committing to a download.
      // The master playlist is gated like the segments, so it gets the page's
      // headers too; the rule is dropped when the engine answers.
      const { sendReferer } = await getSettings();
      const ruleId = sendReferer ? await addRefererRule(message.referer) : null;
      if (ruleId != null) probeRules.set(message.jobId, ruleId);
      try {
        await sendToEngine({ type: 'probe', jobId: message.jobId, url: message.url });
      } catch (error) {
        await dropProbeRule(message.jobId);
        port.postMessage({ type: 'probe-failed', jobId: message.jobId, error: error.message });
      }
      break;
    }

    case 'cancel':
      await dropProbeRule(message.jobId);
      await cancelJob(message.jobId);
      break;

    case 'clear-tab':
      clearTab(message.tabId);
      break;

    case 'remove-history':
      await removeHistoryEntry(message.id);
      break;

    case 'clear-history':
      await clearHistory();
      break;

    case 'save-settings':
      port.postMessage({ type: 'settings', settings: await saveSettings(message.settings) });
      break;

    case 'show-download':
      chrome.downloads.show(message.downloadId);
      break;

    case 'open-options':
      chrome.runtime.openOptionsPage();
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Miscellaneous wiring
// ---------------------------------------------------------------------------

/** Clicking the toolbar icon opens the panel rather than a popup. */
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

/** Content scripts report `<video>` elements the network layer cannot see. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'page-media') return undefined;

  const tabId = sender.tab?.id;
  if (tabId == null) return undefined;

  for (const item of message.items ?? []) {
    const kind = kindFromUrl(item.url);
    // A `blob:` or MSE source has no downloadable URL of its own; the
    // underlying playlist shows up through webRequest instead.
    if (!kind) continue;
    recordMedia(tabId, {
      url: item.url,
      kind,
      size: null,
      title: message.title ?? null,
      referer: message.pageUrl ?? null,
      detectedAt: Date.now(),
      source: 'dom',
    });
  }

  // Titles arrive with the DOM scan, so backfill anything found by network.
  if (message.title) {
    for (const item of tabMedia(tabId).values()) {
      if (!item.title) item.title = message.title;
    }
  }

  sendResponse?.({ ok: true });
  return undefined;
});
