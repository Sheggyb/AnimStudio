// Skeleton analysis: hierarchy, rest pose, automatic body-part labels, mirror pairs, IK chains.
//
// The source files only have names like "bone_42", so we infer anatomy from the rest pose:
// feet are the lowest lateral chains, hands the lowest lateral bones with finger children,
// the chest joins the arms, the pelvis joins the legs and the head is the busiest centre bone.
import * as THREE from 'three';

export const GROUPS = [
  { id: 'torso', label: 'Torso', color: '#4f9cff' },
  { id: 'head', label: 'Head', color: '#b88cff' },
  { id: 'arm.L', label: 'Left arm', color: '#3fd08a' },
  { id: 'arm.R', label: 'Right arm', color: '#ff7a59' },
  { id: 'leg.L', label: 'Left leg', color: '#2fc4d6' },
  { id: 'leg.R', label: 'Right leg', color: '#ffb84f' },
  { id: 'extra', label: 'Cloth / hair / tail', color: '#9aa3b5' },
  { id: 'attach', label: 'Attachment points', color: '#5f6778' },
  { id: 'parts', label: 'Parts', color: '#f472b6' },
];
export const GROUP_BY_ID = Object.fromEntries(GROUPS.map((g) => [g.id, g]));

// Handy selection sets built from groups.
export const SETS = {
  all: null,
  upper: ['torso:upper', 'head', 'arm.L', 'arm.R'],
  lower: ['torso:lower', 'leg.L', 'leg.R'],
  arms: ['arm.L', 'arm.R'],
  legs: ['leg.L', 'leg.R'],
};

const PRETTY = {
  root: 'Root',
  hips: 'Hips',
  pelvis: 'Pelvis',
  spine: 'Spine',
  chest: 'Chest',
  neck: 'Neck',
  head: 'Head',
  clavicle: 'Clavicle',
  upperarm: 'Upper arm',
  forearm: 'Forearm',
  hand: 'Hand',
  finger: 'Finger',
  thigh: 'Thigh',
  calf: 'Calf',
  foot: 'Foot',
  toe: 'Toe',
  armx: 'Arm extra',
  weapon: 'Weapon socket',
  weaponback: 'Back weapon socket',
  rootx: 'Root extra',
};

/** Human-readable text for a semantic label such as "upperarm.L" or "finger.R.2.0". */
export function prettyLabel(label) {
  if (!label) return null;
  const [kind, ...rest] = label.split('.');
  const side = rest[0] === 'L' || rest[0] === 'R' ? rest.shift() : null;
  const nums = rest.map((x) => +x + 1).join('.');
  return `${side ? side + ' ' : ''}${PRETTY[kind] || kind}${nums ? ' ' + nums : ''}`;
}

const V = () => new THREE.Vector3();

/**
 * Analyse a skeleton.
 * @param {THREE.Object3D} root  model root (gltf.scene), at rest pose
 * @param {THREE.Bone[]} bones   skeleton bones
 * @param {THREE.Box3} [box]     mesh bounds in model space (for height / ground)
 */
