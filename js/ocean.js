import { SEA_GLSL } from './waves.js?v=2';
import { camera } from './camera.js?v=2';
import { CREATURE_GLSL } from './creatures.data.js?v=2';

const VERT = `#version 300 es
void main() {
  // One oversized triangle covering the viewport.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform vec3  uCamPos, uCamFwd, uCamRight, uCamUp;
uniform float uTanHalf, uAspect;
uniform vec3  uSunDir;
uniform float uDetail;

// Where the floats are sitting, handed over each frame: xy is the world
// position, z how strongly it is disturbing the water, w its radius.
#define MAX_WAKE 32
uniform vec4 uWake[MAX_WAKE];
uniform int  uWakeN;
// World-space xz box (min.xy, max.zw) outside which no entry in uWake can
// touch the water. Most of the sea is outside it and skips the loop.
uniform vec4 uWakeBox;

// The floats, as real geometry in the scene rather than pictures over it.
// A: xyz centre of the ring, w major radius.
// B: x roll, y pitch, z minor radius, w 0 when the slot is unused.
// C: the vinyl colour.
#define MAX_FLOATS 8
uniform vec4 uFloatA[MAX_FLOATS];
uniform vec4 uFloatB[MAX_FLOATS];
uniform vec3 uFloatC[MAX_FLOATS];
// cos/sin of each ring's roll and pitch, worked out once per frame on the CPU
// rather than four times per distance evaluation in the march.
uniform vec4 uFloatR[MAX_FLOATS];
uniform int  uFloatN;

// Sea life, as geometry too. A: xyz position, w length in metres.
// B: x yaw, y pitch, z roll, w type (0 dolphin, 1 shark).
// Rings use candidate bits 0-7 and creatures bits 8-31 of a uint mask, so 24
// is the ceiling here.
#define MAX_CREAT 24
uniform vec4 uCreatA[MAX_CREAT];
uniform vec4 uCreatB[MAX_CREAT];
uniform int  uCreatN;

${SEA_GLSL}
${CREATURE_GLSL}

const float SHORE_Z = -70.0;    // the water's edge
const float SHELF   = 58.0;     // width of the shallow shelf in front of it
const float PI      = 3.14159265;

// Everything below works in linear light. Palette constants are written the way
// they should look on screen, and S() lifts them into linear on the way in.
vec3 S(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }

// ---------------------------------------------------------------- sea surface

// Macro shape only: what the raymarcher walks.
float traceHeight(vec2 p, float t) {
  float h = 0.0;
  for (int i = 0; i < TRACE_N; i++) {
    vec4 a = SWELL_A[i], b = SWELL_B[i];
    float ph = a.z * dot(a.xy, p) + b.x * t + b.y;
    h += a.w * exp(b.z * (sin(ph) - 1.0));
  }
  return h - TRACE_MEAN;
}

float seaHeightAt(vec2 p, float t) {
  float h = -SWELL_MEAN;
  for (int i = 0; i < SWELL_N; i++) {
    vec4 a = SWELL_A[i], b = SWELL_B[i];
    h += a.w * exp(b.z * (sin(a.z * dot(a.xy, p) + b.x * t + b.y) - 1.0));
  }
  return h;
}

// (height, d/dx, d/dz) -- analytic, so normals are exact.
vec3 seaField(vec2 p, float t, float det) {
  float h = -SWELL_MEAN;
  vec2  g = vec2(0.0);
  for (int i = 0; i < SWELL_N; i++) {
    vec4 a = SWELL_A[i], b = SWELL_B[i];
    float ph = a.z * dot(a.xy, p) + b.x * t + b.y;
    float v  = a.w * exp(b.z * (sin(ph) - 1.0));
    h += v;
    g += v * b.z * cos(ph) * a.z * a.xy;
  }
  if (det > 0.002) {
    h -= DETAIL_MEAN * det;
    for (int i = 0; i < DETAIL_N; i++) {
      vec4 a = DETAIL_A[i], b = DETAIL_B[i];
      float ph = a.z * dot(a.xy, p) + b.x * t + b.y;
      float v  = a.w * det * exp(b.z * (sin(ph) - 1.0));
      h += v;
      g += v * b.z * cos(ph) * a.z * a.xy;
    }
  }
  return vec3(h, g);
}

// Cheap swell-only slope, for sampling the surface back in time so foam can
// trail behind a crest instead of blinking on and off with it.
float swellSlope(vec2 p, float t) {
  vec2 g = vec2(0.0);
  for (int i = 0; i < TRACE_N; i++) {
    vec4 a = SWELL_A[i], b = SWELL_B[i];
    float ph = a.z * dot(a.xy, p) + b.x * t + b.y;
    float v  = a.w * exp(b.z * (sin(ph) - 1.0));
    g += v * b.z * cos(ph) * a.z * a.xy;
  }
  return length(g);
}

// ---------------------------------------------------------------------- noise

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}

float fbm(vec2 p, int oct) {
  float a = 0.5, s = 0.0;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    p = rot * p * 2.03;
    a *= 0.5;
  }
  return s;
}

// ------------------------------------------------------------------------ sky

vec3 skyColor(vec3 rd) {
  float up = max(rd.y, 0.0);

  vec3 zenith  = S(0.068, 0.258, 0.665);
  vec3 mid     = S(0.270, 0.520, 0.815);
  vec3 horizon = S(0.430, 0.615, 0.800);

  vec3 c = mix(mid, zenith, pow(up, 0.85));
  c = mix(horizon, c, pow(smoothstep(0.0, 0.155, up), 0.80));

  // Late afternoon: the whole half of the sky the sun is in runs warm, not just
  // a halo around the disc.
  float azWarm = dot(normalize(vec3(rd.x, 0.0, rd.z) + 1e-5),
                     normalize(vec3(uSunDir.x, 0.0, uSunDir.z))) * 0.5 + 0.5;
  c = mix(c, c * vec3(1.24, 1.04, 0.86), pow(azWarm, 2.2) * 0.26 * (1.0 - up * 0.55));
  c = mix(c, c * vec3(1.16, 1.02, 0.90), (1.0 - smoothstep(0.0, 0.22, up)) * 0.30);

  float sd = max(dot(rd, uSunDir), 0.0);
  c += vec3(1.00, 0.74, 0.40) * pow(sd, 900.0) * 1.20;
  c += vec3(0.98, 0.68, 0.36) * pow(sd, 150.0) * 0.60;
  c += vec3(0.94, 0.66, 0.40) * pow(sd, 18.0)  * 0.26;
  c += vec3(0.80, 0.56, 0.34) * pow(sd, 3.2)   * 0.16;
  c += vec3(0.60, 0.44, 0.30) * pow(sd, 1.3)   * 0.10 * (1.0 - up);

  // The disc: small, and far enough above white to clip and bloom.
  c += vec3(1.0, 0.97, 0.90) * smoothstep(0.999977, 0.999996, sd) * 80.0;
  return c;
}

// Cumulus, projected onto a high plane.
vec3 addClouds(vec3 col, vec3 rd) {
  if (rd.y < 0.010) return col;
  float sd = max(dot(rd, uSunDir), 0.0);

  for (int L = 0; L < 2; L++) {
    float hgt = L == 0 ? 1.0 : 2.2;
    vec2 q = rd.xz / max(rd.y, 0.001) * (0.75 / hgt);
    q += vec2(uTime * 0.012, uTime * 0.004) * (L == 0 ? 1.0 : 0.55);

    // Stretched along the view so low decks read as cumulus and not as spots.
    float d = fbm(q * vec2(1.0, 1.25), L == 0 ? 5 : 4);
    d = d + (d - 0.5) * 0.85;                      // more contrast, longer tail
    float cover = L == 0 ? 0.425 : 0.495;
    float m   = smoothstep(cover, cover + 0.16, d);
    float lit = smoothstep(cover + 0.01, cover + 0.26, d);

    // Bright, warm tops; cool shaded bases.
    vec3 body = mix(S(0.46, 0.53, 0.63), S(1.0, 0.985, 0.95), lit * lit);
    body += vec3(0.55, 0.36, 0.16) * pow(sd, 3.0) * 0.75;
    body *= mix(0.82, 1.18, lit);

    float fade = smoothstep(0.010, 0.13, rd.y) * (L == 0 ? 0.94 : 0.58);
    col = mix(col, body, clamp(m * fade, 0.0, 1.0));
  }
  return col;
}

// ----------------------------------------------------------------- the shore

// Angular profile of the far shore, in radians above the true horizon.
float treeLine(float az) {
  float grove = fbm(vec2(az * 22.0, 3.7), 4);
  // High frequency and sharply peaked, so individual crowns resolve.
  float palms = pow(max(0.0, vnoise(vec2(az * 330.0, 11.0))), 5.0);
  float headland = smoothstep(0.30, 0.0, abs(az + 0.46)) * 0.0145;
  return 0.0132 + grove * 0.0120 + palms * 0.0135 + headland;
}

float sandLine(float az) {
  return 0.0058 + fbm(vec2(az * 30.0, 19.0), 3) * 0.0026;
}

float surfLine(float az) {
  return 0.0014 + fbm(vec2(az * 70.0, 41.0), 3) * 0.0012;
}

// ---------------------------------------------------------------- sea shading

float shoreZ(float x) {
  return SHORE_Z + (fbm(vec2(x * 0.0085, 5.5), 3) - 0.5) * 30.0;
}

// Disturbed water around and astern of each float. The trail widens and
// fades with distance behind, the way a wake actually does.
float wakeField(vec2 q, float t, out float splash, out float burst) {
  float trail = 0.0;
  splash = 0.0;
  burst = 0.0;
  if (any(lessThan(q, uWakeBox.xy)) || any(greaterThan(q, uWakeBox.zw))) return 0.0;
  for (int i = 0; i < MAX_WAKE; i++) {
    if (i >= uWakeN) break;
    vec4 w = uWake[i];
    // This loop runs for every pixel of sea, so everything below is skipped
    // wherever the entry provably contributes nothing. Without these, each
    // extra animal cost ~2ms a frame regardless of how much screen it covered.
    if (w.z < 0.002) continue;                 // eased-out sources
    vec2 d = q - w.xy;
    float dd = dot(d, d);
    // A negative radius marks an impact splash rather than a float's wake.
    if (w.w < 0.0) {
      float br = -w.w;
      if (dd > br * br * 1.44) continue;       // core reaches 1.05br, rim 1.14br
      float rr2 = length(d * vec2(1.0, 1.35));
      // Thin in the middle, heaviest around the rim: a solid disc reads as
      // paper, and real thrown water is a ragged ring of aerated foam.
      float core = 1.0 - smoothstep(br * 0.12, br * 1.05, rr2);
      float rim  = 1.0 - smoothstep(0.0, br * 0.42, abs(rr2 - br * 0.72));
      burst = max(burst, (core * 0.40 + rim * 0.90) * w.z);
      continue;
    }
    float r = max(w.w, 0.4);
    float behind = -d.x;                       // the floats travel +x
    // The collar ends by 1.32r; the trail is zero ahead of the source, has
    // decayed below 1% by 40m astern, and never spreads past its own width.
    bool inTrail = behind > -0.6 && behind < 40.0
                && abs(d.y) < 1.06 * (r * 0.34 + max(behind, 0.0) * 0.072);
    if (!inTrail && dd > r * r * 1.96) continue;

    // A broad, soft field around the tube. Deliberately not a crisp annulus:
    // the noise below is what turns this into foam, and a hard-edged ring here
    // just reads as a painted-on hoop.
    float rr = length(d * vec2(1.0, 1.42));
    float collar = 1.0 - smoothstep(0.0, r * 0.46, abs(rr - r * 0.86));
    collar *= collar;
    splash = max(splash, collar * w.z);

    // The trail astern.
    float halfW = r * 0.34 + max(behind, 0.0) * 0.072;
    float v = abs(d.y) / halfW;
    // Two streaks along the shoulders of the wake rather than one solid band.
    float lateral = (1.0 - smoothstep(0.62, 1.05, v)) * (0.34 + 0.86 * smoothstep(0.18, 0.72, v));
    float along = exp(-max(behind, 0.0) * 0.115) * smoothstep(-0.6, 0.6, behind);
    trail = max(trail, lateral * along * w.z);
  }
  return clamp(trail, 0.0, 1.0);
}

// ----------------------------------------------------------------- sea life

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// iq's approximate ellipsoid: well behaved under sphere tracing, unlike a thin
// triangular prism built from max(), which stalls the march to a crawl.
float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}

// ------------------------------------------------ traced creature geometry
//
// Both animals are built from measurements traced off reference silhouettes
// (see creatures.data.js): a body swept along a measured centreline, height and
// width profile, with fins as exact 2D polygon distance fields extruded into
// thin blades.

void profIdx(float x, out int i0, out float fr) {
  float u = clamp((1.0 - x) * 0.5 * float(PROF_N - 1), 0.0, float(PROF_N - 1) - 0.001);
  i0 = int(u);
  fr = u - float(i0);
}

// Elliptical cross-section at this slice, using the k0*(k0-1)/k1 ellipse
// estimate. Scaling by the smaller semi-axis instead was so conservative on a
// dolphin's tall, razor-thin tailstock that the tracer ran out of steps before
// reaching it, and the tail rendered as a wisp.
float sdTracedBody(vec3 p, float c, float h, float w) {
  vec2 q = vec2(p.y - c, p.z);
  // Guard for a degenerate slice: fall back to a round section, whose distance
  // is exact, rather than an ellipse so flat the estimate stops meaning anything.
  if (min(h, w) < 0.008) return max(length(q) - max(h, w), abs(p.x) - 1.0);
  vec2 r = vec2(h, w);
  float k0 = length(q / r);
  float k1 = length(q / (r * r));
  return max(k0 * (k0 - 1.0) / max(k1, 1e-6), abs(p.x) - 1.0);
}

// Exact signed distance to a traced polygon.
float sdPolyV(vec2 p, int s, int n) {
  float d = dot(p - FIN_V[s], p - FIN_V[s]);
  float sgn = 1.0;
  for (int k = 0; k < 64; k++) {
    if (k >= n) break;
    vec2 vi = FIN_V[s + k];
    vec2 vj = FIN_V[s + (k == 0 ? n - 1 : k - 1)];
    vec2 e = vj - vi, w = p - vi;
    vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-9), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= vi.y, p.y < vj.y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) sgn = -sgn;
  }
  return sgn * sqrt(d);
}

// A polygon extruded along n into a blade: thick at the root, thin at the edge.
// The bounding box gives a cheap lower bound, so the polygon loop only runs
// when the fin could actually be the nearest surface.
float sdFinBlade(vec2 uv, float n, int s, int cnt, vec4 bb, float th, float cutoff) {
  vec2 bc = 0.5 * (bb.xy + bb.zw), be = 0.5 * (bb.zw - bb.xy);
  vec2 qb = abs(uv - bc) - be;
  float lower = length(vec2(length(max(qb, 0.0)), max(abs(n) - th, 0.0)));
  if (lower > cutoff) return 1e5;
  float d2 = sdPolyV(uv, s, cnt);
  // Thin only in a narrow band at the edge. Distance-to-edge has a ridge along
  // the middle of the fin, and tapering across the whole fin carried that ridge
  // into the surface normal as a crease -- the crumpled look on the flukes.
  // Saturating early keeps the ridge in the flat, constant-thickness region.
  float t = mix(0.0035, th, smoothstep(0.0, 0.028, -d2));
  vec2 w = vec2(d2, abs(n) - t);
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - 0.0012;
}

// A paired fin hanging off the flank: its plane leaves the body at root and
// angles down by tilt.
float sdPairedFin(vec3 p, float rootY, float rootZ, float tilt, int s, int cnt, vec4 bb, float th, float cutoff) {
  vec2 yz = vec2(p.y - rootY, abs(p.z) - rootZ);
  vec2 dir = vec2(-sin(tilt), cos(tilt));
  vec2 nrm = vec2(cos(tilt), sin(tilt));
  return sdFinBlade(vec2(p.x, dot(yz, dir)), dot(yz, nrm), s, cnt, bb, th, cutoff);
}

float sdShark(vec3 p) {
  int i; float fr; profIdx(p.x, i, fr);
  float c = mix(SH_C[i], SH_C[i + 1], fr);
  float h = mix(SH_H[i], SH_H[i + 1], fr);
  float w = mix(SH_W[i], SH_W[i + 1], fr);
  float d = sdTracedBody(p, c, h, w);
  const float K = 0.020;
  d = smin(d, sdFinBlade(p.xy, p.z, SH_DORSAL_S, SH_DORSAL_N, SH_DORSAL_B, SH_DORSAL_T, d + K), K);
  d = smin(d, sdFinBlade(p.xy, p.z, SH_DORSAL2_S, SH_DORSAL2_N, SH_DORSAL2_B, SH_DORSAL2_T, d + K), K * 0.5);
  d = smin(d, sdFinBlade(p.xy, p.z, SH_ANAL_S, SH_ANAL_N, SH_ANAL_B, SH_ANAL_T, d + K), K * 0.5);
  d = smin(d, sdFinBlade(p.xy, p.z, SH_TAIL_S, SH_TAIL_N, SH_TAIL_B, SH_TAIL_T, d + K), K);
  d = smin(d, sdPairedFin(p, SH_PEC_ROOT_Y, SH_PEC_ROOT_Z, SH_PEC_TILT,
                          SH_PEC_S, SH_PEC_N, SH_PEC_B, SH_PEC_T, d + K), K);
  return d;
}

float sdDolphin(vec3 p) {
  int i; float fr; profIdx(p.x, i, fr);
  float c = mix(DO_C[i], DO_C[i + 1], fr);
  float h = mix(DO_H[i], DO_H[i + 1], fr);
  float w = mix(DO_W[i], DO_W[i + 1], fr);
  float d = sdTracedBody(p, c, h, w);
  const float K = 0.024;
  d = smin(d, sdFinBlade(p.xy, p.z, DO_DORSAL_S, DO_DORSAL_N, DO_DORSAL_B, DO_DORSAL_T, d + K), K);
  // Flukes lie flat, in the plane of the tail stock.
  d = smin(d, sdFinBlade(p.xz, p.y - DO_FLUKE_Y, DO_FLUKE_S, DO_FLUKE_N, DO_FLUKE_B, DO_FLUKE_T, d + K), K);
  d = smin(d, sdPairedFin(p, DO_PEC_ROOT_Y, DO_PEC_ROOT_Z, DO_PEC_TILT,
                          DO_PEC_S, DO_PEC_N, DO_PEC_B, DO_PEC_T, d + K), K);
  return d;
}

// Centreline and half-height at x, for shading the belly relative to the body.
void creatureMid(float x, float shark, out float c, out float h) {
  int i; float fr; profIdx(x, i, fr);
  if (shark > 0.5) { c = mix(SH_C[i], SH_C[i + 1], fr); h = mix(SH_H[i], SH_H[i + 1], fr); }
  else             { c = mix(DO_C[i], DO_C[i + 1], fr); h = mix(DO_H[i], DO_H[i + 1], fr); }
}

vec3 creatureLocal(vec3 p, int i) {
  vec3 q = (p - uCreatA[i].xyz) / uCreatA[i].w;
  float cy = cos(-uCreatB[i].x), sy = sin(-uCreatB[i].x);
  q = vec3(q.x * cy - q.z * sy, q.y, q.x * sy + q.z * cy);
  float cp = cos(-uCreatB[i].y), sp = sin(-uCreatB[i].y);
  q = vec3(q.x * cp - q.y * sp, q.x * sp + q.y * cp, q.z);
  float cr = cos(-uCreatB[i].z), sr = sin(-uCreatB[i].z);
  q = vec3(q.x, q.y * cr - q.z * sr, q.y * sr + q.z * cr);
  return q;
}

float sdCreature(vec3 p, int i) {
  vec3 q = creatureLocal(p, i);
  float d = uCreatB[i].w > 0.5 ? sdShark(q) : sdDolphin(q);
  // Slice-wise body distance is not a strict field; step conservatively.
  return d * uCreatA[i].w * 0.6;
}

// ---------------------------------------------------------------- the floats

// Into the ring's own frame, undoing its roll and pitch.
vec3 floatRotate(vec3 q, int i) {
  vec4 r = uFloatR[i];        // cos roll, sin roll, cos pitch, sin pitch
  q = vec3(q.x * r.x + q.y * r.y, -q.x * r.y + q.y * r.x, q.z);
  return vec3(q.x, q.y * r.z + q.z * r.w, -q.y * r.w + q.z * r.z);
}

vec3 floatLocal(vec3 p, int i) { return floatRotate(p - uFloatA[i].xyz, i); }

// The torus normal in closed form, taken back out to world space. It used to
// be six finite-difference samples of a shared ring-or-animal distance
// function, whose branch compiled to both sides -- so every pixel of every
// ring was paying for the traced shark and dolphin six times over.
vec3 floatNormal(vec3 p, int i) {
  vec3 q = floatLocal(p, i);
  float k = 1.0 - uFloatA[i].w / max(length(q.xz), 1e-4);
  vec3 n = vec3(q.x * k, q.y, q.z * k);
  vec4 r = uFloatR[i];
  n = vec3(n.x, n.y * r.z - n.z * r.w, n.y * r.w + n.z * r.z);
  n = vec3(n.x * r.x - n.y * r.y, n.x * r.y + n.y * r.x, n.z);
  return normalize(n);
}

// Traced shapes reach at most ~1.05 of their half-length from the origin
// (tail lobe and fluke tips).
float creatBound(int i) { return uCreatA[i].w * 1.12; }

// A capsule along the spine that still contains every fin. Radius measured off
// the traced data (shark 0.394, dolphin 0.429 of the half-length), plus margin.
// The animals are long and thin, so this encloses ~29% of the bounding
// sphere's volume -- most of the sphere is empty water that no longer pays for
// the full shape.
float creatCapsule(vec3 p, int i) {
  vec3 q = creatureLocal(p, i);
  q.x -= clamp(q.x, -0.92, 0.92);
  return (length(q) - 0.47) * uCreatA[i].w;
}

float solidsMap(vec3 p, uint mask, out int which) {
  float best = 1e9;
  which = -1;
  // Outside an object's bounding sphere, the distance to that sphere is a safe
  // underestimate of the distance to the object, so use it instead of running
  // the full shape. Only objects whose sphere actually contains this point pay
  // for their real SDF -- with many animals on screen, that is usually one.
  // (Rings are intersected exactly in traceSolids and never marched.)
  for (int i = 0; i < MAX_CREAT; i++) {
    if (i >= uCreatN) break;
    if ((mask & (1u << uint(i + 8))) == 0u) continue;
    // Cheapest first: sphere (no rotation), then capsule, then the real shape.
    float bd = length(p - uCreatA[i].xyz) - creatBound(i);
    if (bd > best) continue;                 // cannot beat what we already have
    float d = bd;
    if (bd <= 0.05) {
      float cb = creatCapsule(p, i);
      if (cb > best) continue;
      d = cb > 0.05 ? cb : sdCreature(p, i);
    }
    if (d < best) { best = d; which = i + 8; }
  }
  return best;
}

vec3 solidNormal(vec3 p, int id) {
  if (id < 8) return floatNormal(p, id);
  int c = id - 8;
  vec2 e = vec2(0.0016, 0.0);
  return normalize(vec3(
    sdCreature(p + e.xyy, c) - sdCreature(p - e.xyy, c),
    sdCreature(p + e.yxy, c) - sdCreature(p - e.yxy, c),
    sdCreature(p + e.yyx, c) - sdCreature(p - e.yyx, c)));
}

// Bounding spheres first: most pixels touch no ring at all, and the ones that
// do usually touch one.
// Ray against a torus in closed form: the torus lies in the xy plane about
// the origin, tor = (major, minor), rd unit length. iq's quartic solver
// (https://iquilezles.org/articles/intersectors), which stays stable as long
// as the ray starts near the ring -- the caller starts it at the edge of the
// ring's bounding slab rather than back at the camera.
float iTorus(vec3 ro, vec3 rd, vec2 tor) {
  float po = 1.0;
  float Ra2 = tor.x * tor.x, ra2 = tor.y * tor.y;
  float m = dot(ro, ro), n = dot(ro, rd);
  float k = (m - ra2 - Ra2) / 2.0;
  float k3 = n;
  float k2 = n * n + Ra2 * rd.z * rd.z + k;
  float k1 = k * n + Ra2 * ro.z * rd.z;
  float k0 = k * k + Ra2 * ro.z * ro.z - Ra2 * ra2;
  // Keep |c1| away from zero by solving for 1/t instead.
  if (abs(k3 * (k3 * k3 - k2) + k1) < 0.01) {
    po = -1.0;
    float tmp = k1; k1 = k3; k3 = tmp;
    k0 = 1.0 / k0;
    k1 = k1 * k0; k2 = k2 * k0; k3 = k3 * k0;
  }
  float c2 = 2.0 * k2 - 3.0 * k3 * k3;
  float c1 = k3 * (k3 * k3 - k2) + k1;
  float c0 = k3 * (k3 * (-3.0 * k3 * k3 + 4.0 * k2) - 8.0 * k1) + 4.0 * k0;
  c2 /= 3.0; c1 *= 2.0; c0 /= 3.0;
  float Q = c2 * c2 + c0;
  float R = 3.0 * c0 * c2 - c2 * c2 * c2 - c1 * c1;
  float h = R * R - Q * Q * Q;
  float z;
  if (h < 0.0) {
    float sQ = sqrt(Q);
    z = 2.0 * sQ * cos(acos(clamp(R / (sQ * Q), -1.0, 1.0)) / 3.0);
  } else {
    float sQ = pow(sqrt(h) + abs(R), 1.0 / 3.0);
    z = sign(R) * abs(sQ + Q / sQ);
  }
  z = c2 - z;
  float d1 = z - 3.0 * c2;
  float d2 = z * z - 3.0 * c0;
  if (abs(d1) < 1.0e-4) {
    if (d2 < 0.0) return -1.0;
    d2 = sqrt(d2);
  } else {
    if (d1 < 0.0) return -1.0;
    d1 = sqrt(d1 / 2.0);
    d2 = c1 / d1;
  }
  float result = 1e20;
  h = d1 * d1 - z + d2;
  if (h > 0.0) {
    h = sqrt(h);
    float t1 = -d1 - h - k3; t1 = po < 0.0 ? 2.0 / t1 : t1;
    float t2 = -d1 + h - k3; t2 = po < 0.0 ? 2.0 / t2 : t2;
    if (t1 > 0.0) result = t1;
    if (t2 > 0.0) result = min(result, t2);
  }
  h = d1 * d1 - z - d2;
  if (h > 0.0) {
    h = sqrt(h);
    float t1 = d1 - h - k3; t1 = po < 0.0 ? 2.0 / t1 : t1;
    float t2 = d1 + h - k3; t2 = po < 0.0 ? 2.0 / t2 : t2;
    if (t1 > 0.0) result = min(result, t1);
    if (t2 > 0.0) result = min(result, t2);
  }
  return result;
}

float traceSolids(vec3 ro, vec3 rd, float tMax, out int hitIdx) {
  hitIdx = -1;
  float best = tMax;

  // Rings are intersected exactly rather than marched. Sphere-tracing them
  // was most of their cost: every ray through a ring's bounding sphere took
  // dozens of steps, grazing ones up to the 120-step cap.
  for (int i = 0; i < MAX_FLOATS; i++) {
    if (i >= uFloatN) break;
    if (uFloatB[i].w < 0.01) continue;
    // Clip to the slab and cylinder that hold the tube, in the ring's frame.
    vec3 o = floatLocal(ro, i);
    vec3 d = floatRotate(rd, i);
    float hy = uFloatB[i].z + 0.1;
    float rc = uFloatA[i].w + uFloatB[i].z + 0.1;
    float t0 = 0.0, t1 = best;
    if (abs(d.y) > 1e-5) {
      float a = (-hy - o.y) / d.y, b = (hy - o.y) / d.y;
      t0 = max(t0, min(a, b)); t1 = min(t1, max(a, b));
    } else if (abs(o.y) > hy) continue;
    float qa = dot(d.xz, d.xz), qb = dot(o.xz, d.xz), qc = dot(o.xz, o.xz) - rc * rc;
    if (qa > 1e-8) {
      float disc = qb * qb - qa * qc;
      if (disc < 0.0) continue;
      disc = sqrt(disc);
      t0 = max(t0, (-qb - disc) / qa); t1 = min(t1, (-qb + disc) / qa);
    } else if (qc > 0.0) continue;
    if (t1 <= t0) continue;
    // The march registered a hit within 0.0012 + 0.0008t of the surface, so
    // the tube it drew was that much fatter; keep the rings the same weight.
    vec3 s = o + d * t0;
    float th = iTorus(s.xzy, d.xzy, vec2(uFloatA[i].w, uFloatB[i].z + 0.0012 + t0 * 0.0008));
    if (th > 0.0 && t0 + th < t1) { best = t0 + th; hitIdx = i; }
  }

  // The animals are traced shapes with no closed form, so they are marched,
  // and only as far as the nearest ring.
  uint mask = 0u;
  float tStart = 1e9, tEnd = 0.0;
  for (int i = 0; i < MAX_CREAT; i++) {
    if (i >= uCreatN) break;
    vec3 oc = ro - uCreatA[i].xyz;
    float br = creatBound(i);
    float b = dot(oc, rd);
    float c = dot(oc, oc) - br * br;
    float h = b * b - c;
    if (h < 0.0) continue;
    h = sqrt(h);
    if (-b + h < 0.0) continue;
    mask |= (1u << uint(i + 8));
    tStart = min(tStart, max(-b - h, 0.0));
    tEnd = max(tEnd, -b + h);
  }
  tEnd = min(tEnd, best);
  if (mask != 0u && tStart < tEnd) {
    float t = tStart;
    for (int s = 0; s < 120; s++) {
      vec3 p = ro + rd * t;
      int w;
      float d = solidsMap(p, mask, w);
      if (d < 0.0012 + t * 0.0008) { hitIdx = w; return t; }
      // The blended body is not a strict distance field, so under-step a little.
      t += max(d * 0.82, 0.002);
      if (t > tEnd) break;
    }
  }
  return hitIdx >= 0 ? best : -1.0;
}

float shoreMask(vec3 p) { return 1.0 - clamp((p.z - shoreZ(p.x)) / SHELF, 0.0, 1.0); }

vec3 shadeSea(vec3 ro, vec3 rd, vec3 p, vec3 n, float dist, float t, float footprint) {
  float shallow = shoreMask(p);
  float depth   = mix(0.20, 11.0, 1.0 - shallow);

  vec3 sun = uSunDir;
  vec3 v   = -rd;

  float fres = 0.02 + 0.98 * pow(clamp(1.0 - dot(n, v), 0.0, 1.0), 5.0);

  // --- reflection: the sky, mirrored and flattened a little
  vec3 r = reflect(rd, n);
  r.y = abs(r.y) * 0.88 + 0.004;
  vec3 rr = normalize(r);
  // Clouds belong in the shallow, near-horizon reflections. In the foreground
  // the reflected ray points steeply up, where rr.xz/rr.y swings so fast
  // between neighbouring pixels that the cloud field maps onto the swell as
  // contour rings -- so fade them out as the reflection steepens.
  float cloudy = smoothstep(0.42, 0.07, abs(rr.y));
  vec3 skyRefl = skyColor(rr);
  // skyColor was evaluated twice here, and addClouds ran even where its blend
  // weight is zero -- which is most of the frame.
  vec3 refl = cloudy > 0.002 ? mix(skyRefl, addClouds(skyRefl, rr), cloudy) : skyRefl;

  // --- body: colour set by how much water the light travelled through
  vec3 deepC    = S(0.016, 0.150, 0.235);
  vec3 midC     = S(0.030, 0.400, 0.500);
  vec3 shallowC = S(0.240, 0.800, 0.745);
  vec3 sandC    = S(0.540, 0.760, 0.665);

  float k = clamp(depth / 9.0, 0.0, 1.0);
  vec3 body = mix(shallowC, midC, smoothstep(0.02, 0.62, k));
  body = mix(body, deepC, smoothstep(0.35, 1.60, pow(k, 1.20)));
  body = mix(sandC, body, smoothstep(0.0, 0.28, k));

  // Subsurface scatter: a rim on crest tips you are looking THROUGH toward the
  // sun. A wide lobe here washes the whole sea green.
  float thin    = smoothstep(0.62, 1.15, p.y);
  float backlit = pow(max(dot(v, -normalize(vec3(sun.x, 0.0, sun.z))), 0.0), 10.0);
  body += S(0.170, 0.640, 0.480) * thin * backlit * 0.30;
  body += S(0.120, 0.300, 0.290) * max(dot(n, sun), 0.0) * 0.07;

  vec3 col = mix(body, refl, fres);

  // --- sun specular. Roughness grows with the pixel footprint: the slope
  // variance that stops being resolvable is folded into the lobe instead of
  // being sprinkled on as per-pixel noise. That is what makes a glitter track
  // taper toward the horizon.
  float rough = clamp(0.045 + 0.30 * smoothstep(0.01, 0.90, footprint), 0.045, 0.34);
  vec3  hv  = normalize(sun + v);
  float ndh = max(dot(n, hv), 0.0);
  float ndv = max(dot(n, v), 1e-3);
  float ndl = max(dot(n, sun), 0.0);
  float a2  = rough * rough * rough * rough;
  float dn  = ndh * ndh * (a2 - 1.0) + 1.0;
  float D   = a2 / (PI * dn * dn);
  float G   = 0.5 / max(mix(2.0 * ndl * ndv, ndl + ndv, rough * rough), 1e-4);
  col += vec3(1.0, 0.93, 0.80) * D * G * ndl * 22.0 * fres;

  // --- foam, driven by how close the surface is to folding over
  float steep = length(n.xz);
  float now   = smoothstep(0.16, 0.54, steep);
  // Foam cannot live in a trough.
  float trough = smoothstep(-0.30, 0.42, p.y);

  // What the floats and impacts are doing to the water, needed up front: it
  // decides whether this pixel can carry any foam at all.
  float splash, burst;
  float wk = wakeField(p.xz, t, splash, burst);

  // Away from crests, the shelf, the floats and any splash there is no foam
  // here, and every noise lookup below would be multiplied out to nothing.
  bool anyFoam = trough > 0.004 || shallow > 0.02
              || wk > 0.0005 || splash > 0.0005 || burst > 0.0005;

  float foam = 0.0;
  float age = 0.0;                      // 0 at the crest, 1 astern
  if (anyFoam) {
    // Sampled upwind along the swell, at the current time: the trail then lies
    // along the crest and fades astern, instead of running across the wave
    // train the way a backwards-in-time sample does.
    float lag1 = smoothstep(0.24, 0.66, swellSlope(p.xz + DOM_DIR * 2.9, t)) * 0.62;
    float lag2 = smoothstep(0.28, 0.72, swellSlope(p.xz + DOM_DIR * 6.6, t)) * 0.30;
    float trail = max(now, max(lag1, lag2));
    age = clamp(1.0 - now / max(trail, 1e-3), 0.0, 1.0);
    trail *= trough;

    if (trail > 0.0005) {
      float mottle = fbm(p.xz * 0.85 + vec2(t * 0.06, 0.0), 4) * 0.62
                   + fbm(p.xz * 3.30 - vec2(0.0, t * 0.22), 3) * 0.52;
      trail *= 0.22 + 0.78 * mottle;
      // The fine octave is below a pixel by the time it reaches the horizon.
      float bubbles = fbm(p.xz * 5.5 + vec2(0.0, t * 0.5), 4) * 0.72
                    + fbm(p.xz * 17.0 - t * 0.35, 3) * 0.40
                      * (1.0 - smoothstep(0.10, 0.60, footprint));
      foam = smoothstep(0.52, 1.18, trail * (0.24 + bubbles * 1.20));
    }

    // Breakers marching onto the shallow shelf, plus permanent whitewater at
    // the very edge.
    if (shallow > 0.02) {
      float band = sin((p.z - shoreZ(p.x)) * 0.30 - t * 1.05) * 0.5 + 0.5;
      float surf = pow(shallow, 3.4) * smoothstep(0.82, 0.995, band);
      surf *= 0.30 + 0.80 * fbm(p.xz * 0.9 + vec2(t * 0.2, 0.0), 3);
      surf += smoothstep(0.975, 1.0, shallow) * (0.35 + 0.45 * fbm(p.xz * 3.0 + t * 0.6, 3));
      foam = clamp(foam + surf, 0.0, 1.0);
    }

    // Churn drifts with the water rather than crawling across it, and carries
    // most of the weight, so what you see is broken foam rather than a shape
    // with noise sprinkled on top.
    if (wk > 0.0005 || splash > 0.0005) {
      vec2 drift = vec2(t * 0.16, t * 0.05);
      float churn = fbm(p.xz * 2.6 - drift, 4) * 0.70
                  + fbm(p.xz * 7.4 + drift * 1.7, 4) * 0.55
                  + fbm(p.xz * 19.0 - drift * 3.0, 3) * 0.32
                    * (1.0 - smoothstep(0.10, 0.55, footprint));
      // Wide ramps: a narrow one makes foam snap on and off between frames.
      foam = clamp(foam
            + smoothstep(0.30, 1.00, wk     * (0.26 + churn * 1.35)) * 0.90
            + smoothstep(0.20, 0.86, splash * (0.34 + churn * 1.30)) * 1.0, 0.0, 1.0);
    }
  }

  // Impact water is brighter and far more aerated than anything the wind makes,
  // so it gets its own pass instead of competing with the ambient whitecaps.
  float burstMask = 0.0;
  if (burst > 0.0005) {
    // Fine, fast bubbles specific to thrown water -- the noise carries most of
    // the weight so the edge tears instead of cutting.
    float spray = fbm(p.xz * 9.0 - vec2(t * 1.6, t * 0.9), 4) * 0.85
                + fbm(p.xz * 26.0 + t * 2.2, 3) * 0.45
                  * (1.0 - smoothstep(0.08, 0.45, footprint));
    burstMask = smoothstep(0.34, 1.20, burst * (0.16 + spray * 1.65));
    foam = max(foam, burstMask);
  }

  // A brighter band of aerated water just under the foam edge.
  col = mix(col, S(0.66, 0.88, 0.90), smoothstep(0.26, 0.60, foam) * 0.22);
  // Whitecap albedo is nearer 0.6 than 1.0, and the tail thins back toward the
  // water rather than staying paint-white to its edge.
  vec3 foamC = S(0.88, 0.935, 0.955) * (0.60 + 0.44 * ndl);
  foamC = mix(foamC, body, age * 0.55);
  col = mix(col, foamC, smoothstep(0.18, 0.96, foam) * (0.78 - age * 0.40));

  if (burstMask > 0.001) {
    vec3 aer = S(0.97, 0.99, 1.0) * (0.86 + 0.34 * ndl);
    col = mix(col, aer, burstMask * 0.96);
    col = mix(col, S(0.62, 0.88, 0.90), smoothstep(0.02, 0.26, burst) * 0.26);
  }

  // --- aerial perspective
  float fog = 1.0 - exp(-dist * 0.0034);
  vec3 fogC = skyColor(normalize(vec3(rd.x, 0.012, rd.z)));
  col = mix(col, fogC, fog * 0.86);
  return col;
}

// Glossy vinyl. It reflects the sky above the horizon and the sea below it,
// which is the whole reason the rings moved into the shader.
vec3 shadeFloat(vec3 ro, vec3 rd, vec3 p, vec3 n, int i, float dist, float waterH) {
  vec3 base = uFloatC[i];
  vec3 sun = uSunDir;
  vec3 v = -rd;

  float ndl = max(dot(n, sun), 0.0);
  float ndv = max(dot(n, v), 1e-3);

  // Diffuse body, with a little wrap so the shaded side does not go black.
  vec3 col = base * (0.30 + 0.78 * (ndl * 0.5 + 0.5) * (0.45 + 0.55 * ndl));

  // Bounce off the water onto the underside.
  float up = n.y * 0.5 + 0.5;
  col += base * S(0.16, 0.42, 0.50) * (1.0 - up) * 0.55;

  // Environment: sky above, sea below.
  vec3 r = reflect(rd, n);
  vec3 env;
  if (r.y > 0.0) {
    env = skyColor(normalize(r));
  } else {
    // What the water looks like from here, roughly: deep body plus the sky it
    // is itself reflecting.
    vec3 seaBody = S(0.020, 0.230, 0.330);
    vec3 skyBack = skyColor(normalize(vec3(r.x, max(-r.y, 0.03), r.z)));
    env = mix(seaBody, skyBack, 0.45);
  }
  float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  col = mix(col, env, fres * 0.82);

  // Tight highlight: vinyl is glossy.
  vec3 hv = normalize(sun + v);
  col += vec3(1.0, 0.95, 0.86) * pow(max(dot(n, hv), 0.0), 420.0) * 5.0;
  col += vec3(1.0, 0.95, 0.86) * pow(max(dot(n, hv), 0.0), 34.0) * 0.30;

  // Wet, darker band just above the waterline, and heavy tinting below it.
  float below = waterH - p.y;
  col = mix(col, col * S(0.55, 0.72, 0.78), smoothstep(0.16, -0.02, below) * 0.0 + smoothstep(-0.14, 0.02, below) * 0.45);
  if (below > 0.0) {
    vec3 water = S(0.030, 0.330, 0.430);
    col = mix(col, col * 0.55 + water * 0.55, clamp(below * 2.6, 0.0, 0.85));
  }

  // Foam clinging to the tube where it cuts the surface.
  float band = 1.0 - smoothstep(0.0, 0.30, abs(below + 0.04));
  float suds = fbm(p.xz * 7.0 + vec2(uTime * 0.7, uTime * 0.25), 4) * 0.8
             + fbm(p.xz * 21.0 - uTime * 1.1, 3) * 0.5;
  float cling = smoothstep(0.30, 0.98, band * (0.26 + suds * 1.50));
  col = mix(col, S(0.94, 0.97, 0.98) * (0.66 + 0.40 * ndl), cling * 0.88);

  float fog = 1.0 - exp(-dist * 0.0034);
  col = mix(col, skyColor(normalize(vec3(rd.x, 0.012, rd.z))), fog * 0.86);
  return col;
}

// Wet skin: counter-shaded dark above and pale below, very glossy, and tinted
// by the water once it is under the surface.
vec3 shadeCreature(vec3 ro, vec3 rd, vec3 p, vec3 n, int ci, float dist, float waterH) {
  vec3 loc = creatureLocal(p, ci);
  float shark = uCreatB[ci].w;

  // Counter-shading runs from the back down to the belly.
  // Counter-shading measured against the traced body at this slice, so the
  // pale belly follows the real waterline of the animal.
  float midC, midH;
  creatureMid(loc.x, shark, midC, midH);
  float rel = (loc.y - midC) / max(midH, 0.02);
  // Sharks carry a crisp line along the flank; dolphins blend more softly.
  float belly = shark > 0.5 ? smoothstep(0.02, -0.22, rel) : smoothstep(0.10, -0.45, rel);
  // A fin below the spine is still dark on top: only surfaces that actually
  // face down take the pale belly colour.
  belly *= smoothstep(0.55, -0.25, n.y);
  vec3 back  = shark > 0.5 ? S(0.47, 0.47, 0.46) : S(0.36, 0.40, 0.46);
  vec3 under = shark > 0.5 ? S(0.90, 0.91, 0.89) : S(0.84, 0.86, 0.88);
  vec3 base = mix(back, under, belly);
  // A pale flank streak, which is what makes a dolphin read as a dolphin.
  base = mix(base, under, smoothstep(0.55, 0.0, abs(rel + 0.05)) * (1.0 - shark) * 0.22);

  vec3 sun = uSunDir, v = -rd;
  float ndl = max(dot(n, sun), 0.0);
  float ndv = max(dot(n, v), 1e-3);

  float up = n.y * 0.5 + 0.5;
  // The sun sits behind these animals from this camera, so what we see is
  // mostly their shadow side. Sky irradiance on its own paints that side deep
  // blue; mostly desaturate it, and add the fill a real scene has from the
  // bright water and sky behind the viewer.
  vec3 skyAmb = skyColor(vec3(0.0, 1.0, 0.0));
  skyAmb = mix(vec3(dot(skyAmb, vec3(0.30, 0.59, 0.11))), skyAmb, 0.18) * 3.0;
  vec3 amb = mix(S(0.22, 0.30, 0.32), skyAmb, up);
  float fill = max(dot(n, v), 0.0);
  vec3 col = base * (amb + vec3(1.05, 0.98, 0.88) * ndl * 1.15 + S(0.62, 0.64, 0.66) * fill * 0.55);
  // Backlit rim: the sun catching the silhouette edge.
  // Silhouette edges only: a flat fluke seen at a grazing angle must not light up.
  float rim = pow(1.0 - ndv, 4.0) * max(dot(-v, sun) * 0.6 + 0.4, 0.0) * (1.0 - abs(n.y) * 0.85);
  col += vec3(1.0, 0.93, 0.80) * rim * 0.50;

  vec3 r = reflect(rd, n);
  vec3 env = r.y > 0.0 ? skyColor(normalize(r))
                       : mix(S(0.020, 0.230, 0.330),
                             skyColor(normalize(vec3(r.x, max(-r.y, 0.03), r.z))), 0.45);
  float fres = 0.03 + 0.97 * pow(1.0 - ndv, 5.0);
  col = mix(col, env, fres * 0.42);

  // Soaking wet, so the highlight is tight and bright.
  vec3 hv = normalize(sun + v);
  col += vec3(1.0, 0.96, 0.88) * pow(max(dot(n, hv), 0.0), 640.0) * 7.0;
  col += vec3(1.0, 0.96, 0.88) * pow(max(dot(n, hv), 0.0), 48.0) * 0.26;

  float below = waterH - p.y;
  if (below > 0.0) {
    col = mix(col, col * 0.52 + S(0.030, 0.330, 0.430) * 0.55, clamp(below * 2.2, 0.0, 0.88));
  } else {
    // Water still sheeting off it just above the surface.
    col = mix(col, col * 1.18 + vec3(0.03), smoothstep(0.30, 0.0, -below) * 0.30);
  }

  float fog = 1.0 - exp(-dist * 0.0034);
  col = mix(col, skyColor(normalize(vec3(rd.x, 0.012, rd.z))), fog * 0.86);
  return col;
}

// Dispatch by id so the composite does not care what it hit.
vec3 shadeSolid(vec3 ro, vec3 rd, vec3 p, vec3 n, int id, float dist, float waterH) {
  if (id < 8) return shadeFloat(ro, rd, p, n, id, dist, waterH);
  return shadeCreature(ro, rd, p, n, id - 8, dist, waterH);
}

// ------------------------------------------------------------------- tracing

// False-position search on f(t) = p.y - traceHeight(p.xz): robust and cheap.
float traceSea(vec3 ro, vec3 rd, float t, float tMax, out vec3 hit) {
  const int STEPS = 14;
  float tb = 0.0;
  float fb = ro.y - traceHeight(ro.xz, t);
  float ta = tMax;
  float fa = 1.0;
  bool found = false;

  // Quadratic spacing: fine near the camera where a wave covers many pixels.
  for (int i = 1; i <= STEPS; i++) {
    float u = float(i) / float(STEPS);
    float tc = tMax * u * u;
    vec3 pc = ro + rd * tc;
    float fc = pc.y - traceHeight(pc.xz, t);
    if (fc < 0.0) { ta = tc; fa = fc; found = true; break; }
    tb = tc; fb = fc;
  }
  if (!found) { hit = ro + rd * tMax; return -1.0; }

  float tm = ta;
  for (int i = 0; i < 6; i++) {
    tm = mix(tb, ta, fb / max(fb - fa, 1e-5));
    vec3 p = ro + rd * tm;
    float f = p.y - traceHeight(p.xz, t);
    if (f < 0.0) { ta = tm; fa = f; } else { tb = tm; fb = f; }
  }
  hit = ro + rd * tm;
  return tm;
}

// ------------------------------------------------------------------- grading

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// ---------------------------------------------------------------------- main

void main() {
  vec2 uv = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  vec3 rd = normalize(uCamRight * uv.x * uTanHalf * uAspect
                    + uCamUp    * uv.y * uTanHalf
                    + uCamFwd);
  vec3 ro = uCamPos;
  float t = uTime;

  float pixAngle = 2.0 * uTanHalf / uRes.y;

  float az = atan(rd.x, -rd.z);
  float el = asin(clamp(rd.y, -1.0, 1.0));

  float dShore  = (ro.z - SHORE_Z) / max(cos(az), 0.25);
  float elShore = -atan(ro.y / dShore);

  vec3 col;

  int fi;
  float tFloat;
  float tWater = -1.0;

  if (el < elShore) {
    // ---- open water
    float tMax = min(dShore * 1.12, 900.0);
    vec3 p;
    float d = traceSea(ro, rd, t, max(tMax, 40.0), p);
    if (d < 0.0) {
      tFloat = traceSolids(ro, rd, 400.0, fi);
      col = addClouds(skyColor(rd), rd);
    } else {
      float dist = length(p - ro);
      // Solids are only visible to 2.6m below the surface, so there is no
      // reason to march the ray any deeper than that.
      tFloat = traceSolids(ro, rd, dist + 2.6, fi);
      float footprint = dist * pixAngle / max(abs(dot(normalize(p - ro), vec3(0.0, 1.0, 0.0))), 0.03);
      float det = uDetail * (1.0 - smoothstep(0.35, 2.4, footprint));
      vec3 f = seaField(p.xz, t, det);
      vec3 n = normalize(vec3(-f.y, 1.0, -f.z));
      tWater = dist;
      col = shadeSea(ro, rd, p, n, dist, t, footprint);

      // The part of a ring under the surface, seen through the water.
      if (tFloat > 0.0 && tFloat > dist) {
        vec3 fp = ro + rd * tFloat;
        float depthIn = tFloat - dist;
        if (depthIn < 2.6) {
          vec3 fn = solidNormal(fp, fi);
          vec3 fc = shadeSolid(ro, rd, fp, fn, fi, tFloat, seaHeightAt(fp.xz, t));
          // Fades out with how much water is in front of it.
          float seen = (1.0 - smoothstep(0.0, 1.5, depthIn)) * 0.72;
          col = mix(col, fc, seen);
        }
      }
    }
  } else {
    // ---- sky, with the far shore standing in front of it
    tFloat = traceSolids(ro, rd, 400.0, fi);
    col = addClouds(skyColor(rd), rd);

    float rel = el - elShore;
    // The shore tops out ~0.0525 rad above the waterline and its surf lip at
    // 0.0022; above that every lookup below would be multiplied out to nothing.
    if (rel < 0.06) {
    float sand = sandLine(az);
    float tree = treeLine(az);
    vec3  hazeC = skyColor(normalize(vec3(rd.x, 0.010, rd.z)));

    if (rel < tree) {
      vec3 surfC  = S(0.970, 0.980, 0.985);
      vec3 wet    = S(0.560, 0.520, 0.445);
      vec3 dry    = S(0.975, 0.925, 0.795);
      vec3 grove  = S(0.075, 0.150, 0.075);
      vec3 canopy = S(0.215, 0.360, 0.150);

      float surf = surfLine(az);
      vec3 land;
      if (rel < surf) {
        land = surfC;
      } else if (rel < sand) {
        float g = smoothstep(surf, sand, rel);
        land = mix(mix(surfC, wet, smoothstep(0.0, 0.30, g)), dry, smoothstep(0.22, 1.0, g));
      } else {
        float g = smoothstep(sand, tree, rel);
        land = mix(canopy, grove, smoothstep(0.12, 0.80, g));
        land = mix(mix(dry, land, smoothstep(0.0, 0.14, g)), land, 0.90);
        land += vec3(0.075, 0.060, 0.022) * pow(1.0 - g, 3.0);   // sun on the palm tops
      }

      land = mix(land, hazeC, 0.15 + smoothstep(0.0, 0.06, abs(az)) * 0.10);

      float edge = smoothstep(0.0, 0.0010, tree - rel);
      col = mix(col, land, edge);
    }

    // Whitewater where the swell meets the sand -- broken up along the beach
    // rather than one ruled line across the frame.
    float lipN = fbm(vec2(az * 95.0, 7.3), 4);
    float lipT = 0.0007 + lipN * 0.0016;
    float lip  = smoothstep(lipT, 0.0, abs(rel + 0.0003));
    col = mix(col, mix(S(0.97, 0.985, 0.99), hazeC, 0.20), lip * smoothstep(0.30, 0.75, lipN) * 0.95);
    }
  }

  // A ring in front of whatever we just drew wins outright.
  if (tFloat > 0.0) {
    vec3 fp = ro + rd * tFloat;
    if (tWater < 0.0 || tFloat <= tWater) {
      vec3 fn = solidNormal(fp, fi);
      col = shadeSolid(ro, rd, fp, fn, fi, tFloat, seaHeightAt(fp.xz, t));
    }
  }

  // ---- grade
  col = aces(col * 0.97);
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 1.26);

  // A light vignette only -- the old one was crushing the sun in the corner.
  float vig = smoothstep(1.70, 0.36, length(uv * vec2(0.90, 1.0)));
  col *= 0.97 + 0.03 * vig;

  col += (hash21(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;

  fragColor = vec4(col, 1.0);
}`;

