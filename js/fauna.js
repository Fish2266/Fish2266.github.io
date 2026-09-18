import { sampleSea } from './waves.js';
import { camera } from './camera.js';

// Everything alive in the scene. All of it is world-positioned and projected
// through the same camera as the sea and the floats, so one perspective and one
// depth order covers gulls, fins and cards alike.

const rand = (a, b) => a + Math.random() * (b - a);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const GRAV = 9.81;

// Depth ordering shared with cards.js, so a fin at 20 m sorts behind a float
// at 12 m instead of always painting on top of it.
const depthZ = (d) => 1000 - Math.round(d * 4);

// How much a thing at this distance washes out into the haze. The sea uses
// exp(-dist * 0.0026); sprites follow the same curve so they sit in the air
// rather than on the glass.
const haze = (d) => clamp01(1 - Math.exp(-d * 0.0042));

const GULL = `<svg viewBox="-30 -16 60 32" aria-hidden="true">
  <path class="wing wing-l" d="M0 -1 C -6 -8, -15 -11, -27 -7 C -18 -4, -8 0, -1 3 Z"/>
  <path class="wing wing-r" d="M0 -1 C 6 -8, 15 -11, 27 -7 C 18 -4, 8 0, 1 3 Z"/>
  <path class="body" d="M-5 1 C -2 -2, 3 -3, 7 -1 C 4 2, -1 3, -5 1 Z"/>
</svg>`;

class Sprite {
  constructor(layer, html, cls) {
    this.el = document.createElement('div');
    this.el.className = `sprite ${cls}`;
    this.el.innerHTML = html;
    this.inner = this.el.firstElementChild;
    this.el.style.opacity = '0';
    layer.appendChild(this.el);
  }

  // sink: metres the sprite has dropped below the surface. Rather than fading,
  // the sprite slides down inside a box clipped at the waterline, so it goes
  // *under* the water the way a real fin does.
  place(world, sizeM, spin = '', sink = 0) {
    const p = camera.project(world);
    if (!p) { this.hide(); return null; }
    const px = sizeM * p.scale;
    const sinkPx = sink * p.scale;

    this.el.style.width = `${px.toFixed(1)}px`;
    this.el.style.height = `${px.toFixed(1)}px`;
    this.el.style.transform =
      `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) translate(-50%, -50%) ${spin}`;
    this.el.style.zIndex = String(depthZ(p.depth));
    this.el.style.setProperty('--haze', haze(p.depth).toFixed(3));
    if (this.inner) this.inner.style.transform = `translateY(${sinkPx.toFixed(1)}px)`;
    this.el.style.opacity = '1';
    return p;
  }

  hide() { this.el.style.opacity = '0'; }
}

// A gull working the updraught: long shallow arcs, an occasional burst of flaps.
class Gull {
  constructor(layer) {
    this.s = new Sprite(layer, GULL, 'gull');
    this.reset(true);
  }
  reset(first = false) {
    this.dir = Math.random() < 0.5 ? 1 : -1;
    this.x = this.dir > 0 ? rand(-120, -85) : rand(85, 120);
    if (first) this.x = rand(-60, 60);
    this.z = rand(-110, -26);
    this.y = rand(6.5, 22);
    this.speed = rand(2.4, 4.4);
    this.phase = Math.random() * 10;
    this.glide = rand(2.8, 6.5);
    this.size = rand(1.7, 2.6);
  }
  update(t, dt) {
    this.x += this.dir * this.speed * dt;
    this.y += Math.sin(t * 0.4 + this.phase) * 0.55 * dt;
    if (this.x > 126 || this.x < -126) { this.reset(); return; }

    const cycle = (t * 0.55 + this.phase) % (this.glide + 1.5);
    const flapping = cycle > this.glide;
    const beat = flapping
      ? Math.sin((cycle - this.glide) * 12.5)
      : Math.sin(t * 0.6 + this.phase) * 0.14;
    this.s.el.style.setProperty('--flap', `${(beat * 30).toFixed(1)}deg`);
    // Banking into the glide.
    const bank = Math.sin(t * 0.3 + this.phase) * 7;

    this.s.place({ x: this.x, y: this.y, z: this.z }, this.size,
      `rotate(${bank.toFixed(1)}deg) scaleX(${this.dir > 0 ? 1 : -1})`);
  }
}

// Critically damped spring, integrated implicitly so it is stable at any frame
// time. Every channel of the shark's motion goes through one of these: nothing
// is read straight off the water, so nothing can snap.
function spring(st, target, omega, dt) {
  const f = 1 + 2 * dt * omega, hoo = dt * omega * omega, hhoo = dt * hoo;
  const inv = 1 / (f + hhoo);
  const x = (f * st.x + dt * st.v + hhoo * target) * inv;
  st.v = (st.v + hoo * (target - st.x)) * inv;
  st.x = x;
}
const smooth01 = (v) => { const c = clamp01(v); return c * c * (3 - 2 * c); };

// A shark cruising the surface. It is geometry in the shader, so the water
// hides whatever is under it without any clipping on our side.
class Shark {
  constructor() { this.active = false; }

