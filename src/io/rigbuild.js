// Skeleton builder: place joint markers on any mesh (or let Auto-find guess them), then build
// a humanoid skeleton and automatic skin weights. Works on static models and re-rigs others.
import * as THREE from 'three';

/** Markers the user places. side: markers with L get an automatic R mirror. */
export const MARKERS = [
  { id: 'pelvis', label: 'Hips (center)', hint: 'Middle of the hips, between the legs' },
  { id: 'chest', label: 'Chest', hint: 'Middle of the upper torso' },
  { id: 'neck', label: 'Neck base', hint: 'Where the neck meets the shoulders' },
  { id: 'headTop', label: 'Top of head', hint: 'Top of the skull' },
  { id: 'shoulder', label: 'Shoulder', side: true, hint: 'Shoulder joint (top of the arm)' },
  { id: 'elbow', label: 'Elbow', side: true, hint: 'Elbow joint' },
  { id: 'wrist', label: 'Wrist', side: true, hint: 'Wrist joint' },
  { id: 'handTip', label: 'Hand tip', side: true, hint: 'Tip of the middle finger' },
  { id: 'hip', label: 'Leg top (hip joint)', side: true, hint: 'Top of the thigh' },
  { id: 'knee', label: 'Knee', side: true, hint: 'Knee joint' },
  { id: 'ankle', label: 'Ankle', side: true, hint: 'Ankle joint' },
  { id: 'toe', label: 'Toe', side: true, hint: 'Ball of the foot / toes' },
];

export const markerKeys = () => MARKERS.flatMap((m) => (m.side ? [`${m.id}.L`, `${m.id}.R`] : [m.id]));

/** Mesh vertices in model space, exactly as displayed (skinning applied). */
export function collectVertices(root, maxCount = 80000) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const pts = [];
  const v = new THREE.Vector3();
  const meshes = [];
  root.traverse((o) => o.isMesh && o.visible !== false && meshes.push(o));
  let total = 0;
  for (const m of meshes) total += m.geometry.attributes.position.count;
  const step = Math.max(1, Math.floor(total / maxCount));
  for (const m of meshes) {
    const M = inv.clone().multiply(m.matrixWorld);
    const n = m.geometry.attributes.position.count;
    for (let i = 0; i < n; i += step) {
      if (m.isSkinnedMesh) m.getVertexPosition(i, v);
      else v.fromBufferAttribute(m.geometry.attributes.position, i);
      pts.push(v.clone().applyMatrix4(M));
    }
  }
  return pts;
}

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * Guess every marker from the mesh shape. Assumes Y-up; finds the facing from the feet.
 * Returns { markers: {key: Vector3}, facing, center }.
 */
