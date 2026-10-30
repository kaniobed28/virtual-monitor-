// @ts-check
process.env.LOG_LEVEL = 'error'; // quieten capture's info/warn logs during tests

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CaptureManager, buildFfmpegArgs } from '../src/capture.js';

/** A fake ChildProcess with stdout/stderr streams and a kill() spy. */
function makeFakeProc() {
  const proc = /** @type {any} */ (new EventEmitter());
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    // Emulate the OS reaping the process after a kill.
    proc.emit('exit', null, 'SIGTERM');
    return true;
  };
  return proc;
}

/** Build a fake spawn that records calls and hands back queued fake procs. */
function makeFakeSpawn() {
  const calls = [];
  const procs = [];
  const spawn = (cmd, args, opts) => {
    const proc = makeFakeProc();
    calls.push({ cmd, args, opts });
    procs.push(proc);
    return proc;
  };
  return { spawn, calls, procs };
}

const JPEG = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

/** @returns {any} */
function config(displays) {
  return { ffmpegPath: 'ffmpeg', displays };
}

const DDAGRAB = { id: 1, source: 'ddagrab', outputIdx: 1, fps: 30, quality: 5, maxWidth: 1920 };

test('capture: start spawns ffmpeg with the exact args and no shell', () => {
  const fake = makeFakeSpawn();
  const cm = new CaptureManager(config([DDAGRAB]), { spawn: fake.spawn });
  cm.start(1);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].cmd, 'ffmpeg');
  assert.deepEqual(fake.calls[0].args, buildFfmpegArgs(DDAGRAB));
  assert.equal(fake.calls[0].opts.shell, false);
  assert.equal(fake.calls[0].opts.windowsHide, true);
  assert.equal(cm.isRunning(1), true);
  cm.stopAll();
});

test('capture: stdout bytes are parsed into frame events', () => {
  const fake = makeFakeSpawn();
  const cm = new CaptureManager(config([DDAGRAB]), { spawn: fake.spawn });
  /** @type {Array<[number, Buffer]>} */
  const frames = [];
  cm.on('frame', (id, buf) => frames.push([id, buf]));
  cm.start(1);
  fake.procs[0].stdout.emit('data', JPEG);
  assert.equal(frames.length, 1);
  assert.equal(frames[0][0], 1);
  assert.deepEqual([...frames[0][1]], [...JPEG]);
  cm.stopAll();
});

test('capture: start is idempotent while running', () => {
  const fake = makeFakeSpawn();
  const cm = new CaptureManager(config([DDAGRAB]), { spawn: fake.spawn });
  cm.start(1);
  cm.start(1);
  assert.equal(fake.calls.length, 1);
  cm.stopAll();
});

test('capture: stop kills the process and prevents restart', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const fake = makeFakeSpawn();
    const cm = new CaptureManager(config([DDAGRAB]), { spawn: fake.spawn });
    cm.start(1);
    const proc = fake.procs[0];
    cm.stop(1);
    assert.equal(proc.killed, true);
    assert.equal(cm.isRunning(1), false);
    // The kill() emitted 'exit', but because we stopped, no restart is scheduled.
    mock.timers.tick(60000);
    assert.equal(fake.calls.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('capture: unexpected exit restarts with backoff and emits capture-error', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const fake = makeFakeSpawn();
    const cm = new CaptureManager(config([DDAGRAB]), { spawn: fake.spawn });
    const errors = [];
    cm.on('capture-error', (id, msg) => errors.push([id, msg]));
    cm.start(1);

    // Simulate ffmpeg dying unexpectedly.
    fake.procs[0].emit('exit', 1, null);
    assert.deepEqual(errors[0], [1, 'capture failed, retrying']);
    assert.equal(fake.calls.length, 1); // not yet restarted

    mock.timers.tick(1000); // first backoff step
    assert.equal(fake.calls.length, 2);

    // Second failure → next backoff step (2000 ms).
    fake.procs[1].emit('exit', 1, null);
    mock.timers.tick(1999);
    assert.equal(fake.calls.length, 2);
    mock.timers.tick(1);
    assert.equal(fake.calls.length, 3);
    cm.stopAll();
  } finally {
    mock.timers.reset();
  }
});

test('capture: a healthy frame resets the backoff', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const fake = makeFakeSpawn();
    const cm = new CaptureManager(config([DDAGRAB]), { spawn: fake.spawn });
    cm.start(1);
    fake.procs[0].emit('exit', 1, null);
    mock.timers.tick(1000); // restart #2 (attempt was 1 → delay 1000)
    // Now a frame arrives on the new process: attempt resets to 0.
    fake.procs[1].stdout.emit('data', JPEG);
    fake.procs[1].emit('exit', 1, null);
    mock.timers.tick(1000); // back to the first (1000 ms) step, not 2000
    assert.equal(fake.calls.length, 3);
    cm.stopAll();
  } finally {
    mock.timers.reset();
  }
});

test('capture: gdigrab-window reports "window not found" from stderr', () => {
  const fake = makeFakeSpawn();
  const win = { id: 2, source: 'gdigrab-window', windowTitle: 'Nope', fps: 15, quality: 6, maxWidth: 1280 };
  const cm = new CaptureManager(config([win]), { spawn: fake.spawn });
  const errors = [];
  cm.on('capture-error', (id, msg) => errors.push([id, msg]));
  cm.start(2);
  fake.procs[0].stderr.emit('data', Buffer.from('[gdigrab @ ...] Could not find window with title Nope\n'));
  assert.ok(errors.some((e) => e[0] === 2 && e[1] === 'window not found'));
  cm.stopAll();
});

test('capture: unknown display id throws', () => {
  const cm = new CaptureManager(config([DDAGRAB]), { spawn: makeFakeSpawn().spawn });
  assert.throws(() => cm.start(99), /unknown display/);
});
