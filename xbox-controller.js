/**
 * Dedicated Dual Xbox Controller Engine for Street Fighter II Turbo (SNES9x / EmulatorJS)
 *
 * - Supports 1P & 2P Xbox controllers simultaneously (USB or Bluetooth, Standard Gamepad API)
 * - Bridges both D-Pad AND Left Analog Stick cleanly to SNES D-Pad for quarter-circles & charge moves
 * - Two fighting layouts: "modern" (X/Y/RB punches, A/B/RT kicks) and "classic" (SNES shoulder L/R)
 * - Takes clean ownership of gamepad polling at rAF (~60-120Hz) so there are zero double-inputs
 * - Supports P1 <-> P2 swap, rumble identification, and live visual button telemetry
 */
(function () {
  'use strict';

  // Snes9x RetroArch button indices used by EmulatorJS gameManager.simulateInput(player, index, val)
  const SNES = {
    A: 0,      // Medium Kick
    X: 1,      // Medium Punch
    SELECT: 2,
    START: 3,
    UP: 4,
    DOWN: 5,
    LEFT: 6,
    RIGHT: 7,
    B: 8,      // Light Kick
    Y: 9,      // Light Punch
    L: 10,     // Heavy Punch (Fierce)
    R: 11      // Heavy Kick (Roundhouse)
  };

  // Layout definitions: each SNES button maps to one or more Standard Gamepad button indices
  // Standard Xbox indices: 0=A, 1=B, 2=X, 3=Y, 4=LB, 5=RB, 6=LT, 7=RT, 8=View, 9=Menu, 12..15=DPad
  const LAYOUTS = {
    modern: {
      name: 'Xbox 6-Button',
      subtitle: 'Top row punches (X · Y · RB) · Bottom row kicks (A · B · RT)',
      buttons: {
        Y: [2],       // X -> Light Punch
        X: [3],       // Y -> Medium Punch
        L: [5, 4],    // RB (or LB) -> Heavy Punch
        B: [0],       // A -> Light Kick
        A: [1],       // B -> Medium Kick
        R: [7, 6],    // RT (or LT) -> Heavy Kick
        SELECT: [8],  // View
        START: [9]    // Menu
      },
      labels: {
        Y: { xbox: 'X', move: 'Light Punch', type: 'punch' },
        X: { xbox: 'Y', move: 'Med Punch', type: 'punch' },
        L: { xbox: 'RB', move: 'Heavy Punch', type: 'punch' },
        B: { xbox: 'A', move: 'Light Kick', type: 'kick' },
        A: { xbox: 'B', move: 'Med Kick', type: 'kick' },
        R: { xbox: 'RT', move: 'Heavy Kick', type: 'kick' }
      }
    },
    classic: {
      name: 'Classic SNES',
      subtitle: 'LB = Heavy Punch · RB = Heavy Kick (matches original SNES pad)',
      buttons: {
        Y: [2],       // X -> Light Punch
        X: [3],       // Y -> Medium Punch
        L: [4, 6],    // LB (or LT) -> Heavy Punch
        B: [0],       // A -> Light Kick
        A: [1],       // B -> Medium Kick
        R: [5, 7],    // RB (or RT) -> Heavy Kick
        SELECT: [8],  // View
        START: [9]    // Menu
      },
      labels: {
        Y: { xbox: 'X', move: 'Light Punch', type: 'punch' },
        X: { xbox: 'Y', move: 'Med Punch', type: 'punch' },
        L: { xbox: 'LB', move: 'Heavy Punch', type: 'punch' },
        B: { xbox: 'A', move: 'Light Kick', type: 'kick' },
        A: { xbox: 'B', move: 'Med Kick', type: 'kick' },
        R: { xbox: 'RB', move: 'Heavy Kick', type: 'kick' }
      }
    }
  };

  class XboxArcadeController {
    constructor(options = {}) {
      this.layoutKey = localStorage.getItem('sf2_xbox_layout') || 'modern';
      if (!LAYOUTS[this.layoutKey]) this.layoutKey = 'modern';

      this.deadzone = parseFloat(localStorage.getItem('sf2_xbox_deadzone') || '0.32');
      if (Number.isNaN(this.deadzone) || this.deadzone < 0.1 || this.deadzone > 0.7) {
        this.deadzone = 0.32;
      }

      this.swapped = false;
      this.onStatusChange = options.onStatusChange || (() => {});
      this.onInputVisual = options.onInputVisual || (() => {});

      // Track last sent state per player (0 and 1) so we only call simulateInput on edges
      this.prevState = [this._emptyState(), this._emptyState()];
      this.assignedIndices = [null, null]; // gamepad.index for P1, P2
      this.connectedIds = ['', ''];
      this.ejsGamepadTerminated = false;
      this.audioUnlocked = false;
      this.rafId = null;

      window.addEventListener('gamepadconnected', () => this.refreshAssignments());
      window.addEventListener('gamepaddisconnected', () => this.refreshAssignments());
    }

    _emptyState() {
      return {
        UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0,
        Y: 0, X: 0, L: 0, B: 0, A: 0, R: 0,
        SELECT: 0, START: 0
      };
    }

    getLayout() {
      return LAYOUTS[this.layoutKey];
    }

    setLayout(key) {
      if (!LAYOUTS[key]) return;
      this.layoutKey = key;
      localStorage.setItem('sf2_xbox_layout', key);
      this.releaseAll();
      this.onStatusChange(this.getStatus());
    }

    setDeadzone(val) {
      const n = Math.max(0.12, Math.min(0.65, Number(val) || 0.32));
      this.deadzone = n;
      localStorage.setItem('sf2_xbox_deadzone', String(n));
    }

    swapPlayers() {
      this.swapped = !this.swapped;
      this.releaseAll();
      this.refreshAssignments();
    }

    getRawGamepads() {
      if (!navigator.getGamepads) return [];
      const list = navigator.getGamepads();
      const active = [];
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].connected) active.push(list[i]);
      }
      return active;
    }

    refreshAssignments() {
      const pads = this.getRawGamepads();
      let p1 = pads[0] || null;
      let p2 = pads[1] || null;

      if (this.swapped && p1 && p2) {
        [p1, p2] = [p2, p1];
      } else if (this.swapped && p1 && !p2) {
        // Keep single controller on P1 even if swap was toggled with 1 pad
        this.swapped = false;
      }

      const nextIndices = [p1 ? p1.index : null, p2 ? p2.index : null];
      const nextIds = [p1 ? this._cleanName(p1.id) : '', p2 ? this._cleanName(p2.id) : ''];

      const changed =
        nextIndices[0] !== this.assignedIndices[0] ||
        nextIndices[1] !== this.assignedIndices[1] ||
        nextIds[0] !== this.connectedIds[0] ||
        nextIds[1] !== this.connectedIds[1];

      if (changed) {
        this.releaseAll();
        this.assignedIndices = nextIndices;
        this.connectedIds = nextIds;
        this.onStatusChange(this.getStatus());
      }
    }

    _cleanName(raw) {
      if (!raw) return 'Xbox Controller';
      const lower = raw.toLowerCase();
      if (lower.includes('xbox')) {
        if (lower.includes('series') || lower.includes('0b12') || lower.includes('0b13')) {
          return 'Xbox Series Controller';
        }
        if (lower.includes('360')) return 'Xbox 360 Controller';
        if (lower.includes('one')) return 'Xbox One Controller';
        return 'Xbox Wireless Controller';
      }
      // Strip verbose USB vendor/product suffixes
      return raw.replace(/\s*\(.*?\)\s*/g, ' ').trim().slice(0, 32) || 'Gamepad';
    }

    getStatus() {
      return {
        layoutKey: this.layoutKey,
        layout: LAYOUTS[this.layoutKey],
        deadzone: this.deadzone,
        swapped: this.swapped,
        players: [
          {
            slot: 0,
            connected: this.assignedIndices[0] !== null,
            index: this.assignedIndices[0],
            name: this.connectedIds[0]
          },
          {
            slot: 1,
            connected: this.assignedIndices[1] !== null,
            index: this.assignedIndices[1],
            name: this.connectedIds[1]
          }
        ]
      };
    }

    rumble(playerSlot) {
      const idx = this.assignedIndices[playerSlot];
      if (idx === null || !navigator.getGamepads) return false;
      const gp = navigator.getGamepads()[idx];
      if (!gp || !gp.vibrationActuator || typeof gp.vibrationActuator.playEffect !== 'function') {
        return false;
      }
      try {
        gp.vibrationActuator.playEffect('dual-rumble', {
          startDelay: 0,
          duration: 240,
          weakMagnitude: 0.7,
          strongMagnitude: 0.55
        });
        return true;
      } catch (_) {
        return false;
      }
    }

    _takeOwnershipFromEmulatorJS() {
      if (this.ejsGamepadTerminated) return;
      if (window.EJS_emulator && window.EJS_emulator.gamepad && typeof window.EJS_emulator.gamepad.terminate === 'function') {
        window.EJS_emulator.gamepad.terminate();
        this.ejsGamepadTerminated = true;
      }
    }

    _unlockAudio() {
      if (this.audioUnlocked) return;
      if (window.EJS_emulator && window.EJS_emulator.audioContext) {
        if (window.EJS_emulator.audioContext.state === 'suspended') {
          window.EJS_emulator.audioContext.resume().catch(() => {});
        }
        this.audioUnlocked = true;
      }
    }

    _isPressed(gp, btnIdx) {
      const btn = gp.buttons[btnIdx];
      if (!btn) return false;
      if (typeof btn === 'number') return btn > 0.25;
      // Triggers (6=LT, 7=RT) are analog on Xbox controllers
      if (btnIdx === 6 || btnIdx === 7) {
        return btn.pressed || btn.value > 0.25;
      }
      return Boolean(btn.pressed || btn.value > 0.5);
    }

    _readPlayerState(gp) {
      const s = this._emptyState();
      if (!gp) return s;

      const axX = gp.axes[0] || 0;
      const axY = gp.axes[1] || 0;
      const dz = this.deadzone;

      // Combine D-Pad AND Left Analog Stick seamlessly
      s.UP    = (this._isPressed(gp, 12) || axY < -dz) ? 1 : 0;
      s.DOWN  = (this._isPressed(gp, 13) || axY >  dz) ? 1 : 0;
      s.LEFT  = (this._isPressed(gp, 14) || axX < -dz) ? 1 : 0;
      s.RIGHT = (this._isPressed(gp, 15) || axX >  dz) ? 1 : 0;

      // Prevent simultaneous opposing directions (SOCD neutral)
      if (s.LEFT && s.RIGHT) { s.LEFT = 0; s.RIGHT = 0; }
      if (s.UP && s.DOWN) { s.UP = 0; s.DOWN = 0; }

      const map = LAYOUTS[this.layoutKey].buttons;
      for (const [snesBtn, indices] of Object.entries(map)) {
        let down = 0;
        for (let i = 0; i < indices.length; i++) {
          if (this._isPressed(gp, indices[i])) {
            down = 1;
            break;
          }
        }
        s[snesBtn] = down;
      }
      return s;
    }

    _sendInput(playerSlot, snesBtn, value) {
      const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (gm && typeof gm.simulateInput === 'function') {
        try {
          gm.simulateInput(playerSlot, SNES[snesBtn], value);
        } catch (_) {}
      }
    }

    releaseAll() {
      for (let p = 0; p < 2; p++) {
        const prev = this.prevState[p];
        for (const btn of Object.keys(prev)) {
          if (prev[btn] !== 0) {
            prev[btn] = 0;
            this._sendInput(p, btn, 0);
            this.onInputVisual(p, btn, false);
          }
        }
      }
    }

    tick() {
      this._takeOwnershipFromEmulatorJS();
      this.refreshAssignments();

      const raw = navigator.getGamepads ? navigator.getGamepads() : [];
      for (let p = 0; p < 2; p++) {
        const idx = this.assignedIndices[p];
        if (idx === null) continue;
        const gp = raw[idx];
        if (!gp || !gp.connected) continue;

        const next = this._readPlayerState(gp);
        const prev = this.prevState[p];

        for (const btn of Object.keys(next)) {
          if (next[btn] !== prev[btn]) {
            if (next[btn] === 1) this._unlockAudio();
            prev[btn] = next[btn];
            this._sendInput(p, btn, next[btn]);
            this.onInputVisual(p, btn, next[btn] === 1);
          }
        }
      }

      this.rafId = requestAnimationFrame(() => this.tick());
    }

    start() {
      if (this.rafId !== null) return;
      this.refreshAssignments();
      this.onStatusChange(this.getStatus());
      this.tick();
    }

    stop() {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.releaseAll();
    }
  }

  window.SF2_SNES_INDICES = SNES;
  window.SF2_XBOX_LAYOUTS = LAYOUTS;
  window.XboxArcadeController = XboxArcadeController;
})();
