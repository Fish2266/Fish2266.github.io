// The sea, defined once.
//
// Height is a sum of sharpened, phase-offset sinusoids:
//
//   h(p) = SUM  A * ( exp( s * (sin(k·d·p + wt + phi) - 1) ) - mean(s) )
//
// exp(sin(x)-1) sharpened by s gives the pointed crests and long flat troughs
// real swell has, and its derivative is the same term times s·cos(x), so
// surface normals are exact rather than sampled -- the raymarcher and the
// floating cards read the identical surface.
//
// The component list is a directional spectrum, not a handful of tidy waves:
// amplitude falls off either side of a peak wavelength, headings fan out
// (short waves spread much wider than long swell), and every component gets a
// random starting phase. Without that last part a small number of coherent
// sinusoids sums to a regular interference lattice that reads as woven fabric.

export const G = 9.81;
export const TIME_SCALE = 0.55;

const PEAK_L = 38.0;      // dominant wavelength, metres
const LONG_L = 56.0;
const SHORT_L = 0.62;
const DOM_DEG = 4.0;      // swell heading: 0 runs straight at the beach
const TOTAL_N = 26;
const SWELL_N = 8;        // the long end: drives the silhouette and the cards
export const TRACE_N = 6; // what the raymarcher walks: macro shape only

// Deterministic, so the JS sea and the baked GLSL sea are the same sea.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mean of exp(s*(sin x - 1)) over a full period == exp(-s)*I0(s).
function besselI0(x) {
  let sum = 1, term = 1;
  for (let m = 1; m < 24; m++) {
    term *= (x * x) / (4 * m * m);
    sum += term;
    if (term < 1e-12) break;
  }
  return sum;
}

function build() {
  const rnd = mulberry32(0x5EA0FF);
  const out = [];

  for (let i = 0; i < TOTAL_N; i++) {
    const u = i / (TOTAL_N - 1);
    const L = LONG_L * Math.pow(SHORT_L / LONG_L, u);   // log-spaced wavelengths
    const x = L / PEAK_L;

    // Amplitude envelope: climbs to the peak, falls away beyond it.
    let amp = Math.pow(x, 1.15) * Math.exp(-1.15 * Math.pow(x, 2.6));
    amp *= 0.72 + rnd() * 0.56;

    // Short waves fan out more widely than long swell, but a cos^2s-style
    // peaked draw keeps most of the energy within ~20 degrees of the wind
    // instead of spraying it into a near-orthogonal second wave train.
    const spread = 12 + 46 * Math.pow(1 - Math.min(1, x), 1.5);
    const r = rnd();
    const heading = DOM_DEG + spread * Math.sign(r - 0.5) * Math.pow(Math.abs(2 * r - 1), 1.8);

    // Long swell carries the sharp crests; chop stays rounded.
    const sharp = 1.0 + 2.10 * Math.min(1, L / 30);

    out.push({ L, amp, heading, sharp, phase: rnd() * Math.PI * 2 });
  }

  // Normalise so the significant wave height stays where the camera expects it.
  const total = out.reduce((s, w) => s + w.amp, 0);
  const scale = 3.55 / total;
  for (const w of out) w.amp *= scale;

  return out.map((w) => {
    const a = (w.heading * Math.PI) / 180;
    const k = (2 * Math.PI) / w.L;
    return {
      dx: Math.sin(a),
      dz: Math.cos(a),
      k,
      amp: w.amp,
      w: Math.sqrt(G * k) * TIME_SCALE,       // deep-water dispersion
      phase: w.phase,
      sharp: w.sharp,
      mean: Math.exp(-w.sharp) * besselI0(w.sharp),
    };
  });
}

const ALL = build();
export const SWELL_WAVES = ALL.slice(0, SWELL_N);
export const DETAIL_WAVES = ALL.slice(SWELL_N);

const meanOf = (list) => list.reduce((s, w) => s + w.amp * w.mean, 0);
const SWELL_MEAN = meanOf(SWELL_WAVES);
const DETAIL_MEAN = meanOf(DETAIL_WAVES);
// The raymarcher walks a subset, so it needs that subset's own mean. Using the
// full one shades crests with the trough's normal.
const TRACE_MEAN = meanOf(SWELL_WAVES.slice(0, TRACE_N));

// Amplitude-weighted mean heading: which way the sea is actually running.
// Foam is advected along it rather than sampled backwards in time.
const domX = SWELL_WAVES.reduce((s, w) => s + w.amp * w.dx, 0);
const domZ = SWELL_WAVES.reduce((s, w) => s + w.amp * w.dz, 0);
const domLen = Math.hypot(domX, domZ) || 1;

// Height and the two horizontal slopes, in one pass. Swell only: the cards are
// far too big to notice the chop.
export function sampleSea(x, z, t) {
  let h = -SWELL_MEAN, dx = 0, dz = 0;
  for (const s of SWELL_WAVES) {
    const phase = s.k * (s.dx * x + s.dz * z) + s.w * t + s.phase;
    const v = s.amp * Math.exp(s.sharp * (Math.sin(phase) - 1));
    const g = v * s.sharp * Math.cos(phase) * s.k;
    h += v;
    dx += g * s.dx;
    dz += g * s.dz;
  }
  return { h, dx, dz };
}

// The same components, emitted as GLSL, so there is exactly one sea.
function glslArrays(name, list, mean) {
  const f = (n) => n.toFixed(6);
  const A = list.map((s) => `  vec4(${f(s.dx)}, ${f(s.dz)}, ${f(s.k)}, ${f(s.amp)})`).join(',\n');
  const B = list.map((s) => `  vec4(${f(s.w)}, ${f(s.phase)}, ${f(s.sharp)}, 0.0)`).join(',\n');
  const n = list.length;
  return `const int ${name}_N = ${n};\n` +
         `const vec4 ${name}_A[${n}] = vec4[${n}](\n${A}\n);\n` +
         `const vec4 ${name}_B[${n}] = vec4[${n}](\n${B}\n);\n` +
         `const float ${name}_MEAN = ${mean.toFixed(6)};\n`;
}

export const SEA_GLSL =
  glslArrays('SWELL', SWELL_WAVES, SWELL_MEAN) +
  glslArrays('DETAIL', DETAIL_WAVES, DETAIL_MEAN) +
  `const int TRACE_N = ${TRACE_N};\n` +
  `const float TRACE_MEAN = ${TRACE_MEAN.toFixed(6)};\n` +

  `const vec2 DOM_DIR = vec2(${(domX / domLen).toFixed(6)}, ${(domZ / domLen).toFixed(6)});\n`;
