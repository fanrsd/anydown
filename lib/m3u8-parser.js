/**
 * HLS playlist parser (RFC 8216 subset).
 *
 * Handles the tags a downloader actually needs: variant selection, segment
 * lists, AES-128 keys, byte ranges, fMP4 init segments, and enough DRM
 * signalling to refuse protected content instead of producing garbage.
 *
 * Pure functions only — no network, no `chrome.*`, no DOM.
 */

import { DRM_KEY_METHODS, DRM_KEY_FORMATS } from './constants.js';

/**
 * Parse an HLS attribute list: comma-separated `KEY=VALUE` pairs where a value
 * may be a quoted string containing commas, a hex sequence, or a bare token.
 *
 * @param {string} input the text after the tag's colon
 * @returns {Record<string, string>}
 */
export function parseAttributes(input) {
  const attributes = {};
  const length = input.length;
  let cursor = 0;

  while (cursor < length) {
    while (cursor < length && (input[cursor] === ',' || input[cursor] === ' ')) cursor++;
    if (cursor >= length) break;

    const equals = input.indexOf('=', cursor);
    if (equals === -1) break;
    const key = input.slice(cursor, equals).trim();
    cursor = equals + 1;

    let value;
    if (input[cursor] === '"') {
      const closing = input.indexOf('"', cursor + 1);
      if (closing === -1) {
        value = input.slice(cursor + 1);
        cursor = length;
      } else {
        value = input.slice(cursor + 1, closing);
        cursor = closing + 1;
      }
    } else {
      let comma = input.indexOf(',', cursor);
      if (comma === -1) comma = length;
      value = input.slice(cursor, comma).trim();
      cursor = comma;
    }

    if (key) attributes[key] = value;
  }

  return attributes;
}

