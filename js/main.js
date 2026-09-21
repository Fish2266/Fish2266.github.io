import { camera } from './camera.js';
import { Ocean } from './ocean.js';
import { Fleet } from './cards.js';
import { Fauna } from './fauna.js';

const canvas = document.getElementById('sea');
const stage  = document.getElementById('stage');
const title  = document.querySelector('.title');
const ocean  = new Ocean(canvas);
const fleet  = new Fleet(stage);
const fauna  = new Fauna(document.querySelector('main'));

if (!ocean.ok) document.body.classList.add('no-webgl');

function resize() {
  // #sea is `position: fixed; inset: 0`, so CSS already stretches it over the
  // whole viewport — including the strip iOS Safari keeps behind its toolbars.
  // Overriding that with window.innerHeight painted the sea to the *visual*
  // viewport instead, which is shorter whenever the toolbars are up, and left
  // a band of bare page gradient along the bottom. Measure the element and let
  // CSS decide how big it is.
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  camera.resize(w, h);
  camera.update();
  ocean.resize(w, h);
  fleet.resize();
}

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let clock = 8.0;
let intro = 0;

function step(dt) {
  // The sea is integrated with a clamped step so a long stall cannot teleport
  // it, but everything on a schedule -- the intro, the procession, the wildlife
  // -- runs off the real elapsed time. Clamping those made the whole page run
  // in slow motion whenever the frame rate dropped.
  const dtSea = Math.min(dt, 0.05);
  clock += dtSea;

  intro = Math.min(1, intro + dt / 1.25);
  const e = intro * intro * (3 - 2 * intro);
  title.style.opacity = e.toFixed(3);
  if (!reduced) {
    title.style.filter = e < 1 ? `blur(${((1 - e) * 8).toFixed(2)}px)` : 'none';
    title.style.transform = `translateX(-50%) translateY(${((1 - e) * 16).toFixed(2)}px)`;
  }

  camera.update();
  fleet.update(clock, dt);
  fauna.update(clock, dt);
  // Floats and breaching dolphins both disturb the same water.
  ocean.render(clock, dtSea, fleet.wakes.concat(fauna.splashes), fleet.floats, fauna.creatures);
}

let last = performance.now() / 1000;

function frame(now) {
  now /= 1000;
  const dt = Math.max(0, Math.min(now - last, 0.25));
  last = now;
  step(reduced ? 0 : dt);
  requestAnimationFrame(frame);
}

// Scrolling drives the procession: down speeds it up, up slows it and can run
// it backwards to bring back a card that has just left.
// Debug: S summons a shark, D a dolphin.
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 's') fauna.summon('shark');
  else if (k === 'd') fauna.summon('dolphin');
});

window.addEventListener('wheel', (e) => {
  fleet.nudge(Math.max(-1.2, Math.min(1.2, e.deltaY * 0.004)));
}, { passive: true });

window.addEventListener('resize', resize, { passive: true });
// iOS slides its toolbars away without firing `resize` on the window; the
// visual viewport is what actually changed, so listen there too.
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', resize, { passive: true });
}
window.addEventListener('orientationchange', resize, { passive: true });
resize();

// ?still=<seconds> renders one settled frame and stops: for screenshots and
// for anything that cannot run an animation loop.
const q = new URLSearchParams(location.search);
if (q.has('still')) {
  const raw = parseFloat(q.get('still'));
  const at = Number.isFinite(raw) ? raw : 6;
  // The floats are a physics sim now, so a still has to let them settle
  // rather than rendering them at their initial state.
  const warm = 2.0;
  ocean.forceReady();          // a still cannot wait for a later frame
  clock = at - warm;
  intro = 1;
  fleet.seek(at - warm);
  for (let i = 0; i < Math.round(warm * 60); i++) step(1 / 60);
} else {
  step(0.016);
  requestAnimationFrame(frame);
}

// Lets a frame be driven by hand when rAF is throttled (hidden preview panes,
// screenshot tooling). Harmless in normal use.
// Handles for driving the scene by hand when debugging.
window.__fauna = fauna;
window.__ocean = ocean;
window.__fleet = fleet;
window.__frame = (dt = 1 / 60, n = 1) => { for (let i = 0; i < n; i++) step(dt); };
