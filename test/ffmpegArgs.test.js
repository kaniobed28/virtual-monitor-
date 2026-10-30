// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFfmpegArgs } from '../src/capture.js';

test('ffmpegArgs: ddagrab exact args', () => {
  const args = buildFfmpegArgs({
    id: 1,
    source: 'ddagrab',
    outputIdx: 2,
    fps: 30,
    quality: 5,
    maxWidth: 1920,
  });
  assert.deepEqual(args, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'ddagrab=output_idx=2:framerate=30:draw_mouse=1',
    '-vf', "hwdownload,format=bgra,scale='min(1920,iw)':-2",
    '-c:v', 'mjpeg',
    '-q:v', '5',
    '-f', 'mjpeg', 'pipe:1',
  ]);
});

test('ffmpegArgs: gdigrab-region exact args', () => {
  const args = buildFfmpegArgs({
    id: 1,
    source: 'gdigrab-region',
    bounds: { x: 1280, y: 0, width: 640, height: 1080 },
    fps: 30,
    quality: 5,
    maxWidth: 1920,
  });
  assert.deepEqual(args, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '1',
    '-offset_x', '1280', '-offset_y', '0',
    '-video_size', '640x1080',
    '-i', 'desktop',
    '-vf', "scale='min(1920,iw)':-2",
    '-c:v', 'mjpeg',
    '-q:v', '5',
    '-f', 'mjpeg', 'pipe:1',
  ]);
});

test('ffmpegArgs: gdigrab-window exact args', () => {
  const args = buildFfmpegArgs({
    id: 2,
    source: 'gdigrab-window',
    windowTitle: 'Microsoft Teams',
    fps: 15,
    quality: 6,
    maxWidth: 1280,
  });
  assert.deepEqual(args, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'gdigrab', '-framerate', '15', '-draw_mouse', '1',
    '-i', 'title=Microsoft Teams',
    '-vf', "scale='min(1280,iw)':-2,pad=ceil(iw/2)*2:ceil(ih/2)*2",
    '-c:v', 'mjpeg',
    '-q:v', '6',
    '-f', 'mjpeg', 'pipe:1',
  ]);
});
