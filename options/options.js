/**
 * Options page.
 *
 * Settings live in `chrome.storage.local` and are read straight from there.
 * Writes go through the service worker so it can broadcast the change to any
 * open panel rather than letting the two views drift out of sync.
 */

import {
  CONCURRENCY_MAX,
  CONCURRENCY_MIN,
  DEFAULT_SETTINGS,
  PANEL_PORT,
  STORAGE_SETTINGS,
} from '../lib/constants.js';

const controls = {
  concurrency: document.getElementById('concurrency'),
  concurrencyValue: document.getElementById('concurrency-value'),
  retries: document.getElementById('retries'),
  retriesValue: document.getElementById('retries-value'),
  subfolder: document.getElementById('subfolder'),
  saveAs: document.getElementById('save-as'),
  sendReferer: document.getElementById('send-referer'),
  clearHistory: document.getElementById('clear-history'),
  saved: document.getElementById('saved'),
};

controls.concurrency.min = String(CONCURRENCY_MIN);
controls.concurrency.max = String(CONCURRENCY_MAX);

const port = chrome.runtime.connect({ name: PANEL_PORT });

async function load() {
  const stored = await chrome.storage.local.get(STORAGE_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_SETTINGS] ?? {}) };

  controls.concurrency.value = String(settings.concurrency);
  controls.concurrencyValue.textContent = String(settings.concurrency);
  controls.retries.value = String(settings.maxRetries);
  controls.retriesValue.textContent = String(settings.maxRetries);
  controls.subfolder.value = settings.subfolder;
  controls.saveAs.checked = settings.saveAs;
  controls.sendReferer.checked = settings.sendReferer;
}

let savedTimer = null;

function save(patch) {
  port.postMessage({ type: 'save-settings', settings: patch });

  controls.saved.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    controls.saved.hidden = true;
  }, 1600);
}

controls.concurrency.addEventListener('input', () => {
  controls.concurrencyValue.textContent = controls.concurrency.value;
});
controls.concurrency.addEventListener('change', () => {
  save({ concurrency: Number(controls.concurrency.value) });
});

controls.retries.addEventListener('input', () => {
  controls.retriesValue.textContent = controls.retries.value;
});
controls.retries.addEventListener('change', () => {
  save({ maxRetries: Number(controls.retries.value) });
});

controls.subfolder.addEventListener('change', () => {
  save({ subfolder: controls.subfolder.value.trim() });
});

controls.saveAs.addEventListener('change', () => save({ saveAs: controls.saveAs.checked }));
controls.sendReferer.addEventListener('change', () =>
  save({ sendReferer: controls.sendReferer.checked }),
);

controls.clearHistory.addEventListener('click', () => {
  port.postMessage({ type: 'clear-history' });
  controls.saved.textContent = 'History cleared';
  controls.saved.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    controls.saved.hidden = true;
    controls.saved.textContent = 'Saved';
  }, 1600);
});

load();
