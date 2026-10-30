// @ts-check
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StreamHub } from '../src/streamHub.js';

/** Fake CaptureManager that records start/stop and tracks running state. */
class FakeCapture extends EventEmitter {
  constructor() {
    super();
    this.started = [];
    this.stopped = [];
    this.running = new Set();
  }
  start(id) {
    this.started.push(id);
    this.running.add(id);
  }
  stop(id) {
    this.stopped.push(id);
    this.running.delete(id);
  }
  isRunning(id) {
    return this.running.has(id);
  }
}

/** @param {number} [buffered] */
function fakeWs(buffered = 0) {
  return { readyState: 1, bufferedAmount: buffered, sent: [], send(d) { this.sent.push(d); } };
}

test('hub: starts capture on first client, not again on second', () => {
  const cap = new FakeCapture();
  const hub = new StreamHub(cap);
  hub.addClient(1, fakeWs());
  hub.addClient(1, fakeWs());
  assert.deepEqual(cap.started, [1]);
  assert.equal(hub.count(1), 2);
});

test('hub: stops capture only after grace period when last client leaves', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const cap = new FakeCapture();
    const hub = new StreamHub(cap);
    const a = fakeWs();
    const b = fakeWs();
    hub.addClient(1, a);
    hub.addClient(1, b);

    hub.removeClient(1, a);
    assert.deepEqual(cap.stopped, []); // still one client

    hub.removeClient(1, b);
    assert.deepEqual(cap.stopped, []); // grace not elapsed
    mock.timers.tick(4999);
    assert.deepEqual(cap.stopped, []);
    mock.timers.tick(1);
    assert.deepEqual(cap.stopped, [1]);
  } finally {
    mock.timers.reset();
  }
});

test('hub: reconnect within grace cancels the stop', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const cap = new FakeCapture();
    const hub = new StreamHub(cap);
    const a = fakeWs();
    hub.addClient(1, a);
    hub.removeClient(1, a);
    mock.timers.tick(3000);
    hub.addClient(1, fakeWs()); // reconnect before grace elapses
    mock.timers.tick(5000);
    assert.deepEqual(cap.stopped, []); // stop was cancelled
    assert.deepEqual(cap.started, [1]); // not restarted (was still running)
  } finally {
    mock.timers.reset();
  }
});

test('hub: broadcasts frames, dropping clients over the backpressure limit', () => {
  const cap = new FakeCapture();
  const hub = new StreamHub(cap);
  const low = fakeWs(0);
  const high = fakeWs(3 * 1024 * 1024); // > 2 MB
  hub.addClient(1, low);
  hub.addClient(1, high);

  const frame = Buffer.from([1, 2, 3]);
  cap.emit('frame', 1, frame);

  assert.equal(low.sent.length, 1);
  assert.equal(high.sent.length, 0);
});

test('hub: frames for one display are not sent to another display clients', () => {
  const cap = new FakeCapture();
  const hub = new StreamHub(cap);
  const d1 = fakeWs();
  const d2 = fakeWs();
  hub.addClient(1, d1);
  hub.addClient(2, d2);
  cap.emit('frame', 1, Buffer.from([9]));
  assert.equal(d1.sent.length, 1);
  assert.equal(d2.sent.length, 0);
});

test('hub: capture-error is forwarded as a JSON error to that display', () => {
  const cap = new FakeCapture();
  const hub = new StreamHub(cap);
  const ws = fakeWs();
  hub.addClient(1, ws);
  cap.emit('capture-error', 1, 'window not found');
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: 'error', message: 'window not found' });
});
