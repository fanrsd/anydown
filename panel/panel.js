/**
 * Side panel.
 *
 * A pure view over state the service worker owns. Closing the panel never
 * stops a download; re-opening it asks for the current state and redraws.
 *
 * Page titles and stream URLs come from arbitrary websites, so everything
 * rendered here goes through `textContent` and cloned `<template>` markup.
 * No string is ever assigned to `innerHTML`.
 */

import { JobState, PANEL_PORT, labelForKind, MediaKind } from '../lib/constants.js';
import {
  formatBytes,
  formatEta,
  formatRelativeTime,
  formatSpeed,
  suggestFilename,
  truncateUrl,
} from '../lib/format.js';
import { describeVariant } from '../lib/m3u8-parser.js';

const elements = {
  contextTitle: document.getElementById('context-title'),
  tally: document.getElementById('tally'),
  detectedCount: document.getElementById('detected-count'),
  mediaList: document.getElementById('media-list'),
  detectedEmpty: document.getElementById('detected-empty'),
  historyList: document.getElementById('history-list'),
  historyEmpty: document.getElementById('history-empty'),
  historyFoot: document.getElementById('history-foot'),
  viewDetected: document.getElementById('view-detected'),
  viewHistory: document.getElementById('view-history'),
  clearHistory: document.getElementById('clear-history'),
  openOptions: document.getElementById('open-options'),
};

const templates = {
  card: document.getElementById('tpl-card'),
  history: document.getElementById('tpl-history'),
  variant: document.getElementById('tpl-variant'),
};

/** Detected media for the active tab, keyed by URL. */
const items = new Map();
/** Job state mirrored from the service worker, keyed by job id. */
const jobs = new Map();
/** Which job belongs to which media URL, so a card can find its progress. */
const jobIdByUrl = new Map();
/** Rendered cards, keyed by media URL, so updates do not rebuild the list. */
const cards = new Map();

let activeTabId = null;
let port = null;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function connect() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  elements.contextTitle.textContent = tab?.title || tab?.url || 'This tab';

  port = chrome.runtime.connect({ name: PANEL_PORT });
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // The worker restarts on demand; reconnecting re-syncs everything.
    setTimeout(connect, 400);
  });
  port.postMessage({ type: 'hello', tabId: activeTabId });
}

function send(message) {
  port?.postMessage(message);
}

