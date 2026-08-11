/**
 * Formatting helpers shared by the panel, the options page and the engine.
 * Pure string/number work — safe to unit test outside a browser.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Format a byte count with a sensible unit, e.g. `1.4 GB`. */
export function formatBytes(bytes, decimals = 1) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), BYTE_UNITS.length - 1);
  const scaled = value / 1024 ** exponent;
  // Whole bytes never need a decimal point.
  const digits = exponent === 0 ? 0 : decimals;
  return `${scaled.toFixed(digits)} ${BYTE_UNITS[exponent]}`;
}

/** Format a transfer rate, e.g. `12.4 MB/s`. */
export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Format seconds as `h:mm:ss` or `m:ss`. */
export function formatDuration(totalSeconds) {
  const seconds = Number(totalSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** Format a remaining-time estimate, e.g. `2:05 left`, or `—` when unknown. */
export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) return '—';
  return `${formatDuration(seconds)} left`;
}

const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Control characters, which are illegal in filenames on every platform. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;
/** Reserved on Windows, or a path separator we must not let through. */
const ILLEGAL_CHARACTERS = /[<>:"/\\|?*]/g;

/**
 * Make a string safe to use as a single filename component on every platform
 * the extension can run on, and acceptable to `chrome.downloads.download`
 * (which rejects path traversal and absolute paths outright).
 *
 * Hyphens and underscores survive deliberately: they carry meaning in most
 * video titles.
 *
 * @param {string} name candidate name, without extension
 * @param {string} fallback used when nothing usable survives sanitising
 */
export function sanitizeFilename(name, fallback = 'video') {
  let safe = String(name ?? '')
    .normalize('NFC')
    .replace(CONTROL_CHARACTERS, '')
    .replace(ILLEGAL_CHARACTERS, ' ')
    // Separators became spaces above, so a component that is now nothing but
    // dots is a `.` or `..` traversal leftover rather than part of a name.
    .split(' ')
    .filter((component) => !/^\.+$/.test(component))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Leading dots hide files on unix; trailing dots and spaces break Windows.
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '')
    .trim();

  if (WINDOWS_RESERVED_NAMES.has(safe.toLowerCase())) safe = `${safe}_`;

  // Leave room for the extension and a de-duplication suffix from the browser.
  if (safe.length > 120) safe = safe.slice(0, 120).trim();

  return safe || fallback;
}

/**
 * Build a download path: `subfolder/name.ext`, each component sanitised.
 * Returns a relative path, which is what `chrome.downloads.download` wants.
 */
export function buildDownloadPath(subfolder, name, extension) {
  const file = `${sanitizeFilename(name)}.${sanitizeFilename(extension, 'bin')}`;
  const folder = subfolder ? sanitizeFilename(subfolder, '') : '';
  return folder ? `${folder}/${file}` : file;
}

/**
 * Derive a default filename from a page title and a media URL, preferring the
 * page title because it is almost always the more meaningful of the two.
 */
export function suggestFilename({ title, url }) {
  const fromTitle = sanitizeFilename(title ?? '', '');
  if (fromTitle) return fromTitle;

  try {
    const { pathname, hostname } = new URL(url);
    const last = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1));
    const stem = last.replace(/\.[^.]+$/, '');
    const fromUrl = sanitizeFilename(stem, '');
    if (fromUrl && fromUrl.toLowerCase() !== 'index' && fromUrl.toLowerCase() !== 'playlist') {
      return fromUrl;
    }
    return sanitizeFilename(hostname.replace(/^www\./, ''), 'video');
  } catch {
    return 'video';
  }
}

/** Relative timestamp for the history list, e.g. `3 min ago`. */
export function formatRelativeTime(timestamp, now = Date.now()) {
  const elapsed = Math.max(0, now - Number(timestamp));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(Number(timestamp)).toLocaleDateString();
}

/** Shorten a URL for display without losing the parts that identify it. */
export function truncateUrl(url, maxLength = 64) {
  const text = String(url ?? '');
  if (text.length <= maxLength) return text;
  const head = Math.ceil((maxLength - 1) / 2);
  const tail = Math.floor((maxLength - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
