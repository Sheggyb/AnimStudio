// Modal dialogs and schema-driven forms.
import { h, clear } from './dom.js';

let stack = [];
export const dialogOpen = () => stack.length > 0;

/**
 * Open a modal. Returns { el, body, close(result), result: Promise }.
 * buttons: [{ label, primary, danger, value, onClick }]
 */
export function openModal({ title, body = null, buttons = [{ label: 'Close', value: null }], wide = false, side = false, footLeft = null, onKey = null }) {
  const root = document.getElementById('overlay-root');
  let resolve;
  const result = new Promise((r) => (resolve = r));
  const bodyEl = h('div', { class: 'modal-body' }, body);
  const foot = h('div', { class: 'modal-foot' }, footLeft, h('div', { class: 'grow' }));
  const modal = h('div', { class: 'modal' + (wide ? ' wide' : '') }, h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'ghost icon', title: 'Close (Esc)', onclick: () => close(null) }, '✕')), bodyEl, foot);
  const back = h('div', { class: 'modal-back' + (side ? ' side' : '') }, modal);
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) back._downOnBack = true;
  });
  back.addEventListener('click', (e) => {
    if (e.target === back && back._downOnBack) close(null);
    back._downOnBack = false;
  });
  const handle = { el: modal, body: bodyEl, foot, close, result, buttons: {} };
  for (const b of buttons) {
    const btn = h(
      'button',
      {
        class: b.primary ? 'primary' : b.danger ? 'danger' : '',
        onclick: async () => {
          if (b.onClick) {
            const r = await b.onClick(handle);
            if (r === false) return;
          }
          close(b.value !== undefined ? (typeof b.value === 'function' ? b.value(handle) : b.value) : null);
        },
      },
      b.label
    );
    handle.buttons[b.label] = btn;
    foot.append(btn);
  }
  function onKeyDown(e) {
    if (stack[stack.length - 1] !== handle) return;
    if (onKey && onKey(e) === true) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(null);
    } else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
      const primary = buttons.find((b) => b.primary);
      if (primary) {
        e.preventDefault();
        e.stopPropagation();
        handle.buttons[primary.label].click();
      }
    }
  }
  function close(value) {
    if (!back.isConnected) return;
    back.remove();
    window.removeEventListener('keydown', onKeyDown, true);
    stack = stack.filter((s) => s !== handle);
    resolve(value);
  }
  window.addEventListener('keydown', onKeyDown, true);
  root.append(back);
  stack.push(handle);
  setTimeout(() => modal.querySelector('input:not([type=checkbox]):not([type=range]), select, textarea')?.focus(), 30);
  return handle;
}

export function alertDialog(title, message) {
  return openModal({ title, body: typeof message === 'string' ? h('p', {}, message) : message, buttons: [{ label: 'OK', primary: true, value: true }] }).result;
}

export async function confirmDialog(title, message, { ok = 'OK', danger = false } = {}) {
  const r = await openModal({
    title,
    body: typeof message === 'string' ? h('p', {}, message) : message,
    buttons: [
      { label: 'Cancel', value: false },
      { label: ok, primary: !danger, danger, value: true },
    ],
  }).result;
  return !!r;
}

export async function promptDialog(title, value = '', { label = '', ok = 'OK', placeholder = '' } = {}) {
  const r = await formDialog({ title, fields: [{ key: 'v', label, type: 'text', value, placeholder }], ok });
  return r ? r.v : null;
}

/**
 * Schema-driven form.
 * field: { key, label, type: number|range|text|select|checkbox|seg|info|checklist|textarea,
 *          value, min, max, step, unit, options: [{value,label}] | string[], hint, full, show(values) }
 * onChange(values) fires on every edit (used for live preview). Resolves values or null.
 */
