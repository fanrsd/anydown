/**
 * AES-128-CBC helpers for HLS clear-key segments (`#EXT-X-KEY:METHOD=AES-128`).
 *
 * Only clear-key transport encryption is handled here. DRM systems are refused
 * upstream in the parser; nothing in this file attempts to defeat one.
 *
 * Uses the standard Web Crypto API, so it runs unchanged in the offscreen
 * document and under `node --test`.
 */

/** Decode a hex string, with or without a `0x` prefix, into bytes. */
export function hexToBytes(hex) {
  let text = String(hex).trim();
  if (text.startsWith('0x') || text.startsWith('0X')) text = text.slice(2);
  if (text.length % 2 !== 0) text = `0${text}`;
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`Invalid hex in IV or key: ${hex}`);
    bytes[i] = byte;
  }
  return bytes;
}

/** Encode bytes as a lowercase hex string. Used for logging and tests. */
export function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build the 16-byte initialisation vector for a segment.
 *
 * RFC 8216 §5.2: when `#EXT-X-KEY` carries no `IV`, the media sequence number
 * of the segment is used as a 128-bit big-endian integer.
 *
 * @param {string|null} explicitIv the `IV` attribute, if the playlist had one
 * @param {number} sequenceNumber the segment's media sequence number
 * @returns {Uint8Array} exactly 16 bytes
 */
export function ivForSegment(explicitIv, sequenceNumber) {
  if (explicitIv) {
    const bytes = hexToBytes(explicitIv);
    if (bytes.length === 16) return bytes;
    // Right-align a short IV, truncate an over-long one, so a sloppy playlist
    // still yields a usable 16-byte block.
    const iv = new Uint8Array(16);
    if (bytes.length < 16) iv.set(bytes, 16 - bytes.length);
    else iv.set(bytes.subarray(bytes.length - 16));
    return iv;
  }

  const iv = new Uint8Array(16);
  // Big-endian across the low 8 bytes; sequence numbers never exceed 2^53.
  let value = BigInt(Math.max(0, Math.trunc(sequenceNumber)));
  for (let i = 15; i >= 8 && value > 0n; i--) {
    iv[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return iv;
}

/**
 * Import a raw 16-byte AES key.
 *
 * `encrypt` is requested alongside `decrypt` because the unpadded fallback in
 * {@link decryptSegment} needs to encrypt a single synthetic block.
 *
 * @param {ArrayBuffer|Uint8Array} rawKey
 * @returns {Promise<CryptoKey>}
 */
export async function importAesKey(rawKey) {
  const bytes = rawKey instanceof Uint8Array ? rawKey : new Uint8Array(rawKey);
  if (bytes.length !== 16) {
    throw new Error(`AES-128 key must be 16 bytes, got ${bytes.length}`);
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-CBC' }, false, [
    'decrypt',
    'encrypt',
  ]);
}

/**
 * Decrypt ciphertext whose final block carries no PKCS#7 padding.
 *
 * `SubtleCrypto.decrypt` always validates padding and has no "no padding"
 * mode, so a synthetic block is appended whose plaintext is a full pad block:
 *
 *   append E(pad XOR C_n), so P_(n+1) = D(E(pad XOR C_n)) XOR C_n = pad
 *
 * SubtleCrypto then validates that block, strips it, and returns exactly the
 * original plaintext.
 */
async function decryptWithoutPadding(key, iv, data) {
  const bytes = new Uint8Array(data);
  const lastCipherBlock = bytes.slice(bytes.length - 16);
  const fullPadBlock = new Uint8Array(16).fill(16);

  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv: lastCipherBlock }, key, fullPadBlock),
  );

  const combined = new Uint8Array(bytes.length + 16);
  combined.set(bytes);
  combined.set(encrypted.subarray(0, 16), bytes.length);

  return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, combined);
}

/**
 * Decrypt one AES-128-CBC segment.
 *
 * Most encoders pad with PKCS#7, which SubtleCrypto handles directly. A few
 * emit ciphertext that is already block-aligned with no pad block, which makes
 * SubtleCrypto throw `OperationError`; that case falls through to
 * {@link decryptWithoutPadding}.
 *
 * @param {CryptoKey} key
 * @param {Uint8Array} iv 16 bytes
 * @param {ArrayBuffer|Uint8Array} data ciphertext
 * @returns {Promise<ArrayBuffer>} plaintext
 */
export async function decryptSegment(key, iv, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length === 0) return new ArrayBuffer(0);
  if (bytes.length % 16 !== 0) {
    throw new Error(`Encrypted segment is not block-aligned (${bytes.length} bytes)`);
  }

  try {
    return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, bytes);
  } catch (error) {
    if (error?.name !== 'OperationError') throw error;
    return decryptWithoutPadding(key, iv, bytes);
  }
}

/**
 * Cache of imported keys so a playlist with thousands of segments sharing one
 * key URI does not re-fetch and re-import it thousands of times.
 */
export class KeyCache {
  #keys = new Map();

  /**
   * @param {(url: string) => Promise<ArrayBuffer>} fetchKeyBytes fetches raw key material
   */
  constructor(fetchKeyBytes) {
    this.fetchKeyBytes = fetchKeyBytes;
  }

  /**
   * Resolve a key URI to an imported {@link CryptoKey}, fetching at most once
   * per URI even under concurrent callers.
   */
  async get(keyUri) {
    if (!keyUri) throw new Error('Encrypted stream has no key URI');
    let pending = this.#keys.get(keyUri);
    if (!pending) {
      pending = this.fetchKeyBytes(keyUri).then(importAesKey);
      this.#keys.set(keyUri, pending);
      // A failed fetch must not be cached, or every later segment inherits it.
      pending.catch(() => this.#keys.delete(keyUri));
    }
    return pending;
  }

  clear() {
    this.#keys.clear();
  }
}
