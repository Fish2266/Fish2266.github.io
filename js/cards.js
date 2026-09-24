import { sampleSea } from './waves.js?v=2';
import { camera } from './camera.js?v=2';

// Pixels per metre at the procession's nominal depth. Cards are authored at
// their CSS size for this value and scaled from it, so type lands near the
// size it was designed at.
const REF = 78.2;

const FLEET_DEPTH = 12.63;
const CARD_PX = 268;      // must match --card-w
const CARD_H_PX = 186;    // must match --card-h
const MIN_CARD_PX = 244;  // below this the copy stops being readable

const SPEED = 0.95;       // metres per second across the frame
const GAP_FACTOR = 1.12;  // loop length as a multiple of the on-screen span

// Each card keeps its own distance, so the procession has depth rather than
// running along a single rail.
const DEPTHS = [0.90, -2.00, 1.70, -1.10, 0.20];

// Vinyl colours, authored as sRGB and handed over in linear light because the
// shader grades everything in linear.
const HUES = {
  lagoon: [0.09, 0.66, 0.78],
  kelp:   [0.18, 0.66, 0.30],
  dusk:   [0.40, 0.42, 0.85],
  coral:  [0.95, 0.40, 0.22],
  sun:    [0.88, 0.66, 0.13],
};
const lin = (c) => c.map((v) => Math.pow(v, 2.2));

// The float each card rides in. Drawn twice: the far side sits behind the
// card, the near side in front, so the card sits *through* the ring.
// The rings are drawn by the shader now, as real geometry, so all that lives
// here is the physics and where the card sits relative to it.
export const MAJOR_R = 2.05;   // ring radius, metres
export const MINOR_R = 0.42;   // tube thickness

const GRAV = 9.81;
const SIT_DEPTH = 0.26;        // how deep the tube rides at rest
const BUOY_K = GRAV / SIT_DEPTH;
const HEAVE_DAMP = 2.3;
const ROLL_K = 30.0, ROLL_D = 3.6;
const SURGE = 3.4;             // how hard the wave face shoves a float along
const TETHER = 5.2;            // pull back toward its slot in the procession

function canSurf(aspect, height, tanHalf, reduced) {
  if (reduced) return false;   // a column is the right answer for reduced motion
  const scale = (height * 0.5) / tanHalf / FLEET_DEPTH;
  return aspect >= 1.42 && CARD_PX * (scale / REF) >= MIN_CARD_PX;
}

const wrap = (v, m) => ((v % m) + m) % m;

export class Fleet {
  constructor(root) {
    this.els = [...root.querySelectorAll('.card')];
    this.held = null;
    this.hold = this.els.map(() => 0);
    this.zNow = this.els.map(() => -1);

    // Where each card is in the loop, and how fast the loop is running. Kept
    // apart from the scene clock so hovering can stop the procession without
    // freezing the sea.
    this.march = 0;
    this.marchRate = 1;
    this.boost = 1;          // scroll wheel nudges this, then it eases home
    this.placed = false;

    // Wake sources handed to the ocean shader, so foam is drawn in the water
    // itself rather than faked with a div.
    this.wakes = [];
    // Uniform buffers for the shader's rings.
    this.floats = [];
    // One rigid body per card: heave, roll and surge are integrated rather
    // than read straight off the wave, so a float lags, overshoots and settles.
    this.body = this.els.map(() => ({ x: 0, y: 1.0, vx: 0, vy: 0, roll: 0, rollV: 0, pitch: 0, pitchV: 0, seeded: false }));

    this.faces = this.els.map((el) => el.querySelector('.face'));

    this.els.forEach((el, i) => {
      el.addEventListener('pointerenter', () => { this.held = el; });
      el.addEventListener('pointerleave', () => { if (this.held === el) this.held = null; });
      el.addEventListener('pointerdown', () => { this.pointerAt = performance.now(); });
      // Keyboard focus has to fetch the card, or a card that is off-frame can
      // never be reached at all. A click also fires focus, though -- seeking on
      // that yanked the procession out from under the pointer.
      el.addEventListener('focus', () => {
        const byPointer = performance.now() - (this.pointerAt || -1e9) < 400;
        if (!byPointer) this.bringIn(i);
        this.held = el;
      });
      el.addEventListener('blur', () => { if (this.held === el) this.held = null; });
    });

    this.resize();
  }