export function analyzeRig(root, bones, box = null) {
  root.updateMatrixWorld(true);
  const n = bones.length;
  const names = bones.map((b) => b.name);
  const byName = new Map(names.map((nm, i) => [nm, i]));
  const index = new Map(bones.map((b, i) => [b, i]));
  const parent = bones.map((b) => (index.has(b.parent) ? index.get(b.parent) : -1));
  const children = bones.map(() => []);
  parent.forEach((p, i) => p >= 0 && children[p].push(i));
  const rest = bones.map((b) => ({ p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() }));

  // Transform of the (non-bone) parent of the root bones, relative to the model root.
  const invRoot = root.matrixWorld.clone().invert();
  const firstRoot = bones[parent.indexOf(-1)];
  const baseM = new THREE.Matrix4();
  if (firstRoot?.parent) baseM.multiplyMatrices(invRoot, firstRoot.parent.matrixWorld);
  const baseP = V(),
    baseQ = new THREE.Quaternion(),
    baseS = V();
  baseM.decompose(baseP, baseQ, baseS);

  // Parents-first order + depth.
  const order = [];
  const depth = new Int32Array(n);
  const queue = [];
  for (let i = 0; i < n; i++) if (parent[i] < 0) queue.push(i);
  while (queue.length) {
    const i = queue.shift();
    order.push(i);
    for (const c of children[i]) {
      depth[c] = depth[i] + 1;
      queue.push(c);
    }
  }

  // Rest pose in model space.
  const wq = [],
    wp = [];
  for (const i of order) {
    const p = parent[i];
    const pq = p < 0 ? baseQ : wq[p];
    const pp = p < 0 ? baseP : wp[p];
    wq[i] = pq.clone().multiply(rest[i].q);
    wp[i] = rest[i].p.clone().applyQuaternion(pq).add(pp);
  }

  const subtreeSize = new Int32Array(n);
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    subtreeSize[i] = 1 + children[i].reduce((s, c) => s + subtreeSize[c], 0);
  }
  const subtree = (i) => {
    const out = [];
    const st = [i];
    while (st.length) {
      const x = st.pop();
      out.push(x);
      st.push(...children[x]);
    }
    return out;
  };
  const ancestors = (i) => {
    const out = [];
    for (let p = parent[i]; p >= 0; p = parent[p]) out.push(p);
    return out;
  };
  const lca = (a, b) => {
    const set = new Set([a, ...ancestors(a)]);
    if (set.has(b)) return b;
    for (const p of ancestors(b)) if (set.has(p)) return p;
    return -1;
  };
  // Path from `from` (exclusive) down to `to` (inclusive).
  const pathDown = (from, to) => {
    const out = [];
    for (let x = to; x >= 0 && x !== from; x = parent[x]) out.push(x);
    return out.reverse();
  };

  // ---- scale & centre ----
  let minY = Infinity,
    maxY = -Infinity;
  wp.forEach((p) => ((minY = Math.min(minY, p.y)), (maxY = Math.max(maxY, p.y))));
  const ground = box ? box.min.y : minY;
  const H = Math.max(1e-3, box ? box.max.y - box.min.y : maxY - minY);

  const roots = [];
  for (let i = 0; i < n; i++) if (parent[i] < 0) roots.push(i);
  const mainRoot = roots.reduce((a, b) => (subtreeSize[b] > subtreeSize[a] ? b : a), roots[0]);
  const main = subtree(mainRoot);
  const inMain = new Set(main);

  // Lateral (left/right) axis = horizontal axis with the most mirror-symmetric joints.
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0;
  };
  let lateral = 'x',
    center = 0,
    bestPairs = -1;
  for (const ax of ['x', 'z']) {
    const c = median(main.map((i) => wp[i][ax]));
    let pairs = 0;
    for (const i of main) {
      if (Math.abs(wp[i][ax] - c) < 0.02 * H) continue;
      const m = wp[i].clone();
      m[ax] = 2 * c - m[ax];
      if (main.some((j) => j !== i && depth[j] === depth[i] && wp[j].distanceTo(m) < 0.03 * H)) pairs++;
    }
    if (pairs > bestPairs) [bestPairs, lateral, center] = [pairs, ax, c];
  }
  const side = (i) => wp[i][lateral] - center;
  const forwardAxis = lateral === 'x' ? 'z' : 'x';

  const kind = new Array(n).fill(null); // semantic label, e.g. "upperarm.L"
  const group = new Array(n).fill('attach');
  for (const i of main) group[i] = 'extra';

  // ---- legs ----
  const tolSide = 0.02 * H;
  const lowLeaves = main.filter((i) => !children[i].length && wp[i].y - ground < 0.15 * H && Math.abs(side(i)) > tolSide);
  // Feet touch the ground: prefer the lowest leaves (long arms can hang below the knees), then deeper chains.
  const pickLeaf = (sgn, pool, minChain) => {
    const c = pool.filter((i) => Math.sign(side(i)) === sgn && depth[i] - depth[mainRoot] >= minChain);
    const band = (i) => Math.round((wp[i].y - ground) / (0.04 * H));
    c.sort((a, b) => band(a) - band(b) || depth[b] - depth[a] || wp[a].y - wp[b].y);
    return c.length ? c[0] : -1;
  };
  let legs = null;
  {
    const a = pickLeaf(+1, lowLeaves, 3),
      b = pickLeaf(-1, lowLeaves, 3);
    if (a >= 0 && b >= 0) {
      const pelvis = lca(a, b);
      const ca = pathDown(pelvis, a),
        cb = pathDown(pelvis, b);
      if (pelvis >= 0 && ca.length >= 3 && cb.length >= 3) legs = { pelvis, pos: ca, neg: cb };
    }
  }

  // ---- arms ----
  let arms = null;
  {
    // The legs and anything hanging down from the pelvis (skirts, tabards) can't be an arm. The
    // spine may branch off the same bone as the legs (Blender/Rigify rigs), so keep what goes up.
    const legSet = new Set(
      legs ? [legs.pos[0], legs.neg[0], ...children[legs.pelvis].filter((c) => wp[c].y < wp[legs.pelvis].y)].flatMap(subtree) : [],
    );
    const cands = main.filter((i) => !legSet.has(i) && children[i].length >= 2 && Math.abs(side(i)) > 0.07 * H);
    const lowest = (sgn) => {
      const c = cands.filter((i) => Math.sign(side(i)) === sgn).sort((x, y) => wp[x].y - wp[y].y);
      return c.length ? c[0] : -1;
    };
    const a = lowest(+1),
      b = lowest(-1);
    if (a >= 0 && b >= 0) {
      const chest = lca(a, b);
      const ca = pathDown(chest, a),
        cb = pathDown(chest, b);
      if (chest >= 0 && ca.length >= 3 && cb.length >= 3) arms = { chest, pos: ca, neg: cb };
    }
  }

  // ---- facing / left side ----
  // glTF convention: the model faces +Z and +X is its left. Detect it from the toes or the face.
  let forwardSign = 1;
  if (legs && legs.pos.length >= 4) {
    const foot = legs.pos[2],
      toe = legs.pos[3];
    const d = wp[toe][forwardAxis] - wp[foot][forwardAxis];
    if (Math.abs(d) > 0.01 * H) forwardSign = Math.sign(d);
  }
  const fwdVec = V();
  fwdVec[forwardAxis] = forwardSign;
  const leftVec = V().crossVectors(new THREE.Vector3(0, 1, 0), fwdVec); // left = up x forward
  const leftSign = Math.sign(leftVec[lateral]) || 1;
  const sideName = (i) => (side(i) * leftSign > 0 ? 'L' : 'R');

  const chains = {};
  const ik = {};
  const special = {};

  if (legs) {
    for (const ch of [legs.pos, legs.neg]) {
      const s = sideName(ch[0]);
      const names3 = ['thigh', 'calf', 'foot', 'toe'];
      ch.forEach((b, k) => (kind[b] = `${names3[Math.min(k, 3)]}.${s}${k > 3 ? '.' + (k - 3) : ''}`));
      for (const b of subtree(ch[0])) group[b] = `leg.${s}`;
      chains[`leg.${s}`] = ch;
      ik[`foot.${s}`] = { upper: ch[0], lower: ch[1], end: ch[2], toe: ch[3] ?? -1, bend: 'forward' };
    }
  }
  if (arms) {
    for (const ch of [arms.pos, arms.neg]) {
      const s = sideName(ch[ch.length - 1]);
      const L = ch.length;
      ch.forEach((b, k) => {
        const fromEnd = L - 1 - k;
        const base = ['hand', 'forearm', 'upperarm', 'clavicle'][fromEnd] || 'armx';
        kind[b] = base === 'armx' ? `armx.${s}.${k}` : `${base}.${s}`;
      });
      for (const b of subtree(ch[0])) group[b] = `arm.${s}`;
      chains[`arm.${s}`] = ch;
      const hand = ch[L - 1];
      ik[`hand.${s}`] = { upper: ch[L - 3], lower: ch[L - 2], end: hand, bend: 'back' };
      // Fingers: chains under the hand, ordered front to back.
      const fingers = [...children[hand]].sort((x, y) => (wp[y][forwardAxis] - wp[x][forwardAxis]) * forwardSign);
      fingers.forEach((f, k) => {
        let x = f,
          j = 0;
        while (x >= 0) {
          kind[x] = `finger.${s}.${k}.${j++}`;
          x = children[x].length ? children[x][0] : -1;
        }
      });
    }
  }

  let chest = -1,
    head = -1,
    hips = -1,
    pelvis = -1;
  if (arms) {
    chest = arms.chest;
    const armSet = new Set([...subtree(arms.pos[0]), ...subtree(arms.neg[0])]);
    // A head with face bones (jaw, eyes) branches; otherwise it's the highest bone of the neck chain,
    // not counting an end marker at the very top of the model (HeadTop_End).
    const isTopMarker = (i) => !children[i].length && wp[i].y > ground + 0.95 * H;
    const cands = subtree(chest).filter((i) => i !== chest && !armSet.has(i) && !isTopMarker(i) && Math.abs(side(i)) < 0.05 * H && wp[i].y > wp[chest].y);
    const branches = (i) => (children[i].length >= 2 ? children[i].length : 0);
    cands.sort((a, b) => branches(b) - branches(a) || wp[b].y - wp[a].y);
    if (cands.length) {
      head = cands[0];
      const neck = pathDown(chest, head).slice(0, -1);
      neck.forEach((b, k) => (kind[b] = `neck.${k}`));
      chains.neck = neck;
      kind[head] = 'head';
      for (const b of subtree(neck[0] ?? head)) if (group[b] === 'extra') group[b] = 'head';
      special.head = head;
    }
  }
  if (legs) pelvis = legs.pelvis;
  if (legs && arms) hips = lca(pelvis, chest);
  else hips = pelvis >= 0 ? pelvis : chest;

  if (hips >= 0) {
    const torso = [];
    const pathToHips = pathDown(mainRoot, hips);
    if (hips !== mainRoot) {
      kind[mainRoot] = 'root';
      torso.push(mainRoot);
      pathToHips.slice(0, -1).forEach((b, k) => ((kind[b] = `rootx.${k}`), torso.push(b)));
    }
    kind[hips] = 'hips';
    torso.push(hips);
    if (pelvis >= 0 && pelvis !== hips) {
      kind[pelvis] = 'pelvis';
      torso.push(pelvis);
    }
    if (chest >= 0 && chest !== hips) {
      const spine = pathDown(hips, chest).slice(0, -1);
      spine.forEach((b, k) => ((kind[b] = `spine.${k}`), torso.push(b)));
      chains.spine = spine;
      kind[chest] = 'chest';
      torso.push(chest);
    }
    for (const b of torso) group[b] = 'torso';
  }
  Object.assign(special, { root: mainRoot, hips, pelvis, chest });

  // Name the leftover chains ("extras": cloth, tabard, tail, hair, ...).
  let extraId = 0;
  for (const i of order) {
    if (group[i] !== 'extra' || kind[i]) continue;
    let x = i,
      j = 0;
    const id = extraId++;
    while (x >= 0 && group[x] === 'extra' && !kind[x]) {
      kind[x] = `extra.${id}.${j++}`;
      x = children[x].length === 1 ? children[x][0] : -1;
    }
  }

  // Upper / lower torso split for masks.
  const torsoUpper = new Set();
  const torsoLower = new Set();
  for (let i = 0; i < n; i++) {
    if (group[i] !== 'torso') continue;
    if (kind[i] === 'chest' || kind[i]?.startsWith('spine')) torsoUpper.add(i);
    else torsoLower.add(i);
  }

  // ---- mirror pairs ----
  const mirror = new Int32Array(n).fill(-1);
  const byKind = new Map();
  kind.forEach((k, i) => k && byKind.set(k, i));
  kind.forEach((k, i) => {
    if (!k) return;
    const other = k.replace(/\.L(\.|$)/, '.\u0000$1').replace(/\.R(\.|$)/, '.L$1').replace('\u0000', 'R');
    if (other !== k && byKind.has(other)) mirror[i] = byKind.get(other);
  });
  for (const i of main) {
    if (mirror[i] >= 0 || Math.abs(side(i)) < tolSide) continue;
    const m = wp[i].clone();
    m[lateral] = 2 * center - m[lateral];
    let best = -1,
      bd = 0.03 * H;
    for (const j of main) {
      if (j === i || depth[j] !== depth[i] || mirror[j] >= 0) continue;
      const d = wp[j].distanceTo(m);
      if (d < bd) [bd, best] = [d, j];
    }
    if (best >= 0) {
      mirror[i] = best;
      mirror[best] = i;
    }
  }

  const labels = kind.map((k) => prettyLabel(k));
  const core = new Set();
  for (let i = 0; i < n; i++) if (group[i] !== 'attach' && group[i] !== 'extra') core.add(i);

  const rig = {
    bones,
    names,
    byName,
    parent,
    children,
    depth,
    order,
    rest,
    restWorld: { q: wq, p: wp },
    baseP,
    baseQ,
    height: H,
    ground,
    center,
    lateral,
    forwardAxis,
    forwardSign,
    leftSign,
    mainRoot,
    kind,
    byKind,
    labels,
    group,
    chains,
    ik,
    special,
    mirror,
    core,
    torsoUpper,
    torsoLower,
    humanoid: !!(legs && arms),
    subtree,
    lca,
    pathDown,
  };
  // Standard bone names (Mixamo, Unreal, Blender, AnimStudio's own builder) beat geometry.
  nameLabels(rig);
  markSockets(rig);
  return rig;
}

