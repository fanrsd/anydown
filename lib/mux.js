/**
 * Join a video-only and an audio-only fragmented MP4 into one file.
 *
 * HLS serves a separate audio rendition as its own stream, so a download
 * produces two byte streams that no player will open together. Concatenating
 * them is meaningless: each carries its own `moov`. The tracks have to be
 * described once, in one container, with their samples copied across.
 *
 * `MP4Box` is injected rather than imported so this runs under `node --test`
 * without a DOM, the same reason `fetchWithRetry` takes a `fetchImpl`.
 *
 * Only fragmented MP4 input works. MPEG-TS carries its own framing and would
 * need a demuxer; callers check before reaching here.
 */

/** Read a whole fMP4 byte stream, resolved once its moov has been parsed. */
function parseFile(MP4Box, bytes) {
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    file.onError = (error) => reject(new Error(String(error)));
    file.onReady = (info) => resolve({ file, info });

    // mp4box takes an ArrayBuffer tagged with its offset in the stream. A
    // Uint8Array view may sit inside a larger buffer, so slice to be exact.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    buffer.fileStart = 0;
    file.appendBuffer(buffer);
    file.flush();

    // `onReady` fires during parsing above. Reaching here without it means the
    // bytes were not a parseable MP4 — a TS stream, or a truncated download.
    reject(new Error('No MP4 moov box found'));
  });
}

/** Every sample of one track, in order. */
function readSamples(file, trackId, expected) {
  const collected = [];
  file.onSamples = (_id, _user, samples) => collected.push(...samples);
  file.setExtractionOptions(trackId, null, { nbSamples: expected });
  file.start();
  file.flush();
  file.stop();

  if (collected.length === 0 && expected > 0) {
    throw new Error(`Track ${trackId} yielded no samples`);
  }
  return collected;
}

/**
 * The decoder configuration box for a track: `avcC`, `hvcC` or `esds`.
 *
 * Without it the output names a codec it never describes, and the file opens
 * to a black screen or silence rather than failing outright.
 */
function describeTrack(file, trackId) {
  const trak = file.getTrackById(trackId);
  const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
  if (!entry) throw new Error(`Track ${trackId} has no sample description`);

  const config = entry.avcC ?? entry.hvcC ?? entry.av1C ?? entry.vpcC ?? entry.esds ?? null;
  if (!config) throw new Error(`Track ${trackId} has no decoder configuration`);
  return { entry, config };
}

/** Copy every sample of a source track into the output track. */
function copySamples(output, outputTrackId, file, track) {
  for (const sample of readSamples(file, track.id, track.nb_samples)) {
    output.addSample(outputTrackId, sample.data, {
      duration: sample.duration,
      dts: sample.dts,
      cts: sample.cts,
      is_sync: sample.is_sync,
    });
  }
}

/**
 * @param {object} MP4Box the mp4box.js module or global
 * @param {Uint8Array} videoBytes a video-only fragmented MP4
 * @param {Uint8Array} audioBytes an audio-only fragmented MP4
 * @returns {Promise<Uint8Array>} one MP4 holding both tracks
 */
export async function muxToMp4(MP4Box, videoBytes, audioBytes) {
  const video = await parseFile(MP4Box, videoBytes);
  const audio = await parseFile(MP4Box, audioBytes);

  const videoTrack = video.info.videoTracks?.[0];
  const audioTrack = audio.info.audioTracks?.[0];
  if (!videoTrack) throw new Error('The video stream holds no video track');
  if (!audioTrack) throw new Error('The audio stream holds no audio track');

  const videoConfig = describeTrack(video.file, videoTrack.id);
  const audioConfig = describeTrack(audio.file, audioTrack.id);

  const output = MP4Box.createFile();

  // `type` is the sample entry fourCC, which mp4box uses to pick the entry
  // class. Taking it from the source keeps HEVC and AV1 working, not just AVC.
  const videoId = output.addTrack({
    type: videoConfig.entry.type,
    hdlr: 'vide',
    timescale: videoTrack.timescale,
    width: videoTrack.track_width,
    height: videoTrack.track_height,
    description: videoConfig.config,
  });

  const audioId = output.addTrack({
    type: audioConfig.entry.type,
    hdlr: 'soun',
    timescale: audioTrack.timescale,
    channel_count: audioConfig.entry.channel_count,
    samplesize: audioConfig.entry.samplesize,
    samplerate: audioConfig.entry.samplerate,
    description: audioConfig.config,
  });

  copySamples(output, videoId, video.file, videoTrack);
  copySamples(output, audioId, audio.file, audioTrack);

  return new Uint8Array(output.getBuffer());
}
