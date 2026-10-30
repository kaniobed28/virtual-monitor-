/* Phone Monitor browser client.
 * Renders MJPEG frames (binary WebSocket messages) onto a letterboxed canvas,
 * sends latency pings, optionally forwards touch as pointer events, and shows a
 * help panel after repeated connection failures. Works on Android Chrome and
 * iOS Safari 15+. No build step; plain ES2020. */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const display = Number(params.get('display') || '1');
  const token = params.get('token') || '';

  const canvas = document.getElementById('screen');
  const ctx = canvas.getContext('2d');
  const pill = document.getElementById('pill');
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('start-btn');
  const iosHint = document.getElementById('ios-hint');
  const help = document.getElementById('help');

  const isIOS =
    /iP(hone|od|ad)/.test(navigator.platform) ||
    (navigator.userAgent.includes('Mac') && 'ontouchend' in document);

  // ---- Render state ------------------------------------------------------
  let latestBitmap = null; // newest decoded frame awaiting draw
  let drawnRect = { x: 0, y: 0, w: 0, h: 0 }; // letterbox rect in CSS pixels
  let dpr = window.devicePixelRatio || 1;
  let frameCount = 0;
  let fps = 0;
  let rttMs = null;
  let inputEnabled = false;

  // ---- Connection state --------------------------------------------------
  let ws = null;
  let backoff = 500;
  const BACKOFF_MAX = 10000;
  let failures = 0;
  let started = false;
  let pingTimer = null;
  let pillTimer = null;

  const supportsBitmap = typeof createImageBitmap === 'function';

  // ---- Canvas sizing -----------------------------------------------------
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    render(); // re-letterbox immediately on rotation/resize
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

  // ---- Rendering (latest frame only) -------------------------------------
  function render() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const bmp = latestBitmap;
    if (!bmp) return;

    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.min(cw / bmp.width, ch / bmp.height);
    const dw = bmp.width * scale;
    const dh = bmp.height * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;
    ctx.drawImage(bmp, dx, dy, dw, dh);

    // Store rect in CSS pixels for pointer mapping (undo DPR).
    drawnRect = { x: dx / dpr, y: dy / dpr, w: dw / dpr, h: dh / dpr };
  }

  function scheduleRender() {
    requestAnimationFrame(() => {
      render();
    });
  }

  async function onFrame(blob) {
    frameCount++;
    try {
      if (supportsBitmap) {
        const bmp = await createImageBitmap(blob);
        if (latestBitmap && latestBitmap.close) latestBitmap.close();
        latestBitmap = bmp;
        scheduleRender();
      } else {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          latestBitmap = img;
          scheduleRender();
          URL.revokeObjectURL(url);
        };
        img.onerror = () => URL.revokeObjectURL(url);
        img.src = url;
      }
    } catch {
      /* drop undecodable frame */
    }
  }

  // ---- Status pill -------------------------------------------------------
  function setState(state, text) {
    pill.dataset.state = state;
    pill.textContent = text;
    pill.classList.remove('faded');
    clearTimeout(pillTimer);
    if (state === 'connected') {
      pillTimer = setTimeout(() => pill.classList.add('faded'), 2500);
    }
  }

  function updatePill() {
    if (pill.dataset.state !== 'connected') return;
    const parts = [`d${display}`, `${fps} fps`];
    if (rttMs != null) parts.push(`${rttMs} ms`);
    pill.textContent = parts.join(' · ');
  }

  setInterval(() => {
    fps = frameCount;
    frameCount = 0;
    updatePill();
  }, 1000);

  // ---- WebSocket ---------------------------------------------------------
  function wsUrl() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = `display=${encodeURIComponent(display)}&token=${encodeURIComponent(token)}`;
    return `${scheme}://${location.host}/ws?${q}`;
  }

  function connect() {
    setState(failures > 0 ? 'reconnecting' : 'connecting', failures > 0 ? 'reconnecting…' : 'connecting…');
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    ws.binaryType = 'blob';

    ws.onopen = () => {
      failures = 0;
      backoff = 500;
      help.classList.add('hidden');
      setState('connected', `d${display}`);
      startPings();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        handleText(ev.data);
      } else {
        onFrame(ev.data);
      }
    };

    ws.onclose = (ev) => {
      stopPings();
      if (ev.code === 4004) {
        setState('error', 'unknown display');
        return; // fatal, don't retry
      }
      if (ev.code === 4029) {
        setState('error', 'too many clients');
        return;
      }
      failures++;
      setState('closed', 'disconnected');
      if (failures >= 3) help.classList.remove('hidden');
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will follow and drive the retry.
    };
  }

  function handleText(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      inputEnabled = Boolean(msg.inputEnabled);
    } else if (msg.type === 'pong' && typeof msg.t === 'number') {
      rttMs = Date.now() - msg.t;
      updatePill();
    } else if (msg.type === 'error') {
      setState('error', msg.message || 'error');
    }
  }

  function scheduleReconnect() {
    const delay = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
    setTimeout(connect, delay);
  }

  function startPings() {
    stopPings();
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      }
    }, 2000);
  }

  function stopPings() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  // ---- Wake Lock ---------------------------------------------------------
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => {
        wakeLock = null;
      });
    } catch {
      /* ignored (e.g. not a secure context) */
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquireWakeLock();
  });

  // ---- Fullscreen / start gesture ----------------------------------------
  async function start() {
    if (started) return;
    started = true;
    overlay.classList.add('hidden');

    if (!isIOS && document.documentElement.requestFullscreen) {
      try {
        await document.documentElement.requestFullscreen();
      } catch {
        /* user can still use it windowed */
      }
    }
    acquireWakeLock();
    resize();
    connect();
  }

  startBtn.addEventListener('click', start);
  if (isIOS && !window.navigator.standalone) iosHint.classList.remove('hidden');

  // ---- Pointer input (§5.2) ----------------------------------------------
  let pendingMove = null;
  let moveScheduled = false;

  function toNormalized(clientX, clientY) {
    const r = drawnRect;
    if (r.w <= 0 || r.h <= 0) return null;
    const nx = (clientX - r.x) / r.w;
    const ny = (clientY - r.y) / r.h;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null; // tap in the black bars
    return { x: nx, y: ny };
  }

  function sendPointer(action, clientX, clientY) {
    if (!inputEnabled || !ws || ws.readyState !== WebSocket.OPEN) return;
    const n = toNormalized(clientX, clientY);
    if (!n) return;
    ws.send(JSON.stringify({ type: 'pointer', action, x: n.x, y: n.y }));
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!started) return;
    sendPointer('down', e.clientX, e.clientY);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!started || e.buttons === 0) return;
    pendingMove = { x: e.clientX, y: e.clientY };
    if (!moveScheduled) {
      moveScheduled = true;
      requestAnimationFrame(() => {
        moveScheduled = false;
        if (pendingMove) {
          sendPointer('move', pendingMove.x, pendingMove.y);
          pendingMove = null;
        }
      });
    }
  });

  const endPointer = (e) => {
    if (!started) return;
    sendPointer('up', e.clientX, e.clientY);
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // Initial layout (before start, so the black canvas fills the screen).
  resize();
})();
