// @ts-check
/**
 * Minimal leveled logger with timestamps.
 * Level is read once from the `LOG_LEVEL` environment variable (default "info").
 */

/** @typedef {'debug'|'info'|'warn'|'error'} Level */

/** @type {Record<Level, number>} */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * @returns {Level}
 */
function currentLevel() {
  const raw = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return /** @type {Level} */ (raw in LEVELS ? raw : 'info');
}

/**
 * @param {Level} level
 * @param {unknown[]} args
 */
function emit(level, args) {
  if (LEVELS[level] < LEVELS[currentLevel()]) return;
  const ts = new Date().toISOString();
  const tag = `[${ts}] ${level.toUpperCase()}`;
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(tag, ...args);
}

export const logger = {
  /** @param {...unknown} args */
  debug: (...args) => emit('debug', args),
  /** @param {...unknown} args */
  info: (...args) => emit('info', args),
  /** @param {...unknown} args */
  warn: (...args) => emit('warn', args),
  /** @param {...unknown} args */
  error: (...args) => emit('error', args),
};

export default logger;
