import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runPool,
  fetchWithRetry,
  fetchBytes,
  RateTracker,
  throttle,
  delay,
  isAbort,
  abortError,
} from '../lib/downloader.js';

/** Minimal stand-in for a fetch Response. */
function response(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    async arrayBuffer() {
      return new TextEncoder().encode(body).buffer;
    },
  };
}

test('runPool preserves input order regardless of completion order', async () => {
  const items = [50, 10, 30, 0, 20];
  const { results, errors } = await runPool(
    items,
    async (ms, index) => {
      await delay(ms);
      return index;
    },
    { concurrency: 5 },
  );

  assert.equal(errors.size, 0);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
});

test('runPool never exceeds the concurrency limit', async () => {
  let inFlight = 0;
  let peak = 0;

  await runPool(
    Array.from({ length: 40 }, (_, index) => index),
    async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight--;
    },
    { concurrency: 4 },
  );

  assert.equal(peak, 4);
});

test('runPool records a failure and keeps going', async () => {
  const attempted = [];
  const { results, errors } = await runPool(
    [0, 1, 2, 3, 4],
    async (item) => {
      attempted.push(item);
      if (item === 2) throw new Error('segment 2 is gone');
      return item * 10;
    },
    { concurrency: 2 },
  );

  assert.equal(attempted.length, 5, 'every item is still attempted');
  assert.equal(errors.size, 1);
  assert.match(errors.get(2).message, /segment 2 is gone/);
  assert.deepEqual(results, [0, 10, undefined, 30, 40]);
});

test('runPool reports each settled item through onSettled', async () => {
  const settled = [];
  await runPool(
    [0, 1, 2],
    async (item) => {
      if (item === 1) throw new Error('nope');
      return item;
    },
    { concurrency: 1, onSettled: (event) => settled.push(event) },
  );

  assert.deepEqual(
    settled.map((event) => [event.index, event.ok]),
    [[0, true], [1, false], [2, true]],
  );
});

test('runPool aborts promptly and rejects with AbortError', async () => {
  const controller = new AbortController();
  let started = 0;

  const pending = runPool(
    Array.from({ length: 100 }, (_, index) => index),
    async () => {
      started++;
      await delay(20);
    },
    { concurrency: 3, signal: controller.signal },
  );

  await delay(10);
  controller.abort();

  await assert.rejects(pending, (error) => isAbort(error));
  assert.ok(started < 100, 'the remaining items are never started');
});

test('runPool handles an empty item list', async () => {
  const { results, errors } = await runPool([], async () => 1, { concurrency: 4 });
  assert.deepEqual(results, []);
  assert.equal(errors.size, 0);
});

test('fetchWithRetry returns the first successful response', async () => {
  let calls = 0;
  const result = await fetchWithRetry('https://example.com/seg.ts', {
    fetchImpl: async () => {
      calls++;
      return response(200, 'ok');
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.status, 200);
});

test('fetchWithRetry retries a 503 and then succeeds', async () => {
  let calls = 0;
  const result = await fetchWithRetry('https://example.com/seg.ts', {
    baseDelay: 1,
    retries: 3,
    fetchImpl: async () => {
      calls++;
      return calls < 3 ? response(503) : response(200, 'recovered');
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.status, 200);
});

test('fetchWithRetry does not retry a 403', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      fetchWithRetry('https://example.com/seg.ts', {
        baseDelay: 1,
        retries: 5,
        fetchImpl: async () => {
          calls++;
          return response(403);
        },
      }),
    /HTTP 403/,
  );

  assert.equal(calls, 1, 'a signed-URL rejection is permanent, so retrying only burns time');
});

test('fetchWithRetry gives up after the configured attempts', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      fetchWithRetry('https://example.com/seg.ts', {
        baseDelay: 1,
        retries: 2,
        fetchImpl: async () => {
          calls++;
          throw new Error('connection reset');
        },
      }),
    /connection reset/,
  );

  assert.equal(calls, 3, 'the initial attempt plus two retries');
});