/** Weapon socket bones ("Weapon_R", "Weapon_L", "Weapon_Back") -> semantic kind, else null. */
export function socketKind(name) {
  const m = /^weapon_?(r|l|right|left|back)$/i.exec(String(name).replace(/^.*[:|]/, ''));
  if (!m) return null;
  const s = m[1].toLowerCase();
  return s === 'back' ? 'weaponback' : `weapon.${s[0].toUpperCase()}`;
}

/** Sockets are attachment points: never part of body selections, masks or retargeting. */
function markSockets(rig) {
  rig.bones.forEach((_, i) => {
    const k = socketKind(rig.names[i]);
    if (!k) return;
    rig.kind[i] = k;
    rig.group[i] = 'attach';
    rig.labels[i] = prettyLabel(k);
    rig.byKind.set(k, i);
    rig.core.delete(i);
    rig.torsoUpper.delete(i);
    rig.torsoLower.delete(i);
  });
  const l = rig.byKind.get('weapon.L'),
    r = rig.byKind.get('weapon.R');
  if (l !== undefined && r !== undefined) {
    rig.mirror[l] = r;
    rig.mirror[r] = l;
  }
}

// ---------------------------------------------------------------------------
// Name-based labelling
// ---------------------------------------------------------------------------
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const NAME_KINDS = [
  [/^(hips?|pelvis)$/, 'hips'],
  [/^spine\d*$/, 'spine'],
  [/^(chest|upperchest|spine_?chest)$/, 'chest'],
  [/^neck\d*$/, 'neck'],
  [/^head$/, 'head'],
  [/^(shoulder|clavicle|collar|collarbone)$/, 'clavicle'],
  [/^(upperarm|arm|uparm)$/, 'upperarm'],
  [/^(forearm|lowerarm|elbow)$/, 'forearm'],
  [/^(hand|wrist)$/, 'hand'],
  [/^(upleg|upperleg|thigh)$/, 'thigh'],
  [/^(leg|lowerleg|calf|shin|knee)$/, 'calf'],
  [/^(foot|ankle)$/, 'foot'],
  [/^(toe|toes|toebase|ball)$/, 'toe'],
];

