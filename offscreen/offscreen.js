/**
 * The download engine.
 *
 * Runs inside an offscreen document so it survives service worker idle
 * termination and can create the object URL for the assembled file. It talks
 * to the service worker over a single long-lived port and never touches any
 * `chrome.*` API other than `chrome.runtime`, which is all an offscreen
 * document is permitted.
 */

import { ENGINE_PORT, JobState } from '../lib/constants.js';
import {
  KeyCache,
  decryptSegment,
  ivForSegment,
} from '../lib/crypto-aes.js';
import {
  RateTracker,
  abortError,
  fetchBytes,
  fetchWithRetry,
  isAbort,
  runPool,
  throttle,
} from '../lib/downloader.js';
import { parsePlaylist } from '../lib/m3u8-parser.js';

const port = chrome.runtime.connect({ name: ENGINE_PORT });

/** In-flight jobs: `jobId -> { controller, objectUrls }`. */
const activeJobs = new Map();
/** Object URLs handed to the service worker, kept alive until it says so. */
const heldObjectUrls = new Set();

port.onMessage.addListener((message) => {
  switch (message.type) {
    case 'start':
      void runJob(message);
      break;
    case 'probe':
      void probe(message);
      break;
    case 'cancel':
      activeJobs.get(message.jobId)?.controller.abort();
      break;
    case 'release':
      releaseObjectUrl(message.objectUrl);
      break;
    default:
      break;
  }
});

function releaseObjectUrl(objectUrl) {
  if (!heldObjectUrls.has(objectUrl)) return;
  URL.revokeObjectURL(objectUrl);
  heldObjectUrls.delete(objectUrl);
}

/** Fetch a playlist as text, with retries. */
async function fetchText(url, options) {
  const response = await fetchWithRetry(url, options);
  return response.text();
}

/**
 * Read a playlist URL and report the quality options it offers.
 *
 * A master playlist yields its variants. A media playlist has only one
 * quality, so an empty list means "nothing to choose, just download it".
 */
async function probe({ jobId, url }) {
  try {
    const text = await fetchText(url, { retries: 2 });
    const playlist = parsePlaylist(text, url);

    if (playlist.type === 'master') {
      if (playlist.drm.protected) {
        port.postMessage({ type: 'failed', jobId, error: capitalise(playlist.drm.reason) });
        return;
      }
      port.postMessage({ type: 'variants', jobId, variants: playlist.variants });
      return;
    }

    port.postMessage({ type: 'variants', jobId, variants: [] });
  } catch (error) {
    port.postMessage({ type: 'failed', jobId, error: describeError(error) });
  }
}

/**
 * Download an HLS stream end to end: resolve the playlist, fetch and decrypt
 * every segment in parallel, and assemble one file.
 */
