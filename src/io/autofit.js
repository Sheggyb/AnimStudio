// Auto-fit: guess a humanoid's joints from its mesh.
//
// The front silhouette is drawn into a grid; a distance field says how thick the body is at
// every cell, and the geodesic distance from the middle of the torso finds the ends of the
// limbs (head top, hands, feet). Each limb's centre line is the path back to the torso along the
// ridge of the distance field: the shoulder is where that line enters the thick torso, the wrist
// the narrowing before the hand, the neck the narrowest row under the head. Depth comes from the
// mesh itself (joints sit in the middle of the body). Arms that touch the body in the
// silhouette fall back to slicing the mesh.
import * as THREE from 'three';

/** Vertices and triangles of every visible mesh, in model space, as displayed (skinning applied). */
export function collectMesh(root, maxVerts = 200000) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const meshes = [];
  root.traverse((o) => o.isMesh && o.visible !== false && meshes.push(o));
  let total = 0;
  for (const m of meshes) total += m.geometry.attributes.position.count;
  const step = Math.max(1, Math.ceil(total / maxVerts));
  const pos = [];
  const tris = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const M = inv.clone().multiply(m.matrixWorld);
    const g = m.geometry;
    const n = g.attributes.position.count;
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      if (m.isSkinnedMesh) m.getVertexPosition(i, v);
      else v.fromBufferAttribute(g.attributes.position, i);
      v.applyMatrix4(M);
      pos.push(v.x, v.y, v.z);
    }
    if (step === 1) {
      const idx = g.index ? g.index.array : null;
      const cnt = idx ? idx.length : n;
      for (let t = 0; t + 2 < cnt; t += 3) tris.push(base + (idx ? idx[t] : t), base + (idx ? idx[t + 1] : t + 1), base + (idx ? idx[t + 2] : t + 2));
    }
  }
  return { pos: Float32Array.from(pos), tris: Uint32Array.from(tris) };
}

/** A 2D occupancy grid of the mesh seen along one axis ('z': front view x/y, 'x': side view z/y). */
function silhouette(mesh, box, cell, along = 'z') {
  const ax = along === 'z' ? 0 : 2; // horizontal axis of the image
  const x0 = box.min.getComponent(ax) - cell * 2,
    y0 = box.min.y - cell * 2;
  const W = Math.ceil((box.max.getComponent(ax) - x0) / cell) + 3,
    H = Math.ceil((box.max.y - y0) / cell) + 3;
  const occ = new Uint8Array(W * H);
  const { pos, tris } = mesh;
  const gx = (i) => (pos[i * 3 + ax] - x0) / cell;
  const gy = (i) => (pos[i * 3 + 1] - y0) / cell;
  const mark = (x, y) => {
    const xi = Math.floor(x),
      yi = Math.floor(y);
    if (xi >= 0 && yi >= 0 && xi < W && yi < H) occ[yi * W + xi] = 1;
  };
  if (tris.length) {
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t],
        b = tris[t + 1],
        c = tris[t + 2];
      const ax_ = gx(a), ay = gy(a), bx = gx(b), by = gy(b), cx = gx(c), cy = gy(c);
      const minx = Math.floor(Math.min(ax_, bx, cx)), maxx = Math.floor(Math.max(ax_, bx, cx));
      const miny = Math.floor(Math.min(ay, by, cy)), maxy = Math.floor(Math.max(ay, by, cy));
      if (maxx - minx < 1 && maxy - miny < 1) {
        mark(ax_, ay);
        continue;
      }
      // fill the triangle (cell centres inside it), plus its corners so thin slivers count
      const area = (bx - ax_) * (cy - ay) - (by - ay) * (cx - ax_);
      mark(ax_, ay), mark(bx, by), mark(cx, cy);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = miny; y <= maxy; y++)
        for (let x = minx; x <= maxx; x++) {
          const px = x + 0.5,
            py = y + 0.5;
          const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
          const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax_ - px)) / area;
          if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) mark(px, py);
        }
    }
  } else for (let i = 0; i < pos.length / 3; i++) for (const [dx, dy] of [[0, 0], [0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]]) mark(gx(i) + dx, gy(i) + dy);
  // close pin holes (dilate, then erode)
  const morph = (src, keep) => {
    const out = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += src[(y + dy) * W + x + dx];
        out[y * W + x] = keep(n, src[y * W + x]) ? 1 : 0;
      }
    return out;
  };
  const closed = morph(morph(occ, (n) => n > 0), (n) => n === 9);
  for (let i = 0; i < W * H; i++) closed[i] |= occ[i];
  return { occ: closed, W, H, x0, y0, cell, ax };
}

