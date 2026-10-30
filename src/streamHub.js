// @ts-check
import logger from './logger.js';

/** @typedef {import('./capture.js').CaptureManager} CaptureManager */

const BACKPRESSURE_LIMIT = 2 * 1024 * 1024; // 2 MB (§4.5)
const GRACE_MS = 5000; // keep capturing 5 s after the last client leaves
const WS_OPEN = 1;

/**
 * Fans out captured frames to the WebSocket clients watching each display, and
 * owns the capture lifecycle: capture starts when a display gets its first
 * client and stops GRACE_MS after its last client disconnects.
 */
export class StreamHub {
  /**
   * @param {CaptureManager} captureManager
   */
  constructor(captureManager) {
    this.capture = captureManager;
    /** @type {Map<number, Set<any>>} */
    this.clients = new Map();
    /** @type {Map<number, NodeJS.Timeout>} */
    this.graceTimers = new Map();

    this.capture.on('frame', (displayId, frame) => this._broadcastFrame(displayId, frame));
    this.capture.on('capture-error', (displayId, message) => this._broadcastError(displayId, message));
  }

  /**
   * @param {number} displayId
   * @returns {number}
   */
  count(displayId) {
    const set = this.clients.get(displayId);
    return set ? set.size : 0;
  }

  /**
   * @param {number} displayId
   * @param {any} ws
   */
  addClient(displayId, ws) {
    let set = this.clients.get(displayId);
    if (!set) {
      set = new Set();
      this.clients.set(displayId, set);
    }
    const wasEmpty = set.size === 0;
    set.add(ws);

    // A new client cancels any pending stop.
    const timer = this.graceTimers.get(displayId);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(displayId);
    }

    if (wasEmpty && !this.capture.isRunning(displayId)) {
      logger.info(`hub: first client on display ${displayId}; starting capture`);
      this.capture.start(displayId);
    }
  }

  /**
   * @param {number} displayId
   * @param {any} ws
   */
  removeClient(displayId, ws) {
    const set = this.clients.get(displayId);
    if (!set) return;
    set.delete(ws);
    if (set.size > 0) return;

    // Last client left: stop after a grace period so quick reconnects don't
    // thrash FFmpeg.
    if (this.graceTimers.has(displayId)) return;
    const timer = setTimeout(() => {
      this.graceTimers.delete(displayId);
      if (this.count(displayId) === 0) {
        logger.info(`hub: last client left display ${displayId}; stopping capture`);
        this.capture.stop(displayId);
      }
    }, GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.graceTimers.set(displayId, timer);
  }

  /**
   * @param {number} displayId
   * @param {Buffer} frame
   */
  _broadcastFrame(displayId, frame) {
    const set = this.clients.get(displayId);
    if (!set || set.size === 0) return;
    for (const ws of set) {
      if (ws.readyState !== WS_OPEN) continue;
      // Backpressure: only the newest frame matters; drop rather than queue.
      if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > BACKPRESSURE_LIMIT) continue;
      try {
        ws.send(frame);
      } catch (err) {
        logger.debug(`hub: send failed on display ${displayId}: ${/** @type {Error} */ (err).message}`);
      }
    }
  }

  /**
   * @param {number} displayId
   * @param {string} message
   */
  _broadcastError(displayId, message) {
    const set = this.clients.get(displayId);
    if (!set || set.size === 0) return;
    const payload = JSON.stringify({ type: 'error', message });
    for (const ws of set) {
      if (ws.readyState !== WS_OPEN) continue;
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
}

export default StreamHub;