  // x/dir/z may be given to place it deliberately (the debug summon does).
  start(opts = {}) {
    this.active = true;
    this.t = 0;
    this.dir = opts.dir ?? (Math.random() < 0.5 ? 1 : -1);
    this.z = opts.z ?? rand(-19, -8);
    this.exitX = 36;
    this.x = opts.x ?? (this.dir > 0 ? -32 : 32);
    this.speed = rand(1.6, 2.3);
    this.len = rand(1.5, 1.9);
    this.phase = Math.random() * 10;
    this.depth = { x: opts.startDepth ?? 3.2, v: 0 };   // metres below the surface it is riding
    this.enterSecs = opts.enterSecs ?? 3.0;
    this.surf = { x: 0, v: 0 };        // that surface, heavily low-passed
    this.pitch = { x: 0, v: 0 };
    this.roll = { x: 0, v: 0 };
    this.diveClock = rand(6, 11);
    this.diveLeft = 0;
    this.body = null;
    this.wake = null;
  }

  update(t, dt) {
    if (!this.active) return;
    this.t += dt;

    // Tail beats give a slight surge rather than a perfectly constant glide.
    const beat = Math.sin(this.t * 2.4 + this.phase);
    this.x += this.dir * this.speed * (1 + 0.05 * beat) * dt;
    if (Math.abs(this.x) > this.exitX) { this.active = false; this.body = null; this.wake = null; return; }

    // Cruise with the dorsal out; now and then slide under for a few seconds.
    this.diveClock -= dt;
    if (this.diveClock <= 0 && this.diveLeft <= 0) { this.diveLeft = rand(3, 5); this.diveClock = rand(8, 14); }
    if (this.diveLeft > 0) this.diveLeft -= dt;

    // Rise in after spawning and sink away before leaving, so it never blinks.
    const enter = 1 - smooth01(this.t / this.enterSecs);
    const leave = smooth01((Math.abs(this.x) - (this.exitX - 8)) / 8);
    const target = 0.16 + (this.diveLeft > 0 ? 1.4 : 0) + Math.max(enter, leave) * 3.0;
    spring(this.depth, target, 1.4, dt);

    // Only the long swell moves it, and only while it is near the surface.
    // Pinning it to the instantaneous wave height made it bob like a cork.
    const sea = sampleSea(this.x, this.z, t);
    const ride = Math.max(0, 1 - this.depth.x / 1.2) * 0.5;
    spring(this.surf, sea.h * ride, 1.5, dt);

    const y = this.surf.x - this.depth.x;
    const vy = this.surf.v - this.depth.v;

    // The nose follows the path it is actually taking.
    const tgtPitch = Math.atan2(vy, this.speed) * 0.5 + sea.dx * this.dir * 0.06 * ride;
    spring(this.pitch, tgtPitch, 2.2, dt);
    spring(this.roll, sea.dz * 0.10 * ride + Math.sin(this.t * 0.5 + this.phase) * 0.03, 1.8, dt);

    const wag = beat * 0.035;
    this.body = {
      x: this.x, y, z: this.z, len: this.len,
      yaw: (this.dir > 0 ? 0 : Math.PI) + wag,
      pitch: this.pitch.x, roll: this.roll.x,
      type: 1,
    };
    this.wake = this.depth.x < 0.5 ? [this.x, this.z, (1 - this.depth.x / 0.5) * 0.8, 1.2] : null;
  }
}

// A breach, on a real ballistic arc. The old version faked the jump with a
// parabola in normalised time and clipped the sprite at the waterline, which
// is why it looked wrong coming out and going back in.
class Dolphin {
  constructor() { this.active = false; }
  // dir / z / centre (x of the apex) may be given to place it deliberately.
  start(opts = {}) {
    this.active = true;
    this.dir = opts.dir ?? (Math.random() < 0.5 ? 1 : -1);
    this.z = opts.z ?? rand(-16, -7);
    this.len = rand(1.1, 1.4);
    this.apex = rand(1.5, 2.6);                 // metres of air above the surface
    // Start and finish well under, so it rises out of invisibility and dives
    // back into it rather than blinking into existence at the surface.
    this.launchY = -3.4;
    this.vy = Math.sqrt(2 * GRAV * (this.apex - this.launchY));
    this.vx = this.dir * rand(4.0, 6.5);
    this.t = 0;
    this.life = 2 * this.vy / GRAV;             // back down to the launch depth
    // Launch far enough back that the apex lands where asked, mid-frame by default.
    this.x = -this.vx * this.life * 0.5 + (opts.centre ?? rand(-3, 3));
    this.h = undefined;
  }
  update(t, dt) {
    if (!this.active) return;
    this.t += dt;
    if (this.t > this.life) { this.active = false; this.body = null; return; }

    const x = this.x + this.vx * this.t;
    const sea = sampleSea(x, this.z, t);
    // Height above the local surface, ballistic.
    const h = this.launchY + this.vy * this.t - 0.5 * GRAV * this.t * this.t;
    this.h = h;                                  // height above the local surface
    const y = sea.h + h;

    // The nose follows the velocity vector, which is what a real breach does.
    const vyNow = this.vy - GRAV * this.t;
    const pitch = Math.atan2(vyNow, Math.abs(this.vx));

    this.body = {
      x, y, z: this.z, len: this.len,
      yaw: this.dir > 0 ? 0 : Math.PI,
      pitch,
      roll: Math.sin(this.t * 2.2) * 0.18,
      type: 0,
    };

    this.surfaceX = x;
  }
}