/** Chamfer distance (in cells) from every occupied cell to the nearest empty one. */
function distanceField({ occ, W, H }) {
  const D = new Float32Array(W * H);
  const BIG = 1e9;
  for (let i = 0; i < W * H; i++) D[i] = occ[i] ? BIG : 0;
  const r2 = Math.SQRT2;
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!D[i]) continue;
      D[i] = Math.min(D[i], D[i - 1] + 1, D[i - W] + 1, D[i - W - 1] + r2, D[i - W + 1] + r2);
    }
  for (let y = H - 2; y > 0; y--)
    for (let x = W - 2; x > 0; x--) {
      const i = y * W + x;
      if (!D[i]) continue;
      D[i] = Math.min(D[i], D[i + 1] + 1, D[i + W] + 1, D[i + W + 1] + r2, D[i + W - 1] + r2);
    }
  return D;
}

class Heap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(id, p) {
    const a = this.a;
    a.push([id, p]);
    let i = a.length - 1;
    while (i > 0) {
      const u = (i - 1) >> 1;
      if (a[u][1] <= a[i][1]) break;
      [a[u], a[i]] = [a[i], a[u]];
      i = u;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && a[c + 1][1] < a[c][1]) c++;
        if (a[c][1] >= a[i][1]) break;
        [a[c], a[i]] = [a[i], a[c]];
        i = c;
      }
    }
    return top;
  }
}

/** Dijkstra over occupied cells from `seed`; cost(i, len) per step. Returns { dist, prev }. */
function paths({ occ, W, H }, seed, cost) {
  const dist = new Float64Array(W * H).fill(Infinity);
  const prev = new Int32Array(W * H).fill(-1);
  const heap = new Heap();
  dist[seed] = 0;
  heap.push(seed, 0);
  const N = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.size) {
    const [i, d] = heap.pop();
    if (d > dist[i]) continue;
    const x = i % W,
      y = (i / W) | 0;
    for (const [dx, dy, len] of N) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (!occ[j]) continue;
      const nd = d + cost(j, len);
      if (nd < dist[j]) {
        dist[j] = nd;
        prev[j] = i;
        heap.push(j, nd);
      }
    }
  }
  return { dist, prev };
}

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** Point at fraction f of a polyline's length. */
export function pointAlong(path, f) {
  let total = 0;
  const segs = [];
  for (let i = 1; i < path.length; i++) {
    const l = path[i].distanceTo(path[i - 1]);
    segs.push(l);
    total += l;
  }
  let target = Math.max(0, Math.min(1, f)) * total;
  for (let i = 1; i < path.length; i++) {
    if (target <= segs[i - 1] || i === path.length - 1) return path[i - 1].clone().lerp(path[i], Math.min(1, target / (segs[i - 1] || 1)));
    target -= segs[i - 1];
  }
  return path[path.length - 1].clone();
}
/** Index along a polyline at fraction f of its length. */
function indexAlong(path, f) {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += path[i].distanceTo(path[i - 1]);
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    acc += path[i].distanceTo(path[i - 1]);
    if (acc >= f * total) return i;
  }
  return path.length - 1;
}

/**
 * Guess every marker from the mesh. Assumes Y-up; finds the facing from the feet.
 * Returns { markers: {key: Vector3}, facing, center, height, ground, fingers: {L, R} | null }.
 */
