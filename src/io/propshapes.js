// Built-in placeholder weapons, made from primitives so animation can start before real models
// exist. Convention for every prop (built-in or file): origin = where the main hand grips,
// +Z = muzzle / pointing direction, +Y = up. userData.support = where the other hand goes.
import * as THREE from 'three';

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.25, flatShading: true, ...opts });

function part(group, geo, material, { p = [0, 0, 0], r = [0, 0, 0] } = {}) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(...p);
  m.rotation.set(...r.map((d) => (d * Math.PI) / 180));
  m.castShadow = true;
  group.add(m);
  return m;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
// Cylinder along Z.
const tube = (r0, r1, len, seg = 10) => new THREE.CylinderGeometry(r1, r0, len, seg).rotateX(Math.PI / 2);

/** u = character height; weapons are sized to the character. */
function rifle(u) {
  const g = new THREE.Group();
  const metal = mat(0x3b4048, { metalness: 0.55 });
  const dark = mat(0x23262c, { metalness: 0.5 });
  const wood = mat(0x8a5a33, { metalness: 0 });
  part(g, box(0.035 * u, 0.075 * u, 0.035 * u), wood, { p: [0, -0.015 * u, 0], r: [-15, 0, 0] }); // pistol grip (hand)
  part(g, box(0.045 * u, 0.065 * u, 0.3 * u), metal, { p: [0, 0.04 * u, 0.1 * u] }); // receiver
  part(g, box(0.04 * u, 0.075 * u, 0.17 * u), wood, { p: [0, 0.025 * u, -0.13 * u], r: [4, 0, 0] }); // stock
  part(g, box(0.05 * u, 0.055 * u, 0.14 * u), wood, { p: [0, 0.035 * u, 0.29 * u] }); // handguard (support hand)
  part(g, tube(0.011 * u, 0.011 * u, 0.2 * u), dark, { p: [0, 0.045 * u, 0.45 * u] }); // barrel
  part(g, tube(0.017 * u, 0.017 * u, 0.04 * u), dark, { p: [0, 0.045 * u, 0.56 * u] }); // muzzle
  part(g, box(0.03 * u, 0.1 * u, 0.045 * u), dark, { p: [0, -0.04 * u, 0.13 * u], r: [12, 0, 0] }); // magazine
  part(g, tube(0.016 * u, 0.016 * u, 0.12 * u), dark, { p: [0, 0.095 * u, 0.1 * u] }); // scope
  g.userData.support = [0, 0.035 * u, 0.29 * u];
  g.userData.muzzle = [0, 0.045 * u, 0.58 * u];
  return g;
}

function bazooka(u) {
  const g = new THREE.Group();
  const olive = mat(0x5a6431, { metalness: 0.2 });
  const dark = mat(0x2a2d24, { metalness: 0.4 });
  const band = mat(0xb08a2e, { metalness: 0.3 });
  const y = 0.09 * u;
  part(g, box(0.035 * u, 0.085 * u, 0.04 * u), dark, { p: [0, 0.01 * u, 0], r: [-10, 0, 0] }); // rear grip (hand)
  part(g, tube(0.055 * u, 0.055 * u, 0.72 * u, 14), olive, { p: [0, y, 0.16 * u] }); // tube
  part(g, tube(0.055 * u, 0.085 * u, 0.12 * u, 14), dark, { p: [0, y, -0.25 * u] }); // rear flare
  part(g, tube(0.064 * u, 0.064 * u, 0.05 * u, 14), dark, { p: [0, y, 0.52 * u] }); // muzzle ring
  part(g, tube(0.06 * u, 0.06 * u, 0.025 * u, 14), band, { p: [0, y, 0.33 * u] }); // band
  part(g, box(0.035 * u, 0.08 * u, 0.04 * u), dark, { p: [0, 0.015 * u, 0.24 * u], r: [-5, 0, 0] }); // front grip (support)
  part(g, box(0.02 * u, 0.05 * u, 0.06 * u), dark, { p: [0.06 * u, y + 0.05 * u, 0.08 * u] }); // sight
  part(g, box(0.07 * u, 0.04 * u, 0.12 * u), dark, { p: [0, y - 0.05 * u, -0.08 * u] }); // shoulder pad
  g.userData.support = [0, 0.015 * u, 0.24 * u];
  g.userData.muzzle = [0, y, 0.56 * u];
  return g;
}

function pistol(u) {
  const g = new THREE.Group();
  const metal = mat(0x41464f, { metalness: 0.6 });
  const grip = mat(0x2b2b2b, { metalness: 0.1 });
  part(g, box(0.03 * u, 0.075 * u, 0.04 * u), grip, { p: [0, -0.01 * u, 0], r: [-15, 0, 0] }); // grip (hand)
  part(g, box(0.032 * u, 0.04 * u, 0.15 * u), metal, { p: [0, 0.04 * u, 0.045 * u] }); // slide
  part(g, tube(0.008 * u, 0.008 * u, 0.02 * u), grip, { p: [0, 0.045 * u, 0.13 * u] }); // muzzle
  part(g, box(0.008 * u, 0.025 * u, 0.03 * u), metal, { p: [0, 0.005 * u, 0.04 * u] }); // trigger guard
  g.userData.support = [0, -0.02 * u, -0.01 * u];
  g.userData.muzzle = [0, 0.045 * u, 0.14 * u];
  return g;
}

function grenade(u) {
  const g = new THREE.Group();
  part(g, new THREE.SphereGeometry(0.035 * u, 10, 8), mat(0x4e5a2e), { p: [0, 0, 0.01 * u] });
  part(g, box(0.02 * u, 0.025 * u, 0.02 * u), mat(0x777777, { metalness: 0.6 }), { p: [0, 0.04 * u, 0.01 * u] });
  return g;
}

export const BUILTIN_PROPS = {
  rifle: { label: 'Rifle', make: rifle, socket: 'Weapon_R', twoHanded: true },
  bazooka: { label: 'Bazooka', make: bazooka, socket: 'Weapon_R', twoHanded: true },
  pistol: { label: 'Pistol', make: pistol, socket: 'Weapon_R', twoHanded: false },
  grenade: { label: 'Grenade', make: grenade, socket: 'Weapon_L', twoHanded: false },
};

export function makeBuiltinProp(kind, height) {
  const def = BUILTIN_PROPS[kind];
  if (!def) throw new Error(`Unknown built-in prop "${kind}". Available: ${Object.keys(BUILTIN_PROPS).join(', ')}`);
  const g = def.make(height);
  g.name = def.label;
  return g;
}
