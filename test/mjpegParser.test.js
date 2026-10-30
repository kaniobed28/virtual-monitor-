// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MjpegParser } from '../src/mjpegParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

/** @param {number[]} body */
function frame(body) {
  return Buffer.from([...SOI, ...body, ...EOI]);
}

/** @param {MjpegParser} p */
function collect(p) {
  /** @type {Buffer[]} */
  const frames = [];
  p.on('frame', (f) => frames.push(f));
  return frames;
}

test('mjpeg: single complete frame', () => {
  const p = new MjpegParser();
  const frames = collect(p);
  p.push(frame([1, 2, 3]));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
});

test('mjpeg: several frames in one chunk', () => {
  const p = new MjpegParser();
  const frames = collect(p);
  p.push(Buffer.concat([frame([1]), frame([2]), frame([3])]));
  assert.equal(frames.length, 3);
  assert.deepEqual([...frames[1]], [0xff, 0xd8, 2, 0xff, 0xd9]);
});

test('mjpeg: frame split across 3 chunks (incl. split markers)', () => {
  const p = new MjpegParser();
  const frames = collect(p);
  const full = frame([10, 20, 30]); // FF D8 0A 14 1E FF D9
  // Split so the SOI and EOI markers straddle chunk boundaries.
  p.push(full.subarray(0, 1)); // FF
  p.push(full.subarray(1, 6)); // D8 0A 14 1E FF
  p.push(full.subarray(6)); // D9
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [...full]);
});

test('mjpeg: garbage before SOI is discarded', () => {
  const p = new MjpegParser();
  const frames = collect(p);
  p.push(Buffer.concat([Buffer.from([0x00, 0x99, 0xab]), frame([7])]));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [0xff, 0xd8, 7, 0xff, 0xd9]);
});

test('mjpeg: overflow with no EOI resets buffer', () => {
  const p = new MjpegParser();
  const frames = collect(p);
  // Start a frame but never terminate it; push > 20 MB.
  p.push(Buffer.from(SOI));
  p.push(Buffer.alloc(21 * 1024 * 1024, 0x55));
  assert.equal(frames.length, 0);
  assert.equal(p.buf.length, 0);
  // Parser recovers for subsequent valid frames.
  p.push(frame([1]));
  assert.equal(frames.length, 1);
});

test('mjpeg: parses the sample fixture into 2 frames', () => {
  const p = new MjpegParser();
  const frames = collect(p);
  const data = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.mjpeg'));
  p.push(data);
  assert.equal(frames.length, 2);
});