/** "mixamorig:LeftUpLeg" -> { side: 'L', base: 'upleg', finger: null } */
export function parseBoneName(raw) {
  // "mixamorig:LeftArm", "mixamorig9LeftArm" (numbered Mixamo rigs), "mixamorig_LeftArm" -> "LeftArm"
  let n = String(raw).replace(/^.*[:|]/, '').replace(/^mixamorig\d*_?/i, '');
  n = n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  let words = n
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  words = words.filter((w) => !['mixamorig', 'armature', 'def', 'deform', 'bip', 'bip01', 'b', 'bone', 'jnt', 'joint', 'ctrl'].includes(w));
  if (words.some((w) => w === 'end' || w === 'nub' || w === 'top' || w === 'tip')) return { side: null, base: null };
  let side = null;
  words = words.filter((w) => {
    if (w === 'left' || w === 'l') return (side = 'L'), false;
    if (w === 'right' || w === 'r') return (side = 'R'), false;
    return true;
  });
  const base = words.join('');
  const fm = /^(?:hand|finger)?(thumb|index|middle|ring|pinky|little)(\d*)$/.exec(base);
  if (fm) return { side, base, finger: fm[1] === 'little' ? 'pinky' : fm[1], seg: +fm[2] || 0 };
  return { side, base, finger: null };
}

