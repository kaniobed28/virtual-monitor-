// @ts-check
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} Bounds
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} DisplayConfig
 * @property {number} id
 * @property {'ddagrab'|'gdigrab-region'|'gdigrab-window'} source
 * @property {number} [outputIdx]
 * @property {Bounds} [bounds]
 * @property {string} [windowTitle]
 * @property {number} fps
 * @property {number} quality
 * @property {number} maxWidth
 */

/**
 * @typedef {Object} Config
 * @property {string} host
 * @property {number} port
 * @property {'lan'|'usb'|'hotspot'} mode
 * @property {string} token
 * @property {string} ffmpegPath
 * @property {string} adbPath
 * @property {DisplayConfig[]} displays
 * @property {{ enabled: boolean }} input
 * @property {{ enabled: boolean, keyPath: string, certPath: string }} https
 */

const VALID_MODES = ['lan', 'usb', 'hotspot'];
const VALID_SOURCES = ['ddagrab', 'gdigrab-region', 'gdigrab-window'];

class ConfigError extends Error {}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * @param {string} msg
 * @returns {never}
 */
function fail(msg) {
  throw new ConfigError(`config: ${msg}`);
}

/**
 * @param {unknown} n
 * @param {string} name
 * @param {number} min
 * @param {number} max
 */
