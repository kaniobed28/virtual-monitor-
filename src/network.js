// @ts-check
import os from 'node:os';

/** @typedef {import('./config.js').Config} Config */

// Adapter names that are virtual / not useful for reaching the PC from a phone.
const VIRTUAL_IFACE_RE = /(vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Default Switch|TAP|Npcab|docker)/i;

/**
 * Non-internal IPv4 addresses on physical adapters.
 *
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [interfaces] injectable for tests
 * @returns {Array<{ iface: string, address: string }>}
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  /** @type {Array<{ iface: string, address: string }>} */
  const out = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    if (!infos) continue;
    if (VIRTUAL_IFACE_RE.test(name)) continue;
    for (const info of infos) {
      const family = /** @type {string | number} */ (info.family);
      const isV4 = family === 'IPv4' || family === 4;
      if (!isV4 || info.internal) continue;
      out.push({ iface: name, address: info.address });
    }
  }
  return out;
}

/**
 * Phone-facing URLs per display, derived from the mode.
 * - lan / hotspot → one entry per (LAN address × display)
 * - usb           → one entry per display at localhost (through adb reverse)
 *
 * @param {Config} config
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [interfaces] injectable for tests
 * @returns {Array<{ display: number, url: string }>}
 */
export function phoneUrls(config, interfaces = os.networkInterfaces()) {
  const scheme = config.https && config.https.enabled ? 'https' : 'http';
  const port = config.port;
  const tokenQ = encodeURIComponent(config.token);

  /** @param {string} host @param {number} display */
  const make = (host, display) =>
    `${scheme}://${host}:${port}/?display=${display}&token=${tokenQ}`;

  /** @type {Array<{ display: number, url: string }>} */
  const out = [];

  if (config.mode === 'usb') {
    for (const d of config.displays) out.push({ display: d.id, url: make('localhost', d.id) });
    return out;
  }

  // lan / hotspot
  const addrs = lanAddresses(interfaces);
  const hosts = addrs.length > 0 ? addrs.map((a) => a.address) : ['<pc-ip>'];
  for (const host of hosts) {
    for (const d of config.displays) out.push({ display: d.id, url: make(host, d.id) });
  }
  return out;
}

export default { lanAddresses, phoneUrls };