export function autoFind(root, { fingers = true, symmetric = true } = {}) {
  const mesh = collectMesh(root);
  const P = mesh.pos;
  const nPts = P.length / 3;
  const pts = [];
  const stride = Math.max(1, Math.floor(nPts / 80000));
  for (let i = 0; i < nPts; i += stride) pts.push(new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]));
  const box = new THREE.Box3().setFromPoints(pts);
  const H = box.max.y - box.min.y;
  const g = box.min.y;
  const at = (f) => g + f * H;
  const slice = (f, tol = 0.02) => pts.filter((p) => Math.abs(p.y - at(f)) < tol * H);

  // --- centre line and facing (from the legs and feet, which nothing covers)
  const legsBand = pts.filter((p) => p.y >= at(0.05) && p.y <= at(0.3));
  const lx = legsBand.map((p) => p.x).sort((a, b) => a - b);
  const cx = lx.length ? (lx[Math.floor(lx.length * 0.02)] + lx[Math.floor(lx.length * 0.98)]) / 2 : (box.min.x + box.max.x) / 2;
  const feetPts = pts.filter((p) => p.y <= at(0.05) && Math.abs(p.x - cx) > 0.03 * H);
  const fz = mean(slice(0.09, 0.015).filter((p) => Math.abs(p.x - cx) > 0.03 * H).map((p) => p.z));
  const zs = feetPts.map((p) => p.z).sort((a, b) => a - b);
  const pct = (q) => (zs.length ? zs[Math.min(zs.length - 1, Math.floor(q * zs.length))] : fz);
  const facing = fz - pct(0.05) > 1.3 * (pct(0.95) - fz) ? -1 : 1; // glTF faces +Z; flip only when the toes clearly point back
  const leftSgn = facing; // facing +Z: the character's left is +X

  // Depth: the middle of the body at (x, y) — between the front and back of the mesh there.
  const depthAt = (x, y, r = 0.02 * H, fallback = null) => {
    let lo = Infinity,
      hi = -Infinity;
    for (const p of pts)
      if (Math.abs(p.y - y) < r && Math.abs(p.x - x) < r) {
        if (p.z < lo) lo = p.z;
        if (p.z > hi) hi = p.z;
      }
    return lo <= hi ? (lo + hi) / 2 : fallback ?? (box.min.z + box.max.z) / 2;
  };

  // --- front silhouette, thickness and geodesic distance from the torso
  const cell = H / 200;
  const S = silhouette(mesh, box, cell, 'z');
  const D = distanceField(S);
  const toCell = (x, y) => Math.floor((y - S.y0) / cell) * S.W + Math.floor((x - S.x0) / cell);
  const fromCell = (i) => new THREE.Vector3(S.x0 + ((i % S.W) + 0.5) * cell, S.y0 + (((i / S.W) | 0) + 0.5) * cell, 0);
  let seed = -1;
  for (let y = at(0.5); y <= at(0.7); y += cell)
    for (let x = cx - 0.08 * H; x <= cx + 0.08 * H; x += cell) {
      const i = toCell(x, y);
      if (S.occ[i] && (seed < 0 || D[i] > D[seed])) seed = i;
    }
  const geo = seed >= 0 ? paths(S, seed, (j, len) => len) : null;
  // Centre lines run along the ridge of the thickness field.
  const ridge = seed >= 0 ? paths(S, seed, (j, len) => len / (0.25 + D[j]) ** 2) : null;
  const lineTo = (i) => {
    const out = [];
    for (let k = i; k >= 0 && out.length < 4000; k = ridge.prev[k]) out.push(fromCell(k));
    return out; // from the end towards the torso
  };
  // Ends of the limbs: local maxima of the geodesic distance.
  const ends = [];
  if (geo) {
    const R = Math.max(3, Math.round(0.04 * 200));
    for (let i = 0; i < S.W * S.H; i++) {
      if (!S.occ[i] || !Number.isFinite(geo.dist[i])) continue;
      const x = i % S.W,
        y = (i / S.W) | 0;
      let top = true;
      for (let dy = -R; dy <= R && top; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= S.W || ny >= S.H) continue;
          const j = ny * S.W + nx;
          if (S.occ[j] && geo.dist[j] > geo.dist[i]) {
            top = false;
            break;
          }
        }
      if (top && geo.dist[i] > 0.15 * 200) ends.push({ i, p: fromCell(i), d: geo.dist[i] });
    }
    ends.sort((a, b) => b.d - a.d);
  }
  const m = {};

  // --- legs: the crotch is the highest height where left and right are apart
  let crotch = 0.45;
  for (let f = 0.12; f <= 0.62; f += 0.01) {
    const s = slice(f, 0.006);
    if (s.length < 6) continue;
    const gap = 0.012 * H;
    const left = s.filter((p) => p.x > cx + gap).length;
    const right = s.filter((p) => p.x < cx - gap).length;
    const mid = s.filter((p) => Math.abs(p.x - cx) <= gap).length;
    if (left > 2 && right > 2 && mid === 0) crotch = f;
  }
  const sideOf = (s, sgn) => s.filter((p) => (p.x - cx) * sgn > 0.01 * H);
  const centerOf = (arr, fb) => (arr.length ? new THREE.Vector3(mean(arr.map((p) => p.x)), mean(arr.map((p) => p.y)), mean(arr.map((p) => p.z))) : fb);
  const legCenter = (f, sgn) => centerOf(sideOf(slice(f, 0.012), sgn), new THREE.Vector3(cx + sgn * 0.08 * H, at(f), depthAt(cx, at(f))));
  const hipF = Math.min(0.62, crotch + 0.04);
  m.pelvis = new THREE.Vector3(cx, at(hipF + 0.01), depthAt(cx, at(hipF + 0.01)));
  for (const [s, sgn] of [['L', leftSgn], ['R', -leftSgn]]) {
    const hip = legCenter(crotch - 0.04, sgn);
    m[`hip.${s}`] = new THREE.Vector3(hip.x, at(hipF), m.pelvis.z);
    // Ankle: where the leg stops being a leg and becomes a foot (the front-back extent grows).
    const legPts = (f0, f1) => sideOf(pts.filter((p) => p.y >= at(f0) && p.y <= at(f1)), sgn).filter((p) => Math.abs(p.x - hip.x) < 0.09 * H);
    const extent = (arr) => (arr.length > 4 ? Math.max(...arr.map((p) => p.z)) - Math.min(...arr.map((p) => p.z)) : 0);
    const shin = extent(legPts(0.16, 0.22)) || 0.06 * H;
    let ankleF = 0.045;
    for (let f = 0.02; f <= 0.14; f += 0.005) {
      if (extent(legPts(f - 0.004, f + 0.004)) < shin * 1.35) {
        ankleF = Math.max(0.03, f - 0.005);
        break;
      }
    }
    const ankle = legCenter(ankleF + 0.01, sgn);
    m[`ankle.${s}`] = new THREE.Vector3(ankle.x, at(ankleF), depthAt(ankle.x, at(ankleF + 0.01), 0.025 * H, ankle.z));
    const kneeY = (m[`hip.${s}`].y + m[`ankle.${s}`].y) / 2 + 0.01 * H;
    const knee = centerOf(sideOf(pts.filter((p) => Math.abs(p.y - kneeY) < 0.012 * H), sgn), new THREE.Vector3(hip.x, kneeY, m.pelvis.z));
    m[`knee.${s}`] = new THREE.Vector3(knee.x, kneeY, depthAt(knee.x, kneeY, 0.02 * H, knee.z));
    const foot = sideOf(pts.filter((p) => p.y <= at(0.04)), sgn).map((p) => p.z).sort((a, b) => a - b);
    const tipZ = foot.length ? (facing > 0 ? foot[Math.floor(foot.length * 0.97)] : foot[Math.floor(foot.length * 0.03)]) : NaN;
    const az = m[`ankle.${s}`].z;
    m[`toe.${s}`] = new THREE.Vector3(m[`ankle.${s}`].x, at(0.015), Number.isFinite(tipZ) ? az + (tipZ - az) * 0.7 : az + facing * 0.06 * H);
  }

  // --- head top: the end of the limbs nearest the centre line, high up
  const headEnd = ends.find((e) => Math.abs(e.p.x - cx) < 0.12 * H && e.p.y > at(0.7));
  const topY = box.max.y - 0.01 * H;
  // Width of the silhouette row through the centre line at height y.
  const width = (y) => {
    const row = Math.floor((y - S.y0) / cell);
    if (row < 0 || row >= S.H) return 0;
    const x = Math.floor((cx - S.x0) / cell);
    if (!S.occ[row * S.W + x]) return 0;
    let a = x,
      b = x;
    while (a > 0 && S.occ[row * S.W + a - 1]) a--;
    while (b < S.W - 1 && S.occ[row * S.W + b + 1]) b++;
    return (b - a + 1) * cell;
  };
  // The neck in the silhouette: the narrowest row between the torso and the head top (big helmets
  // and hair are wide, the neck under them is not).
  let neckPt = null;
  if (seed >= 0)
    for (let y = fromCell(seed).y + 0.05 * H; y <= topY - 0.05 * H; y += cell) {
      const w = width(y);
      if (w > 0 && (!neckPt || w < neckPt.w)) neckPt = { x: cx, y, w, half: w / 2 + 2 * cell };
    }

  m.headTop = new THREE.Vector3(headEnd ? headEnd.p.x * 0.3 + cx * 0.7 : cx, topY, depthAt(cx, at(0.96), 0.03 * H));

  // --- arms
  const torsoRows = pts.filter((p) => Math.abs(p.y - at(0.5)) < 0.02 * H);
  const ext = (sg) => torsoRows.reduce((a, p) => Math.max(a, (p.x - cx) * sg), 0);
  const torsoHalf = Math.min(ext(1), ext(-1)) || 0.15 * H;
  const arms = {};
  for (const [s, sgn] of [['L', leftSgn], ['R', -leftSgn]]) {
    // The hand: the furthest end on this side that isn't a foot or the head. Things hanging off the
    // head (a bandana tail, a ponytail, long ears) also stick out sideways, but their way into the
    // torso comes down through the neck; an arm joins the torso below it.
    const viaHead = (e) => !!neckPt && lineTo(e.i).some((p) => Math.abs(p.x - neckPt.x) < neckPt.half && p.y > neckPt.y + 2 * cell);
    const hand = ends.find((e) => (e.p.x - cx) * sgn > torsoHalf * 0.6 && e.p.y > at(Math.min(0.3, crotch - 0.08)) && e !== headEnd && !viaHead(e));
    let path = null;
    if (hand && ridge) {
      const line = lineTo(hand.i); // hand -> torso
      // The shoulder is where the centre line enters the thick torso.
      const thick = line.map((p) => D[toCell(p.x, p.y)] || 0);
      const outer = thick.slice(0, Math.max(3, Math.floor(line.length * 0.35)));
      const armD = median(outer) || 1;
      let k = line.findIndex((p, j) => j > outer.length * 0.5 && (thick[j] > armD * 1.9 || Math.abs(p.x - cx) < torsoHalf * 0.9));
      if (k < 0) k = line.length - 1;
      // A shoulder joint is never far outside the torso. Big shoulder pads or gloves can look like
      // the torso starting early: then carry on in to just outside the torso's side.
      if (Math.abs(line[k].x - cx) > torsoHalf * 1.5) {
        const k2 = line.findIndex((p, j) => j > k && Math.abs(p.x - cx) <= torsoHalf * 1.3);
        if (k2 > 0) k = k2;
      }
      const arm = line.slice(0, k + 1).reverse(); // shoulder -> hand tip
      const reach = arm[0].distanceTo(arm[arm.length - 1]);
      if (arm.length >= 6 && reach > 0.18 * H) path = { arm, thick: thick.slice(0, k + 1).reverse() };
    }
    if (path) {
      const { arm, thick } = path;
      const shoulder = arm[0].clone();
      const dir = arm[arm.length - 1].clone().sub(shoulder).normalize();
      const down = dir.y < -0.8; // arms hanging: the line enters the torso at the armpit, below the joint
      if (down) shoulder.y = Math.min(at(0.84), shoulder.y + 0.06 * H);
      else shoulder.x -= sgn * 0.02 * H; // the joint sits a little inside the deltoid
      // Wrist: the narrowest point before the hand, measured across the arm in 3D the widest way
      // (a palm-down hand looks thin from the front, but its palm is broad).
      const axis = arm[arm.length - 1].clone().sub(arm[0]).normalize();
      const u1 = new THREE.Vector3(0, 0, 1).addScaledVector(axis, -axis.z).normalize();
      const u2 = new THREE.Vector3().crossVectors(axis, u1);
      const across = (p0) => {
        let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, n = 0;
        const tmp = new THREE.Vector3();
        for (const q of pts) {
          tmp.set(q.x - p0.x, q.y - p0.y, q.z);
          if (Math.abs(tmp.dot(axis)) > 0.006 * H) continue;
          const a = tmp.dot(u1), b = tmp.dot(u2);
          if (Math.hypot(a, b) > 0.09 * H) continue;
          a0 = Math.min(a0, a), a1 = Math.max(a1, a), b0 = Math.min(b0, b), b1 = Math.max(b1, b), n++;
        }
        return n > 3 ? Math.max(a1 - a0, b1 - b0) : Infinity;
      };
      let wi = indexAlong(arm, 0.76),
        wd = Infinity;
      for (let f = 0.58; f <= 0.9; f += 0.02) {
        const j = indexAlong(arm, f);
        const wv = across(arm[j]);
        if (wv < wd * 0.98) [wd, wi] = [wv, j];
      }
      const wrist = arm[wi].clone();
      const tip = arm[arm.length - 1].clone();
      // Elbow: about 55% of the way from the shoulder to the wrist, along the arm's own line.
      const toWrist = arm.slice(0, wi + 1);
      const elbow = pointAlong(toWrist.length > 1 ? toWrist : [shoulder, wrist], 0.55);
      arms[s] = { shoulder, elbow, wrist, tip };
    } else arms[s] = traceArmBySlices(pts, cx, sgn, H, at);
  }
  for (const s of ['L', 'R']) {
    const a = arms[s];
    m[`shoulder.${s}`] = new THREE.Vector3(a.shoulder.x, a.shoulder.y, depthAt(a.shoulder.x, a.shoulder.y, 0.03 * H));
    m[`elbow.${s}`] = new THREE.Vector3(a.elbow.x, a.elbow.y, depthAt(a.elbow.x, a.elbow.y, 0.02 * H) - facing * 0.005 * H); // elbows bend backwards
    m[`wrist.${s}`] = new THREE.Vector3(a.wrist.x, a.wrist.y, depthAt(a.wrist.x, a.wrist.y, 0.015 * H));
    m[`handTip.${s}`] = new THREE.Vector3(a.tip.x, a.tip.y, depthAt(a.tip.x, a.tip.y, 0.015 * H));
  }

  // --- neck: the narrowest row between the shoulders and the head top, at its base
  const shoulderY = Math.max(m['shoulder.L'].y, m['shoulder.R'].y);

  let neckY = shoulderY + 0.04 * H,
    narrow = Infinity;
  const yLo = Math.min(shoulderY, at(0.9)),
    yHi = Math.max(yLo + 0.02 * H, topY - 0.12 * (topY - m.pelvis.y));
  for (let y = yLo; y <= yHi; y += cell) {
    const w = width(y);
    if (w > 0 && w < narrow) [narrow, neckY] = [w, y];
  }
  // the base: down from the narrowest row until the shoulders start
  let base = neckY;
  for (let y = neckY; y >= shoulderY - 0.03 * H; y -= cell) {
    if (width(y) > narrow * 1.6) break;
    base = y;
  }
  // A neck base is never far above the shoulders (big helmets narrow above it, not below).
  const neckBase = Math.max(shoulderY - 0.02 * H, Math.min(base, neckY, shoulderY + 0.05 * H));
  m.neck = new THREE.Vector3(cx, neckBase, depthAt(cx, neckBase, 0.02 * H));
  const chestY = m.pelvis.y + 0.6 * (m.neck.y - m.pelvis.y);
  m.chest = new THREE.Vector3(cx, chestY, depthAt(cx, chestY, 0.03 * H));

  // Characters are (nearly) symmetric: average each left/right pair, so one side's mistake is halved.
  if (symmetric)
    for (const k of Object.keys(m)) {
      if (!k.endsWith('.L')) continue;
      const r = k.replace('.L', '.R');
      const avg = m[k].clone().add(new THREE.Vector3(2 * cx - m[r].x, m[r].y, m[r].z)).multiplyScalar(0.5);
      m[k].copy(avg);
      m[r].set(2 * cx - avg.x, avg.y, avg.z);
    }
  const found = { markers: m, facing, center: cx, height: H, ground: g };
  if (fingers) found.fingers = { L: findFingers(pts, m['wrist.L'], m['handTip.L'], facing, H), R: findFingers(pts, m['wrist.R'], m['handTip.R'], facing, H) };
  return found;
}