export function autoFind(root) {
  const pts = collectVertices(root);
  const box = new THREE.Box3().setFromPoints(pts);
  const H = box.max.y - box.min.y;
  const g = box.min.y;
  const at = (f) => g + f * H;
  const band = (f0, f1) => pts.filter((p) => p.y >= at(f0) && p.y <= at(f1));
  const torso = band(0.45, 0.75);
  // Centre line from the legs' outer extents: robust to arms, weapons and uneven detail.
  const legs = band(0.05, 0.3);
  const lx = legs.map((p) => p.x).sort((a, b) => a - b);
  const cx = lx.length ? (lx[Math.floor(lx.length * 0.02)] + lx[Math.floor(lx.length * 0.98)]) / 2 : (box.min.x + box.max.x) / 2;
  const cz = median(torso.map((p) => p.z));
  const slice = (f, tol = 0.02) => pts.filter((p) => Math.abs(p.y - at(f)) < tol * H);

  // --- legs: find the crotch (highest height where left and right are separated)
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
  const legCenter = (f, sgn) => centerOf(sideOf(slice(f, 0.015), sgn), new THREE.Vector3(cx + sgn * 0.08 * H, at(f), cz));

  // --- facing from the feet: toes stick out further than heels
  // Measure from the ankles: toes stick out further in front than heels behind. Only look at
  // the feet themselves (off the centre line) and use percentiles so capes/robes can't fool it.
  const feet = band(0, 0.05).filter((p) => Math.abs(p.x - cx) > 0.03 * H);
  const fz = mean(slice(0.09, 0.015).filter((p) => Math.abs(p.x - cx) > 0.03 * H).map((p) => p.z));
  const zs = feet.map((p) => p.z).sort((a, b) => a - b);
  const pct = (q) => (zs.length ? zs[Math.min(zs.length - 1, Math.floor(q * zs.length))] : fz);
  // glTF convention is +Z forward; only flip when the feet clearly point the other way.
  const facing = fz - pct(0.05) > 1.3 * (pct(0.95) - fz) ? -1 : 1;
  const leftSgn = facing; // glTF: facing +Z -> left is +X

  const m = {};
  const hipF = Math.min(0.62, crotch + 0.04);
  m.pelvis = new THREE.Vector3(cx, at(hipF + 0.01), cz);
  m.chest = new THREE.Vector3(cx, at(0.72), cz);
  m.neck = new THREE.Vector3(cx, at(0.84), cz);
  m.headTop = new THREE.Vector3(cx, box.max.y - 0.01 * H, median(slice(0.97, 0.03).map((p) => p.z)) || cz);

  for (const [s, sgn] of [
    ['L', leftSgn],
    ['R', -leftSgn],
  ]) {
    const hip = legCenter(crotch - 0.04, sgn);
    m[`hip.${s}`] = new THREE.Vector3(hip.x, at(hipF), cz);
    const ankleF = 0.045;
    m[`knee.${s}`] = legCenter((hipF + ankleF) / 2 + 0.01, sgn);
    const ankle = legCenter(0.07, sgn);
    m[`ankle.${s}`] = new THREE.Vector3(ankle.x, at(ankleF), ankle.z);
    const foot = sideOf(band(0, 0.04), sgn).map((p) => p.z).sort((a, b) => a - b);
    const tipZ = foot.length ? (facing > 0 ? foot[Math.floor(foot.length * 0.95)] : foot[Math.floor(foot.length * 0.05)]) : NaN;
    m[`toe.${s}`] = new THREE.Vector3(ankle.x, at(0.015), Number.isFinite(tipZ) ? ankle.z + (tipZ - ankle.z) * 0.7 : ankle.z + facing * 0.06 * H);

    // --- arms: trace the arm through the mesh
    const path = traceArm(pts, cx, sgn, H, at);
    let shoulder, tip;
    if (path.length >= 3) {
      shoulder = path[0].clone();
      tip = path[path.length - 1].clone();
    } else {
      shoulder = new THREE.Vector3(cx + sgn * 0.11 * H, at(0.81), cz);
      tip = new THREE.Vector3(cx + sgn * 0.2 * H, at(0.4), cz);
      path.splice(0, path.length, shoulder, tip);
    }
    const along = (f) => pointAlong(path, f);
    m[`shoulder.${s}`] = shoulder;
    m[`elbow.${s}`] = along(0.44);
    m[`elbow.${s}`].z -= facing * 0.01 * H; // elbows bend backwards
    m[`wrist.${s}`] = along(0.8);
    m[`handTip.${s}`] = tip;
  }
  // Pull every marker to the middle of the body along the front/back axis.
  for (const k of Object.keys(m)) {
    if (/^(toe|elbow|wrist|handTip)/.test(k)) continue; // traced arm points are already centred
    const near = pts.filter((p) => Math.abs(p.y - m[k].y) < 0.02 * H && Math.abs(p.x - m[k].x) < 0.03 * H);
    if (near.length > 3) m[k].z = (Math.min(...near.map((p) => p.z)) + Math.max(...near.map((p) => p.z))) / 2;
  }
  return { markers: m, facing, center: cx, height: H, ground: g };
}