function requireIntInRange(n, name, min, max) {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    fail(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(n)}`);
  }
}

/**
 * @param {Bounds} b
 * @param {string} where
 */
function validateBounds(b, where) {
  if (!isObject(b)) fail(`${where}: bounds must be an object`);
  for (const k of ['x', 'y', 'width', 'height']) {
    if (typeof b[k] !== 'number' || !Number.isInteger(b[k])) {
      fail(`${where}: bounds.${k} must be an integer`);
    }
  }
  if (b.width <= 0 || b.height <= 0) fail(`${where}: bounds width/height must be positive`);
  if (b.width % 2 !== 0 || b.height % 2 !== 0) {
    fail(`${where}: bounds width and height must be even numbers`);
  }
}

/**
 * Validate and normalize a raw config object. Pure (no filesystem access) so it
 * can be unit-tested directly.
 *
 * @param {unknown} raw
 * @returns {Config}
 */
export function validateConfig(raw) {
  if (!isObject(raw)) fail('must be a JSON object');

  const mode = raw.mode === undefined ? 'lan' : raw.mode;
  if (!VALID_MODES.includes(/** @type {string} */ (mode))) {
    fail(`mode must be one of ${VALID_MODES.join(', ')}`);
  }

  // host: explicit value wins; otherwise default depends on mode.
  const hostExplicit = Object.prototype.hasOwnProperty.call(raw, 'host') && raw.host !== undefined;
  let host;
  if (hostExplicit) {
    if (typeof raw.host !== 'string' || raw.host.length === 0) fail('host must be a non-empty string');
    host = raw.host;
  } else {
    host = mode === 'usb' ? '127.0.0.1' : '0.0.0.0';
  }

  const port = raw.port === undefined ? 3000 : raw.port;
  requireIntInRange(port, 'port', 1, 65535);

  // token rule (§4.1)
  const token = raw.token;
  if (typeof token !== 'string' || token.length === 0) fail('token is required');
  if (token.startsWith('CHANGE-ME')) fail('token is still the placeholder; set a real random token');
  if (token.length < 16) fail('token must be at least 16 characters');

  const ffmpegPath = raw.ffmpegPath === undefined ? 'ffmpeg' : raw.ffmpegPath;
  if (typeof ffmpegPath !== 'string' || ffmpegPath.length === 0) fail('ffmpegPath must be a string');

  const adbPath = raw.adbPath === undefined ? 'adb' : raw.adbPath;
  if (typeof adbPath !== 'string' || adbPath.length === 0) fail('adbPath must be a string');

  if (!Array.isArray(raw.displays) || raw.displays.length === 0) {
    fail('displays must be a non-empty array');
  }

  /** @type {Set<number>} */
  const ids = new Set();
  /** @type {Set<number>} */
  const outputIdxs = new Set();
  /** @type {DisplayConfig[]} */
  const displays = [];

  for (const [i, d] of raw.displays.entries()) {
    const where = `displays[${i}]`;
    if (!isObject(d)) fail(`${where} must be an object`);

    requireIntInRange(d.id, `${where}.id`, 1, 999);
    if (ids.has(/** @type {number} */ (d.id))) fail(`${where}.id duplicates an earlier display id (${d.id})`);
    ids.add(/** @type {number} */ (d.id));

    const source = d.source === undefined ? 'ddagrab' : d.source;
    if (!VALID_SOURCES.includes(/** @type {string} */ (source))) {
      fail(`${where}.source must be one of ${VALID_SOURCES.join(', ')}`);
    }

    requireIntInRange(d.fps, `${where}.fps`, 1, 60);
    requireIntInRange(d.quality, `${where}.quality`, 2, 31);
    requireIntInRange(d.maxWidth, `${where}.maxWidth`, 320, 3840);

    /** @type {DisplayConfig} */
    const out = {
      id: /** @type {number} */ (d.id),
      source: /** @type {any} */ (source),
      fps: /** @type {number} */ (d.fps),
      quality: /** @type {number} */ (d.quality),
      maxWidth: /** @type {number} */ (d.maxWidth),
    };

    if (source === 'ddagrab') {
      requireIntInRange(d.outputIdx, `${where}.outputIdx`, 0, 64);
      if (outputIdxs.has(/** @type {number} */ (d.outputIdx))) {
        fail(`${where}.outputIdx duplicates an earlier ddagrab outputIdx (${d.outputIdx})`);
      }
      outputIdxs.add(/** @type {number} */ (d.outputIdx));
      out.outputIdx = /** @type {number} */ (d.outputIdx);
      if (d.bounds !== undefined) {
        validateBounds(/** @type {Bounds} */ (d.bounds), where);
        out.bounds = /** @type {Bounds} */ (d.bounds);
      }
    } else if (source === 'gdigrab-region') {
      if (d.bounds === undefined) fail(`${where}: gdigrab-region requires bounds`);
      validateBounds(/** @type {Bounds} */ (d.bounds), where);
      out.bounds = /** @type {Bounds} */ (d.bounds);
    } else if (source === 'gdigrab-window') {
      const title = d.windowTitle;
      if (typeof title !== 'string' || title.length === 0) {
        fail(`${where}: gdigrab-window requires a non-empty windowTitle`);
      }
      if (title.length > 200) fail(`${where}.windowTitle must be at most 200 characters`);
      if (/["\n\r\0]/.test(title)) {
        fail(`${where}.windowTitle must not contain a double-quote, newline or NUL character`);
      }
      out.windowTitle = title;
      if (d.bounds !== undefined) {
        validateBounds(/** @type {Bounds} */ (d.bounds), where);
        out.bounds = /** @type {Bounds} */ (d.bounds);
      }
    }

    displays.push(out);
  }

  const input = isObject(raw.input) ? raw.input : { enabled: false };
  const inputEnabled = Boolean(input.enabled);

  const httpsRaw = isObject(raw.https) ? raw.https : {};
  const https = {
    enabled: Boolean(httpsRaw.enabled),
    keyPath: typeof httpsRaw.keyPath === 'string' ? httpsRaw.keyPath : 'certs/key.pem',
    certPath: typeof httpsRaw.certPath === 'string' ? httpsRaw.certPath : 'certs/cert.pem',
  };

  return {
    host,
    port,
    mode: /** @type {any} */ (mode),
    token,
    ffmpegPath,
    adbPath,
    displays,
    input: { enabled: inputEnabled },
    https,
  };
}

/**
 * Load config.json (relative to the project root) and validate it.
 *
 * @param {string} [configPath]
 * @returns {Config}
 */
export function loadConfig(configPath) {
  const file = configPath || path.join(process.cwd(), 'config.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`cannot read ${file}: ${/** @type {Error} */ (err).message}. Copy config.example.json to config.json.`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(`${file} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
  return validateConfig(raw);
}

export { ConfigError };
export default { loadConfig, validateConfig, ConfigError };
