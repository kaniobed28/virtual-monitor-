// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidToken } from '../src/auth.js';

test('auth: matching tokens pass', () => {
  assert.equal(isValidToken('a-very-long-secret-token', 'a-very-long-secret-token'), true);
});

test('auth: different tokens fail', () => {
  assert.equal(isValidToken('a-very-long-secret-token', 'a-very-long-secret-tokeX'), false);
});

test('auth: length mismatch fails without throwing', () => {
  assert.equal(isValidToken('short', 'a-very-long-secret-token'), false);
  assert.equal(isValidToken('a-very-long-secret-token-extra', 'a-very-long-secret-token'), false);
});

test('auth: null / non-string provided fails', () => {
  assert.equal(isValidToken(null, 'a-very-long-secret-token'), false);
  assert.equal(isValidToken(undefined, 'a-very-long-secret-token'), false);
  assert.equal(isValidToken(/** @type {any} */ (123), 'a-very-long-secret-token'), false);
});

test('auth: empty expected fails', () => {
  assert.equal(isValidToken('anything', ''), false);
});
