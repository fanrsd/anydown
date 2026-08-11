/**
 * Transfer primitives: a bounded-concurrency pool, retrying fetch, and a
 * throughput tracker.
 *
 * Everything here is transport-agnostic — `fetch` is injectable so the pool
 * and the retry policy can be unit tested without a network or a browser.
 */

/** Sleep that rejects promptly when the caller aborts. */
export function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The DOMException shape callers already check for via `error.name`. */
export function abortError(message = 'Aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** True when an error means "the caller cancelled", not "the transfer failed". */
export function isAbort(error) {
  return error?.name === 'AbortError';
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight.
 *
 * Results keep the input order regardless of completion order, which is what
 * makes concatenating video segments safe. A worker that throws does not stop
 * the pool: its index is recorded in `errors` and the remaining items continue.
 * That is deliberate — one dead segment in a 4000-segment stream should cost a
 * glitch, not the whole download.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number, signal: AbortSignal|undefined) => Promise<R>} worker
 * @param {{concurrency?: number, signal?: AbortSignal, onSettled?: Function}} options
 * @returns {Promise<{results: (R|undefined)[], errors: Map<number, Error>}>}
 */
export async function runPool(items, worker, options = {}) {
  const { concurrency = 6, signal, onSettled } = options;
  // Filled rather than left sparse so a failed index reads as an explicit
  // `undefined`; array holes are skipped by `map`/`forEach` and would hide it.
  const results = new Array(items.length).fill(undefined);
  const errors = new Map();

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  async function drain() {
    while (true) {
      if (signal?.aborted) throw abortError();
      const index = cursor++;
      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index], index, signal);
        onSettled?.({ index, ok: true, value: results[index] });
      } catch (error) {
        if (isAbort(error)) throw error;
        errors.set(index, error);
        onSettled?.({ index, ok: false, error });
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, drain));
  return { results, errors };
}

/** HTTP statuses where retrying has a real chance of a different outcome. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * `fetch` with bounded retries and exponential backoff plus jitter.
 *
 * A 4xx other than the ones above is treated as permanent: retrying a 403 on a
 * signed URL only burns time.
 *
 * @param {string} url
 * @param {{retries?: number, signal?: AbortSignal, headers?: object, byteRange?: {offset: number, length: number}|null,
 *   fetchImpl?: typeof fetch, baseDelay?: number, onRetry?: Function}} options
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}) {
  const {
    retries = 3,
    signal,
    headers = {},
    byteRange = null,
    fetchImpl = globalThis.fetch,
    baseDelay = 400,
    onRetry,
  } = options;

  const requestHeaders = { ...headers };
  if (byteRange) {
    const start = byteRange.offset ?? 0;
    requestHeaders.Range = `bytes=${start}-${start + byteRange.length - 1}`;
  }

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw abortError();

    try {
      const response = await fetchImpl(url, {
        signal,
        credentials: 'include',
        headers: requestHeaders,
        cache: 'no-store',
      });

      if (response.ok) return response;

      const error = new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
      error.status = response.status;
      if (!RETRYABLE_STATUSES.has(response.status)) throw error;
      lastError = error;
    } catch (error) {
      if (isAbort(error)) throw error;
      // A permanent status was raised above; do not spend attempts on it.
      if (error.status && !RETRYABLE_STATUSES.has(error.status)) throw error;
      lastError = error;
    }

    if (attempt < retries) {
      const backoff = baseDelay * 2 ** attempt;
      const jitter = Math.random() * baseDelay;
      onRetry?.({ url, attempt: attempt + 1, error: lastError });
      await delay(backoff + jitter, signal);
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

/** Fetch a URL and return its bytes, honouring retries and byte ranges. */
export async function fetchBytes(url, options = {}) {
  const response = await fetchWithRetry(url, options);
  return response.arrayBuffer();
}

/**
 * Rolling throughput estimate over a sliding time window.
 *
 * A window rather than a running average because segment downloads are bursty:
 * an all-time average would still report the slow first seconds long after the
 * transfer reached full speed.
 */
export class RateTracker {
  #samples = [];
  #totalBytes = 0;

  /** @param {number} windowMs how much recent history feeds the estimate */
  constructor(windowMs = 5000) {
    this.windowMs = windowMs;
    this.startedAt = Date.now();
  }

  /** Record bytes that just arrived. */
  add(bytes, now = Date.now()) {
    if (!(bytes > 0)) return;
    this.#totalBytes += bytes;
    this.#samples.push({ at: now, bytes });
    this.#trim(now);
  }

  #trim(now) {
    const cutoff = now - this.windowMs;
    let firstKept = 0;
    while (firstKept < this.#samples.length && this.#samples[firstKept].at < cutoff) firstKept++;
    if (firstKept > 0) this.#samples.splice(0, firstKept);
  }

  /** Total bytes seen since construction. */
  get totalBytes() {
    return this.#totalBytes;
  }

  /** Bytes per second over the window, or 0 before there is enough history. */
  bytesPerSecond(now = Date.now()) {
    this.#trim(now);
    if (this.#samples.length === 0) return 0;
    const oldest = this.#samples[0].at;
    // Below ~250 ms the sample is too short to divide by meaningfully.
    const elapsed = Math.max(now - oldest, 250);
    const bytes = this.#samples.reduce((sum, sample) => sum + sample.bytes, 0);
    return (bytes * 1000) / elapsed;
  }

  /**
   * Seconds remaining, estimated from the current rate.
   * @returns {number|null} null when there is not enough information yet
   */
  etaSeconds(remainingBytes, now = Date.now()) {
    const rate = this.bytesPerSecond(now);
    if (!(rate > 0) || !(remainingBytes > 0)) return null;
    return remainingBytes / rate;
  }
}

/**
 * Throttle a callback to at most one call per interval, always delivering the
 * most recent arguments. Used so a fast pool cannot flood the panel with
 * thousands of progress messages per second.
 */
export function throttle(fn, intervalMs = 250) {
  let lastCall = 0;
  let timer = null;
  let pendingArgs = null;

  const invoke = () => {
    lastCall = Date.now();
    timer = null;
    const args = pendingArgs;
    pendingArgs = null;
    if (args) fn(...args);
  };

  const throttled = (...args) => {
    pendingArgs = args;
    const elapsed = Date.now() - lastCall;
    if (elapsed >= intervalMs) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      invoke();
    } else if (!timer) {
      timer = setTimeout(invoke, intervalMs - elapsed);
    }
  };

  /** Deliver any pending call immediately, e.g. on the final progress event. */
  throttled.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingArgs) invoke();
  };

  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pendingArgs = null;
  };

  return throttled;
}
