// @ts-check
import crypto from 'node:crypto';

/**
 * Timing-safe token comparison. Handles length mismatches and null/undefined
 * without throwing or leaking timing through early returns on length.
 *
 * @param {string | null | undefined} provided
 * @param {string} expected
 * @returns {boolean}
 */
export function isValidToken(provided, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof provided !== 'string') return false;

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  // timingSafeEqual requires equal-length buffers. Comparing against a fixed
  // digest of each side keeps the comparison constant-time regardless of the
  // input length, so we don't short-circuit on a length mismatch.
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();

  const equalHash = crypto.timingSafeEqual(ah, bh);
  // Guard against (astronomically unlikely) hash collisions on differing input.
  return equalHash && a.length === b.length;
}

export default { isValidToken };
