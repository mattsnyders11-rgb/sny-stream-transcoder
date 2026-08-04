import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFfmpegArgs } from '../server/job-manager.js';
import { hlsContentType, isAllowedHlsFilename, rewritePlaylist } from '../server/hls.js';

function optionValue(args, option) {
  const index = args.indexOf(option);
  assert.notEqual(index, -1, `${option} must be present`);
  return args[index + 1];
}

test('FFmpeg emits the locked universal HLS profile', () => {
  const args = buildFfmpegArgs('https://media.example/source.mkv', '/tmp/job', 0);

  assert.equal(optionValue(args, '-c:v'), 'libx264');
  assert.equal(optionValue(args, '-profile:v'), 'high');
  assert.equal(optionValue(args, '-level:v'), '4.1');
  assert.equal(optionValue(args, '-pix_fmt'), 'yuv420p');
  assert.match(optionValue(args, '-vf'), /fps=30/);
  assert.match(optionValue(args, '-vf'), /format=yuv420p/);
  assert.equal(optionValue(args, '-c:a'), 'aac');
  assert.equal(optionValue(args, '-profile:a'), 'aac_low');
  assert.equal(optionValue(args, '-ac'), '2');
  assert.equal(optionValue(args, '-ar'), '48000');
  assert.equal(optionValue(args, '-hls_time'), '2');
  assert.equal(optionValue(args, '-hls_segment_type'), 'fmp4');
  assert.equal(optionValue(args, '-hls_fmp4_init_filename'), 'init.mp4');
  assert.match(optionValue(args, '-hls_segment_filename'), /segment_%06d\.m4s$/);
});

test('fMP4 playlist signs both initialization and media URIs', () => {
  const source = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:2.000000,',
    'segment_000000.m4s',
    ''
  ].join('\n');
  const rewritten = rewritePlaylist(source, 'signed token');

  assert.match(rewritten, /URI="init\.mp4\?token=signed%20token"/);
  assert.match(rewritten, /segment_000000\.m4s\?token=signed%20token/);
});

test('worker serves only known HLS artifacts with correct media types', () => {
  assert.equal(isAllowedHlsFilename('index.m3u8'), true);
  assert.equal(isAllowedHlsFilename('init.mp4'), true);
  assert.equal(isAllowedHlsFilename('segment_000001.m4s'), true);
  assert.equal(isAllowedHlsFilename('../secret'), false);
  assert.equal(hlsContentType('index.m3u8'), 'application/vnd.apple.mpegurl');
  assert.equal(hlsContentType('init.mp4'), 'video/mp4');
  assert.equal(hlsContentType('segment_000001.m4s'), 'video/iso.segment');
});
