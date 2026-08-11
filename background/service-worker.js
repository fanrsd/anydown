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
  kindFromContentType,
  kindFromUrl,
} from '../lib/constants.js';
import { buildDownloadPath, suggestFilename } from '../lib/format.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

/** Detected media per tab: `tabId -> Map<url, MediaItem>`. */
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

/** Segment URLs already covered by a playlist we know about, keyed by tab. */
const knownSegmentPrefixes = new Map();

function tabMedia(tabId) {
  let media = mediaByTab.get(tabId);
  if (!media) {
    media = new Map();
    mediaByTab.set(tabId, media);
  }
  return media;
}

/**
 * Is this URL an individual HLS segment belonging to a playlist we already
 * list? Showing 4000 fragments instead of one playlist would be useless.
 */
function isKnownSegment(tabId, url) {
  const prefixes = knownSegmentPrefixes.get(tabId);
  if (!prefixes) return false;
  for (const prefix of prefixes) {
    if (url.startsWith(prefix)) return true;
  }
  return false;
}

/** Remember the directory a playlist lives in, so its segments stay hidden. */
function rememberPlaylistLocation(tabId, url) {
  try {
    const parsed = new URL(url);
    const prefix = `${parsed.origin}${parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1)}`;
    let prefixes = knownSegmentPrefixes.get(tabId);
    if (!prefixes) {
      prefixes = new Set();
      knownSegmentPrefixes.set(tabId, prefixes);
    }
    prefixes.add(prefix);
  } catch {
    // A URL we cannot parse simply gets no segment suppression.
  }
}

/** Record a detected media resource and tell any open panel about it. */
function recordMedia(tabId, item) {
  if (tabId < 0) return;

  const media = tabMedia(tabId);
  const existing = media.get(item.url);

  if (existing) {
    // Later observations often carry detail the first one lacked.
    Object.assign(existing, {
      size: item.size ?? existing.size,
      kind: item.kind ?? existing.kind,
      referer: item.referer ?? existing.referer,
      title: existing.title || item.title,
    });
    broadcastToPanels({ type: 'media-updated', tabId, item: existing });
    return;
  }

  if (item.kind === MediaKind.TS && isKnownSegment(tabId, item.url)) return;
  if (item.kind === MediaKind.HLS) rememberPlaylistLocation(tabId, item.url);

  media.set(item.url, item);
  updateBadge(tabId);
  broadcastToPanels({ type: 'media-added', tabId, item });
}

/** Requests whose Referer is worth keeping for later segment fetches. */
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!kindFromUrl(details.url)) return;
    const referer = details.requestHeaders?.find(
      (header) => header.name.toLowerCase() === 'referer',
    )?.value;
    if (!referer) return;
    const existing = tabMedia(details.tabId).get(details.url);
    if (existing && !existing.referer) existing.referer = referer;
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders'],
);

/** First pass: classify by URL, which catches most streaming CDNs. */
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    // Our own segment fetches must not feed back into the detected list.
    if (details.initiator?.startsWith('chrome-extension://')) return;

    const kind = kindFromUrl(details.url);
    if (!kind) return;

    recordMedia(details.tabId, {
      url: details.url,
      kind,
      size: null,
      title: null,
      referer: details.documentUrl ?? null,
      detectedAt: Date.now(),
      source: 'network',
    });
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other', 'object'] },
);

/** Second pass: classify by Content-Type, which catches extensionless URLs. */
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.initiator?.startsWith('chrome-extension://')) return;

    const headers = details.responseHeaders ?? [];
    const header = (name) =>
      headers.find((candidate) => candidate.name.toLowerCase() === name)?.value ?? null;

    const kind = kindFromContentType(header('content-type')) ?? kindFromUrl(details.url);
    if (!kind) return;

    const length = Number(header('content-length'));

    recordMedia(details.tabId, {
      url: details.url,
      kind,
      size: Number.isFinite(length) && length > 0 ? length : null,
      title: null,
      referer: null,
      detectedAt: Date.now(),
      source: 'network',
    });
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other', 'object'] },
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
  knownSegmentPrefixes.delete(tabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => updateBadge(tabId));

function clearTab(tabId) {
  mediaByTab.delete(tabId);
  knownSegmentPrefixes.delete(tabId);
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

/**
 * Create the offscreen document if it is not already running. Concurrent
 * callers share one creation promise: `createDocument` throws if a document
 * already exists, and two downloads started together would race.
 */
async function ensureOffscreenDocument() {
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
 * declarativeNetRequest rule adds it, narrowed to the media host and to
 * requests the extension itself initiates, and removed when the job ends.
 *
 * @returns {Promise<number|null>} the rule id to remove later
 */
async function addRefererRule(mediaUrl, referer) {
  if (!referer) return null;

  let host;
  try {
    host = new URL(mediaUrl).hostname;
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
            requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }],
          },
          condition: {
            requestDomains: [host],
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

  const ruleId = settings.sendReferer ? await addRefererRule(request.url, request.referer) : null;

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

async function startDirectDownload({ url, kind, jobId, name, settings, referer }) {
  const ruleId = settings.sendReferer ? await addRefererRule(url, referer) : null;
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
    updateJob(jobId, { state: JobState.DONE, downloadId, finishedAt: Date.now() });
    await addHistoryEntry({
      id: jobId,
      name: `${name}.${extension}`,
      url,
      kind,
      downloadId,
      bytes: null,
      finishedAt: Date.now(),
      partial: false,
    });
  } catch (error) {
    updateJob(jobId, { state: JobState.FAILED, error: error.message });
  } finally {
    await removeRefererRule(ruleId);
  }

  return jobId;
}

/**
 * The engine finished assembling a file. Only the service worker may call
 * `chrome.downloads`, so the object URL crosses over here to be saved.
 */
async function saveAssembledFile(payload) {
  const settings = await getSettings();
  const job = jobs.get(payload.jobId) ?? {};
  const extension = OUTPUT_EXTENSION[MediaKind.HLS];

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
    });
  } catch (error) {
    updateJob(payload.jobId, { state: JobState.FAILED, error: error.message });
    enginePort?.postMessage({ type: 'release', objectUrl: payload.objectUrl });
  } finally {
    await removeRefererRule(job.ruleId);
  }
}

/** Revoke the object URL once Chrome has finished writing the file. */
chrome.downloads.onChanged.addListener(async (delta) => {
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
      updateJob(message.jobId, { state: JobState.PROBING, variants: message.variants });
      broadcastToPanels({ type: 'variants', jobId: message.jobId, variants: message.variants });
      break;

    case 'assembled':
      await saveAssembledFile(message);
      break;

    case 'failed': {
      const job = jobs.get(message.jobId);
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

    case 'probe':
      // Ask the engine for the variant list without committing to a download.
      try {
        await sendToEngine({ type: 'probe', jobId: message.jobId, url: message.url });
      } catch (error) {
        port.postMessage({ type: 'probe-failed', jobId: message.jobId, error: error.message });
      }
      break;

    case 'cancel':
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
