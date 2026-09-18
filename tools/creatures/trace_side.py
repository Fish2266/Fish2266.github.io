import sys, json, math
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from trace import *

name = sys.argv[1]
WINS = sys.argv[2].split(':')
WIN_TOP = int(WINS[0]); WIN_BOT = int(WINS[-1])   # radii, in samples
PED_LO, PED_HI = float(sys.argv[3]), float(sys.argv[4])   # peduncle search range in x
out = sys.argv[5]
orient = sys.argv[6] if len(sys.argv) > 6 else 'side_left'

S = Sil(name, orient, res=720)
N = S.nx
xs, top, bot = column_extents(S)
if orient == 'top_up':
    # The fluke end is the wide one. Make sure it sits at -x.
    def meanw(a, b):
        v = [top[i] - bot[i] for i in range(N) if top[i] is not None and a <= xs[i] <= b]
        return sum(v) / max(1, len(v))
    if meanw(0.85, 0.97) > meanw(-0.97, -0.85):
        S.mirror = True
        xs, top, bot = column_extents(S)
    print('top view mirrored' if S.mirror else 'top view as-is')

top_env = smooth(opening(top, WIN_TOP), 10)
bot_env = smooth(closing(bot, WIN_BOT), 10)

# Peduncle: the thinnest point of the body envelope in the rear.
cand = [i for i in range(N) if top_env[i] is not None and PED_LO <= xs[i] <= PED_HI]
ip = min(cand, key=lambda i: top_env[i] - bot_env[i])
xp = xs[ip]
print(f'{name}: L={S.L:.1f}px grid={N}x{S.ny} peduncle x={xp:.3f} thickness={top_env[ip]-bot_env[ip]:.3f}')

# Recentre vertically on the body's mean centreline so y=0 runs down the spine.
mid = [ (top_env[i] + bot_env[i]) / 2 for i in range(N) if top_env[i] is not None and xp < xs[i] < 0.9 ]
y0 = sum(mid) / len(mid)

EPS = 0.006
col_i = {}
fin = [bytearray(N) for _ in range(S.ny)]
for j in range(S.ny):
    for i in range(N):
        if not S.grid[j][i]: continue
        x, y = S.norm(i, j)
        if top_env[i] is None: continue
        if x <= xp + 0.004 or y > top_env[i] + EPS or y < bot_env[i] - EPS:
            fin[j][i] = 1

comps = components(fin, N, S.ny, min_area=12)
polys = []
for cells in comps:
    xsC = [S.norm(i, j)[0] for (i, j) in cells]; ysC = [S.norm(i, j)[1] for (i, j) in cells]
    cx = sum(xsC) / len(xsC); cy = sum(ysC) / len(ysC)
    is_tail = min(xsC) < xp + 0.01 and max(xsC) < xp + 0.08
    upper = cy > (top_env[int(sum(i for i, _ in cells) / len(cells))] or 0) - 0.02
    # Grow the fin's base down into the body so it is anchored, not balanced on it.
    cs = set(cells)
    irange = range(min(i for i, _ in cells), max(i for i, _ in cells) + 1)
    MARG = 0.035
    for i in irange:
        for j in range(S.ny):
            if not S.grid[j][i] or (i, j) in cs: continue
            x, y = S.norm(i, j)
            if is_tail:
                if x <= xp + 0.07: cs.add((i, j))
            elif upper and top_env[i] - MARG <= y <= top_env[i] + EPS:
                cs.add((i, j))
            elif not upper and bot_env[i] - EPS <= y <= bot_env[i] + MARG:
                cs.add((i, j))
    loop = boundary_loop(list(cs))
    # corner (i,j) -> normalised
    pts = []
    for (i, j) in loop:
        x, y = S.norm(i - 0.5, j - 0.5)
        pts.append((round(x, 4), round(y - y0, 4)))
    poly = simplify_closed(pts, 0.0045)
    kind = 'tail' if is_tail else ('upper' if upper else 'lower')
    polys.append({'kind': kind, 'cx': round(cx, 3), 'cy': round(cy - y0, 3), 'area': round(abs(area(poly)), 5), 'poly': poly})
    print(f'  fin {kind:5s} centre=({cx:+.3f},{cy - y0:+.3f}) cells={len(cells)} verts={len(poly)}')

# Body profile, sampled uniformly nose to tail.
K = 65
prof = []
for k in range(K):
    x = 1 - 2 * k / (K - 1)
    i = min(range(N), key=lambda ii: abs(xs[ii] - x))
    if top_env[i] is None or x < xp - 0.035:
        prof.append((round(x, 4), 0.0, 0.0)); continue
    c = (top_env[i] + bot_env[i]) / 2 - y0
    h = max(0.0, (top_env[i] - bot_env[i]) / 2)
    if x < xp:  # close the body off only behind the peduncle; the tail fin overlaps it
        h *= max(0.0, (x - (xp - 0.035)) / 0.035)
    prof.append((round(x, 4), round(c, 4), round(h, 4)))

json.dump({'name': name, 'xp': xp, 'y0': y0, 'mirror': S.mirror, 'profile': prof, 'fins': polys}, open(out, 'w'), indent=1)

# --- overlay: reference grey, reconstruction red, overlap dark red
W, H = N, S.ny
pix = []
for j in range(H):
    row = []
    for i in range(W):
        x, y = S.norm(i, j); yy = y - y0
        ref = S.grid[j][i]
        k = (1 - x) / 2 * (K - 1); k0 = min(K - 2, max(0, int(k))); fr = k - k0
        c = prof[k0][1] * (1 - fr) + prof[k0 + 1][1] * fr
        h = prof[k0][2] * (1 - fr) + prof[k0 + 1][2] * fr
        model = h > 0 and abs(yy - c) <= h
        if not model:
            for f in polys:
                if inside(f['poly'], x, yy): model = True; break
        if ref and model: row += [150, 20, 30]
        elif model: row += [255, 60, 60]
        elif ref: row += [170, 170, 170]
        else: row += [255, 255, 255]
    pix.append(row)
write_png(out.replace('.json', '_overlay.png'), W, H, pix)
print('wrote', out)
