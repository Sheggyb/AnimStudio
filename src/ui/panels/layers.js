// Right panel › Layers: non-destructive animation layers.
import { app } from '../../app/state.js';
import { run } from '../../app/commands.js';
import { GROUPS } from '../../core/rig.js';
import { h, clear } from '../dom.js';

export class LayersPanel {
  constructor(host) {
    this.el = h('div', { class: 'tab-body' });
    host.append(this.el);
    for (const ev of ['clip', 'clipSelect', 'layer', 'model']) app.on(ev, () => this.render());
    this.render();
  }

  maskText(L) {
    if (!L.mask) return 'All bones';
    const rig = app.rig;
    const set = new Set(L.mask);
    const full = GROUPS.filter((g) => {
      const bones = rig.names.filter((_, i) => rig.group[i] === g.id);
      return bones.length && bones.every((b) => set.has(b));
    }).map((g) => g.label);
    return full.length ? full.join(', ') : `${L.mask.length} bones`;
  }

  render() {
    clear(this.el);
    const clip = app.clip;
    if (!clip) {
      this.el.append(h('div', { class: 'empty' }, 'Select a clip to manage its layers.'));
      return;
    }
    this.el.append(
      h(
        'div',
        { class: 'card', style: { fontSize: '12.5px', color: 'var(--text2)', lineHeight: 1.5 } },
        h('b', { style: { color: 'var(--text)' } }, 'Layers let you change motion without touching the original keys. '),
        'Add an ',
        h('b', {}, 'additive'),
        ' layer and pose on it: your offset is added on top of the animation (one key = whole-clip tweak). ',
        h('b', {}, 'Override'),
        ' layers replace the motion for the masked bones.'
      )
    );
    const list = h('div', { class: 'col' });
    const layers = clip.layers.map((L, idx) => ({ L, idx })).reverse();
    for (const { L, idx } of layers) {
      const active = L.id === app.layerId;
      const isBase = idx === 0;
      const weight = h('input', {
        type: 'range',
        min: 0,
        max: L.mode === 'additive' ? 2 : 1,
        step: 0.01,
        value: L.weight,
        disabled: isBase,
        title: 'Layer weight',
        onclick: (e) => e.stopPropagation(),
        oninput: (e) => {
          if (!app.live) app.beginLive('Layer weight');
          const w = +e.target.value;
          wv.textContent = w.toFixed(2);
          app.updateLive((d) => (d.layers[idx].weight = w));
        },
        onchange: () => app.commitLive('Layer weight'),
      });
      const wv = h('span', { class: 'mono muted', style: { width: '34px', textAlign: 'right' } }, isBase ? '' : L.weight.toFixed(2));
      const row = h(
        'div',
        { class: 'layer-row' + (active ? ' active' : ''), onclick: () => app.setLayer(L.id), ondblclick: () => run('layer.rename') },
        h(
          'button',
          {
            class: 'ghost icon',
            title: isBase ? 'The base layer is always on' : L.mute ? 'Unmute' : 'Mute',
            disabled: isBase,
            onclick: (e) => {
              e.stopPropagation();
              app.edit(L.mute ? 'Unmute layer' : 'Mute layer', (d) => (d.layers[idx].mute = !d.layers[idx].mute));
            },
          },
          isBase ? '●' : L.mute ? '○' : '●'
        ),
        h('div', { class: 'row', style: { minWidth: 0 } }, h('span', { class: 'lname', style: { opacity: L.mute ? 0.5 : 1 } }, L.name), h('span', { class: `mode-tag ${L.mode}` }, L.mode)),
        h('span', { class: 'muted', style: { fontSize: '11px' } }, `${Object.keys(L.tracks).length} bones`),
        isBase ? null : h('div', { class: 'lmeta' }, weight, wv),
        isBase ? null : h('div', { class: 'lmeta' }, h('span', { class: 'muted', style: { fontSize: '11.5px', flex: 1 } }, `Mask: ${this.maskText(L)}`), h('button', { class: 'small', onclick: (e) => (e.stopPropagation(), app.setLayer(L.id), run('layer.mask')) }, 'Mask…'))
      );
      list.append(row);
    }
    this.el.append(list);
    const b = (label, cmd, title, cls = '') => h('button', { class: cls, title, onclick: () => run(cmd) }, label);
    this.el.append(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'sec-title' }, 'Layer actions'),
        h(
          'div',
          { class: 'btn-grid' },
          b('+ Additive layer', 'layer.addAdditive', 'Tweaks are added on top of everything below', 'primary'),
          b('+ Override layer', 'layer.addOverride', 'Replaces the motion of the masked bones'),
          b('Rename', 'layer.rename', 'Rename the active layer'),
          b('Duplicate', 'layer.duplicate', 'Copy the active layer'),
          b('Move up', 'layer.up', 'Evaluate later (on top)'),
          b('Move down', 'layer.down', 'Evaluate earlier'),
          b('Merge all → Base', 'layer.bake', 'Bake every active layer into the base layer'),
          b('Delete layer', 'layer.delete', 'Delete the active layer', 'danger')
        ),
        h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Tip: Tools › Layer another clip… puts e.g. an attack on the upper body over a run.')
      )
    );
  }
}
