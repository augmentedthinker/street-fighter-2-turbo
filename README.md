# Street Fighter II Turbo — Web Arcade Cabinet

Dedicated browser-based **Street Fighter II Turbo: Hyper Fighting** (SNES) cabinet powered by local **Snes9x WebAssembly (EmulatorJS)** with first-class **1P & 2P Xbox controller** support.

## Features
- **Dual Xbox Controller Support (USB & Bluetooth):** Automatically detects Player 1 and Player 2 Xbox controllers (Xbox One, Series X|S, 360, or any Standard Gamepad) with live HUD feedback, **P1 ↔ P2 Swap**, and **Rumble Test** to identify which pad is which.
- **D-Pad + Left Analog Stick:** Both work simultaneously with SOCD neutral cleaning and an adjustable stick deadzone slider for crisp quarter-circle and dragon-punch inputs.
- **Two 6-Button Fighting Layouts:**
  - **Xbox 6-Button (Default):** Top row punches (`X` Light · `Y` Med · `RB` Heavy) · Bottom row kicks (`A` Light · `B` Med · `RT` Heavy).
  - **Classic SNES:** `X` / `Y` / `LB` Punches · `A` / `B` / `RB` Kicks.
- **Full 12-Fighter Move List:** Filterable between all 12 World Warriors, Original 8, and the Four Bosses.
- **CRT Scanlines & Fullscreen Mode** plus keyboard fallback (`Arrow Keys`, `A/S/Q` punches, `Z/X/E` kicks, `Enter` Start, `V` Select).

## Running Locally
Serve the directory with any static HTTP server (required for WebAssembly):

```bash
python3 -m http.server 8080
```

Then open `http://127.0.0.1:8080/` and press any button on your Xbox controller(s) to wake them.
