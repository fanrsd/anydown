/**
 * Shared constants and small classification helpers.
 *
 * This module is imported by the service worker, the offscreen engine, the
 * panel and the tests, so it must stay free of any `chrome.*` or DOM access.
 */

/** Media kinds the extension knows how to present and download. */
export const MediaKind = {
  HLS: 'hls',
  MP4: 'mp4',
  TS: 'ts',
  WEBM: 'webm',
  MKV: 'mkv',
  OGG: 'ogg',
  OTHER: 'other',
};

/** File extension (without dot) to media kind. */
const EXTENSION_KINDS = new Map([
  ['m3u8', MediaKind.HLS],
  ['m3u', MediaKind.HLS],
  ['mp4', MediaKind.MP4],
  ['m4v', MediaKind.MP4],
  ['mov', MediaKind.MP4],
  ['ts', MediaKind.TS],
  ['m2ts', MediaKind.TS],
  ['webm', MediaKind.WEBM],
  ['mkv', MediaKind.MKV],
  ['ogv', MediaKind.OGG],
  ['ogg', MediaKind.OGG],
]);

/** Response `Content-Type` (lowercased, parameters stripped) to media kind. */
const CONTENT_TYPE_KINDS = new Map([
  ['application/vnd.apple.mpegurl', MediaKind.HLS],
  ['application/x-mpegurl', MediaKind.HLS],
  ['audio/mpegurl', MediaKind.HLS],
  ['audio/x-mpegurl', MediaKind.HLS],
  ['video/mp4', MediaKind.MP4],
  ['video/quicktime', MediaKind.MP4],
  ['video/mp2t', MediaKind.TS],
  ['video/webm', MediaKind.WEBM],
  ['video/x-matroska', MediaKind.MKV],
  ['video/ogg', MediaKind.OGG],
  ['application/ogg', MediaKind.OGG],
]);

/** Container extension written to disk for each kind. */
export const OUTPUT_EXTENSION = {
  [MediaKind.HLS]: 'ts',
  [MediaKind.MP4]: 'mp4',
  [MediaKind.TS]: 'ts',
  [MediaKind.WEBM]: 'webm',
  [MediaKind.MKV]: 'mkv',
  [MediaKind.OGG]: 'ogv',
  [MediaKind.OTHER]: 'bin',
};

/**
 * `#EXT-X-KEY` methods that mean the content is rights-managed rather than
 * merely transport-encrypted. These are refused rather than attempted.
 */
export const DRM_KEY_METHODS = new Set([
  'SAMPLE-AES',
  'SAMPLE-AES-CTR',
  'SAMPLE-AES-CENC',
]);

/**
 * `KEYFORMAT` values that identify a commercial DRM system. Matched as a
 * lowercased substring so vendor-specific suffixes still trigger.
 */
export const DRM_KEY_FORMATS = [
  'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', // Widevine
  'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95', // PlayReady
  'com.microsoft.playready',
  'com.apple.streamingkeydelivery', // FairPlay
  'urn:mpeg:dash:mp4protection',
];

/** Defaults for everything the options page can change. */
export const DEFAULT_SETTINGS = {
  /** Segments fetched in parallel. This is the "high speed" knob. */
  concurrency: 6,
  /** Attempts per segment before it is given up on and recorded as missing. */
  maxRetries: 3,
  /** Save into this subfolder of the browser's download directory. */
  subfolder: 'AnyDown',
  /** Ask the browser to show its own save dialog for each file. */
  saveAs: false,
  /** Send the originating page's Referer with segment requests. */
  sendReferer: true,
  /** Entries kept in the history tab. */
  historyLimit: 200,
};

export const CONCURRENCY_MIN = 2;
export const CONCURRENCY_MAX = 16;

/** Ports and storage keys, named once so both ends cannot drift apart. */
export const PANEL_PORT = 'anydown-panel';
export const ENGINE_PORT = 'anydown-engine';
export const STORAGE_HISTORY = 'anydown:history';
export const STORAGE_SETTINGS = 'anydown:settings';
export const SESSION_MEDIA = 'anydown:media';

/** Job lifecycle states shared between the engine and the UI. */
export const JobState = {
  QUEUED: 'queued',
  PROBING: 'probing',
  DOWNLOADING: 'downloading',
  ASSEMBLING: 'assembling',
  SAVING: 'saving',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/**
 * Strip the query string and fragment, then return the lowercased extension of
 * the final path segment, or an empty string when there is none.
 */
export function extensionOf(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = String(url).split(/[?#]/)[0];
  }
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0) return '';
  return lastSegment.slice(dot + 1).toLowerCase();
}

/**
 * Identity of a detected resource: origin and path, with the query dropped.
 *
 * Streaming sites sign media URLs with an expiring token, so a player that
 * re-requests the same stream produces a brand new URL every time. Keyed on
 * the full URL, one video turns into an endless list of near-identical
 * entries; keyed on the path, it stays one entry whose URL is refreshed.
 */
export function mediaKey(url) {
  try {
    const { origin, pathname } = new URL(url);
    return origin + pathname;
  } catch {
    return String(url);
  }
}

/**
 * The directory a URL lives in, used to recognise the parts of a stream that
 * is already listed. Returns null for a URL sitting at the host root, whose
 * directory would otherwise claim every media file on that host.
 */
export function directoryOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // A `blob:` or `data:` URL carries its own inner URL in the path, so
  // slicing a directory out of it produces nonsense. Only real fetches match.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const lastSlash = parsed.pathname.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  return parsed.origin + parsed.pathname.slice(0, lastSlash + 1);
}

/** Classify by URL alone. Returns null when the URL looks unrelated to media. */
export function kindFromUrl(url) {
  return EXTENSION_KINDS.get(extensionOf(url)) ?? null;
}

/** Classify by `Content-Type` header. Returns null when unrecognised. */
export function kindFromContentType(contentType) {
  if (!contentType) return null;
  const bare = String(contentType).split(';')[0].trim().toLowerCase();
  const known = CONTENT_TYPE_KINDS.get(bare);
  if (known) return known;
  // Unrecognised but still video: worth listing, we just cannot name it.
  if (bare.startsWith('video/')) return MediaKind.OTHER;
  return null;
}

/** Human label for a media kind, used on the type badge in the panel. */
export function labelForKind(kind) {
  switch (kind) {
    case MediaKind.HLS: return 'HLS';
    case MediaKind.MP4: return 'MP4';
    case MediaKind.TS: return 'TS';
    case MediaKind.WEBM: return 'WEBM';
    case MediaKind.MKV: return 'MKV';
    case MediaKind.OGG: return 'OGV';
    default: return 'VIDEO';
  }
}
