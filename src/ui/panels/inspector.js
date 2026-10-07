// Right panel › Pose: selected bone, transform controls, keying and posing tools.
import * as THREE from 'three';
import { app } from '../../app/state.js';
import { run, shortcutText } from '../../app/commands.js';
import { afterManualPose } from '../../app/actions.js';
import { GROUPS, GROUP_BY_ID, boneTitle, bonesInSet } from '../../core/rig.js';
import { findKey, INTERP_NAMES } from '../../core/channel.js';
import { h, clear } from '../dom.js';

const DEG = 180 / Math.PI;
const e = new THREE.Euler();

export class PosePanel {
  constructor(host) {
    this.el = h('div', { class: 'tab-body' });
    host.append(this.el);
    this.inputs = null;
    for (const ev of ['selection', 'model', 'rigNames']) app.on(ev, () => this.render());
    app.on('settings', (k) => ['tool', 'gizmoSpace', 'lockFeet'].includes(k) && this.render());
    for (const ev of ['pose', 'time', 'clip', 'layer']) app.on(ev, () => this.sync());
    this.render();
  }

  cmdBtn(label, cmd, title = '', cls = '') {
    const sc = shortcutText(cmd);
    return h('button', { class: cls, title: `${title}${sc ? ` (${sc})` : ''}`, onclick: () => run(cmd) }, label);
  }