  resize() {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.surf = canSurf(camera.aspect, camera.height, camera.tanHalf, reduced);
    document.documentElement.classList.toggle('flow', !this.surf);

    // Clear enough for the whole ring, not just the card -- the ring is the
    // wider of the two, and a short margin popped it into frame.
    this.edge = 5.756 * camera.aspect + MAJOR_R + MINOR_R + 2.6;
    this.span = this.edge * 2;                 // entry to exit
    this.cycle = this.span * GAP_FACTOR;       // plus the gap before it returns

    // Open with the procession already underway. Deferred to here because the
    // camera has no aspect yet when the Fleet is constructed.
    if (!this.placed && this.span > 0) {
      this.march = this.span * 0.34;
      this.placed = true;
    }

    if (!this.surf) {
      for (const el of this.els) {
        el.style.removeProperty('--sc');
        el.style.removeProperty('--rot');
        el.style.removeProperty('--pit');
        el.style.zIndex = '';
        el.style.pointerEvents = '';
        el.style.opacity = '';
      }
      this.zNow = this.els.map(() => -1);
    }
  }

  // Slide the loop so card i is mid-frame.
  bringIn(i) {
    if (!this.surf) return;
    this.march = this.span * 0.5 - (i * this.cycle) / this.els.length;
  }

  // Scroll speeds the procession up, slows it, or drives it backwards. No
  // ceiling: spin it as fast as you like and it coasts back down on its own.
  nudge(delta) {
    if (!this.surf) return;
    this.boost += delta;
  }

  seek(seconds) {
    this.march = this.span * 0.34 + seconds * SPEED;
  }

  update(t, dt) {
    // Ease to a halt under the pointer, so nothing has to be chased to click.
    const target = this.held ? 0 : 1;
    this.marchRate += (target - this.marchRate) * Math.min(1, dt * 3.5);
    this.boost += (1 - this.boost) * Math.min(1, dt * 0.55);

    if (!this.surf) {
      // No rings and no wakes in the column layout, or the shader would keep
      // drawing the last frame's floats behind a static list.
      this.floats.length = 0;
      this.wakes.length = 0;
      this.els.forEach((el, i) => {
        const sea = sampleSea(i * 3.1, t * 0.6, t);
        el.style.setProperty('--bob', `${(sea.h * 4.2).toFixed(2)}px`);
      });
      return;
    }

    // Fixed sub-steps. Buoyancy and the tether are stiff springs, and stiff
    // springs on a variable timestep blow up -- which is what tore the cards
    // apart when the procession was running fast.
    const steps = Math.max(1, Math.min(12, Math.ceil(dt / 0.008)));
    const h = dt / steps;
    for (let k = 0; k < steps; k++) {
      this.march += h * this.marchRate * this.boost * SPEED;
      this.integrate(t, h);
    }
    this.compose(t, dt);
  }