/** If bone names follow a known convention, label the rig from them. Returns true on success. */
export function nameLabels(rig) {
  const n = rig.bones.length;
  const kind = new Array(n).fill(null);
  const found = {};
  const spines = [];
  const necks = [];
  const fingers = { L: {}, R: {} };
  for (let i = 0; i < n; i++) {
    const p = parseBoneName(rig.names[i]);
    if (!p.base) continue;
    if (p.finger && p.side) {
      (fingers[p.side][p.finger] ||= []).push(i);
      continue;
    }
    for (const [re, k] of NAME_KINDS) {
      if (!re.test(p.base)) continue;
      if (k === 'spine') spines.push(i);
      else if (k === 'neck') necks.push(i);
      else {
        const key = ['hips', 'chest', 'head'].includes(k) ? k : p.side ? `${k}.${p.side}` : null;
        if (key && found[key] === undefined) found[key] = i;
      }
      break;
    }
  }
  const need = ['hips', 'head', 'upperarm.L', 'forearm.L', 'hand.L', 'upperarm.R', 'forearm.R', 'hand.R', 'thigh.L', 'calf.L', 'foot.L', 'thigh.R', 'calf.R', 'foot.R'];
  if (!need.every((k) => found[k] !== undefined)) return false;

  const byDepth = (a, b) => rig.depth[a] - rig.depth[b];
  spines.sort(byDepth);
  necks.sort(byDepth);
  if (found.chest === undefined && spines.length) found.chest = spines.pop();
  for (const [k, i] of Object.entries(found)) kind[i] = k;
  spines.forEach((i, k) => (kind[i] = `spine.${k}`));
  necks.forEach((i, k) => (kind[i] = `neck.${k}`));
  for (const s of ['L', 'R'])
    FINGERS.forEach((f, fi) => {
      (fingers[s][f] || []).sort(byDepth).forEach((i, j) => (kind[i] = `finger.${s}.${fi}.${j}`));
    });

  const group = new Array(n).fill('attach');
  for (const i of rig.subtree(rig.mainRoot)) group[i] = 'extra';
  const hips = found.hips;
  const chest = found.chest ?? hips;
  const torso = [...rig.pathDown(rig.mainRoot, hips), hips, ...spines, chest];
  if (rig.mainRoot !== hips) torso.unshift(rig.mainRoot);
  const chains = { spine: spines, neck: necks };
  const ik = {};
  for (const s of ['L', 'R']) {
    const top = found[`clavicle.${s}`] ?? found[`upperarm.${s}`];
    for (const b of rig.subtree(top)) group[b] = `arm.${s}`;
    for (const b of rig.subtree(found[`thigh.${s}`])) group[b] = `leg.${s}`;
    chains[`arm.${s}`] = [found[`clavicle.${s}`], found[`upperarm.${s}`], found[`forearm.${s}`], found[`hand.${s}`]].filter((x) => x !== undefined);
    chains[`leg.${s}`] = [found[`thigh.${s}`], found[`calf.${s}`], found[`foot.${s}`], found[`toe.${s}`]].filter((x) => x !== undefined);
    ik[`hand.${s}`] = { upper: found[`upperarm.${s}`], lower: found[`forearm.${s}`], end: found[`hand.${s}`], bend: 'back' };
    ik[`foot.${s}`] = { upper: found[`thigh.${s}`], lower: found[`calf.${s}`], end: found[`foot.${s}`], toe: found[`toe.${s}`] ?? -1, bend: 'forward' };
  }
  const headTop = necks[0] ?? found.head;
  for (const b of rig.subtree(headTop)) if (group[b] === 'extra') group[b] = 'head';
  for (const b of torso) group[b] = 'torso';
  if (rig.mainRoot !== hips && !kind[rig.mainRoot]) kind[rig.mainRoot] = 'root';

  const byKind = new Map();
  kind.forEach((k, i) => k && byKind.set(k, i));
  const mirror = Int32Array.from(rig.mirror);
  kind.forEach((k, i) => {
    if (!k) return;
    const other = k.includes('.L') ? k.replace('.L', '.R') : k.includes('.R') ? k.replace('.R', '.L') : null;
    if (other && byKind.has(other)) mirror[i] = byKind.get(other);
  });
  const torsoUpper = new Set([...spines, chest].filter((i) => i !== hips));
  const torsoLower = new Set(torso.filter((i) => !torsoUpper.has(i)));
  const core = new Set();
  for (let i = 0; i < n; i++) if (group[i] !== 'attach' && group[i] !== 'extra') core.add(i);
  // Facing from the feet: toes point forward.
  const toe = found['toe.L'],
    foot = found['foot.L'];
  if (toe !== undefined) {
    const fa = rig.forwardAxis;
    const d = rig.restWorld.p[toe][fa] - rig.restWorld.p[foot][fa];
    if (Math.abs(d) > 1e-4) rig.forwardSign = Math.sign(d);
  }
  Object.assign(rig, {
    kind,
    byKind,
    labels: kind.map((k) => prettyLabel(k)),
    group,
    chains,
    ik,
    special: { root: rig.mainRoot, hips, pelvis: hips, chest, head: found.head },
    mirror,
    core,
    torsoUpper,
    torsoLower,
    humanoid: true,
    namedRig: true,
  });
  return true;
}