test('fetchWithRetry reports each retry', async () => {
  const retries = [];
  await assert.rejects(() =>
    fetchWithRetry('https://example.com/seg.ts', {
      baseDelay: 1,
      retries: 2,
      onRetry: (event) => retries.push(event.attempt),
      fetchImpl: async () => response(500),
    }),
  );

  assert.deepEqual(retries, [1, 2]);
});

test('fetchWithRetry stops immediately when aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      fetchWithRetry('https://example.com/seg.ts', {
        signal: controller.signal,
        fetchImpl: async () => response(200),
      }),
    (error) => isAbort(error),
  );
});

test('fetchWithRetry converts a byte range into a Range header', async () => {
  let seenHeaders;
  await fetchWithRetry('https://example.com/all.mp4', {
    byteRange: { offset: 800, length: 1000 },
    fetchImpl: async (_url, init) => {
      seenHeaders = init.headers;
      return response(206, 'partial');
    },
  });

  assert.equal(seenHeaders.Range, 'bytes=800-1799');
});

test('fetchBytes returns the response body', async () => {
  const bytes = await fetchBytes('https://example.com/seg.ts', {
    fetchImpl: async () => response(200, 'hello'),
  });
  assert.equal(new TextDecoder().decode(bytes), 'hello');
});

test('RateTracker reports throughput over its window', () => {
  const tracker = new RateTracker(5000);
  const start = 1_000_000;

  tracker.add(1_000_000, start);
  tracker.add(1_000_000, start + 1000);

  assert.equal(tracker.totalBytes, 2_000_000);
  const rate = tracker.bytesPerSecond(start + 1000);
  assert.ok(rate > 1_500_000 && rate < 2_500_000, `rate was ${rate}`);
});

test('RateTracker forgets samples older than its window', () => {
  const tracker = new RateTracker(1000);
  const start = 1_000_000;

  tracker.add(10_000_000, start);
  const stale = tracker.bytesPerSecond(start + 5000);

  assert.equal(stale, 0, 'nothing recent enough to estimate from');
  assert.equal(tracker.totalBytes, 10_000_000, 'the running total still counts it');
});

test('RateTracker estimates ETA and admits when it cannot', () => {
  const tracker = new RateTracker(5000);
  const start = 1_000_000;

  assert.equal(tracker.etaSeconds(1000, start), null, 'no samples yet');

  tracker.add(1_000_000, start);
  tracker.add(1_000_000, start + 1000);
  const eta = tracker.etaSeconds(4_000_000, start + 1000);

  assert.ok(eta > 1 && eta < 4, `eta was ${eta}`);
  assert.equal(tracker.etaSeconds(0, start + 1000), null, 'nothing left to download');
});

test('RateTracker ignores non-positive samples', () => {
  const tracker = new RateTracker();
  tracker.add(0);
  tracker.add(-5);
  assert.equal(tracker.totalBytes, 0);
  assert.equal(tracker.bytesPerSecond(), 0);
});

test('throttle fires immediately then coalesces, keeping the latest arguments', async () => {
  const seen = [];
  const throttled = throttle((value) => seen.push(value), 50);

  throttled('a');
  throttled('b');
  throttled('c');

  assert.deepEqual(seen, ['a'], 'the leading call goes straight through');

  await delay(80);
  assert.deepEqual(seen, ['a', 'c'], 'intermediate calls collapse into the latest');
});

test('throttle.flush delivers a pending call at once', async () => {
  const seen = [];
  const throttled = throttle((value) => seen.push(value), 1000);

  throttled('first');
  throttled('second');
  throttled.flush();

  assert.deepEqual(seen, ['first', 'second']);
});

test('throttle.cancel drops a pending call', async () => {
  const seen = [];
  const throttled = throttle((value) => seen.push(value), 30);

  throttled('first');
  throttled('dropped');
  throttled.cancel();

  await delay(60);
  assert.deepEqual(seen, ['first']);
});

test('delay rejects when its signal aborts mid-wait', async () => {
  const controller = new AbortController();
  const pending = delay(1000, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => isAbort(error));
});

test('abortError and isAbort agree', () => {
  assert.equal(isAbort(abortError()), true);
  assert.equal(isAbort(new Error('other')), false);
  assert.equal(isAbort(null), false);
});
