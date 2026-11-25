/**
 * Xbox-First Dual Controller Engine for Street Fighter II Turbo (SNES9x / EmulatorJS)
 *
 * - Automatically active from load for Xbox 360 / Xbox One / Series X|S / Standard Gamepads (1P & 2P)
 * - Bridges D-Pad AND Left Analog Stick seamlessly to SNES directions (with SOCD neutral cleaning)
 * - Built-in Xbox Quick Menu chord: hold BACK (View) + START (Menu) for 350ms, or press L3 + R3
 * - Routes D-Pad/Stick + A/B to the Quick Menu when open so zero inputs leak to the fighter
 * - Zero double-inputs: cleanly terminates EmulatorJS's built-in GamepadHandler loop
 */
(function () {
  'use strict';

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

  const LAYOUTS = {
    modern: {
      name: 'Xbox 6-Button',
      short: 'X·Y·RB Punches / A·B·RT Kicks',
      buttons: {
        Y: [2],       // X -> Light Punch
        X: [3],       // Y -> Medium Punch
        L: [5, 4],    // RB (or LB) -> Heavy Punch
        B: [0],       // A -> Light Kick
        A: [1],       // B -> Medium Kick
        R: [7, 6],    // RT (or LT) -> Heavy Kick
        SELECT: [8],  // Back / View
        START: [9]    // Start / Menu
      }
    },
    classic: {
      name: 'Classic SNES',
      short: 'X·Y·LB Punches / A·B·RB Kicks',
      buttons: {
        Y: [2],       // X -> Light Punch
        X: [3],       // Y -> Medium Punch
        L: [4, 6],    // LB (or LT) -> Heavy Punch
        B: [0],       // A -> Light Kick
        A: [1],       // B -> Medium Kick
        R: [5, 7],    // RB (or RT) -> Heavy Kick
        SELECT: [8],  // Back / View
        START: [9]    // Start / Menu
      }
    }
  };

  class XboxArcadeController {
    constructor(options = {}) {
      this.layoutKey = localStorage.getItem('sf2_xbox_layout') || 'modern';
      if (!LAYOUTS[this.layoutKey]) this.layoutKey = 'modern';

      this.deadzone = parseFloat(localStorage.getItem('sf2_xbox_deadzone') || '0.32');
      if (Number.isNaN(this.deadzone) || this.deadzone < 0.12 || this.deadzone > 0.65) {
        this.deadzone = 0.32;
      }

      this.swapped = false;
      this.menuOpen = false;
      this.splashActive = false;

      this.onStatusChange = options.onStatusChange || (() => {});
      this.onMenuToggle = options.onMenuToggle || (() => {});
      this.onMenuNav = options.onMenuNav || (() => {});
      this.onSplashConfirm = options.onSplashConfirm || (() => {});

      this.prevState = [this._emptyState(), this._emptyState()];
      this.prevMenuNav = { UP: false, DOWN: false, LEFT: false, RIGHT: false, A: false, B: false };
      this.lastNavRepeat = 0;

      // Menu chord state (Back+Start held 350ms, or L3+R3 tap)
      this.chordStartAt = 0;
      this.chordFired = false;
      this.stickChordDown = false;

      this.assignedIndices = [null, null];
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

    setMenuOpen(open) {
      const next = Boolean(open);
      if (this.menuOpen === next) return;
      this.menuOpen = next;
      if (next) this.releaseAll();
      // Sync nav edge states so opening/closing doesn't double-trigger A/B
      this.prevMenuNav = { UP: true, DOWN: true, LEFT: true, RIGHT: true, A: true, B: true };
    }

    setSplashActive(active) {
      this.splashActive = Boolean(active);
      if (this.splashActive) this.releaseAll();
    }

    getLayout() {
      return LAYOUTS[this.layoutKey];
    }

    toggleLayout() {
      this.setLayout(this.layoutKey === 'modern' ? 'classic' : 'modern');
    }

    setLayout(key) {
      if (!LAYOUTS[key]) return;
      this.layoutKey = key;
      localStorage.setItem('sf2_xbox_layout', key);
      this.releaseAll();
      this.onStatusChange(this.getStatus());
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
        this.swapped = false;
      }

      const nextIndices = [p1 ? p1.index : null, p2 ? p2.index : null];
      const nextIds = [p1 ? this._cleanName(p1.id) : '', p2 ? this._cleanName(p2.id) : ''];

      if (
        nextIndices[0] !== this.assignedIndices[0] ||
        nextIndices[1] !== this.assignedIndices[1] ||
        nextIds[0] !== this.connectedIds[0] ||
        nextIds[1] !== this.connectedIds[1]
      ) {
        this.releaseAll();
        this.assignedIndices = nextIndices;
        this.connectedIds = nextIds;
        this.onStatusChange(this.getStatus());
      }
    }

    _cleanName(raw) {
      if (!raw) return 'Xbox Controller';
      const lower = raw.toLowerCase();
      if (lower.includes('360') || lower.includes('028e')) return 'Xbox 360';
      if (lower.includes('series') || lower.includes('0b12') || lower.includes('0b13')) return 'Xbox Series';
      if (lower.includes('one') || lower.includes('02ea') || lower.includes('02fd')) return 'Xbox One';
      if (lower.includes('xbox') || lower.includes('xinput')) return 'Xbox Pad';
      return raw.replace(/\s*\(.*?\)\s*/g, ' ').trim().slice(0, 22) || 'Gamepad';
    }

    getStatus() {
      return {
        layoutKey: this.layoutKey,
        layout: LAYOUTS[this.layoutKey],
        swapped: this.swapped,
        players: [
          { slot: 0, connected: this.assignedIndices[0] !== null, name: this.connectedIds[0] },
          { slot: 1, connected: this.assignedIndices[1] !== null, name: this.connectedIds[1] }
        ]
      };
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
      if (btnIdx === 6 || btnIdx === 7) return btn.pressed || btn.value > 0.25;
      return Boolean(btn.pressed || btn.value > 0.5);
    }

    _readDirections(gp) {
      const axX = gp.axes[0] || 0;
      const axY = gp.axes[1] || 0;
      const dz = this.deadzone;
      let UP = (this._isPressed(gp, 12) || axY < -dz) ? 1 : 0;
      let DOWN = (this._isPressed(gp, 13) || axY > dz) ? 1 : 0;
      let LEFT = (this._isPressed(gp, 14) || axX < -dz) ? 1 : 0;
      let RIGHT = (this._isPressed(gp, 15) || axX > dz) ? 1 : 0;
      if (LEFT && RIGHT) { LEFT = 0; RIGHT = 0; }
      if (UP && DOWN) { UP = 0; DOWN = 0; }
      return { UP, DOWN, LEFT, RIGHT };
    }

    _readPlayerState(gp) {
      const s = this._emptyState();
      if (!gp) return s;

      const dirs = this._readDirections(gp);
      s.UP = dirs.UP; s.DOWN = dirs.DOWN; s.LEFT = dirs.LEFT; s.RIGHT = dirs.RIGHT;

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
          }
        }
      }
    }

    _checkMenuChord(gp) {
      if (!gp) return false;
      const now = performance.now();

      // Chord 1: Hold Back (8) + Start (9) for 350ms
      const backStart = this._isPressed(gp, 8) && this._isPressed(gp, 9);
      if (backStart) {
        if (!this.chordStartAt) this.chordStartAt = now;
        if (!this.chordFired && (now - this.chordStartAt) >= 350) {
          this.chordFired = true;
          this.onMenuToggle();
          return true;
        }
      } else {
        this.chordStartAt = 0;
        this.chordFired = false;
      }

      // Chord 2: Press Left Stick (10) + Right Stick (11) together
      const sticks = this._isPressed(gp, 10) && this._isPressed(gp, 11);
      if (sticks && !this.stickChordDown) {
        this.stickChordDown = true;
        this.onMenuToggle();
        return true;
      } else if (!sticks) {
        this.stickChordDown = false;
      }
      return false;
    }

    _handleMenuNavigation(gp) {
      if (!gp) return;
      const dirs = this._readDirections(gp);
      const cur = {
        UP: Boolean(dirs.UP),
        DOWN: Boolean(dirs.DOWN),
        LEFT: Boolean(dirs.LEFT),
        RIGHT: Boolean(dirs.RIGHT),
        A: this._isPressed(gp, 0) || this._isPressed(gp, 9), // A or Start
        B: this._isPressed(gp, 1) || this._isPressed(gp, 8)  // B or Back
      };

      const now = performance.now();
      for (const dir of ['UP', 'DOWN', 'LEFT', 'RIGHT']) {
        if (cur[dir] && (!this.prevMenuNav[dir] || now - this.lastNavRepeat > 190)) {
          this.onMenuNav(dir);
          this.lastNavRepeat = now;
        }
      }
      if (cur.A && !this.prevMenuNav.A) this.onMenuNav('CONFIRM');
      if (cur.B && !this.prevMenuNav.B) this.onMenuNav('BACK');
      this.prevMenuNav = cur;
    }

    tick() {
      this._takeOwnershipFromEmulatorJS();
      this.refreshAssignments();

      const raw = navigator.getGamepads ? navigator.getGamepads() : [];
      const p1Idx = this.assignedIndices[0];
      const p1Pad = p1Idx !== null ? raw[p1Idx] : null;

      // Splash screen: press A or Start on Xbox controller to jump straight into play
      if (this.splashActive) {
        if (p1Pad && (this._isPressed(p1Pad, 0) || this._isPressed(p1Pad, 9))) {
          this._unlockAudio();
          this.onSplashConfirm();
        }
        this.rafId = requestAnimationFrame(() => this.tick());
        return;
      }

      // Check Quick Menu toggle chord on P1 controller
      if (p1Pad) {
        this._checkMenuChord(p1Pad);
      }

      // If Quick Menu is open, route P1 inputs to menu instead of fighter
      if (this.menuOpen) {
        this._handleMenuNavigation(p1Pad);
        this.rafId = requestAnimationFrame(() => this.tick());
        return;
      }

      // Normal gameplay: poll both P1 and P2 at full rAF rate
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
