// @ts-check
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import { MjpegParser } from './mjpegParser.js';
import logger from './logger.js';

/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./config.js').DisplayConfig} DisplayConfig */

const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];
const STDERR_RING = 20;
const STDERR_LOG_INTERVAL_MS = 2000;
const WINDOW_NOT_FOUND_RE = /could not find|can'?t find window|window not found|no such window/i;

/**
 * Build the exact FFmpeg argument array for a display, branching on `source`.
 * Pure function (no spawning), so it is unit-tested against §4.2.
 *
 * @param {DisplayConfig} display
 * @returns {string[]}
 */
export function buildFfmpegArgs(display) {
  const base = ['-hide_banner', '-loglevel', 'error'];
  const scale = `scale='min(${display.maxWidth},iw)':-2`;
  const tail = ['-c:v', 'mjpeg', '-q:v', String(display.quality), '-f', 'mjpeg', 'pipe:1'];

  switch (display.source) {
    case 'ddagrab':
      return [
        ...base,
        '-f', 'lavfi',
        '-i', `ddagrab=output_idx=${display.outputIdx}:framerate=${display.fps}:draw_mouse=1`,
        '-vf', `hwdownload,format=bgra,${scale}`,
        ...tail,
      ];

    case 'gdigrab-region': {
      const b = /** @type {NonNullable<DisplayConfig['bounds']>} */ (display.bounds);
      return [
        ...base,
        '-f', 'gdigrab', '-framerate', String(display.fps), '-draw_mouse', '1',
        '-offset_x', String(b.x), '-offset_y', String(b.y),
        '-video_size', `${b.width}x${b.height}`,
        '-i', 'desktop',
        '-vf', scale,
        ...tail,
      ];
    }

    case 'gdigrab-window':
      return [
        ...base,
        '-f', 'gdigrab', '-framerate', String(display.fps), '-draw_mouse', '1',
        '-i', `title=${display.windowTitle}`,
        '-vf', `${scale},pad=ceil(iw/2)*2:ceil(ih/2)*2`,
        ...tail,
      ];

    default:
      throw new Error(`buildFfmpegArgs: unknown source ${JSON.stringify(display.source)}`);
  }
}

/**
 * @typedef {Object} CaptureState
 * @property {import('node:child_process').ChildProcess | null} proc
 * @property {MjpegParser} parser
 * @property {NodeJS.Timeout | null} restartTimer
 * @property {number} attempt
 * @property {boolean} stopped
 * @property {string[]} stderrRing
 * @property {number} lastStderrLog
 */

/** Managers that have ever spawned a process, for global cleanup on exit. */
/** @type {Set<CaptureManager>} */
const liveManagers = new Set();
let exitHandlersRegistered = false;

function registerExitHandlers() {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;
  // Synchronous safety net: kill any surviving FFmpeg children when the Node
  // process exits normally or via process.exit(). Signal-driven graceful
  // shutdown (SIGINT/SIGTERM) is owned by server.js, which calls stopAll()
  // before exiting; we deliberately do not register signal handlers here so we
  // don't pre-empt that graceful path.
  process.on('exit', () => {
    for (const m of liveManagers) m.stopAll();
  });
}

/**
 * Spawns and supervises one FFmpeg process per display, parses its MJPEG
 * output into frames, and restarts with exponential backoff on failure.
 *
 * @fires CaptureManager#frame  (displayId:number, frame:Buffer)
 * @fires CaptureManager#capture-error (displayId:number, message:string)
 */
export class CaptureManager extends EventEmitter {
  /**
   * @param {Config} config
   * @param {{ spawn?: typeof nodeSpawn }} [deps] injectable for tests
   */
  constructor(config, deps = {}) {
    super();
    this.config = config;
    this.spawn = deps.spawn || nodeSpawn;
    /** @type {Map<number, DisplayConfig>} */
    this.byId = new Map(config.displays.map((d) => [d.id, d]));
    /** @type {Map<number, CaptureState>} */
    this.states = new Map();
    registerExitHandlers();
    liveManagers.add(this);
  }

  /**
   * @param {number} displayId
   * @returns {boolean}
   */
  isRunning(displayId) {
    const s = this.states.get(displayId);
    return Boolean(s && s.proc && !s.stopped);
  }

