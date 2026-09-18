import json, math, sys

shark = json.load(open('shark.json'))
dside = json.load(open('dolphin_side.json'))
dtop = json.load(open('dolphin_top.json'))

def f(v): return f'{v:.4f}'

def interp(prof, x, idx):
    # prof entries are (x, c, h), x descending from +1
    xs = [p[0] for p in prof]
    for k in range(len(prof) - 1):
        if xs[k] >= x >= xs[k + 1]:
            t = (xs[k] - x) / (xs[k] - xs[k + 1])
            return prof[k][idx] * (1 - t) + prof[k + 1][idx] * t
    return prof[0][idx] if x > xs[0] else prof[-1][idx]

K = len(shark['profile'])

# ---- shark: width isn't in a side view, so estimate it from the height.
# Requiem sharks are broader than deep at the snout and flatten toward the tail.
sh_c = [p[1] for p in shark['profile']]
sh_h = [p[2] for p in shark['profile']]
sh_w = []
for p in shark['profile']:
    x = p[0]
    t = max(0.0, min(1.0, (x - shark['xp']) / (1 - shark['xp'])))
    ratio = 0.80 + 0.26 * t ** 1.4
    sh_w.append(p[2] * ratio)

# ---- dolphin: height from the side view, width measured from the top view.
do_c = [p[1] for p in dside['profile']]
do_h = [p[2] for p in dside['profile']]
do_x = [p[0] for p in dside['profile']]

# The reference is drawn mid-arch, its tail bent ~30 degrees downward. That is
# the pose, not the anatomy, and a flat fluke on a bent tailstock reads as a
# snapped tail. Straighten the spine behind the dorsal region by continuing the
# mid-body centreline, and keep the traced depth.
TAIL0 = -0.40
k0 = min(range(len(do_x)), key=lambda k: abs(do_x[k] - TAIL0))
k1 = min(range(len(do_x)), key=lambda k: abs(do_x[k] - (-0.10)))
slope = (do_c[k0] - do_c[k1]) / (do_x[k0] - do_x[k1])     # mid-body trend
for k in range(len(do_x)):
    if do_x[k] < TAIL0:
        straight = do_c[k0] + slope * (do_x[k] - do_x[k0])
        blend = min(1.0, (TAIL0 - do_x[k]) / 0.12)            # ease in over 0.12
        do_c[k] = do_c[k] * (1 - blend) + straight * blend

# In the side view the fluke is seen edge-on and its near tip hangs below the
# tailstock, which the trace reads as a lump. A tailstock only ever narrows
# toward the flukes, so force depth to be non-increasing, then smooth it.
run = None
for k in range(len(do_x)):
    if do_x[k] < -0.45:
        run = do_h[k] if run is None else min(run, do_h[k])
        do_h[k] = run
sm = do_h[:]
for k in range(1, len(do_x) - 1):
    if do_x[k] < -0.40:
        sm[k] = (do_h[k - 1] + 2 * do_h[k] + do_h[k + 1]) / 4
do_h = sm
do_w = [max(0.0, interp(dtop['profile'], p[0], 2)) for p in dside['profile']]
# Close off the width where the side view closes off the body.
do_w = [w if h > 0 else 0.0 for w, h in zip(do_w, do_h)]

# Height and width must close off together. Where one had already reached zero
# and the other hadn't, the slice became a sheet thousands of times taller than
# wide, and the ellipse distance estimate reports "on the surface" anywhere near
# that sheet's plane -- the tracer drew it as a needle through the tail.
MIN_R = 0.012
for k in range(len(do_h)):
    if min(do_h[k], do_w[k]) < MIN_R:
        do_h[k] = do_w[k] = 0.0
# ...and ease both to zero over the last few live slices so the tip is rounded.
live = [k for k in range(len(do_h)) if do_h[k] > 0 and do_x[k] < 0]
for j, k in enumerate(reversed(live[-3:])):
    fac = (j + 1) / 4.0
    do_h[k] *= fac ** 0.5; do_w[k] *= fac ** 0.5

def chaikin(poly, iters=1):
    for _ in range(iters):
        out = []
        n = len(poly)
        for i in range(n):
            (ax, ay), (bx, by) = poly[i], poly[(i + 1) % n]
            out.append((0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by))
            out.append((0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by))
        poly = out
    return poly

verts = []
fins = {}
def add_fin(key, poly, **meta):
    poly = chaikin(poly)
    s = len(verts)
    verts.extend(poly)
    xs = [v[0] for v in poly]; ys = [v[1] for v in poly]
    fins[key] = dict(start=s, count=len(poly), bb=(min(xs), min(ys), max(xs), max(ys)), **meta)

def pick(data, kind, near_x):
    c = [fn for fn in data['fins'] if fn['kind'] == kind]
    return min(c, key=lambda fn: abs(fn['cx'] - near_x))