/**
 * Follow one arm (side sgn) from shoulder to finger tip.
 * Arms hanging down: horizontal slices, the arm is the outer cluster separated from the torso
 * by a gap. Arms out (T/A-pose): vertical slices moving outwards from the torso.
 */
function traceArm(pts, cx, sgn, H, at) {
  const lat = (p) => (p.x - cx) * sgn;
  const upper = pts.filter((p) => p.y > at(0.5) && p.y < at(0.9) && lat(p) > 0);
  const maxLat = upper.reduce((a, p) => Math.max(a, lat(p)), 0);
  const centroid = (arr) => arr.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(arr.length);
  // Arms are "out" only when the widest point of the body is up near shoulder height.
  const side = pts.filter((p) => p.y > at(0.3) && p.y < at(0.9) && lat(p) > 0);
  const widest = side.reduce((a, p) => (lat(p) > lat(a) ? p : a), side[0] || new THREE.Vector3());
  const path = [];
  if (maxLat > 0.28 * H && widest.y > at(0.45)) {
    // Arms out (T/A-pose). Arm axis from the forearm region, shoulder at the torso's edge.
    const fore = upper.filter((p) => lat(p) > 0.6 * maxLat && lat(p) < 0.85 * maxLat);
    const axis = fore.length ? centroid(fore) : widest.clone();
    // Torso half-width at the belly; use the narrower side (a drooping hand can widen one side).
    const belly = pts.filter((p) => Math.abs(p.y - at(0.5)) < 0.02 * H);
    const ext = (sg) => belly.reduce((a, p) => Math.max(a, (p.x - cx) * sg), 0);
    const torsoHalf = Math.min(ext(1), ext(-1)) || 0.15 * H;
    const tip = upper.reduce((a, p) => (lat(p) > lat(a) ? p : a));
    const shoulder = new THREE.Vector3(cx + sgn * torsoHalf * 0.85, axis.y + (tip.y - axis.y) * -0.15, axis.z);
    path.push(shoulder, axis.clone(), tip.clone());
  } else {
    // arms down: walk down from armpit height looking for an outer cluster
    let prev = null;
    for (let f = 0.8; f >= 0.2; f -= 0.01) {
      const s = pts.filter((p) => Math.abs(p.y - at(f)) < 0.005 * H && lat(p) > 0).sort((a, b) => lat(a) - lat(b));
      if (s.length < 6) continue;
      let cut = -1,
        gap = 0.012 * H;
      for (let i = 1; i < s.length; i++) {
        const g = lat(s[i]) - lat(s[i - 1]);
        if (g > gap) [gap, cut] = [g, i];
      }
      if (cut < 0) {
        if (path.length > 3) break;
        continue;
      }
      const c = centroid(s.slice(cut));
      if (prev && c.distanceTo(prev) > 0.06 * H) break; // jumped to something else
      path.push(c);
      prev = c;
    }
    if (path.length >= 3) {
      // shoulder joint sits above the armpit
      const top = path[0];
      path.unshift(new THREE.Vector3(top.x - sgn * 0.01 * H, Math.min(at(0.82), top.y + 0.07 * H), top.z));
      // The trace stops where the hand touches the thigh: continue along the forearm direction
      // inside a thin cylinder and take the furthest mesh point as the finger tip.
      const last = path[path.length - 1];
      const from = path[Math.max(1, path.length - 6)];
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
      path.push(tip);
    }
  }
  return path;
}

/** Point at fraction f of a polyline's length. */
function pointAlong(path, f) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const l = path[i].distanceTo(path[i - 1]);
    segs.push(l);
    total += l;
  }
  let target = f * total;
  for (let i = 1; i < path.length; i++) {
    if (target <= segs[i - 1] || i === path.length - 1) return path[i - 1].clone().lerp(path[i], Math.min(1, target / (segs[i - 1] || 1)));
    target -= segs[i - 1];
  }
  return path[path.length - 1].clone();
}