/** Arms that touch the body in the silhouette: follow the arm through horizontal slices of the mesh. */
function traceArmBySlices(pts, cx, sgn, H, at) {
  const lat = (p) => (p.x - cx) * sgn;
  const centroid = (arr) => arr.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(arr.length);
  const path = [];
  let prev = null;
  for (let f = 0.8; f >= 0.2; f -= 0.01) {
    const s = pts.filter((p) => Math.abs(p.y - at(f)) < 0.005 * H && lat(p) > 0).sort((a, b) => lat(a) - lat(b));
    if (s.length < 6) continue;
    let cut = -1,
      gap = 0.012 * H;
    for (let i = 1; i < s.length; i++) {
      const gp = lat(s[i]) - lat(s[i - 1]);
      if (gp > gap) [gap, cut] = [gp, i];
    }
    if (cut < 0) {
      if (path.length > 3) break;
      continue;
    }
    const c = centroid(s.slice(cut));
    if (prev && c.distanceTo(prev) > 0.06 * H) break;
    path.push(c);
    prev = c;
  }
  if (path.length < 3) {
    const shoulder = new THREE.Vector3(cx + sgn * 0.11 * H, at(0.81), 0);
    const tip = new THREE.Vector3(cx + sgn * 0.2 * H, at(0.4), 0);
    return { shoulder, elbow: shoulder.clone().lerp(tip, 0.44), wrist: shoulder.clone().lerp(tip, 0.8), tip };
  }
  const top = path[0];
  const shoulder = new THREE.Vector3(top.x - sgn * 0.01 * H, Math.min(at(0.82), top.y + 0.07 * H), top.z);
  // The trace stops where the hand touches the thigh: carry on along the forearm to the finger tip.
  const last = path[path.length - 1];
  const from = path[Math.max(0, path.length - 6)];
  const dir = last.clone().sub(from);
  if (dir.lengthSq() < 1e-10) dir.set(0, -1, 0);
  dir.normalize();
  let tip = last.clone().addScaledVector(dir, 0.08 * H);
  let best = 0;
  const tmp = new THREE.Vector3();
  for (const p of pts) {
    tmp.copy(p).sub(last);
    const t = tmp.dot(dir);
    if (t <= best || t > 0.2 * H) continue;
    if (tmp.addScaledVector(dir, -t).length() < 0.03 * H) [best, tip] = [t, p.clone()];
  }
  const line = [shoulder, ...path, tip];
  return { shoulder, elbow: pointAlong(line, 0.44), wrist: pointAlong(line, 0.8), tip };
}

