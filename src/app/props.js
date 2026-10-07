// Props attached to socket bones (weapons, tools…). They are project data, shown in the viewport
// but never exported with the character — game engines attach their own weapon models to the
// same sockets. Prop: { id, name, source, socket, pos:[x,y,z] metres, rot:[x,y,z] degrees, scale, visible }
// source: "builtin:rifle" or a URL like "/props/MyRifle.glb". Offsets are in the socket's frame.
import * as THREE from 'three';
import { app } from './state.js';
import { uid } from '../core/clip.js';
import { BUILTIN_PROPS } from '../io/propshapes.js';
import { SOCKETS } from '../io/sockets.js';
import { api } from '../io/api.js';

const DEG = Math.PI / 180;

/** "rifle" -> builtin, "x.glb" -> props folder, URLs pass through. */
export async function resolvePropSource(prop) {
  const s = String(prop || '').trim();
  if (!s) throw new Error('Which prop? Use a built-in (rifle, bazooka, pistol, grenade) or a .glb in AnimStudio/props');
  if (s.startsWith('builtin:') || s.startsWith('/')) return s;
  if (BUILTIN_PROPS[s.toLowerCase()]) return `builtin:${s.toLowerCase()}`;
  const files = await api.props();
  const f = files.find((x) => x.name.toLowerCase() === s.toLowerCase() || x.name.toLowerCase() === `${s.toLowerCase()}.glb`);
  if (!f) throw new Error(`Prop "${s}" not found. Built-ins: ${Object.keys(BUILTIN_PROPS).join(', ')}; files: ${files.map((x) => x.name).join(', ') || 'none'}`);
  return f.url;
}

export const propLabel = (source) => (source.startsWith('builtin:') ? BUILTIN_PROPS[source.slice(8)]?.label || source : decodeURIComponent(source.split('/').pop()).replace(/\.glb$/i, ''));

/** Resolve a socket reference ("Weapon_R", "right hand", "back", a bone id/name) to a bone name. */
export function resolveSocket(ref) {
  const rig = app.rig;
  const r = String(ref || 'Weapon_R').toLowerCase().replace(/[\s_-]+/g, '');
  const alias = { weaponr: 'Weapon_R', righthand: 'Weapon_R', right: 'Weapon_R', r: 'Weapon_R', weaponl: 'Weapon_L', lefthand: 'Weapon_L', left: 'Weapon_L', l: 'Weapon_L', weaponback: 'Weapon_Back', back: 'Weapon_Back', holster: 'Weapon_Back' };
  const name = alias[r];
  if (name && rig.byName.has(name)) return name;
  if (name) {
    // No sockets yet: fall back to the matching body bone.
    const parent = SOCKETS.find((s) => s.name === name)?.parent;
    const i = rig.byKind.get(parent);
    if (i !== undefined) return rig.names[i];
  }
  const direct = rig.names.find((n) => n.toLowerCase() === String(ref).toLowerCase());
  if (direct) return direct;
  const byKind = rig.byKind.get(String(ref));
  if (byKind !== undefined) return rig.names[byKind];
  throw new Error(`Socket "${ref}" not found. Use Weapon_R, Weapon_L, Weapon_Back (add_sockets) or a bone name.`);
}

/**
 * Sensible starting offsets. In a hand the barrel runs along the hand (wrist -> finger tip), so
 * wherever the forearm points the weapon points; on the back it is slung diagonally.
 */
export function defaultPlacement(socket) {
  const rig = app.rig;
  if (!/back/i.test(socket)) {
    const si = rig.byName.get(socket);
    const hand = si !== undefined ? rig.parent[si] : rig.byName.get(socket);
    const tip = hand !== undefined && hand >= 0 ? rig.children[hand].find((c) => rig.group[c] !== 'attach') : undefined;
    if (tip === undefined) return { pos: [0, 0, 0], rot: [0, 0, 0] };
    // Direction in the socket frame (= character frame at rest for sockets; bone frame otherwise).
    const dir = rig.restWorld.p[tip].clone().sub(rig.restWorld.p[hand]);
    const frameQ = (si !== undefined && rig.group[si] === 'attach' ? rig.restWorld.q[si] : rig.restWorld.q[hand]).clone().invert();
    dir.applyQuaternion(frameQ).normalize();
    const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir), 'XYZ');
    return { pos: [0, 0, 0], rot: [e.x, e.y, e.z].map((r) => Math.round(r / DEG)) };
  }
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 35 * DEG).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -90 * DEG));
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return { pos: [0, -0.1 * app.rig.height * 0.5, -0.03 * app.rig.height], rot: [e.x, e.y, e.z].map((r) => Math.round((r / DEG) * 10) / 10) };
}

const list = () => app.project.props || [];
const findProp = (ref) => list().find((p) => p.id === ref || p.name.toLowerCase() === String(ref).toLowerCase());

export async function attachProp({ prop, socket = null, name = null, pos = null, rot = null, scale = 1, replace = true }) {
  if (!app.model) throw new Error('No model loaded');
  const source = await resolvePropSource(prop);
  const builtin = source.startsWith('builtin:') ? BUILTIN_PROPS[source.slice(8)] : null;
  const sock = resolveSocket(socket || builtin?.socket || 'Weapon_R');
  const place = defaultPlacement(sock);
  const entry = { id: uid('P'), name: name || propLabel(source), source, socket: sock, pos: pos || place.pos, rot: rot || place.rot, scale, visible: true };
  let props = list().slice();
  // One prop per socket by default (switching weapons replaces the one in that hand).
  if (replace) props = props.filter((p) => p.socket !== sock);
  const used = new Set(props.map((p) => p.name));
  let n = entry.name,
    k = 2;
  while (used.has(n)) n = `${entry.name} ${k++}`;
  entry.name = n;
  props.push(entry);
  app.setProps(props, 'Attach prop');
  return entry;
}

export function updateProp(ref, changes) {
  const p = findProp(ref);
  if (!p) throw new Error(`Prop "${ref}" not found`);
  const next = { ...p };
  if (changes.socket != null) next.socket = resolveSocket(changes.socket);
  for (const k of ['pos', 'rot']) if (Array.isArray(changes[k])) next[k] = changes[k].map(Number);
  if (Array.isArray(changes.support)) next.support = changes.support.map(Number);
  else if (changes.support === null) delete next.support;
  if (changes.scale != null) next.scale = +changes.scale;
  if (changes.visible != null) next.visible = !!changes.visible;
  if (changes.name) next.name = String(changes.name);
  app.setProps(
    list().map((x) => (x.id === p.id ? next : x)),
    'Edit prop'
  );
  return next;
}

export function removeProp(ref) {
  const p = ref === 'all' ? null : findProp(ref);
  if (ref !== 'all' && !p) throw new Error(`Prop "${ref}" not found`);
  app.setProps(ref === 'all' ? [] : list().filter((x) => x.id !== p.id), 'Remove prop');
  return { removed: ref === 'all' ? 'all' : p.name };
}