/** Reflect an L marker to its R partner across the centre plane x = cx. */
export function mirrorMarker(p, cx) {
  return new THREE.Vector3(2 * cx - p.x, p.y, p.z);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Separate pieces of a mesh (armour plates, robot parts, buttons) should move as solid
 * objects. Find connected islands (vertices welded by position so UV seams don't split them)
 * and bind every island smaller than the main body fully to its majority bone.
 * Returns the number of islands made rigid.
 */
export function rigidIslands(geo, si, sw, H) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const q = Math.max(1e-6, H * 0.0005);
  const weld = new Int32Array(n);
  const keys = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) / q)},${Math.round(pos.getY(i) / q)},${Math.round(pos.getZ(i) / q)}`;
    let id = keys.get(k);
    if (id === undefined) keys.set(k, (id = keys.size));
    weld[i] = id;
  }
  const parent = new Int32Array(keys.size).map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  const idx = geo.index ? geo.index.array : null;
  const tri = idx ? idx.length : n;
  for (let t = 0; t + 2 < tri; t += 3) {
    const a = weld[idx ? idx[t] : t],
      b = weld[idx ? idx[t + 1] : t + 1],
      c = weld[idx ? idx[t + 2] : t + 2];
    union(a, b);
    union(b, c);
  }
  const island = new Int32Array(n);
  const size = new Map();
  for (let i = 0; i < n; i++) {
    island[i] = find(weld[i]);
    size.set(island[i], (size.get(island[i]) || 0) + 1);
  }
  if (size.size < 2) return 0;
  const largest = Math.max(...size.values());
  const votes = new Map();
  for (let i = 0; i < n; i++) {
    const r = island[i];
    if (size.get(r) >= largest * 0.5) continue; // main body keeps smooth weights
    let m = votes.get(r);
    if (!m) votes.set(r, (m = new Map()));
    for (let k = 0; k < 4; k++) if (sw[i * 4 + k] > 0) m.set(si[i * 4 + k], (m.get(si[i * 4 + k]) || 0) + sw[i * 4 + k]);
  }
  const winner = new Map();
  for (const [r, m] of votes) winner.set(r, [...m].sort((a, b) => b[1] - a[1])[0][0]);
  for (let i = 0; i < n; i++) {
    const w = winner.get(island[i]);
    if (w === undefined) continue;
    si.fill(0, i * 4, i * 4 + 4);
    sw.fill(0, i * 4, i * 4 + 4);
    si[i * 4] = w;
    sw[i * 4] = 1;
  }
  return winner.size;
}
/** Small binary min-heap of [id, priority]. */
class MinHeap {
  constructor() {
    this.ids = [];
    this.pr = [];
  }
  get size() {
    return this.ids.length;
  }
  push(id, p) {
    const { ids, pr } = this;
    let i = ids.length;
    ids.push(id);
    pr.push(p);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (pr[up] <= p) break;
      ids[i] = ids[up];
      pr[i] = pr[up];
      i = up;
    }
    ids[i] = id;
    pr[i] = p;
  }
  pop() {
    const { ids, pr } = this;
    const top = [ids[0], pr[0]];
    const id = ids.pop();
    const p = pr.pop();
    if (ids.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= ids.length) break;
        if (c + 1 < ids.length && pr[c + 1] < pr[c]) c++;
        if (pr[c] >= p) break;
        ids[i] = ids[c];
        pr[i] = pr[c];
        i = c;
      }
      ids[i] = id;
      pr[i] = p;
    }
    return top;
  }
}

/**
 * Everything that hangs off the head — helmet rims, hair, ponytails, bandana tails, ears — even
 * when it reaches down beside the shoulders. Every vertex joins whichever is closer along the
 * mesh surface: the head core (`isCore`) or the surface tightly wrapped around a body/arm bone.
 * Returns a per-vertex mask (1 = moves with the head), or null if the head region ran into the
 * body (then only the core is used).
 */
export function headRegion(geo, bodyBones, { isCore, floorY, H, cx }) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const v = new THREE.Vector3();
  // nearest body bone per vertex, and how tightly the surface wraps each bone
  const nb = new Int16Array(n);
  const nd = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    let best = -1;
    let bd = Infinity;
    for (let k = 0; k < bodyBones.length; k++) {
      const d = bodyBones[k];
      if (d.side && (v.x - cx) * d.sideSign < -0.03 * H) continue;
      const dist = distToSegment(v, d.a, d.b);
      if (dist < bd) [bd, best] = [dist, k];
    }
    nb[i] = best;
    nd[i] = bd;
  }
  const radius = bodyBones.map((_, k) => {
    const ds = [];
    for (let i = 0; i < n; i += 7) if (nb[i] === k) ds.push(nd[i]);
    ds.sort((a, b) => a - b);
    return ds.length ? ds[Math.floor(ds.length * 0.5)] : 0.05 * H;
  });
  // weld by position so UV seams don't cut the surface apart
  const q = Math.max(1e-6, H * 0.0005);
  const weld = new Int32Array(n);
  const keys = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) / q)},${Math.round(pos.getY(i) / q)},${Math.round(pos.getZ(i) / q)}`;
    let id = keys.get(k);
    if (id === undefined) keys.set(k, (id = keys.size));
    weld[i] = id;
  }
  const W = keys.size;
  // Seeds: the head core, and the surface tightly wrapped around each body/arm bone.
  const label = new Uint8Array(W); // 1 = head, 2 = body
  const wpos = new Float32Array(W * 3);
  for (let i = 0; i < n; i++) {
    const k = weld[i];
    v.fromBufferAttribute(pos, i);
    wpos[k * 3] = v.x;
    wpos[k * 3 + 1] = v.y;
    wpos[k * 3 + 2] = v.z;
    if (isCore(v)) label[k] = 1;
    // clavicles are short and buried in the shoulders, so only their closest surface seeds
    else if (!label[k] && nb[i] >= 0 && nd[i] < (bodyBones[nb[i]].name.startsWith('Clavicle') ? 0.5 : 0.8) * radius[nb[i]]) label[k] = 2;
  }
  // adjacency (CSR) of welded vertices
  const idx = geo.index ? geo.index.array : null;
  const tri = idx ? idx.length : n;
  const deg = new Int32Array(W + 1);
  const vid = (t) => weld[idx ? idx[t] : t];
  for (let t = 0; t + 2 < tri; t += 3) for (const [a, b] of [[t, t + 1], [t + 1, t + 2], [t + 2, t]]) (deg[vid(a)]++, deg[vid(b)]++);
  const start = new Int32Array(W + 1);
  for (let k = 0; k < W; k++) start[k + 1] = start[k] + deg[k];
  const fill = start.slice(0, W);
  const adj = new Int32Array(start[W]);
  for (let t = 0; t + 2 < tri; t += 3)
    for (const [a, b] of [[t, t + 1], [t + 1, t + 2], [t + 2, t]]) {
      const x = vid(a), y = vid(b);
      adj[fill[x]++] = y;
      adj[fill[y]++] = x;
    }
  // Surface (geodesic) Voronoi: every vertex joins whichever seed set is closer along the mesh,
  // so a tail hanging from the head stays with the head even where it lies on the shoulder.
  const dist = new Float64Array(W).fill(Infinity); // full precision: rounding would re-queue vertices endlessly
  const heap = new MinHeap();
  for (let k = 0; k < W; k++) if (label[k]) (dist[k] = 0), heap.push(k, 0);
  while (heap.size) {
    const [k, d] = heap.pop();
    if (d > dist[k]) continue;
    const kx = wpos[k * 3], ky = wpos[k * 3 + 1], kz = wpos[k * 3 + 2];
    for (let e = start[k]; e < start[k + 1]; e++) {
      const m = adj[e];
      const nd2 = d + Math.hypot(wpos[m * 3] - kx, wpos[m * 3 + 1] - ky, wpos[m * 3 + 2] - kz);
      if (nd2 < dist[m]) {
        dist[m] = nd2;
        label[m] = label[k];
        heap.push(m, nd2);
      }
    }
  }
  const seen = label.map((l) => (l === 1 ? 1 : 0));
  const core = new Uint8Array(W);
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    if (isCore(v)) core[weld[i]] = 1;
  }
  const mask = new Uint8Array(n);
  let added = 0;
  let low = Infinity;
  for (let i = 0; i < n; i++) {
    if (!seen[weld[i]]) continue;
    mask[i] = 1;
    if (!core[weld[i]]) {
      added++;
      low = Math.min(low, pos.getY(i));
    }
  }
  if (added > n * 0.25 || low < floorY) return null; // grew into the body: don't trust it
  return mask;
}

