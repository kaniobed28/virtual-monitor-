// @ts-check
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';
import { WebSocketServer } from 'ws';

import { loadConfig } from './config.js';
import { isValidToken, tokenFingerprint } from './auth.js';
import { CaptureManager } from './capture.js';
import { StreamHub } from './streamHub.js';
import { phoneUrls } from './network.js';
import * as displays from './displays.js';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MAX_CLIENTS_PER_DISPLAY = 4; // §6.2
const HEARTBEAT_MS = 15000; // §3.2
const MAX_MESSAGE_BYTES = 1024; // §4.4
const POINTER_RATE_LIMIT = 120; // messages/s per socket (§5.3)
const ADB_POLL_MS = 5000; // §5A.2

async function main() {
  const config = loadConfig();
  const displayIds = new Set(config.displays.map((d) => d.id));

  const capture = new CaptureManager(config);
  const hub = new StreamHub(capture);

  await displays.initDisplays(config);

  // Optional touch input (lazily loaded; Windows only).
  let inputController = null;
  if (config.input.enabled) {
    const { InputController } = await import('./input.js');
    inputController = new InputController(config, displays);
    await inputController.init();
  }

  // ---- Express (static client + healthz) ---------------------------------
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob:; connect-src 'self' ws: wss:",
    );
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok');
  });

  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      },
    }),
  );

  // ---- HTTP(S) server ----------------------------------------------------
  const server = createServer(app, config);

  // ---- WebSocket (noServer; token checked during upgrade) ----------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || '', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token');
    if (!isValidToken(token, config.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const displayId = Number(url.searchParams.get('display'));
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, displayId);
    });
  });

  /**
   * @param {import('ws').WebSocket} ws
   * @param {number} displayId
   */
  function onConnection(ws, displayId) {
    if (!Number.isInteger(displayId) || !displayIds.has(displayId)) {
      ws.close(4004, 'unknown display');
      return;
    }
    if (hub.count(displayId) >= MAX_CLIENTS_PER_DISPLAY) {
      ws.close(4029, 'too many clients');
      return;
    }

    const display = config.displays.find((d) => d.id === displayId);
    // @ts-ignore augment socket with liveness + rate-limit bookkeeping
    ws.isAlive = true;
    // @ts-ignore
    ws.pointerWindowStart = Date.now();
    // @ts-ignore
    ws.pointerCount = 0;

    ws.on('pong', () => {
      // @ts-ignore
      ws.isAlive = true;
    });

    ws.send(
      JSON.stringify({
        type: 'hello',
        display: displayId,
        fps: display ? display.fps : null,
        inputEnabled: config.input.enabled,
      }),
    );

    hub.addClient(displayId, ws);
    logger.info(`ws: client connected to display ${displayId} (clients=${hub.count(displayId)})`);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // clients never send binary
      handleClientMessage(ws, displayId, data);
    });

    ws.on('close', () => {
      hub.removeClient(displayId, ws);
      logger.info(`ws: client left display ${displayId} (clients=${hub.count(displayId)})`);
    });

    ws.on('error', (err) => logger.debug(`ws: socket error on display ${displayId}: ${err.message}`));
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {number} displayId
   * @param {import('ws').RawData} data
   */
  function handleClientMessage(ws, displayId, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(/** @type {any} */ (data));
    if (buf.length > MAX_MESSAGE_BYTES) return;

    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;

    if (msg.type === 'ping') {
      if (typeof msg.t !== 'number') return;
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      return;
    }

    if (msg.type === 'pointer') {
      if (!config.input.enabled || !inputController) return;
      if (msg.action !== 'down' && msg.action !== 'move' && msg.action !== 'up') return;
      if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
      if (msg.x < 0 || msg.x > 1 || msg.y < 0 || msg.y > 1) return;

      // Rate limit: POINTER_RATE_LIMIT messages per rolling second per socket.
      const now = Date.now();
      // @ts-ignore
      if (now - ws.pointerWindowStart >= 1000) {
        // @ts-ignore
        ws.pointerWindowStart = now;
        // @ts-ignore
        ws.pointerCount = 0;
      }
      // @ts-ignore
      if (ws.pointerCount >= POINTER_RATE_LIMIT) return;
      // @ts-ignore
      ws.pointerCount += 1;

      inputController.pointer(displayId, msg.action, msg.x, msg.y);
    }
  }

  // ---- Heartbeat ---------------------------------------------------------
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      // @ts-ignore
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      // @ts-ignore
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  // ---- adb auto-reverse (usb mode) --------------------------------------
  let adbTimer = null;
  if (config.mode === 'usb') adbTimer = startAdbAutoReverse(config);

  // ---- Listen ------------------------------------------------------------
  await new Promise((resolve) => server.listen(config.port, config.host, () => resolve(undefined)));
  printStartup(config);

  // ---- Graceful shutdown -------------------------------------------------
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`server: received ${signal}, shutting down`);
    clearInterval(heartbeat);
    if (adbTimer) clearInterval(adbTimer);
    for (const ws of wss.clients) {
      try {
        ws.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    capture.stopAll();
    server.close(() => process.exit(0));
    // Don't hang forever if sockets refuse to drain.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * @param {import('express').Express} app
 * @param {import('./config.js').Config} config
 */
function createServer(app, config) {
  if (config.https.enabled) {
    try {
      const key = fs.readFileSync(config.https.keyPath);
      const cert = fs.readFileSync(config.https.certPath);
      logger.info('server: HTTPS enabled');
      return https.createServer({ key, cert }, app);
    } catch (err) {
      logger.error(
        `server: HTTPS enabled but cert/key could not be read (${/** @type {Error} */ (err).message}); ` +
          'falling back to HTTP',
      );
    }
  }
  return http.createServer(app);
}

/**
 * @param {import('./config.js').Config} config
 */
function printStartup(config) {
  const scheme = config.https.enabled ? 'https' : 'http';
  logger.info(`server: listening on ${scheme}://${config.host}:${config.port} (mode=${config.mode})`);
  logger.info(`server: token fingerprint ${tokenFingerprint(config.token)}`);
  logger.info('server: open these URLs on the phones:');
  for (const { display, url } of phoneUrls(config)) {
    logger.info(`  display ${display}: ${url}`);
  }
  if (config.mode === 'usb') {
    logger.info('server: usb mode - run scripts/usb-android.ps1 (or it is auto-run every 5 s)');
  } else {
    logger.info('server: if a phone cannot connect, see README troubleshooting (firewall / Wi-Fi isolation / VPN)');
  }
}

/**
 * Poll `adb devices` and keep a reverse tunnel for every connected device, so
 * phones can be unplugged and replugged without restarting the server.
 * @param {import('./config.js').Config} config
 * @returns {NodeJS.Timeout}
 */
function startAdbAutoReverse(config) {
  let warnedMissing = false;
  /** @type {Set<string>} */
  const known = new Set();

  const poll = () => {
    const proc = spawn(config.adbPath, ['devices'], { shell: false, windowsHide: true });
    let out = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.on('error', () => {
      if (!warnedMissing) {
        warnedMissing = true;
        logger.warn(`server: adb not found at '${config.adbPath}'; usb auto-reverse disabled (lan clients still work)`);
      }
    });
    proc.on('exit', (code) => {
      if (code !== 0) return;
      const serials = out
        .split(/\r?\n/)
        .slice(1)
        .map((l) => l.trim().split(/\s+/))
        .filter((p) => p[1] === 'device')
        .map((p) => p[0]);
      for (const serial of serials) {
        if (known.has(serial)) continue;
        known.add(serial);
        const rev = spawn(
          config.adbPath,
          ['-s', serial, 'reverse', `tcp:${config.port}`, `tcp:${config.port}`],
          { shell: false, windowsHide: true },
        );
        rev.on('exit', (c) => {
          if (c === 0) logger.info(`server: adb reverse set for ${serial}`);
          else known.delete(serial); // retry next poll
        });
        rev.on('error', () => known.delete(serial));
      }
      // Forget serials that disappeared so a replug re-establishes the tunnel.
      for (const serial of [...known]) if (!serials.includes(serial)) known.delete(serial);
    });
  };

  poll();
  const timer = setInterval(poll, ADB_POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

main().catch((err) => {
  logger.error(`server: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