  render() {
    clear(this.el);
    this.inputs = null;
    const rig = app.rig;
    if (!rig) {
      this.el.append(h('div', { class: 'empty' }, 'Open a model to start posing.'));
      return;
    }
    const i = app.sel.active;
    const s = app.settings;

    // ---- tools
    const tool = (id, label, key) => h('button', { class: s.tool === id ? 'on' : '', title: `${label} (${key})`, onclick: () => app.set('tool', id) }, label);
    this.el.append(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'sec-title' }, 'Tool'),
        h('div', { class: 'seg', style: { width: '100%' } }, tool('select', 'Select', 'Q'), tool('rotate', 'Rotate', 'E'), tool('move', 'Move', 'W'), tool('ik', 'IK', 'I')),
        h(
          'div',
          { class: 'row wrap' },
          h('div', { class: 'seg' }, ...['local', 'world'].map((sp) => h('button', { class: s.gizmoSpace === sp ? 'on' : '', onclick: () => app.set('gizmoSpace', sp), title: 'Gizmo orientation' }, sp === 'local' ? 'Local' : 'World'))),
          h('label', { class: 'check', title: 'While moving/rotating the hips or spine, keep the feet planted with leg IK' }, h('input', { type: 'checkbox', checked: s.lockFeet, onchange: (ev) => app.set('lockFeet', ev.target.checked) }), 'Lock feet')
        ),
        s.tool === 'ik' ? h('div', { class: 'muted', style: { fontSize: '12px' } }, 'IK: click a hand, foot or arm/leg joint, then drag the pink target — the limb follows and is keyed.') : null
      )
    );

    // ---- quick select
    const groupBtn = (g) =>
      h(
        'button',
        {
          title: `Select ${g.label} (Shift: add)`,
          onclick: (ev) => {
            const idx = bonesInSet(rig, g.id).filter((k) => rig.core.has(k) || rig.group[k] === 'extra');
            app.selectBones(idx, { mode: ev.shiftKey ? 'add' : 'replace', active: idx.find((k) => rig.kind[k] && !rig.kind[k].startsWith('finger')) ?? idx[0] });
          },
        },
        h('span', { class: 'swatch', style: { background: g.color } }),
        g.label.replace('Left ', 'L ').replace('Right ', 'R ').replace('Cloth / hair / tail', 'Extras')
      );
    this.el.append(h('div', { class: 'section' }, h('div', { class: 'sec-title' }, 'Select body part'), h('div', { class: 'group-btns' }, GROUPS.filter((g) => g.id !== 'attach' && rig.group.includes(g.id)).map(groupBtn), h('button', { onclick: () => app.clearBones(), title: 'Clear selection (Esc)' }, 'None'))));

    if (i < 0) {
      this.el.append(
        h(
          'div',
          { class: 'card empty' },
          h('div', {}, 'No bone selected.'),
          h('div', { style: { marginTop: '6px' } }, 'Click a joint in the viewport, a row in the dope sheet, or a bone in the Rig tab.'),
          h('div', { style: { marginTop: '6px' } }, 'Hover joints to see their names.')
        )
      );
      this.el.append(this.poseTools());
      return;
    }

    // ---- bone header
    const g = GROUP_BY_ID[rig.group[i]];
    const title = boneTitle(rig, i, app.nick);
    const p = rig.parent[i];
    const kids = rig.children[i];
    const mirror = rig.mirror[i];
    const navBtn = (label, target, tip) => h('button', { class: 'small', disabled: target < 0, title: tip, onclick: () => app.selectBones([target]) }, label);
    this.el.append(
      h(
        'div',
        { class: 'section card' },
        h('div', { class: 'bone-title' }, h('span', { class: 'swatch', style: { background: g.color } }), title, app.sel.bones.size > 1 ? h('span', { class: 'chip' }, `+${app.sel.bones.size - 1}`) : null),
        h('div', { class: 'bone-sub' }, `${rig.names[i]} · ${g.label}${rig.labels[i] && app.nick[rig.names[i]] ? ` · ${rig.labels[i]}` : ''}`),
        h(
          'div',
          { class: 'navrow' },
          navBtn('↑ Parent', p, p >= 0 ? boneTitle(rig, p, app.nick) : 'No parent'),
          navBtn('↓ Child', kids[0] ?? -1, kids.length ? boneTitle(rig, kids[0], app.nick) : 'No children'),
          navBtn('⇄ Mirror', mirror, mirror >= 0 ? boneTitle(rig, mirror, app.nick) : 'No mirror bone'),
          h('button', { class: 'small', title: 'Give this bone a readable name', onclick: () => run('bone.nickname') }, '✎ Name')
        )
      )
    );

    // ---- transform
    const rot = ['x', 'y', 'z'].map((ax) => {
      const rng = h('input', { type: 'range', min: -180, max: 180, step: 0.5 });
      const num = h('input', { type: 'number', step: 1 });
      const apply = (deg) => {
        const b = rig.bones[i];
        e.setFromQuaternion(b.quaternion, 'XYZ');
        e[ax] = deg / DEG;
        b.quaternion.setFromEuler(e);
        app.setPlaying(false);
        app.emit('pose');
      };
      rng.addEventListener('input', () => ((num.value = rng.value), apply(+rng.value)));
      num.addEventListener('input', () => ((rng.value = num.value), apply(+num.value)));
      const commit = () => afterManualPose([i], 'Rotate bone');
      rng.addEventListener('change', commit);
      num.addEventListener('change', commit);
      return { ax, rng, num, row: h('div', { class: 'slider-row' }, h('span', { class: `ax ax-${ax}` }, ax.toUpperCase()), rng, num) };
    });
    const pos = ['x', 'y', 'z'].map((ax) =>
      h('input', {
        type: 'number',
        step: 0.005,
        title: `Position ${ax.toUpperCase()} (model units)`,
        onchange: (ev) => {
          rig.bones[i].position[ax] = +ev.target.value;
          app.setPlaying(false);
          afterManualPose([i], 'Move bone');
        },
      })
    );
    this.keyInfo = h('div', { class: 'muted', style: { fontSize: '12px' } });
    this.inputs = { i, rot, pos };
    this.el.append(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'sec-title' }, 'Rotation (local, degrees)', h('div', { class: 'grow' }), this.cmdBtn('Reset', 'pose.reset', 'Back to rest pose', 'small ghost')),
        ...rot.map((r) => r.row),
        h('div', { class: 'vec-row' }, h('span', { class: 'muted' }, 'Position'), ...pos),
        this.keyInfo
      )
    );

    // ---- keys
    this.el.append(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'sec-title' }, 'Keys'),
        h(
          'div',
          { class: 'btn-grid' },
          this.cmdBtn('◆ Key selected', 'key.selected', 'Key selected bones at the playhead', 'primary'),
          this.cmdBtn('Key whole body', 'key.all', 'Key every bone at the playhead'),
          this.cmdBtn('Delete key', 'key.deleteAtTime', 'Delete the selected bones’ keys at the playhead'),
          this.cmdBtn('Select bone keys', 'keys.selectSelectedBones', 'Select all keys of the selected bones in the dope sheet')
        )
      )
    );
    this.el.append(this.poseTools());
    this.sync();
  }

  poseTools() {
    return h(
      'div',
      { class: 'section' },
      h('div', { class: 'sec-title' }, 'Pose tools'),
      h(
        'div',
        { class: 'btn-grid' },
        this.cmdBtn('Copy pose', 'pose.copy', 'Copy the selected bones (or whole body)'),
        this.cmdBtn('Paste pose', 'pose.paste', 'Paste and key at the playhead'),
        this.cmdBtn('Paste mirrored', 'pose.pasteMirror', 'Paste with left/right swapped'),
        this.cmdBtn('Mirror → other side', 'pose.mirrorToOther', 'Copy selected bones onto their left/right partners'),
        this.cmdBtn('Flip whole pose', 'pose.flip', 'Mirror the entire body pose'),
        this.cmdBtn('Save to library', 'pose.save', 'Store this pose in the pose library')
      )
    );
  }

  sync() {
    const inp = this.inputs;
    if (!inp || !app.rig || inp.i !== app.sel.active) return;
    const b = app.rig.bones[inp.i];
    e.setFromQuaternion(b.quaternion, 'XYZ');
    for (const r of inp.rot) {
      const deg = +(e[r.ax] * DEG).toFixed(1);
      if (document.activeElement !== r.rng) r.rng.value = deg;
      if (document.activeElement !== r.num) r.num.value = deg;
    }
    inp.pos.forEach((el, k) => {
      if (document.activeElement !== el) el.value = +b.position.getComponent(k).toFixed(4);
    });
    const L = app.layer;
    const tr = L?.tracks[app.rig.names[inp.i]];
    const parts = [];
    for (const [k, label] of [
      ['rot', 'rotation'],
      ['pos', 'position'],
      ['scl', 'scale'],
    ]) {
      const ch = tr?.[k];
      if (!ch) continue;
      const ki = findKey(ch, app.time, 0.45 / app.fps);
      parts.push(ki >= 0 ? `◆ ${label} (${INTERP_NAMES[ch.interp[ki]].toLowerCase()})` : `◇ ${label}`);
    }
    if (this.keyInfo) this.keyInfo.textContent = parts.length ? `Frame ${Math.round(app.time * app.fps)} on “${L.name}”: ${parts.join(' · ')}` : `No keys for this bone on “${L?.name}”.`;
  }
}
