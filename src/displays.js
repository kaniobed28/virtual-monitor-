// @ts-check
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from './logger.js';

/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./config.js').Bounds} Bounds */
/** @typedef {{ index:number, name:string, x:number, y:number, width:number, height:number, primary:boolean }} DetectedDisplay */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'list-displays.ps1');

/** @type {Config | null} */
let activeConfig = null;
/** @type {DetectedDisplay[]} */
let detected = [];

/**
 * Enumerate physical monitors via list-displays.ps1 (Windows only).
 * @returns {Promise<DetectedDisplay[]>}
 */
export async function listDisplays() {
  if (process.platform !== 'win32') {
    logger.warn('displays: listDisplays is Windows-only; returning []');
    return [];
  }
  const json = await runPowerShell(SCRIPT, ['-Json']);
  try {
    const parsed = JSON.parse(json);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    detected = arr.map((d) => ({
      index: Number(d.index),
      name: String(d.name),
      x: Number(d.x),
      y: Number(d.y),
      width: Number(d.width),
      height: Number(d.height),
      primary: Boolean(d.primary),
    }));
    return detected;
  } catch (err) {
    logger.error(`displays: could not parse list-displays.ps1 output: ${/** @type {Error} */ (err).message}`);
    return [];
  }
}

/**
 * Cache the config and (best-effort) detected monitors so getBounds() can map
 * a display id to a rectangle.
 * @param {Config} config
 */
export async function initDisplays(config) {
  activeConfig = config;
  try {
    await listDisplays();
  } catch (err) {
    logger.warn(`displays: enumeration failed: ${/** @type {Error} */ (err).message}`);
  }
}

/**
 * Resolve a display id to a virtual-desktop rectangle.
 * - explicit config `bounds` always win
 * - gdigrab-region: config bounds (required)
 * - gdigrab-window: returns null (resolved at input time from the window rect)
 * - ddagrab: best-effort auto-detection (see note in §4.3)
 *
 * @param {number} displayId
 * @returns {Bounds | null}
 */
export function getBounds(displayId) {
  if (!activeConfig) throw new Error('displays: initDisplays() must run before getBounds()');
  const d = activeConfig.displays.find((x) => x.id === displayId);
  if (!d) throw new Error(`displays: unknown display ${displayId}`);

  if (d.bounds) return { ...d.bounds };
  if (d.source === 'gdigrab-window') return null; // input.js resolves via GetWindowRect

  // ddagrab auto-detect: no reliable outputIdx↔screen mapping, so best-effort.
  if (d.source === 'ddagrab') {
    const byIndex = detected.find((m) => m.index === d.outputIdx);
    const pick = byIndex || detected.find((m) => !m.primary) || detected[0];
    if (pick) {
      logger.warn(
        `displays: ddagrab display ${displayId} bounds auto-detected (${pick.name}); ` +
          'set "bounds" explicitly if touch input lands in the wrong place',
      );
      return { x: pick.x, y: pick.y, width: pick.width, height: pick.height };
    }
  }
  return null;
}

/**
 * @param {string} script
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function runPowerShell(script, args) {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { shell: false, windowsHide: true },
    );
    let out = '';
    let err = '';
    ps.stdout.on('data', (c) => (out += c));
    ps.stderr.on('data', (c) => (err += c));
    ps.on('error', reject);
    ps.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`powershell exited ${code}: ${err.trim()}`));
    });
  });
}

export default { listDisplays, initDisplays, getBounds };