/** Bone indices for a group id or set name ('upper', 'lower', 'arms', 'legs', a group id, 'core'). */
export function bonesInSet(rig, setName) {
  const n = rig.bones.length;
  const out = [];
  if (!setName || setName === 'all') {
    for (let i = 0; i < n; i++) out.push(i);
    return out;
  }
  if (setName === 'core') return [...rig.core];
  if (setName === 'selection') return [];
  const parts = SETS[setName] || [setName];
  for (let i = 0; i < n; i++) {
    for (const p of parts) {
      if (p === 'torso:upper' ? rig.torsoUpper.has(i) : p === 'torso:lower' ? rig.torsoLower.has(i) : rig.group[i] === p) {
        out.push(i);
        break;
      }
    }
  }
  return out;
}

/** Display name: nickname > semantic label > raw name. */
export function boneTitle(rig, i, nick = {}) {
  const raw = rig.names[i];
  return nick[raw] || rig.labels[i] || raw;
}

// ---------------------------------------------------------------------------
// Mirroring helpers (reflection across the rig's lateral plane)
// ---------------------------------------------------------------------------
const _rel = new THREE.Quaternion();
function reflectQuat(q, lateral) {
  if (lateral === 'x') q.set(q.x, -q.y, -q.z, q.w);
  else q.set(-q.x, -q.y, q.z, q.w);
  return q;
}

