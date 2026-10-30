// @ts-check
import logger from './logger.js';

/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./config.js').Bounds} Bounds */

// Win32 constants
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const INPUT_MOUSE = 0;
// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == (HANDLE)-4
const DPI_PER_MONITOR_V2 = -4;

/**
 * Maps normalized phone taps to Win32 mouse actions on the matching monitor.
 * All native (koffi/user32) access is loaded lazily in init() so that importing
 * this module is safe on any OS (tests never call init()).
 */
export class InputController {
  /**
   * @param {Config} config
   * @param {{ getBounds: (id:number) => Bounds | null }} displays
   */
  constructor(config, displays) {
    this.config = config;
    this.displays = displays;
    this.ready = false;
    /** @type {any} */
    this.koffi = null;
    /** @type {Map<number, Bounds>} cached window rects for gdigrab-window */
    this.windowRectCache = new Map();
  }

  async init() {
    if (process.platform !== 'win32') {
      logger.warn('input: non-Windows platform; touch input disabled');
      return;
    }
    try {
      const mod = await import('koffi');
      const koffi = mod.default || mod;
      this.koffi = koffi;

      const user32 = koffi.load('user32.dll');

      const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
        dx: 'long',
        dy: 'long',
        mouseData: 'uint32',
        dwFlags: 'uint32',
        time: 'uint32',
        dwExtraInfo: 'uintptr',
      });
      // koffi aligns `mi` to 8 bytes, inserting 4 bytes of padding after `type`,
      // matching the Win32 INPUT layout on x64 (sizeof == 40).
      const INPUT = koffi.struct('INPUT', { type: 'uint32', mi: MOUSEINPUT });
      this.INPUT = INPUT;
      this.inputSize = koffi.sizeof(INPUT);

      const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
      this.RECT = RECT;

      this._setCursorPos = user32.func('bool __stdcall SetCursorPos(int X, int Y)');
      this._sendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
      this._findWindow = user32.func('void* __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)');
      this._getWindowRect = user32.func('bool __stdcall GetWindowRect(void* hWnd, _Out_ RECT *lpRect)');

      try {
        const setDpi = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr value)');
        setDpi(DPI_PER_MONITOR_V2);
      } catch (err) {
        logger.warn(`input: could not set DPI awareness: ${/** @type {Error} */ (err).message}`);
      }

      this.ready = true;
      logger.info('input: user32 bound; touch input enabled');
    } catch (err) {
      logger.error(`input: failed to initialize koffi/user32: ${/** @type {Error} */ (err).message}`);
    }
  }

  /**
   * @param {number} displayId
   * @param {'down'|'move'|'up'} action
   * @param {number} nx normalized [0,1]
   * @param {number} ny normalized [0,1]
   */
  pointer(displayId, action, nx, ny) {
    if (!this.ready) return;
    const bounds = this._resolveBounds(displayId, action);
    if (!bounds) return;

    const cx = clamp01(nx);
    const cy = clamp01(ny);
    const px = Math.round(bounds.x + cx * (bounds.width - 1));
    const py = Math.round(bounds.y + cy * (bounds.height - 1));

    this._setCursorPos(px, py);

    if (action === 'down') this._mouseButton(MOUSEEVENTF_LEFTDOWN);
    else if (action === 'up') this._mouseButton(MOUSEEVENTF_LEFTUP);
  }

  /**
   * @param {number} dwFlags
   */
  _mouseButton(dwFlags) {
    const input = {
      type: INPUT_MOUSE,
      mi: { dx: 0, dy: 0, mouseData: 0, dwFlags, time: 0, dwExtraInfo: 0 },
    };
    this._sendInput(1, [input], this.inputSize);
  }

  /**
   * @param {number} displayId
   * @param {'down'|'move'|'up'} action
   * @returns {Bounds | null}
   */
  _resolveBounds(displayId, action) {
    const d = this.config.displays.find((x) => x.id === displayId);
    if (!d) return null;

    if (d.source === 'gdigrab-window') {
      // Resolve the window rect on 'down' (and cache for the ensuing move/up).
      if (action === 'down' || !this.windowRectCache.has(displayId)) {
        const rect = this._windowRect(/** @type {string} */ (d.windowTitle));
        if (rect) this.windowRectCache.set(displayId, rect);
        else this.windowRectCache.delete(displayId);
      }
      return this.windowRectCache.get(displayId) || null;
    }

    return this.displays.getBounds(displayId);
  }

  /**
   * @param {string} title
   * @returns {Bounds | null}
   */
  _windowRect(title) {
    const hwnd = this._findWindow(null, title);
    if (!hwnd) return null;
    const rect = {};
    const ok = this._getWindowRect(hwnd, rect);
    if (!ok) return null;
    const r = /** @type {{left:number,top:number,right:number,bottom:number}} */ (rect);
    return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
  }
}

/** @param {number} v */
function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export default InputController;
