// Small DOM toolkit: element builder, toasts, popup menus.

const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'indeterminate', 'textContent', 'innerHTML', 'title', 'htmlFor', 'type', 'min', 'max', 'step', 'placeholder', 'src']);

/** h('button', { class: 'primary', onclick }, 'Label', child, ...) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
export function toast(msg, kind = '', { action = null, ms = 3200 } = {}) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}` }, h('span', {}, msg));
  if (action) el.append(h('button', { onclick: () => (action.run(), el.remove()) }, action.label));
  box.append(el);
  setTimeout(() => el.remove(), kind === 'err' ? Math.max(ms, 5000) : ms);
  while (box.children.length > 4) box.firstChild.remove();
  return el;
}

// ---------------------------------------------------------------------------
// Popup menus (menubar dropdowns, context menus)
// item: { label, shortcut, run, disabled, checked } | 'sep' | { header }
// ---------------------------------------------------------------------------
let openMenu = null;

export function closeMenus() {
  if (openMenu) {
    openMenu.el.remove();
    openMenu.onClose?.();
    openMenu = null;
  }
}

export function popupMenu(items, x, y, { onClose = null, minWidth = 0 } = {}) {
  closeMenus();
  const el = h('div', { class: 'menu', style: minWidth ? { minWidth: minWidth + 'px' } : null });
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') {
      el.append(h('div', { class: 'sep' }));
      continue;
    }
    if (it.header) {
      el.append(h('div', { class: 'hdr' }, it.header));
      continue;
    }
    const dis = typeof it.disabled === 'function' ? it.disabled() : it.disabled;
    const chk = typeof it.checked === 'function' ? it.checked() : it.checked;
    const row = h(
      'div',
      { class: 'mi' + (dis ? ' disabled' : '') },
      h('span', { class: 'chk' }, chk ? '✓' : ''),
      h('span', { class: 'lbl' }, it.label),
      it.shortcut ? h('span', { class: 'sc' }, it.shortcut) : null
    );
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenus();
      it.run?.();
    });
    el.append(row);
  }
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  el.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  openMenu = { el, onClose };
  return el;
}

window.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.el.contains(e.target) && !e.target.closest?.('#menubar')) closeMenus();
});
window.addEventListener('blur', closeMenus);

export const isMenuOpen = () => !!openMenu;

/** Throttle to animation frames. */
export function rafThrottle(fn) {
  let pending = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...lastArgs);
    });
  };
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** Download a Blob as a file. */
export function downloadBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function fmtBytes(n) {
  return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';
}