export class Ocean {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance',
    });
    this.ok = !!this.gl;
    if (!this.ok) return;

    this.build();

    // Late afternoon: sun 15 degrees up and a little right of centre.
    const el = (9.5 * Math.PI) / 180, azm = (27 * Math.PI) / 180;
    this.sun = [Math.sin(azm) * Math.cos(el), Math.sin(el), -Math.cos(azm) * Math.cos(el)];

    // Resolution is the one knob that moves the cost of this shader: every
    // pixel runs the whole raymarch, and no single feature is more than about
    // a quarter of it. So the canvas renders at a continuously adjusted
    // fraction of CSS pixels, steered by measured GPU time (see adaptQuality).
    this.maxScale = Math.min(window.devicePixelRatio || 1, 1.25);
    this.scale = 0;             // chosen on the first resize, from a pixel budget
    this.detail = 1;
    this.adapt = true;          // benchmarks pin this off
    this.gpuMs = [];            // recent GPU frame times, when measurable
    this.gaps = [];             // recent frame intervals, the fallback signal
    this.lastFrame = 0;
    this.lastAdjust = 0;
    this.ceiling = Infinity;    // a scale that proved too slow, for a while
    this.ceilingUntil = 0;
    this.calm = 0;
    this.refresh = 0;           // the display's frame interval, learned at startup

    // Coming back to a backgrounded tab delivers a burst of long frames that
    // say nothing about the GPU. Ignore them.
    document.addEventListener('visibilitychange', () => {
      this.lastFrame = 0;
      this.gaps.length = 0;
      this.gpuMs.length = 0;
      this.calm = 0;
    });

    // iOS drops WebGL contexts under memory pressure and after a tab has sat
    // in the background. Without this the sea came back as a black rectangle
    // until the page was reloaded.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ready = false;
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.build();
      this.canvas.width = 0;           // make resize() reapply the viewport
      if (this.cssW) this.resize(this.cssW, this.cssH);
    });
  }

  build() {
    const gl = this.gl;
    // Kick the shader off without waiting for it. Asking for COMPILE_STATUS or
    // LINK_STATUS blocks until the driver is done, which cost ~70ms on the main
    // thread at startup and held up the first paint of everything else.
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.ready = false;
    this.shaders = [];
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      gl.attachShader(prog, sh);
      this.shaders.push(sh);
    }
    gl.linkProgram(prog);
    this.pendingProg = prog;
    this.vao = gl.createVertexArray();
    // GPU time per frame, read back a few frames late without ever stalling.
    // Chrome and Firefox have it; Safari falls back to frame intervals.
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.queries = [];
  }

  // True once the program is linked and usable. Without the extension this
  // blocks, which is simply the old behaviour.
  poll() {
    if (this.ready || !this.ok || this.lost) return this.ready;
    const gl = this.gl;
    if (this.parallel
        && !gl.getProgramParameter(this.pendingProg, this.parallel.COMPLETION_STATUS_KHR)) {
      return false;
    }
    for (const sh of this.shaders) {
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(sh));
        this.ok = false;
        return false;
      }
    }
    if (!gl.getProgramParameter(this.pendingProg, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(this.pendingProg));
      this.ok = false;
      return false;
    }
    this.prog = this.pendingProg;
    gl.useProgram(this.prog);
    this.u = {};
    for (const n of ['uRes','uTime','uCamPos','uCamFwd','uCamRight','uCamUp',
                     'uTanHalf','uAspect','uSunDir','uDetail','uWake','uWakeN','uWakeBox',
                     'uFloatA','uFloatB','uFloatC','uFloatR','uFloatN',
                     'uCreatA','uCreatB','uCreatN']) {
      this.u[n] = gl.getUniformLocation(this.prog, n);
    }
    this.ready = true;
    return true;
  }

  // Wait for the program, for callers that cannot render a frame later (the
  // still-frame harness).
  forceReady() {
    const saved = this.parallel;
    this.parallel = null;        // skip the "is it done yet" check and block
    const r = this.poll();
    this.parallel = saved;
    return r;
  }

  // Pixel budget for the opening frames, before there is anything measured
  // to steer by. Roughly what an integrated laptop GPU holds at 60fps; the
  // controller climbs from here if there is room.
  startScale(w, h) {
    const coarse = matchMedia('(pointer: coarse)').matches;
    const budget = coarse ? 0.5e6 : 1.25e6;
    return Math.min(this.maxScale, Math.max(0.5, Math.sqrt(budget / Math.max(1, w * h))));
  }

  setScale(scale) {
    const s = Math.max(0.5, Math.min(this.maxScale, scale));
    // Wave detail only gives way once resolution has been cut hard: a glassy
    // sea reads as broken, a soft one does not.
    this.detail = s >= 0.62 ? 1 : s >= 0.55 ? 0.8 : 0.55;
    if (Math.abs(s - this.scale) < 0.004) return;
    this.scale = s;
    this.resize(this.cssW, this.cssH);
  }

  resize(w, h) {
    if (!this.ok || !w) return;
    const first = !this.cssW;
    this.cssW = w; this.cssH = h;
    // Re-read the pixel ratio: dragging the window between a Retina panel and
    // an external monitor changes it without a reload.
    const maxScale = Math.min(window.devicePixelRatio || 1, 1.25);
    // A new pixel ratio usually means a different screen, with its own
    // refresh rate. Forget the old one and take the quicker frames as read.
    if (maxScale !== this.maxScale) this.refresh = 0;
    this.maxScale = maxScale;
    if (first || !this.scale) this.scale = this.startScale(w, h);
    this.scale = Math.min(this.scale, this.maxScale);
    const dw = Math.max(1, Math.round(w * this.scale));
    const dh = Math.max(1, Math.round(h * this.scale));
    if (this.canvas.width !== dw || this.canvas.height !== dh) {
      this.canvas.width = dw;
      this.canvas.height = dh;
      this.gl.viewport(0, 0, dw, dh);
    }
  }

  // Frame timing, recorded on every call to render() -- including the ones
  // made while the shader is still compiling. Those frames do no GPU work, so
  // their spacing is the display's own refresh interval (or whatever cap the
  // browser has imposed, like Chrome's 30fps energy saver). Without that
  // reference a GPU that is uniformly too slow is indistinguishable from a
  // 30Hz screen, and nothing would ever step down.
  track(now) {
    const gap = this.lastFrame ? now - this.lastFrame : 0;
    this.lastFrame = now;
    // A gap beyond 200ms is a stall or a throttled tab, not a frame rate.
    if (document.hidden || !(gap > 0 && gap < 200)) return;
    this.gaps.push(gap);
    // A typical one, not the quickest: callbacks can bunch up after a stall.
    // Page load can also stretch a few, which the steady-state check in
    // adaptQuality() corrects. main.js never draws faster than every 9.5ms.
    if (!this.ready && this.gaps.length >= 3) {
      const c = this.gaps.slice().sort((a, b) => a - b);
      this.refresh = Math.max(9.5, c[c.length >> 1]);
    }
  }

  // Steer the render scale by whether frames arrive on time.
  //
  // Late frames step the scale down, harder the more of them there are, and
  // so does GPU time that plainly exceeds the frame interval. A run of
  // on-time frames probes the scale back up a little. A scale that proved too
  // slow is remembered for a while, so the probe does not keep walking back
  // into the same stutter.
  //
  // GPU time cannot be the target itself: Apple GPUs clock down when there
  // is slack, so a frame's GPU time sits near the frame budget at almost any
  // resolution, and chasing it just kept shrinking the picture.
  //
  // The old ladder counted *consecutive* slow frames. A GPU at ~25ms a frame
  // alternates 16ms and 33ms frames, so every fast one reset the count and
  // the page sat at 30fps on full quality indefinitely.
  adaptQuality(now) {
    const gl = this.gl;
    while (this.queries.length) {
      const q = this.queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.queries.shift();
      const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q);
      if (!gl.getParameter(this.timer.GPU_DISJOINT_EXT) && ms > 0) this.gpuMs.push(ms);
    }
    if (this.gpuMs.length > 60) this.gpuMs.splice(0, this.gpuMs.length - 60);
    if (this.gaps.length < 60 || now - this.lastAdjust < 800) return;

    const sorted = this.gaps.slice().sort((a, b) => a - b);
    this.gaps.length = 0;
    this.lastAdjust = now;
    // No clean reading from startup (a cached shader that was ready at once,
    // a restored context): assume nothing slower than 60Hz is intended.
    const quick = sorted[Math.floor(sorted.length * 0.1)];
    const interval = this.refresh || Math.min(quick, 16.7);
    // Frames can arrive no faster than the display, so a window whose quicker
    // frames beat the estimate proves it was too long.
    if (this.refresh && quick < this.refresh * 0.9) this.refresh = Math.max(9.5, quick);
    const late = sorted.filter((g) => g > interval * 1.45).length / sorted.length;
    // Falling behind can also be spread evenly -- every frame a little long,
    // none of them a clear drop -- so judge the average pace as well.
    const behind = sorted.reduce((a, b) => a + b, 0) / sorted.length / interval;
    const gpu = this.gpuMs.length >= 10
      ? this.gpuMs.slice().sort((a, b) => a - b)[this.gpuMs.length >> 1] : 0;

    if (late > 0.04 || behind > 1.08 || gpu > interval * 1.05) {
      this.ceiling = this.scale;
      this.ceilingUntil = now + 60000;
      this.calm = 0;
      this.gpuMs.length = 0;
      let k = late > 0.4 || behind > 1.4 ? 0.8 : late > 0.2 || behind > 1.2 ? 0.88 : 0.94;
      // Cost goes with pixel count, so a measured overrun says how far to go.
      if (gpu > interval) k = Math.min(k, Math.max(0.7, Math.sqrt((interval * 0.85) / gpu)));
      this.setScale(this.scale * k);
      return;
    }
    if (behind > 1.03 || ++this.calm < 2) return;
    this.calm = 0;
    // Plainly out of headroom. (A down-clocked GPU reads ~0.8 of the budget
    // with room to spare, so this only stops a probe that is sure to fail.)
    if (gpu > interval * 0.92) return;
    // The page's own compositing (the frosted cards) shares the GPU but not
    // the timer, so leave clear room under a scale that has already failed.
    const cap = now < this.ceilingUntil ? this.ceiling * 0.92 : Infinity;
    const next = Math.min(this.scale * 1.06, cap);
    if (next > this.scale + 0.01) this.setScale(next);
  }

  // wakeLists: flat [x, z, strength, radius, ...] arrays, taken in order until
  // the shader's 32 slots are full. Returns whether a frame was drawn.
  render(time, dt, wakeLists, floats, creatures) {
    if (!this.ok) return false;
    // main.js hands over the rAF timestamp: vsync-aligned, so on-time frames
    // measure exactly one interval. Reading the clock here instead jittered by
    // a millisecond or two, enough to make perfect 60fps look like a lag.
    if (this.adapt && this.stamp) this.track(this.stamp);
    if (!this.ready && !this.poll()) return false;   // shader still compiling
    const gl = this.gl, u = this.u;

    if (this.adapt && this.stamp) this.adaptQuality(this.stamp);

    gl.bindVertexArray(this.vao);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, time);
    gl.uniform3f(u.uCamPos, camera.pos.x, camera.pos.y, camera.pos.z);
    gl.uniform3f(u.uCamFwd, camera.fwd.x, camera.fwd.y, camera.fwd.z);
    gl.uniform3f(u.uCamRight, camera.right.x, camera.right.y, camera.right.z);
    gl.uniform3f(u.uCamUp, camera.up.x, camera.up.y, camera.up.z);
    // The canvas can run past the visible screen (see main.js). The shader is a
    // pinhole camera, linear in tangent space, so stretching the half-height
    // tangent by the same factor as the canvas keeps every on-screen pixel
    // exactly where it was and simply draws more sky above and more sea below.
    const k = this.overscanK || 1;
    gl.uniform1f(u.uTanHalf, camera.tanHalf * k);
    gl.uniform1f(u.uAspect, camera.aspect / k);
    gl.uniform3f(u.uSunDir, this.sun[0], this.sun[1], this.sun[2]);
    gl.uniform1f(u.uDetail, this.detail);

    const fn = Math.min(8, (floats && floats.length) || 0);
    if (fn > 0) {
      this.fA ||= new Float32Array(32);
      this.fB ||= new Float32Array(32);
      this.fC ||= new Float32Array(24);
      this.fR ||= new Float32Array(32);
      for (let i = 0; i < fn; i++) {
        const f = floats[i];
        this.fA[i * 4] = f.x; this.fA[i * 4 + 1] = f.y; this.fA[i * 4 + 2] = f.z; this.fA[i * 4 + 3] = f.majorR;
        this.fB[i * 4] = f.roll; this.fB[i * 4 + 1] = f.pitch; this.fB[i * 4 + 2] = f.minorR; this.fB[i * 4 + 3] = 1;
        this.fC[i * 3] = f.col[0]; this.fC[i * 3 + 1] = f.col[1]; this.fC[i * 3 + 2] = f.col[2];
        this.fR[i * 4] = Math.cos(f.roll); this.fR[i * 4 + 1] = Math.sin(f.roll);
        this.fR[i * 4 + 2] = Math.cos(f.pitch); this.fR[i * 4 + 3] = Math.sin(f.pitch);
      }
      gl.uniform4fv(u.uFloatA, this.fA);
      gl.uniform4fv(u.uFloatB, this.fB);
      gl.uniform3fv(u.uFloatC, this.fC);
      gl.uniform4fv(u.uFloatR, this.fR);
    }
    gl.uniform1i(u.uFloatN, fn);

    const cn = Math.min(24, (creatures && creatures.length) || 0);
    if (cn > 0) {
      this.cA ||= new Float32Array(96);
      this.cB ||= new Float32Array(96);
      for (let i = 0; i < cn; i++) {
        const c = creatures[i];
        this.cA[i * 4] = c.x; this.cA[i * 4 + 1] = c.y; this.cA[i * 4 + 2] = c.z; this.cA[i * 4 + 3] = c.len;
        this.cB[i * 4] = c.yaw; this.cB[i * 4 + 1] = c.pitch; this.cB[i * 4 + 2] = c.roll; this.cB[i * 4 + 3] = c.type;
      }
      gl.uniform4fv(u.uCreatA, this.cA);
      gl.uniform4fv(u.uCreatB, this.cB);
    }
    gl.uniform1i(u.uCreatN, cn);

    // Copied straight into the uniform buffer: concatenating and slicing the
    // lists allocated two throwaway arrays every frame.
    const buf = (this.wakeBuf ||= new Float32Array(128));
    const box = (this.wakeBox ||= new Float32Array(4));
    box[0] = box[1] = Infinity; box[2] = box[3] = -Infinity;
    let n = 0;
    for (const list of wakeLists) {
      for (let j = 0; j + 3 < list.length && n < 32; j += 4, n++) {
        const x = list[j], z = list[j + 1], s = list[j + 2], r = list[j + 3];
        buf[n * 4] = x; buf[n * 4 + 1] = z; buf[n * 4 + 2] = s; buf[n * 4 + 3] = r;
        if (s < 0.002) continue;
        // The reach of this entry, matching the early-outs in wakeField(): an
        // impact splash is a disc of 1.2x its radius; a float's collar reaches
        // 1.4r and its trail runs 40m astern (-x), fanning to 1.06x its
        // half-width there.
        let x0, x1, hz;
        if (r < 0) {
          x0 = x + r * 1.2; x1 = x - r * 1.2; hz = -r * 1.2;
        } else {
          const rr = Math.max(r, 0.4);
          x0 = x - 40; x1 = x + rr * 1.4;
          hz = Math.max(rr * 1.4, 1.06 * (rr * 0.34 + 40 * 0.072));
        }
        box[0] = Math.min(box[0], x0 - 0.1); box[1] = Math.min(box[1], z - hz - 0.1);
        box[2] = Math.max(box[2], x1 + 0.1); box[3] = Math.max(box[3], z + hz + 0.1);
      }
    }
    if (box[0] > box[2]) { box[0] = box[1] = 1e9; box[2] = box[3] = -1e9; }
    if (n > 0) gl.uniform4fv(u.uWake, buf);
    gl.uniform1i(u.uWakeN, n);
    gl.uniform4fv(u.uWakeBox, box);
    // At most a handful of queries in flight, never a pile of them if the
    // results stop coming back.
    const q = this.adapt && this.timer && this.queries.length < 6 ? gl.createQuery() : null;
    if (q) gl.beginQuery(this.timer.TIME_ELAPSED_EXT, q);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (q) { gl.endQuery(this.timer.TIME_ELAPSED_EXT); this.queries.push(q); }
    return true;
  }
}
