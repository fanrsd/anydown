/**
 * Page-side detection.
 *
 * The network layer sees almost everything, but two things only exist in the
 * DOM: a plain `<video src>` that was never re-requested while we were
 * watching, and the page title, which is the best default filename we have.
 *
 * This script is deliberately small and passive. It reads, it reports, it
 * never modifies the page.
 */

/** URLs already reported, so a re-scan does not resend the same list. */
const reported = new Set();

/** `blob:` and `data:` sources are page-local and cannot be fetched by us. */
function isDownloadable(url) {
  return typeof url === 'string' && /^https?:/i.test(url);
}

/** Collect candidate media URLs from video and source elements. */
function collectMediaUrls() {
  const urls = new Set();

  for (const video of document.querySelectorAll('video')) {
    if (isDownloadable(video.currentSrc)) urls.add(video.currentSrc);
    if (isDownloadable(video.src)) urls.add(video.src);
    for (const source of video.querySelectorAll('source')) {
      if (isDownloadable(source.src)) urls.add(source.src);
    }
  }

  // Bare <source> elements inside <audio> or picture-style markup.
  for (const source of document.querySelectorAll('source[type^="video"], source[type*="mpegurl"]')) {
    if (isDownloadable(source.src)) urls.add(source.src);
  }

  return [...urls];
}

/**
 * A meaningful title for the page. Site-specific heuristics are avoided on
 * purpose; `document.title` is right often enough and never surprising.
 */
function pageTitle() {
  const ogTitle = document
    .querySelector('meta[property="og:title"], meta[name="og:title"]')
    ?.getAttribute('content')
    ?.trim();
  return ogTitle || document.title?.trim() || '';
}

function report() {
  const fresh = collectMediaUrls().filter((url) => !reported.has(url));
  for (const url of fresh) reported.add(url);

  const title = pageTitle();
  // Send even with no fresh URLs: the title alone lets the worker label items
  // that webRequest found before this script ran.
  if (fresh.length === 0 && !title) return;

  chrome.runtime
    .sendMessage({
      type: 'page-media',
      items: fresh.map((url) => ({ url })),
      title,
      pageUrl: location.href,
    })
    // The service worker may be asleep or the extension reloading; either way
    // there is nothing useful to do about it from here.
    .catch(() => {});
}

report();

/**
 * Players attach their source well after load, so watch for new media
 * elements. The observer is coalesced into one report per animation frame to
 * keep it cheap on pages that mutate constantly.
 */
let scheduled = false;
const observer = new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    report();
  });
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src'],
});

// A late-starting player often only sets its source once playback begins.
document.addEventListener('play', report, { capture: true, passive: true });
document.addEventListener('loadedmetadata', report, { capture: true, passive: true });
