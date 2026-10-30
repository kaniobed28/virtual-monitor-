// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, ConfigError } from '../src/config.js';

const GOOD_TOKEN = 'this-is-a-long-enough-token';

/** @returns {any} a deep-ish copy of a valid config */
function base() {
  return {
    port: 3000,
    mode: 'lan',
    token: GOOD_TOKEN,
    displays: [
      { id: 1, source: 'ddagrab', outputIdx: 1, fps: 30, quality: 5, maxWidth: 1920 },
      { id: 2, source: 'ddagrab', outputIdx: 2, fps: 30, quality: 5, maxWidth: 1920 },
    ],
  };
}

test('config: valid input normalizes with defaults', () => {
  const c = validateConfig(base());
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.ffmpegPath, 'ffmpeg');
  assert.equal(c.adbPath, 'adb');
  assert.equal(c.input.enabled, false);
  assert.equal(c.https.enabled, false);
  assert.equal(c.displays.length, 2);
});

test('config: missing token throws', () => {
  const cfg = base();
  delete cfg.token;
  assert.throws(() => validateConfig(cfg), ConfigError);
});

test('config: placeholder token throws', () => {
  const cfg = base();
  cfg.token = 'CHANGE-ME-long-random-string';
  assert.throws(() => validateConfig(cfg), /placeholder/);
});

test('config: token shorter than 16 chars throws', () => {
  const cfg = base();
  cfg.token = 'short';
  assert.throws(() => validateConfig(cfg), /16 characters/);
});

test('config: duplicate display id throws', () => {
  const cfg = base();
  cfg.displays[1].id = 1;
  assert.throws(() => validateConfig(cfg), /duplicates/);
});

test('config: out-of-range fps throws', () => {
  const cfg = base();
  cfg.displays[0].fps = 120;
  assert.throws(() => validateConfig(cfg), /fps/);
});

test('config: ddagrab missing outputIdx throws', () => {
  const cfg = base();
  delete cfg.displays[0].outputIdx;
  assert.throws(() => validateConfig(cfg), /outputIdx/);
});

test('config: gdigrab-region missing bounds throws', () => {
  const cfg = base();
  cfg.displays = [{ id: 1, source: 'gdigrab-region', fps: 30, quality: 5, maxWidth: 1920 }];
  assert.throws(() => validateConfig(cfg), /bounds/);
});

test('config: gdigrab-window missing windowTitle throws', () => {
  const cfg = base();
  cfg.displays = [{ id: 1, source: 'gdigrab-window', fps: 30, quality: 5, maxWidth: 1920 }];
  assert.throws(() => validateConfig(cfg), /windowTitle/);
});

test('config: invalid windowTitle (double quote) throws', () => {
  const cfg = base();
  cfg.displays = [
    { id: 1, source: 'gdigrab-window', windowTitle: 'bad"title', fps: 30, quality: 5, maxWidth: 1920 },
  ];
  assert.throws(() => validateConfig(cfg), /windowTitle/);
});

test('config: odd gdigrab-region bounds throw', () => {
  const cfg = base();
  cfg.displays = [
    { id: 1, source: 'gdigrab-region', bounds: { x: 0, y: 0, width: 641, height: 480 }, fps: 30, quality: 5, maxWidth: 1920 },
  ];
  assert.throws(() => validateConfig(cfg), /even/);
});

test('config: usb mode defaults host to 127.0.0.1', () => {
  const cfg = base();
  cfg.mode = 'usb';
  const c = validateConfig(cfg);
  assert.equal(c.host, '127.0.0.1');
});

test('config: usb mode keeps explicit host', () => {
  const cfg = base();
  cfg.mode = 'usb';
  cfg.host = '0.0.0.0';
  const c = validateConfig(cfg);
  assert.equal(c.host, '0.0.0.0');
});

test('config: duplicate ddagrab outputIdx throws', () => {
  const cfg = base();
  cfg.displays[1].outputIdx = 1;
  assert.throws(() => validateConfig(cfg), /outputIdx/);
});