// ---------------------------------------------------------------------------
// Fingers
// ---------------------------------------------------------------------------
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/**
 * Finger bases (knuckles) and tips of one hand. Slices across the hand, beyond the palm, show
 * the fingers as separate lumps when the mesh has them; their far ends are the tips. Mitten
 * hands get the usual layout spread over the hand's width. The thumb is the lump nearest the
 * wrist on the front of the hand.
 * Returns { found: bool, base: {finger: Vector3}, tip: {finger: Vector3} }.
 */
export function findFingers(pts, wrist, handTip, facing, H) {
  const d = handTip.clone().sub(wrist);
  const L = d.length();
  if (L < 1e-6) return null;
  d.normalize();
  // across the knuckles: the body's forward direction, square to the hand
  const fwd = new THREE.Vector3(0, 0, facing);
  const w = fwd.clone().addScaledVector(d, -fwd.dot(d));
  if (w.lengthSq() < 1e-6) w.set(0, 1, 0).addScaledVector(d, -d.y);
  w.normalize();
  const n = new THREE.Vector3().crossVectors(d, w).normalize();
  const local = [];
  const tmp = new THREE.Vector3();
  for (const p of pts) {
    tmp.copy(p).sub(wrist);
    const t = tmp.dot(d);
    if (t < -0.1 * L || t > 1.15 * L) continue;
    const a = tmp.dot(w),
      b = tmp.dot(n);
    if (Math.hypot(a, b) > 0.8 * L) continue;
    local.push([t, a, b]);
  }
  const at = (t, a, b) => wrist.clone().addScaledVector(d, t).addScaledVector(w, a).addScaledVector(n, b);
  // lumps across the hand (along w) in a thin slice at distance t
  const lumps = (t, tol = 0.025 * L) => {
    const s = local.filter((q) => Math.abs(q[0] - t) < tol).sort((x, y) => x[1] - y[1]);
    const out = [];
    let cur = null;
    for (const q of s) {
      if (cur && q[1] - cur.hi > 0.03 * L) (out.push(cur), (cur = null));
      if (!cur) cur = { lo: q[1], hi: q[1], b: [] };
      cur.hi = q[1];
      cur.b.push(q[2]);
    }
    if (cur) out.push(cur);
    return out.filter((l) => l.b.length >= 2).map((l) => ({ a: (l.lo + l.hi) / 2, width: l.hi - l.lo, b: (Math.min(...l.b) + Math.max(...l.b)) / 2 }));
  };
  const handWidth = (() => {
    const s = local.filter((q) => Math.abs(q[0] - 0.4 * L) < 0.04 * L).map((q) => q[1]);
    return s.length ? Math.max(...s) - Math.min(...s) : 0.5 * L;
  })();
  const palmMid = (() => {
    const s = local.filter((q) => Math.abs(q[0] - 0.4 * L) < 0.04 * L);
    return s.length ? [mean(s.map((q) => q[1])), mean(s.map((q) => q[2]))] : [0, 0];
  })();
  // Fingers show where slices beyond the palm split into 3-4 lumps.
  let bestT = 0,
    best = [];
  for (let t = 0.62 * L; t <= 0.92 * L; t += 0.03 * L) {
    const ls = lumps(t).filter((l) => l.width < 0.4 * handWidth + 0.02 * L);
    if (ls.length > best.length && ls.length <= 5) [best, bestT] = [ls, t];
  }
  const base = {},
    tip = {};
  let found = false;
  if (best.length >= 3) {
    found = true;
    // Keep the four on the back side of the hand as fingers (the thumb, if one shows, is the one
    // furthest forward); follow each out to its tip.
    let fingerLumps = best.sort((x, y) => x.a - y.a);
    if (fingerLumps.length === 5) fingerLumps = fingerLumps.slice(0, 4);
    // index is the most forward of the four, pinky the most backward
    const order = [...fingerLumps].sort((x, y) => y.a - x.a);
    const names = order.length === 4 ? ['index', 'middle', 'ring', 'pinky'] : order.length === 3 ? ['index', 'middle', 'pinky'] : ['index', 'middle'];
    order.forEach((l, k) => {
      const f = names[k];
      let far = bestT,
        fb = l.b;
      for (const q of local) if (Math.abs(q[1] - l.a) < Math.max(0.03 * L, l.width * 0.6) && q[0] > far) (far = q[0]), (fb = q[2]);
      tip[f] = at(Math.min(far, 1.08 * L) - 0.02 * L, l.a, fb);
      base[f] = at(Math.max(0.42 * L, bestT - 0.3 * (far - bestT) - 0.12 * L), l.a * 0.85 + palmMid[0] * 0.15, palmMid[1]);
    });
    if (!tip.ring) {
      tip.ring = tip.middle.clone().lerp(tip.pinky, 0.5);
      base.ring = base.middle.clone().lerp(base.pinky, 0.5);
    }
  } else {
    // Mitten: the usual layout over the hand's width.
    const spread = { index: 0.36, middle: 0.12, ring: -0.12, pinky: -0.34 };
    const reach = { index: 0.95, middle: 1, ring: 0.95, pinky: 0.85 };
    for (const f of ['index', 'middle', 'ring', 'pinky']) {
      const a = palmMid[0] + spread[f] * handWidth;
      tip[f] = at(reach[f] * L - 0.03 * L, a, palmMid[1]);
      base[f] = at(0.5 * L, a * 0.9, palmMid[1]);
    }
  }
  // Thumb: the lump in front of the index finger, nearest the wrist.
  let thumbTip = null;
  for (let t = 0.25 * L; t <= 0.7 * L; t += 0.03 * L) {
    const ls = lumps(t).sort((x, y) => y.a - x.a);
    if (ls.length >= 2 && ls[0].a > palmMid[0] + 0.25 * handWidth) {
      const l = ls[0];
      let far = t,
        fa = l.a,
        fb = l.b;
      for (const q of local) if (q[1] > l.a - 0.6 * l.width && q[1] > palmMid[0] + 0.2 * handWidth && q[0] < 0.75 * L && Math.hypot(q[0] - t, q[1] - l.a) > Math.hypot(far - t, fa - l.a)) (far = q[0]), (fa = q[1]), (fb = q[2]);
      thumbTip = at(far, fa - 0.02 * L, fb);
      break;
    }
  }
  base.thumb = at(0.12 * L, palmMid[0] + 0.3 * handWidth, palmMid[1]);
  // A thumb is a third to two thirds of the hand long and sits on its front: anything else was a
  // knob or a blade, and the usual place is better.
  const tl = thumbTip ? thumbTip.distanceTo(base.thumb) : 0;
  const front = thumbTip ? thumbTip.clone().sub(wrist).dot(w) > palmMid[0] : false;
  if (!thumbTip || tl < 0.25 * L || tl > 0.65 * L || !front) thumbTip = null;
  tip.thumb = thumbTip || at(0.55 * L, palmMid[0] + 0.75 * handWidth, palmMid[1] - 0.1 * L);
  return { found, base, tip };
}
