/**
 * Design preview harness. Not part of the extension.
 *
 * Stubs the `chrome.*` surface panel.js uses and feeds it a fixed scenario so
 * every visual state — idle, quality picker, mid-download, partial, failed,
 * done — can be looked at without a real stream.
 *
 * Serve the project root over HTTP and open /panel/preview.html.
 */

(() => {
  const NOW = Date.now();

  /**
   * A ribbon in the shape the real engine produces.
   *
   * The pool hands out segments in index order, so progress runs left to
   * right with a working frontier only as wide as the concurrency setting —
   * not scattered across the strip. Faults stay behind at their own position.
   */
  function ribbon(cells, total, completed, faultIndices = []) {
    // Same capacity formula as the service worker: the exact inverse of
    // cellFor, so the preview cannot flatter the real thing.
    const firstIndexIn = (cell) => Math.floor((cell * total + cells - 1) / cells);
    const capacity = Array.from(
      { length: cells },
      (_, cell) => firstIndexIn(cell + 1) - firstIndexIn(cell),
    );
    const done = new Array(cells).fill(0);
    const faulted = new Array(cells).fill(0);

    const cellFor = (index) => Math.min(cells - 1, Math.floor((index * cells) / total));
    for (let index = 0; index < completed; index++) done[cellFor(index)]++;
    for (const index of faultIndices) {
      const cell = cellFor(index);
      faulted[cell]++;
      if (done[cell] > 0) done[cell]--;
    }

    return { cells, capacity, done, faulted };
  }

  const ITEMS = [
    {
      url: 'https://cdn.example.com/vod/s02e04/master.m3u8',
      kind: 'hls',
      size: null,
      title: 'The Signal Room — Episode 4',
      detectedAt: NOW - 2000,
    },
    {
      url: 'https://cdn.example.com/vod/interview/1080/index.m3u8',
      kind: 'hls',
      size: null,
      title: 'Field interview, part two',
      detectedAt: NOW - 9000,
    },
    {
      url: 'https://media.example.org/clips/rooftop-timelapse.mp4',
      kind: 'mp4',
      size: 486_539_264,
      title: 'Rooftop timelapse',
      detectedAt: NOW - 24_000,
    },
    {
      url: 'https://static.example.net/promo/teaser-2026.webm',
      kind: 'webm',
      size: 31_457_280,
      title: 'Teaser',
      detectedAt: NOW - 60_000,
    },
  ];

  const JOBS = [
    {
      id: 'job-running',
      url: ITEMS[0].url,
      state: 'downloading',
      completed: 412,
      total: 1140,
      bytes: 734_003_200,
      bytesPerSecond: 24_117_248,
      etaSeconds: 96,
      failed: 1,
      ribbon: ribbon(48, 1140, 412, [188]),
    },
    {
      // A finished HLS download keeps its ribbon: the faults stay on show as
      // a map of where the file has gaps.
      id: 'job-partial',
      url: ITEMS[3].url,
      state: 'done',
      completed: 322,
      total: 330,
      bytes: 1_073_741_824,
      missing: [44, 45, 130, 131, 132, 240, 241, 242],
      ribbon: ribbon(48, 330, 330, [44, 45, 130, 131, 132, 240, 241, 242]),
    },
    {
      // A direct file has no segments, so it gets no ribbon at all.
      id: 'job-done',
      url: ITEMS[2].url,
      state: 'done',
      bytes: 486_539_264,
      missing: [],
    },
  ];

  const HISTORY = [
    {
      id: 'h1',
      name: 'The Signal Room — Episode 3.ts',
      bytes: 1_395_864_371,
      finishedAt: NOW - 21 * 60_000,
      partial: false,
      downloadId: 1,
    },
    {
      id: 'h2',
      name: 'Panel discussion, full.ts',
      bytes: 2_684_354_560,
      finishedAt: NOW - 5 * 3_600_000,
      partial: true,
      missingCount: 3,
      downloadId: 2,
    },
    {
      id: 'h3',
      name: 'Rooftop timelapse.mp4',
      bytes: 486_539_264,
      finishedAt: NOW - 3 * 24 * 3_600_000,
      partial: false,
      downloadId: 3,
    },
  ];

  const VARIANTS = [
    { height: 1080, bandwidth: 5_200_000, codecs: 'avc1.640028', uri: '#1080' },
    { height: 720, bandwidth: 2_400_000, codecs: 'avc1.4d401f', uri: '#720' },
    { height: 480, bandwidth: 1_100_000, codecs: 'avc1.4d401e', uri: '#480' },
    { height: 360, bandwidth: 600_000, codecs: 'avc1.42c01e', uri: '#360' },
  ];

  const listeners = [];

  globalThis.chrome = {
    runtime: {
      connect() {
        const port = {
          onMessage: { addListener: (fn) => listeners.push(fn) },
          onDisconnect: { addListener: () => {} },
          postMessage(message) {
            if (message.type === 'hello') {
              queueMicrotask(() => {
                emit({
                  type: 'state',
                  tabId: 1,
                  items: ITEMS,
                  jobs: JOBS,
                  history: HISTORY,
                  settings: {},
                });
                // Open the quality picker on the second card by walking the
                // same path a user does, so the preview exercises the real
                // probe exchange rather than faking its result.
                document.querySelectorAll('.js-download')[1]?.click();
              });
              return;
            }

            // Answer the panel's probe with the job id it actually sent.
            if (message.type === 'probe') {
              queueMicrotask(() =>
                emit({
                  type: 'variants',
                  jobId: message.jobId,
                  variants: VARIANTS,
                }),
              );
            }
          },
        };
        return port;
      },
    },
    tabs: {
      query: async () => [{ id: 1, title: 'The Signal Room — Episode 4 · example.com' }],
      onActivated: { addListener: () => {} },
    },
  };

  function emit(message) {
    for (const listener of listeners) listener(message);
  }

  // Drive the picker onto the second card once panel.js has rendered.
  globalThis.__anydownPreview = { emit, ITEMS, JOBS, HISTORY };
})();
