// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanAddresses, phoneUrls } from '../src/network.js';

const IFACES = {
  Ethernet: [{ address: '192.168.1.10', family: 'IPv4', internal: false }],
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  'vEthernet (WSL)': [{ address: '172.20.0.1', family: 'IPv4', internal: false }],
  'Wi-Fi': [
    { address: '10.0.0.5', family: 'IPv4', internal: false },
    { address: 'fe80::1', family: 'IPv6', internal: false },
  ],
};

test('network: lanAddresses filters loopback, virtual adapters and IPv6', () => {
  const addrs = lanAddresses(/** @type {any} */ (IFACES));
  const ips = addrs.map((a) => a.address).sort();
  assert.deepEqual(ips, ['10.0.0.5', '192.168.1.10']);
});

test('network: phoneUrls (lan) produces URL per address per display', () => {
  const config = {
    https: { enabled: false },
    port: 3000,
    token: 'secret-token-value',
    mode: 'lan',
    displays: [{ id: 1 }, { id: 2 }],
  };
  const urls = phoneUrls(/** @type {any} */ (config), /** @type {any} */ (IFACES)).map((u) => u.url);
  assert.equal(urls.length, 4); // 2 addresses x 2 displays
  assert.ok(urls.includes('http://192.168.1.10:3000/?display=1&token=secret-token-value'));
  assert.ok(urls.includes('http://10.0.0.5:3000/?display=2&token=secret-token-value'));
});

test('network: phoneUrls (usb) uses localhost', () => {
  const config = {
    https: { enabled: false },
    port: 3000,
    token: 'secret-token-value',
    mode: 'usb',
    displays: [{ id: 1 }, { id: 2 }],
  };
  const urls = phoneUrls(/** @type {any} */ (config), /** @type {any} */ (IFACES)).map((u) => u.url);
  assert.deepEqual(urls, [
    'http://localhost:3000/?display=1&token=secret-token-value',
    'http://localhost:3000/?display=2&token=secret-token-value',
  ]);
});

test('network: phoneUrls honors https scheme', () => {
  const config = {
    https: { enabled: true },
    port: 8443,
    token: 'secret-token-value',
    mode: 'usb',
    displays: [{ id: 1 }],
  };
  const urls = phoneUrls(/** @type {any} */ (config), /** @type {any} */ (IFACES)).map((u) => u.url);
  assert.equal(urls[0], 'https://localhost:8443/?display=1&token=secret-token-value');
});