# Shark fins traced in the side view.
add_fin('SH_DORSAL', pick(shark, 'upper', 0.19)['poly'], th=0.020)
add_fin('SH_DORSAL2', pick(shark, 'upper', -0.37)['poly'], th=0.010)
add_fin('SH_ANAL', pick(shark, 'lower', -0.38)['poly'], th=0.009)
add_fin('SH_TAIL', pick(shark, 'tail', -0.69)['poly'], th=0.016)
# The pectoral seen side-on: turn its downward reach into span below the flank.
pec = pick(shark, 'lower', 0.41)['poly']
root_y = interp(shark['profile'], 0.41, 1) - interp(shark['profile'], 0.41, 2) * 0.55
# The side view shows the pectoral's reach; use that as its true span, spread
# out like a wing at a shallow angle. Stretching it by 1/sin(tilt) to "undo"
# foreshortening made it hang straight down like a leg.
sh_tilt = math.radians(30)
add_fin('SH_PEC', [(x, -(y - root_y) * 0.95) for x, y in pec], th=0.013)
sh_pec_root = (root_y, interp(shark['profile'], 0.41, 2) * 0.80)

# Dolphin: dorsal from the side, flippers and flukes from the top.
add_fin('DO_DORSAL', pick(dside, 'upper', -0.11)['poly'], th=0.020)
add_fin('DO_FLUKE', pick(dtop, 'tail', -0.89)['poly'], th=0.013)
flip = [fn for fn in dtop['fins'] if fn['kind'] in ('upper', 'lower') and abs(fn['cx'] - 0.33) < 0.1]
flip = max(flip, key=lambda fn: fn['cy'])          # the +z one
fx = flip['cx']
root_z = interp(dtop['profile'], fx, 2) * 0.70
tilt = math.radians(38)
# Keep the top-view planform: stretch lateral reach by 1/cos so it still spans
# the same width seen from above once it is angled down.
add_fin('DO_PEC', [(x, (z - root_z) / math.cos(tilt)) for x, z in flip['poly']], th=0.012)
do_pec_root = (interp([(x, c, h) for x, c, h in zip(do_x, do_c, do_h)], fx, 1) - interp(dside['profile'], fx, 2) * 0.45, root_z)
do_fluke_y = interp([(x, c, h) for x, c, h in zip(do_x, do_c, do_h)], dside['xp'], 1)

sh_ped = interp(shark['profile'], shark['xp'] + 0.1, 2)

L = []
L.append('// Traced from CC0 reference silhouettes on PhyloPic: Carcharhinus obscurus')
L.append('// (Margot Michaud); Tursiops truncatus side view (Kai Caspar) and top view')
L.append('// (Guillaume Dera). Nose at +x, x in [-1,1], y up, z lateral.')
L.append(f'const int PROF_N = {K};')
for nm, arr in (('SH_C', sh_c), ('SH_H', sh_h), ('SH_W', sh_w), ('DO_C', do_c), ('DO_H', do_h), ('DO_W', do_w)):
    L.append(f'const float {nm}[{K}] = float[{K}]({", ".join(f(v) for v in arr)});')
L.append(f'const vec2 FIN_V[{len(verts)}] = vec2[{len(verts)}](' + ', '.join(f'vec2({f(x)}, {f(y)})' for x, y in verts) + ');')
for key, m in fins.items():
    bb = m['bb']
    L.append(f'const int {key}_S = {m["start"]}; const int {key}_N = {m["count"]}; '
             f'const vec4 {key}_B = vec4({f(bb[0])}, {f(bb[1])}, {f(bb[2])}, {f(bb[3])}); const float {key}_T = {m["th"]:.4f};')
L.append(f'const float SH_PEC_ROOT_Y = {f(sh_pec_root[0])}; const float SH_PEC_ROOT_Z = {f(sh_pec_root[1])}; const float SH_PEC_TILT = {sh_tilt:.4f};')
L.append(f'const float DO_PEC_ROOT_Y = {f(do_pec_root[0])}; const float DO_PEC_ROOT_Z = {f(do_pec_root[1])};')
L.append(f'const float DO_PEC_TILT = {tilt:.4f};')
L.append(f'const float DO_FLUKE_Y = {f(do_fluke_y)};')

src = '\n'.join(L)
out = sys.argv[1]
open(out, 'w').write('// Generated by build_glsl.py from traced reference silhouettes. Do not edit.\nexport const CREATURE_GLSL = `\n' + src + '\n`;\n')
print('fins:', {k: (v['count'], round(v['th'], 3)) for k, v in fins.items()})
print('max fin verts', max(m['count'] for m in fins.values()), '| total verts', len(verts), '| max shark h', round(max(sh_h), 3), '| max dolphin h', round(max(do_h), 3), 'w', round(max(do_w), 3))