  /**
   * Start capture for a display. Idempotent: a second call while running is a
   * no-op.
   * @param {number} displayId
   */
  start(displayId) {
    const display = this.byId.get(displayId);
    if (!display) throw new Error(`capture: unknown display ${displayId}`);

    let state = this.states.get(displayId);
    if (state && state.proc) {
      state.stopped = false;
      return; // already running
    }
    if (!state) {
      state = {
        proc: null,
        parser: new MjpegParser(),
        restartTimer: null,
        attempt: 0,
        stopped: false,
        stderrRing: [],
        lastStderrLog: 0,
      };
      state.parser.on('frame', (frame) => {
        state.attempt = 0; // healthy stream: reset backoff
        /** @event CaptureManager#frame */
        this.emit('frame', displayId, frame);
      });
      this.states.set(displayId, state);
    }
    state.stopped = false;
    this._spawn(display, state);
  }

  /**
   * @param {DisplayConfig} display
   * @param {CaptureState} state
   */
  _spawn(display, state) {
    const args = buildFfmpegArgs(display);
    logger.info(`capture: display ${display.id} starting ffmpeg (${display.source})`);
    logger.debug('capture: ffmpeg', this.config.ffmpegPath, args.join(' '));

    const proc = this.spawn(this.config.ffmpegPath, args, { shell: false, windowsHide: true });
    state.proc = proc;
    state.parser.reset();

    proc.stdout?.on('data', (chunk) => state.parser.push(chunk));

    proc.stderr?.on('data', (chunk) => this._onStderr(display, state, chunk));

    proc.on('error', (err) => {
      // e.g. ffmpeg binary not found
      logger.error(`capture: display ${display.id} spawn error: ${err.message}`);
      this.emit('capture-error', display.id, 'capture failed, retrying');
      this._scheduleRestart(display, state);
    });

    proc.on('exit', (code, signal) => {
      if (state.proc === proc) state.proc = null;
      if (state.stopped) return;
      logger.warn(`capture: display ${display.id} ffmpeg exited (code=${code}, signal=${signal})`);
      this.emit('capture-error', display.id, 'capture failed, retrying');
      this._scheduleRestart(display, state);
    });
  }

  /**
   * @param {DisplayConfig} display
   * @param {CaptureState} state
   * @param {Buffer} chunk
   */
  _onStderr(display, state, chunk) {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      state.stderrRing.push(line);
      if (state.stderrRing.length > STDERR_RING) state.stderrRing.shift();
    }
    const now = Date.now();
    if (now - state.lastStderrLog >= STDERR_LOG_INTERVAL_MS) {
      state.lastStderrLog = now;
      logger.warn(`capture: display ${display.id} ffmpeg: ${state.stderrRing[state.stderrRing.length - 1]}`);
    }
    if (display.source === 'gdigrab-window' && WINDOW_NOT_FOUND_RE.test(text)) {
      this.emit('capture-error', display.id, 'window not found');
    }
  }

  /**
   * @param {DisplayConfig} display
   * @param {CaptureState} state
   */
  _scheduleRestart(display, state) {
    if (state.stopped) return;
    if (state.restartTimer) return; // already scheduled
    const delay = BACKOFF_STEPS[Math.min(state.attempt, BACKOFF_STEPS.length - 1)];
    state.attempt += 1;
    logger.info(`capture: display ${display.id} restarting in ${delay} ms (attempt ${state.attempt})`);
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      if (state.stopped) return;
      this._spawn(display, state);
    }, delay);
    // Don't keep the event loop alive solely for a restart.
    if (typeof state.restartTimer.unref === 'function') state.restartTimer.unref();
  }

  /**
   * @param {number} displayId
   */
  stop(displayId) {
    const state = this.states.get(displayId);
    if (!state) return;
    state.stopped = true;
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    if (state.proc) {
      const proc = state.proc;
      state.proc = null;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
    state.parser.reset();
    logger.info(`capture: display ${displayId} stopped`);
  }

  stopAll() {
    for (const id of this.states.keys()) this.stop(id);
  }
}

export default CaptureManager;