async function runJob({ jobId, url, name, variantUrl, concurrency, maxRetries }) {
  const controller = new AbortController();
  const { signal } = controller;
  activeJobs.set(jobId, { controller });

  try {
    // 1. Resolve the playlist, following a master playlist to the chosen variant.
    let playlistUrl = variantUrl || url;
    let playlist = parsePlaylist(await fetchText(playlistUrl, { retries: 2, signal }), playlistUrl);

    if (playlist.type === 'master') {
      if (playlist.drm.protected) throw new Error(capitalise(playlist.drm.reason));
      if (playlist.variants.length === 0) throw new Error('Master playlist lists no streams');
      // No explicit choice: take the best available.
      playlistUrl = playlist.variants[0].uri;
      playlist = parsePlaylist(await fetchText(playlistUrl, { retries: 2, signal }), playlistUrl);
    }

    if (playlist.type !== 'media') throw new Error('Playlist contains no segments');
    if (playlist.drm.protected) throw new Error(capitalise(playlist.drm.reason));
    if (playlist.isLive) {
      throw new Error('This is a live stream. AnyDown can only download finished recordings.');
    }
    if (playlist.segments.length === 0) throw new Error('Playlist contains no segments');

    // 2. Build the work list, putting any fMP4 init segment first.
    const work = [];
    if (playlist.initSegment) {
      work.push({ ...playlist.initSegment, sequence: playlist.mediaSequence, isInit: true });
    }
    work.push(...playlist.segments);

    const keyCache = new KeyCache((keyUri) =>
      fetchBytes(keyUri, { retries: maxRetries, signal }),
    );

    const rate = new RateTracker();
    const failedIndices = [];
    let completed = 0;

    // Which segments settled since the last report. The panel draws segment
    // positions, not just a count, so it needs the indices rather than a
    // total — and a pool completes them out of order.
    let settledSinceReport = [];
    let faultedSinceReport = [];

    const report = throttle(() => {
      port.postMessage({
        type: 'progress',
        jobId,
        state: JobState.DOWNLOADING,
        completed,
        total: work.length,
        bytes: rate.totalBytes,
        bytesPerSecond: rate.bytesPerSecond(),
        // Segment sizes vary, so scale the average so far by what is left.
        etaSeconds: estimateEta(rate, completed, work.length),
        failed: failedIndices.length,
        settled: settledSinceReport,
        faulted: faultedSinceReport,
      });
      settledSinceReport = [];
      faultedSinceReport = [];
    }, 250);

    // 3. Fetch, decrypt, and immediately wrap each segment in a Blob. Holding
    //    ArrayBuffers would grow the JS heap by the size of the whole video;
    //    a Blob moves the bytes into Chrome's blob store, which spills to disk.
    const { results } = await runPool(
      work,
      async (segment) => {
        const bytes = await fetchBytes(segment.uri, {
          retries: maxRetries,
          signal,
          byteRange: segment.byteRange,
        });

        const plain = segment.key
          ? await decryptSegment(
              await keyCache.get(segment.key.uri),
              ivForSegment(segment.key.iv, segment.sequence),
              bytes,
            )
          : bytes;

        rate.add(plain.byteLength);
        return new Blob([plain]);
      },
      {
        concurrency,
        signal,
        onSettled: ({ index, ok }) => {
          if (ok) {
            completed++;
            settledSinceReport.push(index);
          } else {
            failedIndices.push(index);
            faultedSinceReport.push(index);
          }
          report();
        },
      },
    );

    report.flush();

    if (results.every((blob) => !blob)) {
      throw new Error('Every segment failed to download. The stream may require a login.');
    }

    // 4. Concatenate. Blobs join by reference, so this stays cheap.
    port.postMessage({
      type: 'progress',
      jobId,
      state: JobState.ASSEMBLING,
      completed,
      total: work.length,
      bytes: rate.totalBytes,
      failed: failedIndices.length,
    });

    const present = results.filter(Boolean);
    const file = new Blob(present, { type: 'video/mp2t' });
    const objectUrl = URL.createObjectURL(file);
    heldObjectUrls.add(objectUrl);

    port.postMessage({
      type: 'assembled',
      jobId,
      name,
      objectUrl,
      bytes: file.size,
      missing: failedIndices,
    });
  } catch (error) {
    if (isAbort(error)) port.postMessage({ type: 'cancelled', jobId });
    else port.postMessage({ type: 'failed', jobId, error: describeError(error) });
  } finally {
    activeJobs.delete(jobId);
  }
}

/**
 * Estimate remaining seconds from the average segment size observed so far.
 * Segment byte sizes are not known ahead of time, so a byte-based ETA is not
 * available until the download is underway.
 */
function estimateEta(rate, completed, total) {
  if (completed === 0) return null;
  const averageBytes = rate.totalBytes / completed;
  return rate.etaSeconds(averageBytes * (total - completed));
}

/** Turn an error into something worth showing in the panel. */
function describeError(error) {
  if (!error) return 'Unknown error';
  if (isAbort(error)) return 'Cancelled';
  if (error.status === 403) return 'The server refused the request (403). It may need a login.';
  if (error.status === 404) return 'The stream is no longer available (404).';
  if (error.message?.includes('Failed to fetch')) {
    return 'Could not reach the server. Check your connection.';
  }
  return error.message || String(error);
}

function capitalise(text) {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Cancel everything and release any held blobs if the document is torn down.
globalThis.addEventListener('pagehide', () => {
  for (const job of activeJobs.values()) job.controller.abort(abortError());
  for (const objectUrl of heldObjectUrls) URL.revokeObjectURL(objectUrl);
  heldObjectUrls.clear();
});