/** Parse `1920x1080` into `{ width, height }`, or null when malformed. */
export function parseResolution(value) {
  if (!value) return null;
  const match = /^(\d+)\s*[xX]\s*(\d+)$/.exec(value.trim());
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Parse `#EXT-X-BYTERANGE:<length>[@<offset>]`. */
function parseByteRange(value) {
  if (!value) return null;
  const [rawLength, rawOffset] = value.trim().split('@');
  const length = Number(rawLength);
  if (!Number.isFinite(length)) return null;
  const offset = rawOffset === undefined ? null : Number(rawOffset);
  return { length, offset: Number.isFinite(offset) ? offset : null };
}

/**
 * Resolve a playlist-relative URI. Falls back to the raw value when there is
 * no usable base, so a malformed line never throws mid-parse.
 */
function resolveUri(uri, baseUrl) {
  if (!baseUrl) return uri;
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

/** Does this key declaration indicate a commercial DRM system? */
function drmReasonForKey(attributes) {
  const method = (attributes.METHOD || '').toUpperCase();
  if (DRM_KEY_METHODS.has(method)) {
    return `stream uses ${method}, which is DRM-protected`;
  }
  const format = (attributes.KEYFORMAT || '').toLowerCase();
  if (format && format !== 'identity') {
    const matched = DRM_KEY_FORMATS.find((candidate) => format.includes(candidate));
    if (matched) return `stream is protected by a DRM system (${attributes.KEYFORMAT})`;
    return `stream uses an unsupported key format (${attributes.KEYFORMAT})`;
  }
  return null;
}

/** Normalise an `#EXT-X-KEY` attribute list into the shape segments carry. */
function toKey(attributes, baseUrl) {
  const method = (attributes.METHOD || '').toUpperCase();
  if (!method || method === 'NONE') return null;
  return {
    method,
    uri: attributes.URI ? resolveUri(attributes.URI, baseUrl) : null,
    iv: attributes.IV || null,
    keyFormat: attributes.KEYFORMAT || 'identity',
  };
}

/** Split into trimmed, non-empty lines. Tolerates CRLF and stray blank lines. */
function toLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** True when the text looks like an HLS playlist at all. */
export function isPlaylist(text) {
  return typeof text === 'string' && text.trimStart().startsWith('#EXTM3U');
}

/** True when the playlist declares variant streams rather than segments. */
export function isMasterPlaylist(text) {
  return /^#EXT-X-STREAM-INF:/m.test(text);
}

/**
 * Parse a master playlist.
 *
 * @param {string} text
 * @param {string} baseUrl playlist URL, used to resolve relative variant URIs
 * @returns {{type: 'master', variants: Array, audio: Array, subtitles: Array, drm: {protected: boolean, reason: string|null}}}
 */
export function parseMasterPlaylist(text, baseUrl) {
  const lines = toLines(text);
  const variants = [];
  const audio = [];
  const subtitles = [];
  let drmReason = null;
  let pendingVariant = null;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      const rendition = {
        type: (attributes.TYPE || '').toUpperCase(),
        groupId: attributes['GROUP-ID'] || null,
        name: attributes.NAME || null,
        language: attributes.LANGUAGE || null,
        isDefault: (attributes.DEFAULT || '').toUpperCase() === 'YES',
        uri: attributes.URI ? resolveUri(attributes.URI, baseUrl) : null,
      };
      if (rendition.type === 'AUDIO') audio.push(rendition);
      else if (rendition.type === 'SUBTITLES') subtitles.push(rendition);
      continue;
    }

    if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      drmReason ??= drmReasonForKey(parseAttributes(line.slice('#EXT-X-SESSION-KEY:'.length)));
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pendingVariant) {
      const resolution = parseResolution(pendingVariant.RESOLUTION);
      const bandwidth = Number(pendingVariant['AVERAGE-BANDWIDTH'] || pendingVariant.BANDWIDTH);
      variants.push({
        uri: resolveUri(line, baseUrl),
        bandwidth: Number.isFinite(bandwidth) ? bandwidth : 0,
        peakBandwidth: Number(pendingVariant.BANDWIDTH) || 0,
        resolution,
        height: resolution?.height ?? null,
        width: resolution?.width ?? null,
        codecs: pendingVariant.CODECS || null,
        frameRate: Number(pendingVariant['FRAME-RATE']) || null,
        audioGroup: pendingVariant.AUDIO || null,
      });
      pendingVariant = null;
    }
  }

  // Best quality first: height wins, bandwidth breaks ties.
  variants.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth);

  return {
    type: 'master',
    variants,
    audio,
    subtitles,
    drm: { protected: Boolean(drmReason), reason: drmReason },
  };
}