  // One physics sub-step for every card.
  integrate(t, h) {
    const n = this.els.length;
    // A stiffer tether the faster the procession runs, so a float never falls
    // far enough behind its slot to need snapping back.
    const tether = TETHER * (1 + Math.abs(this.boost) * 0.9);

    for (let i = 0; i < n; i++) {
      const travelled = wrap(this.march + (i * this.cycle) / n, this.cycle);
      const x0 = -this.edge + travelled;
      const b = this.body[i];
      const calm = this.hold[i];

      if (!b.seeded) { b.x = x0; b.y = 1.0; b.seeded = true; }

      // The loop wraps from the right edge back to the left. Only a jump that
      // large can be a wrap, and the tether must never try to *drag* a float
      // back across the frame -- it has to be placed.
      if (Math.abs(b.x - x0) > this.span * 0.45) { b.x = x0; b.vx = 0; }

      // Off-stage: park it on its mark. Any correction here is invisible,
      // which is the only place a discontinuity belongs.
      if (travelled > this.span) {
        b.x = x0; b.vx = 0;
        continue;
      }

      const u = travelled / this.span;
      const z = DEPTHS[i % DEPTHS.length] - Math.cos(u * Math.PI * 2) * 1.20
              + Math.cos(t * 0.17 + i * 2.4) * 0.18;
      b.z = z;

      const sea = sampleSea(b.x, z, t);

      // Heave: buoyancy against gravity.
      const submerged = Math.max(0, Math.min(2 * MINOR_R, sea.h - (b.y - MINOR_R)));
      b.vy += (submerged * BUOY_K - GRAV) * h;
      b.vy -= b.vy * Math.min(1, HEAVE_DAMP * h);
      b.y += b.vy * h;

      // Surge along the wave face, held near its slot by the tether.
      const drive = (x0 - b.x) * tether + sea.dx * SURGE * (1 - calm);
      b.vx += drive * h;
      b.vx -= b.vx * Math.min(1, 2.6 * h);
      b.x += b.vx * h;

      // Roll and pitch chase the water's slope as sprung masses.
      const tgtRoll = -Math.atan(sea.dx);
      const tgtPitch = Math.atan(sea.dz);
      b.rollV += (tgtRoll - b.roll) * ROLL_K * h;
      b.rollV -= b.rollV * Math.min(1, ROLL_D * h);
      b.roll += b.rollV * h;
      b.pitchV += (tgtPitch - b.pitch) * ROLL_K * h;
      b.pitchV -= b.pitchV * Math.min(1, ROLL_D * h);
      b.pitch += b.pitchV * h;
    }

    // Rings are solid: if two drift together they shove apart.
    const minD = 2 * (MAJOR_R + MINOR_R);
    for (let a = 0; a < n; a++) {
      for (let c = a + 1; c < n; c++) {
        const A = this.body[a], B = this.body[c];
        const dx = B.x - A.x, dz = (B.z || 0) - (A.z || 0);
        const d = Math.hypot(dx, dz);
        if (d > 0.001 && d < minD) {
          const push = (minD - d) / d * 2.4 * h;
          A.vx -= dx * push;
          B.vx += dx * push;
        }
      }
    }
  }

  // Project everything and write the DOM, once per frame.
  compose(t, dt) {
    const n = this.els.length;
    this.wakes.length = 0;
    this.floats.length = 0;

    this.els.forEach((el, i) => {
      const want = this.held === el ? 1 : 0;
      this.hold[i] += (want - this.hold[i]) * Math.min(1, dt * 7);
      const calm = this.hold[i];

      const travelled = wrap(this.march + (i * this.cycle) / n, this.cycle);
      const b = this.body[i];

      if (travelled > this.span) {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        this.wakes.push(-this.edge, DEPTHS[i % DEPTHS.length], 0, MAJOR_R + MINOR_R);
        return;
      }
      el.style.opacity = '1';
      el.style.pointerEvents = 'auto';

      const z = b.z;

      // Two passes. The card's on-screen height is clamped for legibility, so
      // its height in metres varies -- if the foot is placed at a fixed height
      // the rim cuts a different part of the card at every distance. Measure
      // the scale first, then seat the card so its foot is always the same
      // depth inside the ring.
      const probe = camera.project({ x: b.x, y: b.y + MINOR_R + 1.0, z });
      if (!probe) { el.style.opacity = '0'; return; }
      const s = Math.max(0.82, Math.min(1.45, probe.scale / REF));
      const halfH = (CARD_H_PX * s * 0.5) / probe.scale;      // metres
      const y = b.y + MINOR_R + halfH - 0.22 + calm * 0.30;

      const p = camera.project({ x: b.x, y, z });
      if (!p) { el.style.opacity = '0'; return; }

      const rollDeg = b.roll * (180 / Math.PI) * (1 - calm * 0.55);
      const pitchDeg = b.pitch * (180 / Math.PI) * 0.5 * (1 - calm * 0.55);

      el.style.setProperty('--tx', `${p.x.toFixed(2)}px`);
      el.style.setProperty('--ty', `${p.y.toFixed(2)}px`);
      el.style.setProperty('--sc', s.toFixed(4));
      el.style.setProperty('--rot', `${rollDeg.toFixed(2)}deg`);
      el.style.setProperty('--pit', `${pitchDeg.toFixed(2)}deg`);
      el.style.setProperty('--lift', calm.toFixed(3));
      el.style.setProperty('--skew', `${(Math.tan(b.roll) * 22).toFixed(2)}px`);
      el.style.setProperty('--far', ((p.depth - 11.6) / 3.2).toFixed(3));

      this.clipToRing(this.faces[i], b, p, s, rollDeg);

      this.floats.push({
        x: b.x, y: b.y, z, majorR: MAJOR_R, minorR: MINOR_R,
        roll: b.roll * (1 - calm * 0.5), pitch: b.pitch * (1 - calm * 0.5),
        col: lin(HUES[el.dataset.hue] || HUES.lagoon), i,
      });

      const zi = 1000 - Math.round(p.depth * 4);
      if (zi !== this.zNow[i]) { el.style.zIndex = String(zi); this.zNow[i] = zi; }

      const near = Math.min(travelled, this.span - travelled);
      const speed = Math.min(2.2, Math.abs(b.vx) / 0.9);
      const w = Math.max(0, Math.min(1, near / 3.2)) * (0.35 + 0.75 * speed) * (1 - calm * 0.45);
      this.wakes.push(b.x, z, w, MAJOR_R + MINOR_R);
    });
  }

