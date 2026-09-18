// One camera, shared by the shader and by the cards floating on the water,
// so a card lands exactly where the sea it is sitting on gets drawn.

const V = (x, y, z) => ({ x, y, z });
const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const norm = (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return V(a.x / l, a.y / l, a.z / l); };

export const camera = {
  pos: V(0, 5.20, 12.0),
  target: V(0, -0.41, -16.0),
  fovY: (49 * Math.PI) / 180,
  fwd: V(0, 0, -1),
  right: V(1, 0, 0),
  up: V(0, 1, 0),
  tanHalf: Math.tan((49 * Math.PI) / 360),
  aspect: 1,
  width: 1,
  height: 1,

  resize(w, h) {
    this.width = w;
    this.height = h;
    this.aspect = w / h;
    // Widen the vertical field on tall screens so the horizon keeps its place.
    const fov = this.aspect < 1.0 ? this.fovY * 1.28 : this.fovY;
    this.tanHalf = Math.tan(fov / 2);
  },

  update() {
    this.fwd = norm(sub(this.target, this.pos));
    this.right = norm(cross(this.fwd, V(0, 1, 0)));
    this.up = cross(this.right, this.fwd);
  },

  // World point -> { x, y (css px), scale (px per world unit), depth }
  project(p) {
    const v = sub(p, this.pos);
    const z = dot(v, this.fwd);
    if (z <= 0.01) return null;
    const x = dot(v, this.right) / z / (this.tanHalf * this.aspect);
    const y = dot(v, this.up) / z / this.tanHalf;
    return {
      x: (x * 0.5 + 0.5) * this.width,
      y: (0.5 - y * 0.5) * this.height,
      scale: this.height * 0.5 / this.tanHalf / z,
      depth: z,
    };
  },
};