/** Mirror bone i's local rotation `q` into the frame of its partner (or itself). */
export function mirrorLocalRot(rig, i, q, out = new THREE.Quaternion(), isDelta = false) {
  const j = rig.mirror[i] >= 0 ? rig.mirror[i] : i;
  if (isDelta) return reflectQuat(out.copy(q), rig.lateral);
  _rel.copy(rig.rest[i].q).invert().multiply(q);
  reflectQuat(_rel, rig.lateral);
  return out.copy(rig.rest[j].q).multiply(_rel);
}

export function mirrorLocalPos(rig, i, p, out = new THREE.Vector3(), isDelta = false) {
  const j = rig.mirror[i] >= 0 ? rig.mirror[i] : i;
  if (isDelta) {
    out.copy(p);
    out[rig.lateral] *= -1;
    return out;
  }
  out.copy(p).sub(rig.rest[i].p);
  out[rig.lateral] *= -1;
  return out.add(rig.rest[j].p);
}

export const mirrorIndex = (rig, i) => (rig.mirror[i] >= 0 ? rig.mirror[i] : i);

/** A bare copy of the skeleton (no mesh) for off-screen computation (IK baking, trails...). */
export function makeScratchSkeleton(rig) {
  const root = new THREE.Group();
  root.position.copy(rig.baseP);
  root.quaternion.copy(rig.baseQ);
  const bones = rig.bones.map((b) => {
    const nb = new THREE.Bone();
    nb.name = b.name;
    return nb;
  });
  rig.order.forEach((i) => {
    const p = rig.parent[i];
    (p < 0 ? root : bones[p]).add(bones[i]);
    bones[i].position.copy(rig.rest[i].p);
    bones[i].quaternion.copy(rig.rest[i].q);
    bones[i].scale.copy(rig.rest[i].s);
  });
  root.updateMatrixWorld(true);
  return { root, bones };
}