  // The ring is drawn by the shader, so it cannot paint over a DOM card.
  // Instead the card is cut along the top of the tube's near rim, which puts
  // its foot genuinely inside the float.
  //
  // The cut goes on .face, not on .card. A clip-path establishes a backdrop
  // root, so clipping the card silently disabled the frosted-glass
  // backdrop-filter on the panel inside it -- the cards went see-through.
  // Clipping the panel itself keeps the frost and still makes the cut.
  clipToRing(el, b, p, s, rollDeg) {
    const rr = -rollDeg * Math.PI / 180;
    const ca = Math.cos(rr), sa = Math.sin(rr);
    const cr = Math.cos(b.roll), sr = Math.sin(b.roll);
    const cp = Math.cos(b.pitch), sp = Math.sin(b.pitch);
    const tx = p.x, ty = p.y;

    const N = 16;
    const pts = [];
    let lowest = 1e9;

    for (let k = 0; k <= N; k++) {
      // The near half of the ring, right to left, along the top of the tube.
      const th = (k / N) * Math.PI;
      const lx = MAJOR_R * Math.cos(th), ly = MINOR_R, lz = MAJOR_R * Math.sin(th);
      // Forward rotation: roll about Z, then pitch about X.
      const px1 = lx, py1 = ly * cp - lz * sp, pz1 = ly * sp + lz * cp;
      const wx = px1 * cr - py1 * sr, wy = px1 * sr + py1 * cr, wz = pz1;

      const q = camera.project({ x: b.x + wx, y: b.y + wy, z: b.z + wz });
      if (!q) return;

      // Undo the card's own transform to get its untransformed box coords.
      const dx = (q.x - tx) / s, dy = (q.y - ty) / s;
      const bx = dx * ca - dy * sa + CARD_PX / 2;
      const by = dx * sa + dy * ca + CARD_H_PX / 2;
      lowest = Math.min(lowest, by);
      pts.push([(bx / CARD_PX) * 100, (by / CARD_H_PX) * 100]);
    }

    // Rim entirely below the card: nothing to cut.
    if (lowest > CARD_H_PX + 4) {
      if (el.style.clipPath) el.style.clipPath = '';
      return;
    }

    const f = (v) => Math.max(-40, Math.min(140, v)).toFixed(2);
    const arc = pts.map(([x, y]) => `${f(x)}% ${f(y)}%`).join(', ');
    el.style.clipPath = `polygon(-40% -40%, 140% -40%, 140% ${f(pts[0][1])}%, ${arc}, -40% ${f(pts[N][1])}%)`;
  }
}
