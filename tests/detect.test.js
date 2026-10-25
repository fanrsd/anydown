import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MediaKind,
  OUTPUT_EXTENSION,
  directoryOf,
  isAmbiguousContentType,
  kindFromContentType,
  kindFromUrl,
  mediaKey,
} from '../lib/constants.js';
import { isPlaylist } from '../lib/m3u8-parser.js';

/*
 * The two rules that decide whether a detected URL becomes its own entry in
 * the panel. Both exist because of the same complaint: one film produced a
 * list that kept growing until it was impossible to tell which entry to pick.
 */

test('a re-signed URL keeps the identity of the stream it points at', () => {
  const first = 'https://cdn.example.com/hls/movie/master.m3u8?token=aaa&expires=1000';
  const later = 'https://cdn.example.com/hls/movie/master.m3u8?token=bbb&expires=2000';

  assert.equal(mediaKey(first), mediaKey(later));
  assert.equal(mediaKey(first), 'https://cdn.example.com/hls/movie/master.m3u8');
});

test('different paths stay different entries', () => {
  assert.notEqual(
    mediaKey('https://cdn.example.com/hls/a/master.m3u8'),
    mediaKey('https://cdn.example.com/hls/b/master.m3u8'),
  );
  // Same path on another host is another stream, not the same one.
  assert.notEqual(
    mediaKey('https://one.example.com/hls/master.m3u8'),
    mediaKey('https://two.example.com/hls/master.m3u8'),
  );
});

/*
 * A site that proxies every media file through one endpoint puts the identity
 * in the query. Dropping it collapsed a playlist and all of its segments into
 * one entry, whose kind became whatever arrived last — and a playlist typed as
 * a segment is saved as a text file with a video extension.
 */
test('a proxy endpoint is identified by its query, not its path alone', () => {
  const playlist = 'https://site.example/api/stream?file=master.m3u8';
  const segment = 'https://site.example/api/stream?file=seg-0001.ts';

  assert.notEqual(mediaKey(playlist), mediaKey(segment));
});

test('the query still drops once the path names the file', () => {
  // Otherwise every re-signed CDN URL becomes a new entry again.
  assert.equal(
    mediaKey('https://cdn.example.com/v/master.m3u8?token=aaa'),
    mediaKey('https://cdn.example.com/v/master.m3u8?token=bbb'),
  );
  assert.equal(
    mediaKey('https://cdn.example.com/v/movie.mp4?expires=1'),
    'https://cdn.example.com/v/movie.mp4',
  );
});

test('a URL that will not parse still yields a stable key', () => {
  assert.equal(mediaKey('not a url'), 'not a url');
  assert.equal(mediaKey('not a url'), mediaKey('not a url'));
});

test("a playlist's own directory covers its parts", () => {
  const master = 'https://cdn.example.com/hls/movie/master.m3u8?token=aaa';
  const prefix = directoryOf(master);

  assert.equal(prefix, 'https://cdn.example.com/hls/movie/');

  // Variant playlists, audio renditions, subtitles and segments all live
  // under it, and are parts of the entry already listed.
  for (const part of [
    'https://cdn.example.com/hls/movie/1080p/index.m3u8',
    'https://cdn.example.com/hls/movie/audio-id.m3u8',
    'https://cdn.example.com/hls/movie/subs-en.m3u8',
    'https://cdn.example.com/hls/movie/init.mp4',
    'https://cdn.example.com/hls/movie/seg-00412.ts?token=ccc',
  ]) {
    assert.ok(part.startsWith(prefix), `${part} should be covered by ${prefix}`);
  }
});

test('a sibling directory is a different stream', () => {
  const prefix = directoryOf('https://cdn.example.com/hls/movie/master.m3u8');
  assert.ok(!'https://cdn.example.com/hls/trailer/master.m3u8'.startsWith(prefix));
});

test('seeing a variant before its master does not hide the master', () => {
  // Detection order is whatever the player does, so the narrower directory
  // must not swallow the entry the user actually wants.
  const prefix = directoryOf('https://cdn.example.com/hls/movie/1080p/index.m3u8');
  assert.equal(prefix, 'https://cdn.example.com/hls/movie/1080p/');
  assert.ok(!'https://cdn.example.com/hls/movie/master.m3u8'.startsWith(prefix));
});

test('a playlist at the host root claims nothing', () => {
  // Its directory is the whole host, which would suppress every other video
  // on that CDN. Better to show a duplicate than to hide the real file.
  assert.equal(directoryOf('https://cdn.example.com/master.m3u8'), null);
  assert.equal(directoryOf('https://cdn.example.com/'), null);
  assert.equal(directoryOf('blob:https://example.com/1234'), null);
  assert.equal(directoryOf('not a url'), null);
});

test('Ogg video is recognised and keeps its own container', () => {
  // Found while probing public archives: .ogv matched nothing at all, so the
  // panel offered it as a generic "VIDEO" and saved it as .bin.
  assert.equal(kindFromUrl('https://archive.org/download/x/TheGeneral2.ogv'), MediaKind.OGG);
  assert.equal(kindFromContentType('video/ogg'), MediaKind.OGG);
  assert.equal(OUTPUT_EXTENSION[MediaKind.OGG], 'ogv');
});

/*
 * The third detection pass. Sniffing costs a real request, so what decides
 * whether one is spent matters more than the sniff itself.
 */

test('an uninformative Content-Type is what earns a sniff', () => {
  for (const type of ['application/octet-stream', 'text/plain', 'application/json', '', null]) {
    assert.ok(isAmbiguousContentType(type), `${type} should be sniffable`);
  }
  // Parameters must not defeat the match.
  assert.ok(isAmbiguousContentType('text/plain; charset=utf-8'));
});

test('a type that already means something is never sniffed', () => {
  // text/html is the one that matters: every page on every site would
  // otherwise be fetched a second time just to look at it.
  for (const type of ['text/html', 'video/mp4', 'image/png', 'application/x-mpegURL']) {
    assert.ok(!isAmbiguousContentType(type), `${type} must not be sniffed`);
  }
});

test('a playlist is recognised from its body alone', () => {
  assert.ok(isPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n'));
  assert.ok(isPlaylist('\n  #EXTM3U\n'));
  assert.ok(!isPlaylist('<!DOCTYPE html><html>'));
  assert.ok(!isPlaylist(''));
});
