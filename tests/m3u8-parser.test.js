import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAttributes,
  parseResolution,
  parsePlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
  isMasterPlaylist,
  isPlaylist,
  pickVariant,
  describeVariant,
} from '../lib/m3u8-parser.js';

const BASE = 'https://cdn.example.com/videos/show/index.m3u8';

test('parseAttributes keeps commas inside quoted values', () => {
  const attributes = parseAttributes(
    'BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720',
  );
  assert.equal(attributes.BANDWIDTH, '1280000');
  assert.equal(attributes.CODECS, 'avc1.4d401f,mp4a.40.2');
  assert.equal(attributes.RESOLUTION, '1280x720');
});

test('parseAttributes handles quoted URIs containing query strings', () => {
  const attributes = parseAttributes('METHOD=AES-128,URI="https://k.example.com/k?a=1,b=2",IV=0x00');
  assert.equal(attributes.METHOD, 'AES-128');
  assert.equal(attributes.URI, 'https://k.example.com/k?a=1,b=2');
  assert.equal(attributes.IV, '0x00');
});

test('parseResolution parses and rejects', () => {
  assert.deepEqual(parseResolution('1920x1080'), { width: 1920, height: 1080 });
  assert.equal(parseResolution('broken'), null);
  assert.equal(parseResolution(''), null);
});

