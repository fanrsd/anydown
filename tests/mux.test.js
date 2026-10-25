import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import MP4Box from 'mp4box';
import { muxToMp4 } from '../lib/mux.js';

/*
 * HLS hands a separate audio rendition over as its own stream. Joining the two
 * is what decides whether the saved file has sound, so these fixtures are real
 * fragmented MP4s — a video-only stream and an audio-only one, one second each.
 */
const fixture = (name) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

const VIDEO = fixture('video-only.mp4');
const AUDIO = fixture('audio-only.m4a');

/** Parse bytes back into track info, so the output is judged by what it says. */
function inspect(bytes) {
  const file = MP4Box.createFile();
  let info = null;
  file.onReady = (parsed) => {
    info = parsed;
  };
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  buffer.fileStart = 0;
  file.appendBuffer(buffer);
  file.flush();
  return info;
}

test('the fixtures really are one-track streams, or the rest proves nothing', () => {
  const video = inspect(VIDEO);
  const audio = inspect(AUDIO);

  assert.equal(video.videoTracks.length, 1);
  assert.equal(video.audioTracks.length, 0);
  assert.equal(audio.audioTracks.length, 1);
  assert.equal(audio.videoTracks.length, 0);
});

test('muxing puts both streams in one file that still describes its codecs', async () => {
  const merged = inspect(await muxToMp4(MP4Box, VIDEO, AUDIO));

  assert.equal(merged.videoTracks.length, 1);
  assert.equal(merged.audioTracks.length, 1);

  // A codec string survives only when the decoder configuration box came
  // across. Lose it and the file opens to a black screen or to silence.
  assert.match(merged.videoTracks[0].codec, /^avc1\./);
  assert.match(merged.audioTracks[0].codec, /^mp4a\./);
});

test('every sample crosses over, so neither track is truncated', async () => {
  const video = inspect(VIDEO);
  const audio = inspect(AUDIO);
  const merged = inspect(await muxToMp4(MP4Box, VIDEO, AUDIO));

  assert.equal(merged.videoTracks[0].nb_samples, video.videoTracks[0].nb_samples);
  assert.equal(merged.audioTracks[0].nb_samples, audio.audioTracks[0].nb_samples);
});

test('timescales are kept per track, not forced to a shared one', async () => {
  const video = inspect(VIDEO);
  const audio = inspect(AUDIO);
  const merged = inspect(await muxToMp4(MP4Box, VIDEO, AUDIO));

  // Video and audio run on different clocks. Rewriting either would drift the
  // two apart over a feature-length film.
  assert.equal(merged.videoTracks[0].timescale, video.videoTracks[0].timescale);
  assert.equal(merged.audioTracks[0].timescale, audio.audioTracks[0].timescale);
  assert.notEqual(merged.videoTracks[0].timescale, merged.audioTracks[0].timescale);
});

test('input that is not MP4 is refused, so the caller can fall back', async () => {
  // MPEG-TS starts with a 0x47 sync byte and carries no moov at all.
  const ts = new Uint8Array(376).fill(0);
  ts[0] = 0x47;
  ts[188] = 0x47;

  await assert.rejects(() => muxToMp4(MP4Box, ts, AUDIO));
});

test('a stream missing the track it was chosen for is refused', async () => {
  await assert.rejects(() => muxToMp4(MP4Box, AUDIO, AUDIO), /no video track/i);
  await assert.rejects(() => muxToMp4(MP4Box, VIDEO, VIDEO), /no audio track/i);
});
