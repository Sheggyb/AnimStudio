// Command registry: one place for every user action. Menus, the command palette, keyboard
// shortcuts and toolbar buttons all go through here.
const commands = new Map();
const listeners = new Set();

/**
 * def: { id, label, category, keys: ['Ctrl+S'], run(), enabled?(), checked?(), hidden? }
 */
export function register(...defs) {
  for (const d of defs) commands.set(d.id, d);
}

export function get(id) {
  return commands.get(id);
}

export function all() {
  return [...commands.values()];
}

export function enabled(id) {
  const c = commands.get(id);
  return !!c && (!c.enabled || c.enabled());
}

export function run(id, ...args) {
  const c = commands.get(id);
  if (!c) {
    console.warn('Unknown command', id);
    return;
  }
  if (c.enabled && !c.enabled()) return;
  listeners.forEach((fn) => fn(id));
  return c.run(...args);
}

export function onRun(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Normalise a KeyboardEvent to "Ctrl+Shift+K" style. */
export function eventCombo(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  else if (k === 'ArrowLeft') k = 'Left';
  else if (k === 'ArrowRight') k = 'Right';
  else if (k === 'ArrowUp') k = 'Up';
  else if (k === 'ArrowDown') k = 'Down';
  else if (k === 'Esc') k = 'Escape';
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null;
  parts.push(k);
  return parts.join('+');
}

export function findByCombo(combo) {
  for (const c of commands.values()) if (c.keys?.includes(combo)) return c;
  return null;
}

export const shortcutText = (id) => commands.get(id)?.keys?.[0] || '';
