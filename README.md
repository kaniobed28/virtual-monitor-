# virtual-monitor-

Use up to two phones (Android or iOS) as **extended monitors** for a Windows PC.
Phones connect from a **browser** — nothing is installed on the phone.

`PLAN.md` is the authoritative design & task spec. This README is the setup/usage guide.

---

## Contents

- [How it works](#how-it-works)
- [0. Policy check (read first)](#0-policy-check-read-first)
- [1. Decision flow](#1-decision-flow)
- [2. Install the tools (no admin needed)](#2-install-the-tools-no-admin-needed)
- [3. Create the extra screen(s)](#3-create-the-extra-screens)
- [4. Configure](#4-configure)
- [5. Run](#5-run)
- [6. Connect the phones](#6-connect-the-phones)
- [7. Touch input (optional)](#7-touch-input-optional)
- [8. Quality presets](#8-quality-presets)
- [9. Performance & soak testing](#9-performance--soak-testing)
- [10. Helper scripts](#10-helper-scripts)
- [11. Tests](#11-tests)
- [12. Troubleshooting](#12-troubleshooting)
- [13. Security notes](#13-security-notes)

---

## How it works

```
Windows gives you an extra screen (virtual driver, HDMI dummy plug, or a region/window)
   → FFmpeg captures it as MJPEG
      → Node server fans frames out over a token-protected WebSocket
         → phone browser draws them on a <canvas>, letterboxed
            → (optional) phone taps are sent back and replayed as mouse clicks
```

Transport is MJPEG over a binary WebSocket (works on iOS Safari 15+ and Android Chrome).
Each display is independent, so two phones can show two different screens at once.

---

## 0. Policy check (read first)

Streaming a **work** screen to a **personal** phone, or running unapproved portable software,
may break your company's data-handling rules even when it is technically possible.
**Confirm with your manager/IT first.** This project never disables security software,
elevates privileges, or edits policy — if something is blocked, use a documented fallback
below or ask IT.

---

## 1. Decision flow

```
Policy allows it? ── no/unsure ─► ask IT
        │ yes
        ▼
Can install the Virtual Display Driver (needs admin)?
   yes ─► Source A: ddagrab on virtual monitors
   no  ─► Have 2 free video outputs + 2 HDMI dummy plugs?
             yes ─► Source B: ddagrab on dummy plugs
             no  ─► Source C: gdigrab region / window (mirror only, not a real extra desktop)
        ▼
Phone can open http://<pc-ip>:3000 over Wi-Fi?
   yes ─────────────► mode: lan
   no, Android ─────► mode: usb   (adb reverse — no firewall rule needed)
   no, iPhone ──────► mode: hotspot (if allowed) or ask IT for a firewall rule
```

Full detail (dummy-plug wiring, EDID caveats, etc.) is in `PLAN.md` §2.1–§2.4.

---

## 2. Install the tools (no admin needed)

| Tool | With admin | Without admin (portable) |
|---|---|---|
| **Node.js 20 LTS+** | `winget install OpenJS.NodeJS.LTS` | unzip `node-v20.x-win-x64.zip` to `%USERPROFILE%\tools\node`, add it to your **user** `PATH` |
| **FFmpeg ≥ 6.0** | `winget install Gyan.FFmpeg` | unzip a gyan.dev/BtbN build to `%USERPROFILE%\tools\ffmpeg`, set `ffmpegPath` in `config.json` to `...\bin\ffmpeg.exe` |
| **adb** (usb mode only) | — | unzip Android SDK Platform-Tools to `%USERPROFILE%\tools\platform-tools`, set `adbPath` |

Verify FFmpeg has what we need:

```powershell
ffmpeg -hide_banner -filters  | findstr ddagrab   # should print a line
ffmpeg -hide_banner -devices  | findstr gdigrab    # should print a line
```

Then install the project's npm packages (local, no admin; `koffi` ships prebuilt binaries):

```powershell
npm install
```

---

## 3. Create the extra screen(s)

Pick **one** option. The phone never connects to the screen hardware — it only receives the
stream over the network.

### Option A — Virtual Display Driver (needs admin, true extra desktop)
Install the [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver),
set the monitor count to **2**, pick a resolution close to the phone (e.g. 1920×1080),
then *Settings → System → Display → **Extend these displays***. Use `source: "ddagrab"`.

### Option B — HDMI dummy plugs (no admin, true extra desktop)
Plug one HDMI "headless display emulator" per phone into a free video output
(HDMI port, USB-C with DisplayPort Alt Mode, or a dock). *Extend these displays*,
set each to 1920×1080 @ 100% scaling. Use `source: "ddagrab"`.

### Option C — Region / window (no admin, **mirror only**, last resort)
No extra desktop — you stream a rectangle of your main screen or one app window.
Use `source: "gdigrab-region"` (with `bounds`) or `source: "gdigrab-window"` (with `windowTitle`).

Find the monitor indexes/bounds and window titles:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/list-displays.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/list-windows.ps1
```

> ⚠ The Windows screen order is **not** necessarily FFmpeg's `ddagrab` `output_idx`.
> `list-displays.ps1` prints a per-index test command — grab one frame per index and look at
> the PNG to find the right `outputIdx`.

---

## 4. Configure

```powershell
Copy-Item config.example.json config.json
```

Edit `config.json`. **Set a long random `token`** (≥ 16 chars; the server refuses to start
otherwise). Set the right `source`/`outputIdx`/`bounds`/`windowTitle` per display.

```jsonc
{
  "host": "0.0.0.0",            // auto-forced to 127.0.0.1 in usb mode
  "port": 3000,
  "mode": "lan",                // "lan" | "usb" | "hotspot"
  "token": "use-a-long-random-string-here",
  "ffmpegPath": "ffmpeg",       // or full path to a portable ffmpeg.exe
  "adbPath": "adb",
  "displays": [
    { "id": 1, "source": "ddagrab", "outputIdx": 1, "fps": 30, "quality": 5, "maxWidth": 1920 },
    { "id": 2, "source": "ddagrab", "outputIdx": 2, "fps": 30, "quality": 5, "maxWidth": 1920 }
  ],
  "input": { "enabled": false },
  "https": { "enabled": false, "keyPath": "certs/key.pem", "certPath": "certs/cert.pem" }
}
```

### Config examples per source

```jsonc
// Region of the main screen (right third of a 1080p screen):
{ "id": 1, "source": "gdigrab-region",
  "bounds": { "x": 1280, "y": 0, "width": 640, "height": 1080 },
  "fps": 30, "quality": 5, "maxWidth": 1920 }

// One app window (exact title from list-windows.ps1; width/height must be even):
{ "id": 2, "source": "gdigrab-window", "windowTitle": "Microsoft Teams",
  "fps": 15, "quality": 6, "maxWidth": 1280 }
```

Field rules (validated at startup): `fps` 1–60, `quality` 2 (best)–31 (worst),
`maxWidth` 320–3840, `bounds` width/height **even**, `windowTitle` ≤ 200 chars and no
`"`/newline/NUL, unique `id` and (for ddagrab) unique `outputIdx`.

---

## 5. Run

```powershell
npm start
```

On startup the server prints a phone URL per display (including the token) and a token
fingerprint. Example:

```
server: listening on http://0.0.0.0:3000 (mode=lan)
server: token fingerprint a1b2c3d4
server: open these URLs on the phones:
  display 1: http://192.168.1.10:3000/?display=1&token=...
  display 2: http://192.168.1.10:3000/?display=2&token=...
```

Stop with `Ctrl+C` (graceful shutdown kills FFmpeg).

---

## 6. Connect the phones

### `lan` (Wi-Fi) — Android + iOS
Same Wi-Fi as the PC (prefer 5 GHz). Open the printed `http://<pc-ip>:3000/...` URL.
When Node first listens, Windows may ask to allow access — **allow on Private networks only**.
Confirm reachability (note: a *local* probe passing does **not** prove a phone can reach you):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-network.ps1
```

### `usb` (Android only) — survives blocked firewalls
Enable **Developer options → USB debugging** on the phone, connect a **data** USB cable, accept
the prompt. Set `"mode": "usb"`. The server auto-runs `adb reverse` every 5 s; or run it manually:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/usb-android.ps1
```

Then open `http://localhost:3000/?display=1&token=...` on the phone. `localhost` is a secure
context, so Wake Lock works without HTTPS and nothing is exposed on the network.

### `hotspot` (iPhone, when office Wi-Fi isolates devices)
Only if policy allows the laptop to join a hotspot. Turn the hotspot on one phone, join it from
the laptop and the other phone, then use it like `lan`. The Windows firewall still applies.

> **iPhone has no `adb reverse`.** If the firewall blocks inbound connections, the only options
> are a hotspot (if allowed), an IT-approved firewall rule, or a non-work PC.

### Mixed modes
Android on USB **and** iPhone on Wi-Fi at once: set `"mode": "lan"` (so it binds `0.0.0.0`) and
also run `usb-android.ps1`. `adb reverse` targets `localhost`, which `0.0.0.0` already covers.

### iPhone fullscreen tip
Open the URL in Safari → **Share → Add to Home Screen**, then launch from the icon. This hides
the address bar and runs the PWA fullscreen. Set Auto-Lock to Never (or rely on Wake Lock) so the
screen doesn't sleep.

---

## 7. Touch input (optional)

Set `"input": { "enabled": true }`. Tapping/dragging on the phone moves and clicks the mouse on
the matching monitor (left button). Mapping uses the display bounds; set an explicit `bounds` on
the display if clicks land slightly off (DPI/scaling). Input is **off by default** for safety and
rate-limited to 120 messages/s per connection.

---

## 8. Quality presets

Tune per display. Lower `fps`/`maxWidth` and a **higher** `quality` number reduce bandwidth & lag.

| Preset | fps | quality | Use when |
|---|---|---|---|
| **Battery** | 15 | 8 | Save phone battery / weak Wi-Fi |
| **Balanced** | 30 | 5 | Default |
| **Sharp** | 30 | 3 | Reading text, strong 5 GHz / USB |

A 1080p MJPEG stream is roughly **5–15 Mbps**. On 2.4 GHz Wi-Fi, drop to the Battery preset or use USB.

---

## 9. Performance & soak testing

**Latency target:** ≤ 150 ms on 5 GHz Wi-Fi at 1080p/30fps. The phone's status pill shows live
fps and round-trip latency (from the 2 s app-level ping). To measure glass-to-glass latency,
display a millisecond clock on the captured monitor and photograph the PC screen and phone
together; the difference is the end-to-end latency. Record the number here for your setup.

**Soak test (before relying on it):** run two phones for ~30 minutes and watch the server's
memory:

```powershell
# in another terminal, sample RSS of the node process every 30 s
while ($true) { (Get-Process node | Measure-Object WorkingSet64 -Sum).Sum/1MB; Start-Sleep 30 }
```

RSS should stay roughly flat (≤ ~10% growth). Afterwards, confirm **no orphan `ffmpeg.exe`** in
Task Manager (the server kills FFmpeg on stop and on exit).

---

## 10. Helper scripts (`scripts/`)

Run with `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/<name>.ps1`.

| Script | Purpose |
|---|---|
| `list-displays.ps1` | DPI-aware monitor bounds + the `ddagrab` index test command. `-Json` for machine output. |
| `list-windows.ps1` | Visible window titles for `gdigrab-window`. |
| `check-network.ps1` | LAN IPs, network category, VPN check, phone URLs, local `/healthz` probe. |
| `usb-android.ps1` | `adb reverse` for every connected Android device. `-Port`, `-AdbPath`, `-Remove`. |

---

## 11. Tests

```powershell
npm test
```

Uses the built-in `node:test` runner; needs neither FFmpeg nor a GPU. Covers config validation,
timing-safe auth, the MJPEG parser, exact FFmpeg argument arrays, the StreamHub (start/stop
counting, grace period, backpressure), and LAN/URL generation.

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Black frames / wrong screen | Wrong `outputIdx` | Run the per-index test command printed by `list-displays.ps1` |
| `No such filter: ddagrab` | FFmpeg too old | Use FFmpeg ≥ 6.0 |
| `ddagrab` fails on one monitor only | Hybrid graphics (monitor on the other GPU) | *Settings → Display → Graphics* set FFmpeg to the matching GPU, or move the dummy plug |
| Dummy plug not detected | USB-C port lacks DP Alt Mode / max displays reached | Use another port or a dock; check the laptop spec |
| Only low resolutions with a dummy plug | Plug EDID is limited | Buy a plug advertising 1080p+/4K EDID |
| Phone can't open the URL, PC can | Firewall blocks inbound, Wi-Fi client isolation, VPN | Android: `usb` mode. iPhone: hotspot or ask IT for a rule |
| `adb devices` empty | Charge-only cable, USB debugging off, missing OEM driver | Use a data cable, enable debugging, ask IT for the driver |
| `adb devices` shows `unauthorized` | Prompt not accepted | Unlock the phone and accept "Allow USB debugging" |
| `window not found` | Window closed or title changed | Re-run `list-windows.ps1`, update `windowTitle` |
| Region capture offset / cut off | Windows scaling ≠ 100% | Use the physical-pixel bounds from `list-displays.ps1` |
| Touch clicks the wrong place | DPI awareness / wrong bounds | Set `bounds` explicitly on the display |
| High latency / stutter | 2.4 GHz Wi-Fi, quality too high, CPU busy | Use 5 GHz or USB; raise the `quality` number; lower `fps`/`maxWidth` |
| iPhone screen turns off | No Wake Lock on plain HTTP | Use HTTPS, or `usb` mode (localhost), or set Auto-Lock to Never |
| iPhone shows the address bar | Not opened from the Home Screen | Share → Add to Home Screen, open from the icon |
| "too many clients" | > 4 clients on one display | Close extra tabs/devices (limit is 4 per display) |

---

## 13. Security notes

- Access is **token-gated**; the token must be ≥ 16 chars and not the placeholder.
- In `usb` mode the server binds `127.0.0.1` only — nothing is exposed on the network.
- Touch input is **disabled** unless `input.enabled` is `true`, and is rate-limited.
- `config.json` (holds the token) and `certs/` are **git-ignored**. Never commit real tokens.
  Logs show only a token *fingerprint*; the full token appears only in the startup phone URLs.
- The token is visible in the URL/browser history — use a dedicated browser profile on a shared
  phone, and rotate the token if a screenshot of the URL leaks.
- LAN is treated as untrusted: every client message is schema- and size-validated.
