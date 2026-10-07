// Right panel › Modify: movement modifiers and clip-level tools.
import { app } from '../../app/state.js';
import { run } from '../../app/commands.js';
import { OPS, runOp } from '../../app/oprunner.js';
import { h, clear } from '../dom.js';

const TOOLS = [
  { group: 'Timing', items: [
    ['tools.speed', 'Speed / length', 'Make the clip faster, slower or a set length'],
    ['clip.reverse', 'Reverse', 'Play the clip backwards'],
    ['tools.trim', 'Trim to range', 'Keep only the timeline range'],
    ['tools.cutRange', 'Cut range', 'Remove the timeline range'],
    ['tools.hold', 'Insert hold', 'Freeze the pose at the playhead for N frames'],
  ] },
  { group: 'Create & combine', items: [
    ['tools.moveMaker', 'Move Maker', 'Add walks, attacks, emotes from the library and adjust them with sliders'],
    ['tools.moveMakerClip', 'Adjust this clip', 'Speed, energy, lean, crouch, arms… on the current clip'],
    ['tools.layerClip', 'Layer another clip', 'e.g. attack on the upper body over a run'],
    ['tools.concat', 'Chain clips', 'This clip then another, with a crossfade'],
    ['tools.blend', 'Blend two clips', 'Mix e.g. walk + run into a jog'],
    ['tools.keyPoses', 'Key poses', 'Find the key poses and build a pose-to-pose version'],
    ['tools.retarget', 'Retarget from character', 'Use another character’s animations on this one'],
  ] },
];

export class ModifyPanel {
  constructor(host) {
    this.el = h('div', { class: 'tab-body' });
    host.append(this.el);
    for (const ev of ['clipSelect', 'model', 'layer', 'selection', 'range']) app.on(ev, () => this.render());
    this.render();
  }

  render() {
    clear(this.el);
    if (!app.clip) {
      this.el.append(h('div', { class: 'empty' }, 'Select a clip to modify it.'));
      return;
    }
    const L = app.layer;
    const n = app.sel.bones.size;
    this.el.append(
      h(
        'div',
        { class: 'card', style: { fontSize: '12.5px', color: 'var(--text2)', lineHeight: 1.5 } },
        'Modifiers apply to the ',
        h('b', {}, `“${L.name}”`),
        ' layer',
        n ? [' — you can limit them to the ', h('b', {}, `${n} selected bone${n > 1 ? 's' : ''}`)] : '',
        app.range ? [' and the ', h('b', {}, 'timeline range')] : '',
        '. Every change previews live and can be undone.'
      )
    );
    const groups = [...new Set(OPS.map((o) => o.group))];
    for (const g of groups) {
      this.el.append(
        h(
          'div',
          { class: 'section' },
          h('div', { class: 'sec-title' }, g),
          h(
            'div',
            { class: 'op-grid' },
            OPS.filter((o) => o.group === g).map((o) => h('button', { class: 'op', title: o.desc, onclick: () => runOp(o) }, h('b', {}, o.title), h('span', {}, o.desc.split(/[.—]/)[0])))
          )
        )
      );
    }
    for (const t of TOOLS) {
      this.el.append(
        h(
          'div',
          { class: 'section' },
          h('div', { class: 'sec-title' }, t.group),
          h(
            'div',
            { class: 'op-grid' },
            t.items.map(([cmd, title, desc]) => h('button', { class: 'op', title: desc, onclick: () => run(cmd) }, h('b', {}, title), h('span', {}, desc)))
          )
        )
      );
    }
  }
}
