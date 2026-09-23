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
  //
  // On a phone the canvas also runs --overscan px past the top and bottom of the
  // screen, so the scene carries on behind the Dynamic Island and the toolbar
  // instead of stopping at the layout viewport. The camera is framed on the
  // visible part only; the ocean is told how much taller the canvas is.
  const r = canvas.getBoundingClientRect();
  const over = parseFloat(getComputedStyle(canvas).getPropertyValue('--overscan')) || 0;
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  const visible = Math.max(1, h - 2 * over);
  camera.resize(w, visible);
  camera.update();
  ocean.overscanK = h / visible;
  ocean.resize(w, h);
  fleet.resize();
}

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let clock = 8.0;
let intro = 0;
// Nothing on screen moves until the sea has drawn once: before that the canvas
// is empty, and fading the title in over it wasted the intro on a blank page.
let live = false;

function step(dt) {
  // The sea is integrated with a clamped step so a long stall cannot teleport
  // it, but everything on a schedule -- the intro, the procession, the wildlife
  // -- runs off the real elapsed time. Clamping those made the whole page run
  // in slow motion whenever the frame rate dropped.
  const dtSea = Math.min(dt, 0.05);
  clock += dtSea;

  camera.update();
  fleet.update(clock, dt);
  fauna.update(clock, dt);
  // Floats and breaching dolphins both disturb the same water.
  const drew = ocean.render(clock, dtSea, [fleet.wakes, fauna.splashes], fleet.floats, fauna.creatures);
  if (!live && (drew || !ocean.ok)) {
    live = true;
    // The canvas fades up over the CSS sea once it has a frame to show.
    if (drew) canvas.classList.add('live');
    else document.body.classList.add('no-webgl');    // the shader failed to build
  }

  // Reduced motion skips the fade rather than freezing it: the loop runs with
  // dt = 0 there, so the title used to stay at opacity 0 for good.
  if (intro < 1 && live) {
    intro = reduced ? 1 : Math.min(1, intro + dt / 1.25);
    const e = intro * intro * (3 - 2 * intro);
    title.style.opacity = e.toFixed(3);
    if (!reduced) {
      title.style.filter = e < 1 ? `blur(${((1 - e) * 8).toFixed(2)}px)` : 'none';
      title.style.transform = `translateX(-50%) translateY(${((1 - e) * 16).toFixed(2)}px)`;
    }
  }
  return drew;
}

let last = performance.now() / 1000;
let pending = false;
// Reduced motion draws one still frame and then only redraws when something
// changes it. It used to re-render the identical picture at full frame rate.
let dirty = true;
// ?still= (below) draws by hand and must never start the loop.
let still = false;

// On 120Hz and faster screens, rAF fires more often than the sea needs:
// every frame of this shader is real GPU work, and doubling it bought nothing
// you could see but a hot laptop and a flat battery. Frames closer together
// than this are skipped, which halves 120/144Hz but leaves 60, 90 and 100Hz
// untouched.
const MIN_GAP = 0.0095;

function frame(now) {
  pending = false;
  now /= 1000;
  if (now - last < MIN_GAP) { kick(); return; }
  const dt = Math.max(0, Math.min(now - last, 0.25));
  last = now;
  ocean.stamp = now * 1000;
  if (reduced) {
    if (step(0) || !ocean.ok) dirty = false;
    if (dirty) kick();
    return;
  }
  step(dt);
  kick();
}

function kick() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(frame);
}

function redraw() {
  // Resizing clears the canvas, so a still redraws its frame on the spot.
  if (still) { step(0); return; }
  dirty = true;
  kick();
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

function onResize() {
  resize();
  redraw();
}

window.addEventListener('resize', onResize, { passive: true });
// iOS slides its toolbars away without firing `resize` on the window; the
// visual viewport is what actually changed, so listen there too.
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', onResize, { passive: true });
}
window.addEventListener('orientationchange', onResize, { passive: true });
// A restored WebGL context comes back blank.
canvas.addEventListener('webglcontextrestored', redraw);
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
  still = true;
  ocean.adapt = false;
  ocean.setScale(ocean.maxScale);   // a still is for looking at: full resolution
  ocean.forceReady();          // a still cannot wait for a later frame
  clock = at - warm;
  intro = 1;
  live = true;
  title.style.opacity = '1';
  title.style.filter = 'none';
  title.style.transform = 'translateX(-50%)';
  canvas.classList.add('live');
  fleet.seek(at - warm);
  for (let i = 0; i < Math.round(warm * 60); i++) step(1 / 60);
} else {
  step(0.016);
  kick();
}

// Lets a frame be driven by hand when rAF is throttled (hidden preview panes,
// screenshot tooling). Harmless in normal use.
// Handles for driving the scene by hand when debugging.
window.__fauna = fauna;
window.__ocean = ocean;
window.__fleet = fleet;
window.__frame = (dt = 1 / 60, n = 1) => { for (let i = 0; i < n; i++) step(dt); };
