import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hexToBytes,
  bytesToHex,
  ivForSegment,
  importAesKey,
  decryptSegment,
  KeyCache,
} from '../lib/crypto-aes.js';

const KEY_BYTES = new Uint8Array([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
]);

test('hexToBytes accepts a 0x prefix and odd lengths', () => {
  assert.deepEqual(Array.from(hexToBytes('0x00ff')), [0, 255]);
  assert.deepEqual(Array.from(hexToBytes('00FF')), [0, 255]);
  assert.deepEqual(Array.from(hexToBytes('f')), [15], 'odd length is left-padded');
  assert.throws(() => hexToBytes('zz'), /Invalid hex/);
});

test('bytesToHex round-trips', () => {
  assert.equal(bytesToHex(KEY_BYTES), '000102030405060708090a0b0c0d0e0f');
  assert.deepEqual(Array.from(hexToBytes(bytesToHex(KEY_BYTES))), Array.from(KEY_BYTES));
});

test('an explicit IV is used verbatim', () => {
  const iv = ivForSegment('0x0123456789abcdef0123456789abcdef', 42);
  assert.equal(bytesToHex(iv), '0123456789abcdef0123456789abcdef');
});

test('a short IV is right-aligned and a long one is truncated', () => {
  assert.equal(bytesToHex(ivForSegment('0x01ff', 0)), '000000000000000000000000000001ff');
  const long = '11'.repeat(20);
  assert.equal(bytesToHex(ivForSegment(`0x${long}`, 0)).length, 32);
});

test('without an IV the media sequence number is used, big-endian', () => {
  assert.equal(bytesToHex(ivForSegment(null, 0)), '0'.repeat(32));
  assert.equal(bytesToHex(ivForSegment(null, 1)), '00000000000000000000000000000001');
  assert.equal(bytesToHex(ivForSegment(null, 258)), '00000000000000000000000000000102');
  assert.equal(bytesToHex(ivForSegment(null, 0xabcdef)), '00000000000000000000000000abcdef');
});

test('importAesKey rejects keys that are not 16 bytes', async () => {
  await assert.rejects(() => importAesKey(new Uint8Array(8)), /must be 16 bytes/);
  await assert.rejects(() => importAesKey(new Uint8Array(32)), /must be 16 bytes/);
});

test('decryptSegment recovers PKCS#7-padded ciphertext', async () => {
  const key = await importAesKey(KEY_BYTES);
  const iv = ivForSegment(null, 7);
  const plaintext = new TextEncoder().encode('mpeg-ts payload that is not block aligned');

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plaintext);
  const decrypted = await decryptSegment(key, iv, ciphertext);

  assert.deepEqual(new Uint8Array(decrypted), plaintext);
});

test('decryptSegment recovers ciphertext written without a pad block', async () => {
  const key = await importAesKey(KEY_BYTES);
  const iv = ivForSegment(null, 3);
  // Exactly two blocks of plaintext.
  const plaintext = new Uint8Array(32).map((_, index) => index * 3);

  // SubtleCrypto always pads, so drop the trailing pad block it appends to
  // produce the unpadded ciphertext some HLS encoders emit.
  const padded = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plaintext));
  const unpadded = padded.subarray(0, padded.length - 16);
  assert.equal(unpadded.length, 32);

  const decrypted = await decryptSegment(key, iv, unpadded);
  assert.deepEqual(new Uint8Array(decrypted), plaintext);
});

test('decryptSegment rejects ciphertext that is not block-aligned', async () => {
  const key = await importAesKey(KEY_BYTES);
  await assert.rejects(
    () => decryptSegment(key, ivForSegment(null, 0), new Uint8Array(17)),
    /not block-aligned/,
  );
});

test('decryptSegment passes an empty segment straight through', async () => {
  const key = await importAesKey(KEY_BYTES);
  const result = await decryptSegment(key, ivForSegment(null, 0), new Uint8Array(0));
  assert.equal(result.byteLength, 0);
});

test('KeyCache fetches each key URI exactly once', async () => {
  let fetches = 0;
  const cache = new KeyCache(async () => {
    fetches++;
    return KEY_BYTES.buffer.slice(0);
  });

  const [first, second, third] = await Promise.all([
    cache.get('https://k/1'),
    cache.get('https://k/1'),
    cache.get('https://k/2'),
  ]);

  assert.equal(fetches, 2, 'one fetch per distinct URI, even under concurrency');
  assert.equal(first, second);
  assert.notEqual(first, third);
});

test('KeyCache does not cache a failed fetch', async () => {
  let attempts = 0;
  const cache = new KeyCache(async () => {
    attempts++;
    if (attempts === 1) throw new Error('network down');
    return KEY_BYTES.buffer.slice(0);
  });

  await assert.rejects(() => cache.get('https://k/1'), /network down/);
  await cache.get('https://k/1');
  assert.equal(attempts, 2, 'the second call retries rather than replaying the failure');
});

test('KeyCache requires a key URI', async () => {
  const cache = new KeyCache(async () => KEY_BYTES.buffer.slice(0));
  await assert.rejects(() => cache.get(null), /no key URI/);
});