/**
 * Parse a media playlist into an ordered segment list.
 *
 * @param {string} text
 * @param {string} baseUrl playlist URL, used to resolve relative segment URIs
 * @returns {{type: 'media', segments: Array, targetDuration: number, mediaSequence: number,
 *   isLive: boolean, playlistType: string|null, totalDuration: number, encrypted: boolean,
 *   initSegment: object|null, drm: {protected: boolean, reason: string|null}}}
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = toLines(text);
  const segments = [];

  let currentKey = null;
  let drmReason = null;
  let pendingDuration = 0;
  let pendingTitle = null;
  let pendingByteRange = null;
  let pendingDiscontinuity = false;
  let targetDuration = 0;
  let mediaSequence = 0;
  let playlistType = null;
  let hasEndList = false;
  let initSegment = null;
  // Byte ranges without an explicit offset continue from the previous range on
  // the same resource, so the running offset is tracked per URL.
  const nextOffsetByUrl = new Map();

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const payload = line.slice('#EXTINF:'.length);
      const comma = payload.indexOf(',');
      const duration = Number(comma === -1 ? payload : payload.slice(0, comma));
      pendingDuration = Number.isFinite(duration) ? duration : 0;
      pendingTitle = comma === -1 ? null : payload.slice(comma + 1).trim() || null;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attributes = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      drmReason ??= drmReasonForKey(attributes);
      currentKey = toKey(attributes, baseUrl);
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (attributes.URI) {
        initSegment = {
          uri: resolveUri(attributes.URI, baseUrl),
          byteRange: parseByteRange(attributes.BYTERANGE),
          key: currentKey,
        };
      }
      continue;
    }

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim().toUpperCase();
      continue;
    }

    if (line === '#EXT-X-DISCONTINUITY') {
      pendingDiscontinuity = true;
      continue;
    }

    if (line === '#EXT-X-ENDLIST') {
      hasEndList = true;
      continue;
    }

    if (line.startsWith('#')) continue;

    const uri = resolveUri(line, baseUrl);
    let byteRange = pendingByteRange;
    if (byteRange && byteRange.offset === null) {
      byteRange = { length: byteRange.length, offset: nextOffsetByUrl.get(uri) ?? 0 };
    }
    if (byteRange) {
      nextOffsetByUrl.set(uri, byteRange.offset + byteRange.length);
    }

    segments.push({
      index: segments.length,
      sequence: mediaSequence + segments.length,
      uri,
      duration: pendingDuration,
      title: pendingTitle,
      byteRange,
      key: currentKey,
      discontinuity: pendingDiscontinuity,
    });

    pendingDuration = 0;
    pendingTitle = null;
    pendingByteRange = null;
    pendingDiscontinuity = false;
  }

  const totalDuration = segments.reduce((sum, segment) => sum + segment.duration, 0);

  return {
    type: 'media',
    segments,
    targetDuration,
    mediaSequence,
    playlistType,
    isLive: !hasEndList && playlistType !== 'VOD',
    totalDuration,
    encrypted: segments.some((segment) => segment.key !== null),
    initSegment,
    drm: { protected: Boolean(drmReason), reason: drmReason },
  };
}

/**
 * Parse either flavour of playlist, dispatching on its contents.
 *
 * @throws {Error} when the text is not an HLS playlist at all
 */
export function parsePlaylist(text, baseUrl) {
  if (!isPlaylist(text)) {
    throw new Error('Not an HLS playlist (missing #EXTM3U header)');
  }
  return isMasterPlaylist(text)
    ? parseMasterPlaylist(text, baseUrl)
    : parseMediaPlaylist(text, baseUrl);
}

/**
 * Pick a variant by target height, falling back to the closest one below it,
 * then to the best available. Returns null for an empty variant list.
 */
export function pickVariant(variants, targetHeight) {
  if (!variants || variants.length === 0) return null;
  if (targetHeight == null) return variants[0];
  const exact = variants.find((variant) => variant.height === targetHeight);
  if (exact) return exact;
  const below = variants.filter((variant) => (variant.height ?? 0) <= targetHeight);
  return below.length > 0 ? below[0] : variants[variants.length - 1];
}

/** Short label for a variant, e.g. `1080p · 5.2 Mbps`. */
export function describeVariant(variant) {
  const parts = [];
  if (variant.height) parts.push(`${variant.height}p`);
  else if (variant.width) parts.push(`${variant.width}w`);
  if (variant.bandwidth) parts.push(`${(variant.bandwidth / 1_000_000).toFixed(1)} Mbps`);
  return parts.join(' · ') || 'unknown quality';
}

/** Segment work items for a media playlist, fMP4 init segment first. */
export function segmentsOf(playlist) {
  const work = [];
  if (playlist.initSegment) {
    work.push({ ...playlist.initSegment, sequence: playlist.mediaSequence, isInit: true });
  }
  work.push(...playlist.segments);
  return work;
}

/**
 * The audio playlist a variant depends on, or null when the sound is already
 * inside the video segments.
 *
 * An `EXT-X-MEDIA:TYPE=AUDIO` entry without a URI describes audio muxed into
 * the variant itself — nothing extra to fetch. Only a rendition carrying its
 * own URI is a second stream, and ignoring it yields a silent file.
 */
export function separateAudioUri(master, variant) {
  if (!variant.audioGroup) return null;
  const group = master.audio.filter(
    (rendition) => rendition.groupId === variant.audioGroup && rendition.uri,
  );
  if (group.length === 0) return null;
  return (group.find((rendition) => rendition.isDefault) ?? group[0]).uri;
}