export function formDialog({ title, intro = null, fields, ok = 'Apply', onChange = null, wide = false, side = false, footLeft = null, validate = null }) {
  const values = {};
  const inputs = {};
  const wrappers = {};
  for (const f of fields) if (f.key) values[f.key] = f.value ?? (f.type === 'checkbox' ? false : f.type === 'checklist' ? [] : '');
  const grid = h('div', { class: 'form-grid' });
  const fire = () => {
    for (const f of fields) if (f.show && wrappers[f.key || f.label]) wrappers[f.key || f.label].classList.toggle('hidden', !f.show(values));
    onChange?.({ ...values });
  };

  const normOptions = (opts) => (opts || []).map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) }));

  for (const f of fields) {
    let control;
    const set = (v) => {
      values[f.key] = v;
      fire();
    };
    switch (f.type) {
      case 'info':
        control = h('div', { class: 'hint', style: { color: 'var(--text2)', fontSize: '12.5px', lineHeight: 1.5 } }, f.value);
        break;
      case 'number':
        control = h('div', { class: 'row' }, (inputs[f.key] = h('input', { type: 'number', value: f.value, min: f.min, max: f.max, step: f.step ?? 'any', style: { width: '100%' }, oninput: (e) => set(parseFloat(e.target.value)) })), f.unit ? h('span', { class: 'muted' }, f.unit) : null);
        break;
      case 'range': {
        const num = h('input', { type: 'number', value: f.value, min: f.min, max: f.max, step: f.step ?? 'any' });
        const rng = h('input', { type: 'range', value: f.value, min: f.min, max: f.max, step: f.step ?? 'any' });
        rng.addEventListener('input', () => ((num.value = rng.value), set(parseFloat(rng.value))));
        num.addEventListener('input', () => ((rng.value = num.value), set(parseFloat(num.value))));
        control = h('div', { class: 'range-field' }, rng, h('div', { class: 'row' }, num, f.unit ? h('span', { class: 'muted' }, f.unit) : null));
        inputs[f.key] = num;
        break;
      }
      case 'select':
        control = inputs[f.key] = h(
          'select',
          { onchange: (e) => set(e.target.value) },
          normOptions(f.options).map((o) => (o.group ? h('optgroup', { label: o.group }, normOptions(o.options).map((x) => h('option', { value: x.value, selected: x.value === f.value }, x.label))) : h('option', { value: o.value, selected: o.value === f.value }, o.label)))
        );
        break;
      case 'seg': {
        const btns = normOptions(f.options).map((o) => {
          const b = h('button', { class: o.value === f.value ? 'on' : '', type: 'button', onclick: () => (btns.forEach((x) => x.classList.toggle('on', x === b)), set(o.value)) }, o.label);
          return b;
        });
        control = h('div', { class: 'seg' }, btns);
        break;
      }
      case 'checkbox':
        control = h('label', { class: 'check' }, (inputs[f.key] = h('input', { type: 'checkbox', checked: !!f.value, onchange: (e) => set(e.target.checked) })), h('span', {}, f.text || ''));
        break;
      case 'checklist': {
        const sel = new Set(f.value || []);
        const opts = normOptions(f.options);
        const boxes = opts.map((o) =>
          h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              checked: sel.has(o.value),
              onchange: (e) => {
                e.target.checked ? sel.add(o.value) : sel.delete(o.value);
                set(opts.filter((x) => sel.has(x.value)).map((x) => x.value));
              },
            }),
            o.swatch ? h('span', { class: 'swatch', style: { background: o.swatch } }) : null,
            h('span', {}, o.label)
          )
        );
        const tools = f.bulk
          ? h(
              'div',
              { class: 'row', style: { marginBottom: '4px' } },
              h('button', { class: 'small', type: 'button', onclick: () => (opts.forEach((o) => sel.add(o.value)), boxes.forEach((b) => (b.firstChild.checked = true)), set(opts.map((o) => o.value))) }, 'All'),
              h('button', { class: 'small', type: 'button', onclick: () => (sel.clear(), boxes.forEach((b) => (b.firstChild.checked = false)), set([])) }, 'None')
            )
          : null;
        control = h('div', {}, tools, h('div', { class: 'check-list' + (f.oneCol ? ' one' : '') }, boxes));
        break;
      }
      case 'textarea':
        control = inputs[f.key] = h('textarea', { rows: f.rows || 4, value: f.value ?? '', oninput: (e) => set(e.target.value), style: { width: '100%', resize: 'vertical' } });
        break;
      default:
        control = inputs[f.key] = h('input', { type: 'text', value: f.value ?? '', placeholder: f.placeholder || '', oninput: (e) => set(e.target.value), style: { width: '100%' } });
    }
    const wrap = h('div', { class: 'field' + (f.full || ['info', 'checklist', 'textarea'].includes(f.type) || fields.length === 1 ? ' full' : '') }, f.label ? h('span', {}, f.label) : null, control, f.hint ? h('div', { class: 'hint' }, f.hint) : null);
    wrappers[f.key || f.label] = wrap;
    grid.append(wrap);
  }
  const body = h('div', { class: 'col' }, intro ? (typeof intro === 'string' ? h('p', {}, intro) : intro) : null, grid);
  const m = openModal({
    title,
    body,
    wide,
    side,
    footLeft,
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: ok,
        primary: true,
        onClick: () => {
          if (validate) {
            const err = validate(values);
            if (err) {
              let e = body.querySelector('.form-err');
              if (!e) body.append((e = h('div', { class: 'form-err', style: { color: '#fca5a5', fontSize: '12.5px' } })));
              e.textContent = err;
              return false;
            }
          }
        },
        value: () => ({ ...values }),
      },
    ],
  });
  for (const f of fields) if (f.show && wrappers[f.key || f.label]) wrappers[f.key || f.label].classList.toggle('hidden', !f.show(values));
  if (onChange) setTimeout(() => onChange({ ...values }), 0);
  return m.result;
}

/** A modal with arbitrary content that is rebuilt via render(body, close). */
export function customDialog({ title, render, buttons, wide = false }) {
  const m = openModal({ title, body: h('div', { class: 'col' }), buttons, wide });
  render(m.body, m.close, m);
  return m.result;
}

export { clear };