function distToSegment(p, a, b) {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / (ab.lengthSq() || 1e-9)));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/**
 * Replace the model's skeleton (if any) with a humanoid one built from markers, and skin every
 * mesh automatically. Mutates gltf.scene; old animations are dropped (they target old bones).
 */
export function buildSkeleton(gltf, markers, { facing = 1, rigidHead = true } = {}) {
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const M = (k) => markers[k].clone();
  const cx = markers.pelvis.x;
  const pts = Object.values(markers);
  const H = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
  const ground = Math.min(...pts.map((p) => p.y)) - 0.02 * H;

  // Joint positions (model space).
  const J = {
    Root: new THREE.Vector3(cx, ground, markers.pelvis.z),
    Hips: M('pelvis'),
    Spine: M('pelvis').lerp(markers.chest, 0.5),
    Chest: M('chest'),
    Neck: M('neck'),
    Head: M('neck').lerp(markers.headTop, 0.3),
    HeadTop_End: M('headTop'),
  };
  for (const s of ['L', 'R']) {
    J[`Clavicle_${s}`] = M('neck').lerp(markers[`shoulder.${s}`], 0.3).setY(markers.neck.y - 0.02 * H);
    J[`UpperArm_${s}`] = M(`shoulder.${s}`);
    J[`ForeArm_${s}`] = M(`elbow.${s}`);
    J[`Hand_${s}`] = M(`wrist.${s}`);
    J[`HandTip_End_${s}`] = M(`handTip.${s}`);
    J[`Thigh_${s}`] = M(`hip.${s}`);
    J[`Calf_${s}`] = M(`knee.${s}`);
    J[`Foot_${s}`] = M(`ankle.${s}`);
    J[`Toe_${s}`] = M(`toe.${s}`);
    const toeDir = markers[`toe.${s}`].clone().sub(markers[`ankle.${s}`]).setY(0);
    if (toeDir.lengthSq() < 1e-8) toeDir.set(0, 0, facing);
    J[`Toe_End_${s}`] = M(`toe.${s}`).addScaledVector(toeDir.normalize(), 0.04 * H);
  }
  // Weapon sockets (non-deforming): grip point in each palm and a holster on the back. Like every
  // built bone they have identity rest rotations, so props are posed in the character's frame.
  for (const s of ['L', 'R']) J[`Weapon_${s}`] = M(`wrist.${s}`).lerp(markers[`handTip.${s}`], 0.4);
  J.Weapon_Back = M('chest');
  J.Weapon_Back.z -= facing * 0.09 * H;
  const PARENT = { Hips: 'Root', Spine: 'Hips', Chest: 'Spine', Neck: 'Chest', Head: 'Neck', HeadTop_End: 'Head', Weapon_Back: 'Chest' };
  for (const s of ['L', 'R']) {
    Object.assign(PARENT, {
      [`Clavicle_${s}`]: 'Chest',
      [`UpperArm_${s}`]: `Clavicle_${s}`,
      [`ForeArm_${s}`]: `UpperArm_${s}`,
      [`Hand_${s}`]: `ForeArm_${s}`,
      [`HandTip_End_${s}`]: `Hand_${s}`,
      [`Weapon_${s}`]: `Hand_${s}`,
      [`Thigh_${s}`]: 'Hips',
      [`Calf_${s}`]: `Thigh_${s}`,
      [`Foot_${s}`]: `Calf_${s}`,
      [`Toe_${s}`]: `Foot_${s}`,
      [`Toe_End_${s}`]: `Toe_${s}`,
    });
  }
  // Segment each deforming bone covers (head -> tail) for skin weights.
  const TAIL = { Hips: 'Spine', Spine: 'Chest', Chest: 'Neck', Neck: 'Head', Head: 'HeadTop_End' };
  for (const s of ['L', 'R'])
    Object.assign(TAIL, {
      [`Clavicle_${s}`]: `UpperArm_${s}`,
      [`UpperArm_${s}`]: `ForeArm_${s}`,
      [`ForeArm_${s}`]: `Hand_${s}`,
      [`Hand_${s}`]: `HandTip_End_${s}`,
      [`Thigh_${s}`]: `Calf_${s}`,
      [`Calf_${s}`]: `Foot_${s}`,
      [`Foot_${s}`]: `Toe_${s}`,
      [`Toe_${s}`]: `Toe_End_${s}`,
    });

  // ---- collect geometry exactly as displayed, then remove the old content
  const meshes = [];
  root.traverse((o) => o.isMesh && meshes.push(o));
  if (!meshes.length) throw new Error('No meshes to skin.');
  const baked = meshes.map((m) => {
    const Mx = inv.clone().multiply(m.matrixWorld);
    const nM = new THREE.Matrix3().getNormalMatrix(Mx);
    const src = m.geometry;
    const geo = src.clone();
    for (const k of ['skinIndex', 'skinWeight']) geo.deleteAttribute(k);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      if (m.isSkinnedMesh) m.getVertexPosition(i, v);
      else v.fromBufferAttribute(src.attributes.position, i);
      v.applyMatrix4(Mx);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    if (geo.attributes.normal) {
      const nrm = geo.attributes.normal;
      for (let i = 0; i < nrm.count; i++) {
        v.fromBufferAttribute(nrm, i).applyMatrix3(nM).normalize();
        nrm.setXYZ(i, v.x, v.y, v.z);
      }
    }
    geo.morphAttributes = {};
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return { geo, material: m.material, name: m.name, visible: m.visible };
  });
  for (const c of [...root.children]) root.remove(c);

  // ---- bones (identity rotations, positions relative to parent)
  const names = Object.keys(J);
  const bones = {};
  for (const nm of names) {
    const b = new THREE.Bone();
    b.name = nm;
    bones[nm] = b;
  }
  for (const nm of names) {
    const b = bones[nm];
    const p = PARENT[nm];
    if (p) {
      bones[p].add(b);
      b.position.copy(J[nm]).sub(J[p]);
    } else {
      root.add(b);
      b.position.copy(J[nm]);
    }
  }
  root.updateMatrixWorld(true);
  const list = names.map((nm) => bones[nm]);
  const skeleton = new THREE.Skeleton(list);

  // ---- automatic weights: inverse distance to bone segments, same-side limbs only
  const deform = Object.keys(TAIL).map((nm) => ({
    name: nm,
    idx: names.indexOf(nm),
    a: J[nm],
    b: J[TAIL[nm]],
    side: nm.endsWith('_L') ? 1 : nm.endsWith('_R') ? -1 : 0,
    sideSign: Math.sign(J[nm].x - cx) || 1,
  }));
  // A vertex may only blend between its nearest bone and that bone's parent/children, so a
  // hand resting on a thigh never gets pulled by the leg.
  const neighbours = new Map();
  for (const d of deform) {
    const set = new Set([d.name]);
    if (PARENT[d.name] && TAIL[PARENT[d.name]]) set.add(PARENT[d.name]);
    for (const c of Object.keys(PARENT)) if (PARENT[c] === d.name && TAIL[c]) set.add(c);
    if (d.name === 'Chest') ['Clavicle_L', 'Clavicle_R', 'Neck', 'Spine'].forEach((x) => set.add(x));
    neighbours.set(d.name, set);
  }
  const tol = 0.03 * H;
  const eps = 0.012 * H;
  // Rigid head (like most game rigs): everything above the neck follows the Head bone only, so
  // turning or nodding never stretches the face, helmet or hair. A short band below that line
  // blends Neck -> Head so the neck bends smoothly instead of tearing.
  const headIdx = names.indexOf('Head');
  const neckIdx = names.indexOf('Neck');
  const headCut = markers.neck.y + 0.1 * (markers.headTop.y - markers.neck.y);
  const headBand = 0.025 * H;
  // The head is the part above the neck *between the shoulders*. Its sides can be closer to the
  // shoulder bones than to the neck (big heads, high shoulders), so don't trust "nearest bone"
  // there: only vertices low at shoulder height may still belong to the shoulders.
  const shoulderHalf = (Math.abs(markers['shoulder.L'].x - cx) + Math.abs(markers['shoulder.R'].x - cx)) / 2;
  const shoulderTop = Math.max(markers['shoulder.L'].y, markers['shoulder.R'].y) + 0.02 * H;
  const bodyBones = deform.filter((d) => d.name !== 'Head' && d.name !== 'Neck');
  for (const b of baked) {
    const pos = b.geo.attributes.position;
    const n = pos.count;
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    const v = new THREE.Vector3();
    const cand = [];
    const hang = rigidHead
      ? headRegion(b.geo, bodyBones, { isCore: (p) => p.y >= headCut && Math.abs(p.x - cx) < 0.85 * shoulderHalf, floorY: J.Hips.y, H, cx })
      : null;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i);
      const lat = v.x - cx;
      cand.length = 0;
      let nearest = null,
        nd = Infinity;
      for (const d of deform) {
        if (d.side && lat * d.sideSign < -tol) continue; // other side of the body
        const dist = distToSegment(v, d.a, d.b);
        cand.push([d, dist]);
        if (dist < nd) [nd, nearest] = [dist, d];
      }
      const inHead = Math.abs(lat) < 0.85 * shoulderHalf && (!nearest.side || v.y >= shoulderTop);
      if (hang && hang[i] && !(inHead && v.y < headCut)) {
        // hangs off the head (helmet rim, hair, bandana tail…): moves with the head only
        si[i * 4] = headIdx;
        sw[i * 4] = 1;
        continue;
      }
      if (rigidHead && inHead && v.y >= headCut - headBand) {
        const t = Math.min(1, (v.y - (headCut - headBand)) / headBand);
        si[i * 4] = headIdx;
        sw[i * 4] = t;
        si[i * 4 + 1] = neckIdx;
        sw[i * 4 + 1] = 1 - t;
        continue;
      }
      const allowed = neighbours.get(nearest.name);
      const scored = cand.filter(([d]) => allowed.has(d.name)).map(([d, dist]) => [d.idx, 1 / (dist + eps) ** 5]);
      scored.sort((x, y) => y[1] - x[1]);
      const top = scored.slice(0, 4);
      const sum = top.reduce((s, x) => s + x[1], 0) || 1;
      top.forEach(([idx, w], k) => {
        si[i * 4 + k] = idx;
        sw[i * 4 + k] = w / sum;
      });
    }
    rigidIslands(b.geo, si, sw, H);
    b.geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    b.geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const sm = new THREE.SkinnedMesh(b.geo, b.material);
    sm.name = b.name;
    sm.visible = b.visible;
    root.add(sm);
    sm.updateMatrixWorld(true);
    sm.bind(skeleton, sm.matrixWorld);
  }
  gltf.animations = [];
  return { bones: list.length };
}