// The shader has room for this many animals at once. Beyond it, the ones
// nearest the camera are drawn; nothing is removed from the simulation.
const MAX_DRAWN = 24;
// Foam sources the wildlife may use. The floats' wakes go first in the same
// shader budget of 32, so they always keep theirs.
const MAX_FOAM = 24;
const CAM = { x: 0, y: 5.2, z: 12 };

export class Fauna {
  constructor(parent) {
    const layer = document.createElement('div');
    layer.id = 'fauna';
    layer.setAttribute('aria-hidden', 'true');
    (parent || document.body).appendChild(layer);

    this.gulls = Array.from({ length: 5 }, () => new Gull(layer));
    // Pools: every summon adds an animal, and each one leaves on its own when
    // its pass is over.
    this.sharks = [];
    this.dolphins = [];
    this.next = 10;
    this.splashes = [];
    this.creatures = [];
    // Surface impacts, each expanding and fading on its own clock.
    this.rings = [];
  }

  spawnShark(opts) { const a = new Shark(); a.start(opts); this.sharks.push(a); return a; }
  spawnDolphin(opts) { const a = new Dolphin(); a.start(opts); this.dolphins.push(a); return a; }

  // Debug: add one more, without touching any that are already out there.
  // Placement is spread out so a burst of presses doesn't stack them in one spot.
  summon(kind) {
    if (kind === 'shark') {
      const dir = Math.random() < 0.5 ? 1 : -1;
      this.spawnShark({ dir, x: (dir > 0 ? -17 : 17) - dir * rand(0, 4),
                        z: rand(-15, -6), startDepth: 1.4, enterSecs: 1.2 });
    } else if (kind === 'dolphin') {
      this.spawnDolphin({ centre: rand(-8, 8), z: rand(-17, -6) });
    }
  }

  update(t, dt) {
    for (const g of this.gulls) g.update(t, dt);
    for (const a of this.sharks) a.update(t, dt);

    for (const d of this.dolphins) {
      const before = d.h;
      d.update(t, dt);
      // A splash is thrown the moment this dolphin crosses the surface, once on
      // the way out and once on the way back in. Going in throws more water.
      if (d.active && before !== undefined && d.h !== undefined && (before < 0) !== (d.h < 0)) {
        this.rings.push({ x: d.surfaceX, z: d.z, t0: t, power: d.h < 0 ? 1.35 : 0.95 });
      }
    }

    this.sharks = this.sharks.filter((a) => a.active);
    this.dolphins = this.dolphins.filter((a) => a.active);

    // The ambient schedule only fills an empty sea; it never piles on.
    this.next -= dt;
    if (this.next <= 0 && this.sharks.length === 0 && this.dolphins.length === 0) {
      if (Math.random() < 0.35) { this.spawnShark(); this.next = rand(40, 75); }
      else { this.spawnDolphin(); this.next = rand(16, 32); }
    }

    // Bodies for the shader, nearest first if there are more than it can take.
    // Anything deep enough to be invisible yields its slot.
    const bodies = [];
    for (const a of this.sharks) if (a.body) bodies.push(a.body);
    for (const a of this.dolphins) if (a.body) bodies.push(a.body);
    if (bodies.length > MAX_DRAWN) {
      const key = (b) => Math.hypot(b.x - CAM.x, b.y - CAM.y, b.z - CAM.z) + (b.y < -2.5 ? 1e3 : 0);
      bodies.sort((a, b) => key(a) - key(b));
      bodies.length = MAX_DRAWN;
    }
    this.creatures.length = 0;
    this.creatures.push(...bodies);

    // Foam. Expired rings are pruned first -- all of them, not just the ones
    // that happened to fit in the budget.
    const LIFE = 2.2;
    this.rings = this.rings.filter((e) => t - e.t0 >= 0 && t - e.t0 < LIFE);
    this.splashes.length = 0;
    const room = () => this.splashes.length < MAX_FOAM * 4;
    for (const a of this.sharks) if (a.wake && room()) this.splashes.push(...a.wake);
    // Newest splashes first: they are the biggest and brightest.
    for (let i = this.rings.length - 1; i >= 0 && room(); i--) {
      const e = this.rings[i];
      const k = (t - e.t0) / LIFE;
      const radius = 0.55 + k * 3.4;
      const strength = Math.pow(1 - k, 1.4) * (0.30 + 0.70 * Math.pow(1 - k, 3)) * e.power * 3.0;
      // Negative radius flags this as an impact splash for the shader.
      this.splashes.push(e.x, e.z, strength, -radius);
    }
  }
}
