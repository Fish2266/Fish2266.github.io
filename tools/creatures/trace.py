# Trace reference silhouettes into body profiles and fin polygons.
import struct, math, json, zlib, sys
from collections import deque

def load_mask(name):
    d = open(name + '.mask', 'rb').read()
    w, h = struct.unpack('>II', d[:8])
    rows = [d[8 + y * w: 8 + (y + 1) * w] for y in range(h)]
    return w, h, rows

# ---------------------------------------------------------------- sampling
class Sil:
    """A silhouette resampled onto a normalised grid: x in [-1,1] nose at +1,
    y up, same scale on both axes."""
    def __init__(self, name, orient, res=720):
        w, h, rows = load_mask(name)
        pts = [(x, y) for y in range(0, h, 2) for x in range(0, w, 2) if rows[y][x]]
        # principal axis
        mx = sum(p[0] for p in pts) / len(pts); my = sum(p[1] for p in pts) / len(pts)
        sxx = sum((p[0] - mx) ** 2 for p in pts); syy = sum((p[1] - my) ** 2 for p in pts)
        sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
        ang = 0.5 * math.atan2(2 * sxy, sxx - syy)
        if orient == 'side_left':      # nose left, axis roughly horizontal
            theta = ang
            flip = True
        elif orient == 'top_up':       # nose up, axis vertical
            theta = ang
            flip = False
        self.src = (w, h, rows)
        c, s = math.cos(theta), math.sin(theta)
        # Map source pixel -> axis frame (u along axis, v across; image y down).
        def fwd(x, y):
            dx, dy = x - mx, y - my
            return dx * c + dy * s, -dx * s + dy * c
        us = []; vs = []
        for (x, y) in pts:
            u, v = fwd(x, y); us.append(u); vs.append(v)
        umin, umax = min(us), max(us); vmin, vmax = min(vs), max(vs)
        self.theta, self.mx, self.my = theta, mx, my
        L = (umax - umin) / 2.0
        self.L = L
        # grid covering the silhouette in axis frame
        self.nx = res
        self.ny = int(res * (vmax - vmin) / (umax - umin)) + 8
        self.grid = []
        for j in range(self.ny):
            v = vmin - 4 * (umax - umin) / res + j * (umax - umin) / res
            row = bytearray(self.nx)
            for i in range(self.nx):
                u = umin + (i + 0.5) * (umax - umin) / res
                # back to source
                x = mx + u * c - v * s
                y = my + u * s + v * c
                xi, yi = int(round(x)), int(round(y))
                if 0 <= xi < w and 0 <= yi < h and rows[yi][xi]:
                    row[i] = 1
            self.grid.append(row)
        self.umin, self.umax, self.vmin = umin, umax, vmin - 4 * (umax - umin) / res
        self.flip = flip
        self.orient = orient
        self.mirror = False

    # grid cell -> normalised coords
    def norm(self, i, j):
        u = self.umin + (i + 0.5) * (self.umax - self.umin) / self.nx
        v = self.vmin + (j + 0.5) * (self.umax - self.umin) / self.nx
        x = (u - (self.umin + self.umax) / 2) / self.L
        y = -v / self.L
        x = -x
        if self.mirror:
            x = -x
        return x, y

def column_extents(S):
    """For each normalised x sample, the top and bottom of ink."""
    N = S.nx
    top = [None] * N; bot = [None] * N
    for i in range(N):
        js = [j for j in range(S.ny) if S.grid[j][i]]
        if js:
            _, y0 = S.norm(i, js[0]); _, y1 = S.norm(i, js[-1])
            top[i] = max(y0, y1); bot[i] = min(y0, y1)
    xs = [S.norm(i, 0)[0] for i in range(N)]
    return xs, top, bot

def rolling(vals, win, fn):
    n = len(vals); out = [None] * n
    for i in range(n):
        seg = [v for v in vals[max(0, i - win): min(n, i + win + 1)] if v is not None]
        out[i] = fn(seg) if seg else None
    return out

def opening(vals, win):   # remove narrow peaks
    return rolling(rolling(vals, win, min), win, max)
def closing(vals, win):   # remove narrow dips
    return rolling(rolling(vals, win, max), win, min)

def smooth(vals, win):
    n = len(vals); out = [None] * n
    for i in range(n):
        seg = [v for v in vals[max(0, i - win): min(n, i + win + 1)] if v is not None]
        out[i] = sum(seg) / len(seg) if seg else None
    return out

# ---------------------------------------------------------------- polygons
def components(mask, nx, ny, min_area):
    seen = [bytearray(nx) for _ in range(ny)]
    comps = []
    for j in range(ny):
        for i in range(nx):
            if mask[j][i] and not seen[j][i]:
                q = deque([(i, j)]); seen[j][i] = 1; cells = []
                while q:
                    a, b = q.popleft(); cells.append((a, b))
                    for da, db in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        c, d = a + da, b + db
                        if 0 <= c < nx and 0 <= d < ny and mask[d][c] and not seen[d][c]:
                            seen[d][c] = 1; q.append((c, d))
                if len(cells) >= min_area:
                    comps.append(cells)
    return comps

def boundary_loop(cells):
    """Crack-boundary of a pixel set, as the longest closed loop of corners."""
    S = set(cells)
    nxt = {}
    for (i, j) in cells:
        # edges oriented with the inside on the left (y down grid)
        if (i, j - 1) not in S: nxt.setdefault((i, j), []).append((i + 1, j))
        if (i + 1, j) not in S: nxt.setdefault((i + 1, j), []).append((i + 1, j + 1))
        if (i, j + 1) not in S: nxt.setdefault((i + 1, j + 1), []).append((i, j + 1))
        if (i - 1, j) not in S: nxt.setdefault((i, j + 1), []).append((i, j))
    loops = []
    while nxt:
        start = next(iter(nxt)); loop = [start]; cur = start
        while True:
            outs = nxt.get(cur)
            if not outs: break
            n2 = outs.pop()
            if not outs: del nxt[cur]
            if n2 == start: break
            loop.append(n2); cur = n2
        loops.append(loop)
    return max(loops, key=len)

def dp(points, eps):
    if len(points) < 3: return points
    a, b = points[0], points[-1]
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy) or 1e-9
    best, idx = 0, 0
    for k in range(1, len(points) - 1):
        p = points[k]
        dist = abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / L
        if dist > best: best, idx = dist, k
    if best > eps:
        return dp(points[:idx + 1], eps)[:-1] + dp(points[idx:], eps)
    return [a, b]

def simplify_closed(loop, eps):
    # split at the farthest pair so DP works on an open chain
    far = max(range(len(loop)), key=lambda k: (loop[k][0] - loop[0][0]) ** 2 + (loop[k][1] - loop[0][1]) ** 2)
    a = dp(loop[:far + 1], eps); b = dp(loop[far:] + [loop[0]], eps)
    return a[:-1] + b[:-1]

def area(poly):
    return 0.5 * sum(poly[i][0] * poly[i - 1][1] - poly[i - 1][0] * poly[i][1] for i in range(len(poly)))

# ---------------------------------------------------------------- PNG out
def write_png(path, w, h, pix):
    raw = b''.join(b'\x00' + bytes(pix[y]) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
                           + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

def inside(poly, x, y):
    c = False
    for k in range(len(poly)):
        x1, y1 = poly[k]; x2, y2 = poly[k - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c