function handleMessage(message) {
  switch (message.type) {
    case 'state':
      items.clear();
      for (const item of message.items) items.set(item.url, item);
      jobs.clear();
      for (const job of message.jobs) {
        jobs.set(job.id, job);
        if (job.url) jobIdByUrl.set(job.url, job.id);
      }
      renderDetected();
      renderHistory(message.history);
      break;

    case 'media-added':
    case 'media-updated':
      if (message.tabId !== activeTabId) break;
      items.set(message.item.url, message.item);
      renderDetected();
      break;

    case 'tab-cleared':
      if (message.tabId !== activeTabId) break;
      items.clear();
      renderDetected();
      break;

    case 'job-updated':
      jobs.set(message.job.id, message.job);
      if (message.job.url) jobIdByUrl.set(message.job.url, message.job.id);
      applyJobToCard(message.job);
      updateTally();
      break;

    case 'variants':
      showVariants(message.jobId, message.variants);
      break;

    case 'probe-failed':
      showProbeFailure(message.jobId, message.error);
      break;

    case 'history-changed':
      renderHistory(message.history);
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Detected list
// ---------------------------------------------------------------------------

function renderDetected() {
  const ordered = [...items.values()].sort((a, b) => b.detectedAt - a.detectedAt);

  elements.detectedEmpty.hidden = ordered.length > 0;
  elements.detectedCount.hidden = ordered.length === 0;
  elements.detectedCount.textContent = String(ordered.length);

  const seen = new Set();

  for (const item of ordered) {
    seen.add(item.url);
    let card = cards.get(item.url);
    if (!card) {
      card = buildCard(item);
      cards.set(item.url, card);
    }
    fillCardDetails(card, item);
    elements.mediaList.append(card.root);
  }

  for (const [url, card] of cards) {
    if (seen.has(url)) continue;
    card.root.remove();
    cards.delete(url);
  }

  // A job started before this render still needs its progress painted.
  for (const job of jobs.values()) applyJobToCard(job);
  updateTally();
}

function buildCard(item) {
  const root = templates.card.content.firstElementChild.cloneNode(true);

  const card = {
    root,
    url: item.url,
    kind: root.querySelector('.kind'),
    title: root.querySelector('.card__title'),
    meta: root.querySelector('.card__meta'),
    download: root.querySelector('.js-download'),
    picker: root.querySelector('.picker'),
    pickerList: root.querySelector('.picker__list'),
    run: root.querySelector('.run'),
    state: root.querySelector('.js-state'),
    pct: root.querySelector('.js-pct'),
    count: root.querySelector('.js-count'),
    speed: root.querySelector('.js-speed'),
    eta: root.querySelector('.js-eta'),
    cancel: root.querySelector('.js-cancel'),
    note: root.querySelector('.note'),
    ribbon: root.querySelector('.ribbon'),
    ribbonCells: [],
  };

  card.download.addEventListener('click', () => beginDownload(card, item));
  card.cancel.addEventListener('click', () => {
    const jobId = jobIdByUrl.get(card.url);
    if (jobId) send({ type: 'cancel', jobId });
  });

  return card;
}

function fillCardDetails(card, item) {
  card.kind.textContent = labelForKind(item.kind);
  card.kind.dataset.kind = item.kind;
  card.title.textContent = suggestFilename({ title: item.title, url: item.url });

  const meta = [];
  if (item.size) meta.push(formatBytes(item.size));
  meta.push(truncateUrl(hostAndPath(item.url), 40));
  card.meta.textContent = meta.join('  ·  ');
  card.meta.title = item.url;
}

function hostAndPath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Starting a download
// ---------------------------------------------------------------------------

function beginDownload(card, item) {
  const jobId = crypto.randomUUID();
  jobIdByUrl.set(item.url, jobId);
  card.pendingItem = item;
  clearNote(card);

  if (item.kind !== MediaKind.HLS) {
    startJob(jobId, item, null);
    return;
  }

  // HLS may offer several qualities. Ask before committing to one.
  card.state.textContent = 'Reading playlist';
  card.pct.textContent = '';
  card.run.hidden = false;
  card.root.classList.add('is-running');
  send({ type: 'probe', jobId, url: item.url });
}

function startJob(jobId, item, variantUrl) {
  send({
    type: 'start',
    request: {
      jobId,
      url: item.url,
      kind: item.kind,
      title: item.title,
      referer: item.referer,
      variantUrl,
    },
  });
}

function showVariants(jobId, variants) {
  const card = cardForJob(jobId);
  if (!card) return;

  const item = card.pendingItem;
  if (!item) return;

  // A media playlist has a single quality, so there is nothing to ask about.
  if (!variants || variants.length === 0) {
    startJob(jobId, item, null);
    return;
  }

  card.run.hidden = true;
  card.root.classList.remove('is-running');
  card.pickerList.replaceChildren();

  for (const variant of variants) {
    const row = templates.variant.content.firstElementChild.cloneNode(true);
    const button = row.querySelector('.js-variant');
    row.querySelector('.variant__height').textContent = variant.height
      ? `${variant.height}p`
      : '—';
    row.querySelector('.variant__rate').textContent = variant.bandwidth
      ? `${(variant.bandwidth / 1_000_000).toFixed(1)} Mbps`
      : '—';
    row.querySelector('.variant__codec').textContent = variant.codecs ?? '';
    button.title = describeVariant(variant);
    button.addEventListener('click', () => {
      card.picker.hidden = true;
      startJob(jobId, item, variant.uri);
    });
    card.pickerList.append(row);
  }

  card.picker.hidden = false;
}

function showProbeFailure(jobId, error) {
  const card = cardForJob(jobId);
  if (!card) return;
  card.run.hidden = true;
  card.root.classList.remove('is-running');
  setNote(card, error, 'error');
}

function cardForJob(jobId) {
  for (const [url, id] of jobIdByUrl) {
    if (id === jobId) return cards.get(url);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const STATE_LABELS = {
  [JobState.QUEUED]: 'Queued',
  [JobState.PROBING]: 'Reading playlist',
  [JobState.DOWNLOADING]: 'Downloading',
  [JobState.ASSEMBLING]: 'Joining segments',
  [JobState.SAVING]: 'Saving',
  [JobState.DONE]: 'Downloaded',
  [JobState.FAILED]: 'Failed',
  [JobState.CANCELLED]: 'Cancelled',
};

function applyJobToCard(job) {
  const card = job.url ? cards.get(job.url) : cardForJob(job.id);
  if (!card) return;

  const running = [
    JobState.QUEUED,
    JobState.PROBING,
    JobState.DOWNLOADING,
    JobState.ASSEMBLING,
    JobState.SAVING,
  ].includes(job.state);

  card.root.classList.toggle('is-running', running);
  card.root.classList.toggle('is-done', job.state === JobState.DONE);
  card.root.classList.toggle('is-failed', job.state === JobState.FAILED);
  card.root.classList.toggle('is-cancelled', job.state === JobState.CANCELLED);

  card.run.hidden = job.state === undefined;
  card.state.textContent = STATE_LABELS[job.state] ?? '';

  const total = job.total ?? 0;
  const completed = job.completed ?? 0;
  const percent = total > 0 ? Math.floor((completed / total) * 100) : null;

  card.pct.textContent = job.state === JobState.DONE ? '100%' : percent === null ? '' : `${percent}%`;
  card.count.textContent = total > 0 ? `${completed}/${total} segments` : '';
  card.speed.textContent = job.bytesPerSecond ? formatSpeed(job.bytesPerSecond) : '';
  card.eta.textContent = job.etaSeconds ? formatEta(job.etaSeconds) : '';

  if (job.state === JobState.DONE) {
    const size = job.bytes ? formatBytes(job.bytes) : '';
    card.count.textContent = size;
    if (job.missing?.length) {
      setNote(
        card,
        `${job.missing.length} of ${total} segments could not be downloaded, so the file has gaps.`,
        'warn',
      );
    } else {
      clearNote(card);
    }
  } else if (job.state === JobState.FAILED) {
    setNote(card, job.error ?? 'The download failed.', 'error');
  } else if (job.state === JobState.CANCELLED) {
    clearNote(card);
  }

  paintRibbon(card, job);
}

/**
 * Draw the segment ribbon. Cells reflect real segment positions, so a
 * parallel pool lights them scattered rather than sweeping left to right.
 */
function paintRibbon(card, job) {
  const ribbon = job.ribbon;
  if (!ribbon) {
    card.ribbon.hidden = true;
    return;
  }

  if (card.ribbonCells.length !== ribbon.cells) {
    card.ribbon.replaceChildren();
    card.ribbonCells = Array.from({ length: ribbon.cells }, () => {
      const cell = document.createElement('div');
      cell.className = 'ribbon__cell';
      card.ribbon.append(cell);
      return cell;
    });
  }

  for (let index = 0; index < ribbon.cells; index++) {
    const cell = card.ribbonCells[index];
    const capacity = ribbon.capacity[index] || 1;
    const done = ribbon.done[index] ?? 0;
    const faulted = ribbon.faulted[index] ?? 0;

    // A cell holding a lost segment is drawn as a fault even if its other
    // segments arrived: what matters is that the file has a gap there.
    if (faulted > 0) cell.dataset.state = 'fault';
    else if (done >= capacity) cell.dataset.state = 'done';
    else if (done > 0) cell.dataset.state = 'active';
    else delete cell.dataset.state;
  }

  card.ribbon.hidden = false;
}

function setNote(card, text, tone) {
  card.note.textContent = text;
  card.note.dataset.tone = tone;
  card.note.hidden = false;
}

function clearNote(card) {
  card.note.textContent = '';
  card.note.hidden = true;
}

function updateTally() {
  const live = [...jobs.values()].some((job) =>
    [JobState.PROBING, JobState.DOWNLOADING, JobState.ASSEMBLING, JobState.SAVING].includes(
      job.state,
    ),
  );
  elements.tally.dataset.live = String(live);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function renderHistory(history = []) {
  elements.historyList.replaceChildren();
  elements.historyEmpty.hidden = history.length > 0;
  elements.historyFoot.hidden = history.length === 0;

  for (const entry of history) {
    const row = templates.history.content.firstElementChild.cloneNode(true);
    row.querySelector('.row__title').textContent = entry.name;

    const meta = [];
    if (entry.bytes) meta.push(formatBytes(entry.bytes));
    meta.push(formatRelativeTime(entry.finishedAt));

    const metaElement = row.querySelector('.row__meta');
    metaElement.textContent = meta.join('  ·  ');

    // Only the gap is a problem. Colouring the size and the timestamp red
    // alongside it would flag facts that are perfectly fine.
    if (entry.partial) {
      const warning = document.createElement('span');
      warning.className = 'row__warn';
      warning.textContent = `${entry.missingCount} segments missing`;
      metaElement.append('  ·  ', warning);
    }

    row.querySelector('.js-show').addEventListener('click', () => {
      send({ type: 'show-download', downloadId: entry.downloadId });
    });
    row.querySelector('.js-forget').addEventListener('click', () => {
      send({ type: 'remove-history', id: entry.id });
    });

    elements.historyList.append(row);
  }
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) {
      const isActive = other === tab;
      other.classList.toggle('is-active', isActive);
      if (isActive) other.setAttribute('aria-current', 'page');
      else other.removeAttribute('aria-current');
    }
    const showHistory = tab.dataset.view === 'history';
    elements.viewDetected.hidden = showHistory;
    elements.viewHistory.hidden = !showHistory;
  });
}

elements.clearHistory.addEventListener('click', () => send({ type: 'clear-history' }));
elements.openOptions.addEventListener('click', () => send({ type: 'open-options' }));

// Following the active tab keeps the panel about what the user is looking at.
chrome.tabs.onActivated.addListener(() => window.location.reload());

connect();
