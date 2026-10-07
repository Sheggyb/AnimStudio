// Left panel, top: clip library.
import { app } from '../../app/state.js';
import { run } from '../../app/commands.js';
import { h, clear, popupMenu } from '../dom.js';

const FILTERS = [
  ['all', 'All'],
  ['mine', 'Mine'],
  ['edited', 'Edited'],
  ['loop', 'Loops'],
];

export class ClipsPanel {
  constructor(host) {
    this.filter = 'all';
    this.query = '';
    this.count = h('span', { class: 'chip' });
    this.search = h('input', {
      placeholder: 'Search clips…',
      oninput: (e) => {
        this.query = e.target.value.toLowerCase();
        this.render();
      },
    });
    this.filterBtns = FILTERS.map(([id, label]) =>
      h(
        'button',
        {
          class: id === this.filter ? 'on' : '',
          onclick: () => {
            this.filter = id;
            this.filterBtns.forEach((b, k) => b.classList.toggle('on', FILTERS[k][0] === id));
            this.render();
          },
        },
        label
      )
    );
    this.list = h('div', { class: 'list' });
    this.el = h(
      'div',
      { class: 'col', style: { flex: 1, minHeight: 0, gap: 0 } },
      h('div', { class: 'panel-head' }, h('span', { class: 'title' }, 'Clips'), this.count, h('div', { class: 'grow' }), h('button', { class: 'small', title: 'Moves: pick walks, attacks, emotes… from the animation packs and adjust them for this character (Ctrl+Shift+M)', onclick: () => run('tools.moveMaker') }, '✦ Moves'), h('button', { class: 'small primary', title: 'New clip from the current pose (Shift+N)', onclick: () => run('clip.new') }, '+ New')),
      h('div', { style: { padding: '8px 10px 0' } }, h('div', { class: 'search' }, this.search)),
      h('div', { class: 'filters' }, this.filterBtns),
      this.list,
      h(
        'div',
        { class: 'panel-foot' },
        h('button', { class: 'small', title: 'Duplicate (Ctrl+D)', onclick: () => run('clip.duplicate') }, 'Duplicate'),
        h('button', { class: 'small', title: 'Import clips: GLB, AnimStudio .json or Mixamo .fbx (you can also drop .fbx files on the window)', onclick: () => run('file.import') }, 'Import…'),
        h('button', { class: 'small', title: 'Bring animations from another character onto this one', onclick: () => run('tools.retarget') }, 'Retarget…')
      )
    );
    host.append(this.el);
    for (const ev of ['clips', 'clipSelect', 'model']) app.on(ev, () => this.render());
    this.render();
  }

  status(c) {
    if (!c.meta.original) return { badge: c.meta.source === 'retarget' ? ['rt', 'RT'] : c.meta.source === 'derived' ? ['drv', 'MIX'] : ['new', 'NEW'], mine: true };
    const pristine = app.originals.get(c.meta.originalName) === c;
    return { badge: pristine ? null : ['edit', 'EDIT'], mine: !pristine };
  }

  render() {
    clear(this.list);
    const clips = app.clips;
    const checked = clips.filter((c) => app.isExported(c.id)).length;
    this.count.textContent = `${clips.length}`;
    this.count.title = `${checked} of ${clips.length} checked for export`;
    if (!app.model) {
      this.list.append(h('div', { class: 'empty' }, 'Open a model to see its animations.'));
      return;
    }
    const q = this.query;
    const pass = (c) => {
      if (q && !c.name.toLowerCase().includes(q)) return false;
      const st = this.status(c);
      if (this.filter === 'mine') return st.mine;
      if (this.filter === 'edited') return !!st.badge;
      if (this.filter === 'loop') return c.loop;
      return true;
    };
    const mine = clips.filter((c) => pass(c) && this.status(c).mine);
    const orig = clips.filter((c) => pass(c) && !this.status(c).mine);
    const fps = app.fps;
    const row = (c) => {
      const st = this.status(c);
      const r = h(
        'div',
        {
          class: 'clip-row' + (c.id === app.clipId ? ' active' : ''),
          title: `${c.name}\n${c.duration.toFixed(2)}s · ${c.loop ? 'loops' : 'one-shot'}${c.meta.note ? '\n' + c.meta.note : ''}\nDouble-click to rename, right-click for more`,
          onclick: () => app.selectClip(c.id),
          ondblclick: () => run('clip.rename'),
          oncontextmenu: (e) => {
            e.preventDefault();
            app.selectClip(c.id);
            this.menu(e, c);
          },
        },
        h('input', {
          type: 'checkbox',
          checked: app.isExported(c.id),
          title: 'Include in export',
          onclick: (e) => e.stopPropagation(),
          onchange: (e) => app.setExported(c.id, e.target.checked),
        }),
        h('span', { class: 'loopi', title: c.loop ? 'Loops' : 'One-shot' }, c.loop ? '⟲' : ''),
        h('span', { class: 'name' }, c.name),
        st.badge ? h('span', { class: `badge ${st.badge[0]}` }, st.badge[1]) : null,
        h('span', { class: 'dur' }, `${Math.round(c.duration * fps)}f`)
      );
      return r;
    };
    if (mine.length) {
      this.list.append(h('div', { class: 'list-group' }, `My clips · ${mine.length}`));
      mine.forEach((c) => this.list.append(row(c)));
    }
    if (orig.length) {
      this.list.append(h('div', { class: 'list-group' }, `Original · ${orig.length}`));
      orig.forEach((c) => this.list.append(row(c)));
    }
    if (!mine.length && !orig.length) this.list.append(h('div', { class: 'empty' }, 'No clips match.'));
    this.list.querySelector('.clip-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  menu(e, c) {
    const st = this.status(c);
    popupMenu(
      [
        { header: c.name },
        { label: 'Rename…', shortcut: 'F2', run: () => run('clip.rename') },
        { label: 'Duplicate', shortcut: 'Ctrl+D', run: () => run('clip.duplicate') },
        { label: 'Mirrored copy (L↔R)', run: () => run('clip.mirrorCopy') },
        { label: 'Reversed copy', run: () => run('clip.reverseCopy') },
        { label: 'Compare against this (ghost)', run: () => run('view.compareWith', c.id), checked: app.compareClipId === c.id },
        'sep',
        { label: c.loop ? 'Mark as one-shot' : 'Mark as looping', run: () => run('clip.toggleLoop') },
        { label: 'Revert to original', run: () => run('clip.revert'), disabled: !(c.meta.original && st.badge) },
        { label: 'Export only this clip…', run: () => run('file.exportCurrent') },
        { label: 'Save as clip JSON', run: () => run('file.exportClipJson') },
        'sep',
        { label: 'Delete', run: () => run('clip.delete') },
      ],
      e.clientX,
      e.clientY
    );
  }
}
