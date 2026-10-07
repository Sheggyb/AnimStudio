// Right panel › Rig: bone hierarchy with automatic anatomy labels and nicknames.
import { builtMarkers } from '../rigbuilder.js';
import { app } from '../../app/state.js';
import { run } from '../../app/commands.js';
import { GROUPS, GROUP_BY_ID, bonesInSet } from '../../core/rig.js';
import { h, clear, debounce } from '../dom.js';

export class RigPanel {
  constructor(host) {
    this.el = h('div', { class: 'tab-body' });
    host.append(this.el);
    this.query = '';
    this.onlyAnimated = false;
    this.collapsed = new Set();
    const r = debounce(() => this.render(), 60);
    for (const ev of ['model', 'selection', 'rigNames', 'clipSelect', 'clip', 'layer']) app.on(ev, r);
    app.on('settings', (k) => k === 'showAllBones' && r());
    this.render();
  }

  render() {
    if (this.el.offsetParent === null) {
      this.stale = true;
      return;
    }
    this.stale = false;
    const scroll = this.tree?.scrollTop || 0;
    clear(this.el);
    const rig = app.rig;
    if (!rig) {
      this.el.append(h('div', { class: 'empty' }, 'No model loaded.'));
      return;
    }
    const pairs = [...rig.mirror].filter((x) => x >= 0).length / 2;
    const counts = {};
    rig.group.forEach((g) => (counts[g] = (counts[g] || 0) + 1));
    this.el.append(
      h(
        'div',
        { class: 'section card' },
        h('div', { class: 'stat' }, h('span', {}, 'Bones'), h('span', {}, `${rig.bones.length} (${rig.core.size} body)`)),
        h('div', { class: 'stat' }, h('span', {}, 'Anatomy detected'), h('span', { style: { color: rig.humanoid ? 'var(--good)' : 'var(--warn)' } }, rig.humanoid ? 'Humanoid ✓' : 'Partial')),
        h('div', { class: 'stat' }, h('span', {}, 'Left/right pairs'), h('span', {}, String(pairs))),
        h('div', { class: 'stat' }, h('span', {}, 'Height'), h('span', {}, `${rig.height.toFixed(2)} units`)),
        h(
          'button',
          builtMarkers(rig)
            ? { class: 'small primary', style: { marginTop: '6px' }, title: 'Move joints of this skeleton (shoulders, hips, knees…) and update it. Your animations are kept.', onclick: () => run('tools.buildSkeleton') }
            : { class: rig.humanoid ? 'small' : 'small primary', style: { marginTop: '6px' }, title: 'Place joint markers (or let Auto-find guess them) and build a new humanoid skeleton with automatic skin weights', onclick: () => run('tools.buildSkeleton') },
          builtMarkers(rig) ? '✎ Edit skeleton (move joints)…' : rig.humanoid ? 'Rebuild skeleton…' : 'Build skeleton (place joints)…'
        ),
        h(
          'div',
          { class: 'col', style: { gap: '3px', marginTop: '4px' } },
          GROUPS.map((g) =>
            h(
              'div',
              { class: 'row', style: { fontSize: '12.5px', cursor: 'pointer' }, title: `Select ${g.label}`, onclick: () => app.selectBones(bonesInSet(rig, g.id)) },
              h('span', { class: 'swatch', style: { background: g.color } }),
              h('span', { class: 'grow' }, g.label),
              h('span', { class: 'muted' }, counts[g.id] || 0)
            )
          )
        )
      )
    );
    const search = h('input', {
      placeholder: 'Find bone…',
      value: this.query,
      oninput: (e) => {
        this.query = e.target.value.toLowerCase();
        this.renderTree();
      },
    });
    this.el.append(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'row' }, h('div', { class: 'search' }, search)),
        h(
          'div',
          { class: 'row wrap' },
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: app.settings.showAllBones, onchange: (e) => app.set('showAllBones', e.target.checked) }), 'Show all joints in viewport'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: this.onlyAnimated, onchange: (e) => ((this.onlyAnimated = e.target.checked), this.renderTree()) }), 'Only animated')
        )
      )
    );
    this.tree = h('div', { class: 'tree' });
    this.el.append(this.tree, h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Double-click a bone to give it your own name. Names are saved with the project.'));
    this.renderTree();
    this.tree.scrollTop = scroll;
  }

  renderTree() {
    const rig = app.rig;
    clear(this.tree);
    const animated = new Set();
    for (const L of app.clip?.layers || []) for (const b in L.tracks) animated.add(b);
    const q = this.query;
    const match = (i) => {
      if (this.onlyAnimated && !animated.has(rig.names[i])) return false;
      if (!q) return true;
      return `${rig.names[i]} ${rig.labels[i] || ''} ${app.nick[rig.names[i]] || ''}`.toLowerCase().includes(q);
    };
    const flat = !!q || this.onlyAnimated;
    const walk = (i, depth) => {
      const name = rig.names[i];
      if (!flat || match(i)) {
        const hasKids = rig.children[i].length > 0;
        const coll = this.collapsed.has(i);
        const row = h(
          'div',
          {
            class: 'tn' + (app.sel.bones.has(i) ? ' sel' : ''),
            style: { paddingLeft: 4 + (flat ? 0 : depth * 12) + 'px' },
            title: `${name}${rig.labels[i] ? ' — ' + rig.labels[i] : ''}`,
            onclick: (e) => app.selectBones([i], { mode: e.shiftKey ? 'add' : e.ctrlKey ? 'toggle' : 'replace', active: i }),
            ondblclick: () => (app.selectBones([i]), run('bone.nickname')),
          },
          !flat && hasKids
            ? h(
                'span',
                {
                  class: 'muted',
                  style: { width: '10px', cursor: 'pointer' },
                  onclick: (e) => {
                    e.stopPropagation();
                    coll ? this.collapsed.delete(i) : this.collapsed.add(i);
                    this.renderTree();
                  },
                },
                coll ? '▸' : '▾'
              )
            : h('span', { style: { width: '10px' } }),
          h('span', { class: 'swatch', style: { background: GROUP_BY_ID[rig.group[i]].color } }),
          animated.has(name) ? h('span', { class: 'dot', title: 'Animated in this clip' }, '●') : null,
          app.nick[name] ? h('span', { class: 'nick' }, app.nick[name]) : rig.labels[i] ? h('span', { class: 'lab' }, rig.labels[i]) : null,
          h('span', { class: 'raw' }, name)
        );
        this.tree.append(row);
      }
      if (flat || !this.collapsed.has(i)) for (const c of rig.children[i]) walk(c, depth + 1);
    };
    rig.order.filter((i) => rig.parent[i] < 0).forEach((i) => walk(i, 0));
    this.tree.querySelector('.tn.sel')?.scrollIntoView({ block: 'nearest' });
  }

  show() {
    if (this.stale) this.render();
  }
}
