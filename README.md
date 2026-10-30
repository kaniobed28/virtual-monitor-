# virtual-monitor-

Use up to two phones (Android or iOS) as **extended monitors** for a Windows PC.
Phones connect from a browser — nothing is installed on the phone.

See [`PLAN.md`](./PLAN.md) for the full design, task breakdown and contracts (the single source of truth).

## What works (v1)

- Windows virtual/extra monitors captured with FFmpeg (`ddagrab`), or a screen region / app window (`gdigrab`).
- Each display streamed as MJPEG over a binary WebSocket to a phone browser (Android Chrome / iOS Safari 15+).
- Token-protected, LAN or USB (`adb reverse`), no admin required on the no-driver paths.
- Optional touch → mouse control (off by default).

## Quick start

1. **Install tools** (no admin needed — portable zips are fine):
   - Node.js 20 LTS+ and FFmpeg ≥ 6.0 (set `ffmpegPath` if not on `PATH`).
2. **Create the extra screen(s)** — pick one per the decision flow in `PLAN.md` §2.4:
   Virtual Display Driver (needs admin), HDMI dummy plugs, or region/window streaming.
3. **Configure:**
   ```sh
   cp config.example.json config.json
   # set a long random "token", and the right "outputIdx" per display
   node scripts/list-displays.ps1   # find monitor indexes/bounds
   ```
4. **Run:**
   ```sh
   npm install
   npm start
   ```
   The server prints a URL per display (including the token). Open it on each phone.
5. **USB mode (Android):** set `"mode": "usb"` and connect the phone with USB debugging on —
   the server auto-runs `adb reverse`, or run `scripts/usb-android.ps1` manually. Open `http://localhost:3000/...`.

## Helper scripts (`scripts/`)

| Script | Purpose |
|---|---|
| `list-displays.ps1` | Monitors with DPI-aware bounds + the `ddagrab` index test command |
| `list-windows.ps1` | Visible window titles for `gdigrab-window` |
| `check-network.ps1` | LAN IPs, network profile, VPN check, phone URLs, local `/healthz` probe |
| `usb-android.ps1` | `adb reverse` for every connected Android device |

Run them with: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/<name>.ps1`

## Tests

```sh
npm test
```

Tests use the built-in `node:test` runner and need neither FFmpeg nor a GPU.

## Security notes

- Access is token-gated; the server binds to `127.0.0.1` in `usb` mode.
- Touch input is disabled unless `input.enabled` is `true`.
- `config.json` (holds the token) and `certs/` are git-ignored. Never commit real tokens.
- Only use on networks and devices you're authorized to, and check your company policy
  before streaming work content to a personal phone (`PLAN.md` §0.1).