test('isPlaylist and isMasterPlaylist classify correctly', () => {
  assert.equal(isPlaylist('#EXTM3U\n#EXT-X-ENDLIST'), true);
  assert.equal(isPlaylist('<html>nope</html>'), false);
  assert.equal(isMasterPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8'), true);
  assert.equal(isMasterPlaylist('#EXTM3U\n#EXTINF:4,\na.ts'), false);
});

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01e"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1.640028",FRAME-RATE=29.970
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
720p/index.m3u8
`;

test('parseMasterPlaylist reads variants, sorts best first, resolves URIs', () => {
  const result = parseMasterPlaylist(MASTER, BASE);

  assert.equal(result.type, 'master');
  assert.equal(result.variants.length, 3);
  assert.deepEqual(
    result.variants.map((variant) => variant.height),
    [1080, 720, 360],
  );
  assert.equal(result.variants[0].uri, 'https://cdn.example.com/videos/show/1080p/index.m3u8');
  assert.equal(result.variants[0].bandwidth, 5200000);
  assert.equal(result.variants[0].frameRate, 29.97);
  assert.equal(result.variants[2].codecs, 'avc1.42c01e');
  assert.equal(result.drm.protected, false);
});

test('parseMasterPlaylist collects audio renditions', () => {
  const { audio } = parseMasterPlaylist(MASTER, BASE);
  assert.equal(audio.length, 1);
  assert.equal(audio[0].language, 'en');
  assert.equal(audio[0].isDefault, true);
  assert.equal(audio[0].uri, 'https://cdn.example.com/videos/show/audio/en.m3u8');
});

test('parsePlaylist dispatches on playlist flavour', () => {
  assert.equal(parsePlaylist(MASTER, BASE).type, 'master');
  assert.equal(parsePlaylist('#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST', BASE).type, 'media');
  assert.throws(() => parsePlaylist('not a playlist', BASE), /Not an HLS playlist/);
});

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:9.009,
seg0.ts
#EXTINF:9.009,
seg1.ts
#EXT-X-DISCONTINUITY
#EXTINF:3.003,
https://other.example.com/seg2.ts
#EXT-X-ENDLIST
`;

test('parseMediaPlaylist reads segments, durations and absolute URIs', () => {
  const result = parseMediaPlaylist(MEDIA, BASE);

  assert.equal(result.type, 'media');
  assert.equal(result.segments.length, 3);
  assert.equal(result.targetDuration, 10);
  assert.equal(result.isLive, false);
  assert.equal(result.playlistType, 'VOD');
  assert.equal(result.encrypted, false);
  assert.ok(Math.abs(result.totalDuration - 21.021) < 1e-9);

  assert.equal(result.segments[0].uri, 'https://cdn.example.com/videos/show/seg0.ts');
  assert.equal(result.segments[2].uri, 'https://other.example.com/seg2.ts');
  assert.equal(result.segments[2].discontinuity, true);
  assert.equal(result.segments[1].discontinuity, false);
  assert.deepEqual(
    result.segments.map((segment) => segment.index),
    [0, 1, 2],
  );
});

test('media sequence offsets segment sequence numbers', () => {
  const playlist = MEDIA.replace('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:17');
  const { segments, mediaSequence } = parseMediaPlaylist(playlist, BASE);
  assert.equal(mediaSequence, 17);
  assert.deepEqual(
    segments.map((segment) => segment.sequence),
    [17, 18, 19],
  );
});

test('a playlist without ENDLIST is treated as live', () => {
  const playlist = MEDIA.replace('#EXT-X-ENDLIST\n', '').replace(
    '#EXT-X-PLAYLIST-TYPE:VOD\n',
    '',
  );
  assert.equal(parseMediaPlaylist(playlist, BASE).isLive, true);
});

test('AES-128 keys attach to the segments that follow them', () => {
  const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789ABCDEF0123456789ABCDEF
#EXTINF:9.9,
seg0.ts
#EXTINF:9.9,
seg1.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:9.9,
seg2.ts
#EXT-X-ENDLIST
`;
  const { segments, encrypted, drm } = parseMediaPlaylist(playlist, BASE);

  assert.equal(encrypted, true);
  assert.equal(drm.protected, false);
  assert.equal(segments[0].key.method, 'AES-128');
  assert.equal(segments[0].key.uri, 'https://cdn.example.com/videos/show/key.bin');
  assert.equal(segments[0].key.iv, '0x0123456789ABCDEF0123456789ABCDEF');
  assert.equal(segments[1].key.uri, segments[0].key.uri);
  assert.equal(segments[2].key, null, 'METHOD=NONE clears the key');
});

test('SAMPLE-AES is reported as DRM-protected', () => {
  const playlist = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:4,
seg0.ts
#EXT-X-ENDLIST
`;
  const { drm } = parseMediaPlaylist(playlist, BASE);
  assert.equal(drm.protected, true);
  assert.match(drm.reason, /SAMPLE-AES/);
});

test('a Widevine session key marks the master playlist as DRM-protected', () => {
  const playlist = `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="data:text/plain;base64,AA=="
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360
360p.m3u8
`;
  const { drm } = parseMasterPlaylist(playlist, BASE);
  assert.equal(drm.protected, true);
});

test('byte ranges resolve implicit offsets against the same resource', () => {
  const playlist = `#EXTM3U
#EXT-X-MAP:URI="all.mp4",BYTERANGE="800@0"
#EXTINF:4,
#EXT-X-BYTERANGE:1000@800
all.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:2000
all.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:1500
all.mp4
#EXT-X-ENDLIST
`;
  const { segments, initSegment } = parseMediaPlaylist(playlist, BASE);

  assert.deepEqual(initSegment.byteRange, { length: 800, offset: 0 });
  assert.deepEqual(segments[0].byteRange, { length: 1000, offset: 800 });
  assert.deepEqual(segments[1].byteRange, { length: 2000, offset: 1800 });
  assert.deepEqual(segments[2].byteRange, { length: 1500, offset: 3800 });
});

test('segments without EXTINF still parse', () => {
  const { segments } = parseMediaPlaylist('#EXTM3U\nseg0.ts\n#EXT-X-ENDLIST\n', BASE);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].duration, 0);
});

test('CRLF line endings and blank lines are tolerated', () => {
  const { segments } = parseMediaPlaylist(
    '#EXTM3U\r\n\r\n#EXTINF:4,\r\nseg0.ts\r\n\r\n#EXT-X-ENDLIST\r\n',
    BASE,
  );
  assert.equal(segments.length, 1);
  assert.equal(segments[0].uri, 'https://cdn.example.com/videos/show/seg0.ts');
});

test('pickVariant honours a target height and falls back downward', () => {
  const { variants } = parseMasterPlaylist(MASTER, BASE);
  assert.equal(pickVariant(variants, 1080).height, 1080);
  assert.equal(pickVariant(variants, 900).height, 720, 'closest below the target');
  assert.equal(pickVariant(variants, null).height, 1080, 'best available by default');
  assert.equal(pickVariant(variants, 144).height, 360, 'lowest available when nothing fits');
  assert.equal(pickVariant([], 720), null);
});

test('describeVariant produces a compact label', () => {
  assert.equal(describeVariant({ height: 1080, bandwidth: 5200000 }), '1080p · 5.2 Mbps');
  assert.equal(describeVariant({}), 'unknown quality');
});
