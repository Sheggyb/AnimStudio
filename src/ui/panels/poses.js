// Left panel, bottom: pose library (stored in the project).
import { app } from '../../app/state.js';
import { run } from '../../app/commands.js';
import { applyPoseData } from '../../app/actions.js';
import { promptDialog, confirmDialog } from '../dialog.js';
import { h, clear, popupMenu } from '../dom.js';

export class PosesPanel {
  constructor(host) {
    this.grid = h('div', { class: 'pose-grid' });
    this.collapsed = false;
    this.toggle = h('button', { class: 'ghost small', onclick: () => ((this.collapsed = !this.collapsed), this.render()) }, '▾');
    this.el = h(
      'div',
      { id: 'posesWrap' },
      h(
        'div',
        { class: 'panel-head' },
        this.toggle,
        h('span', { class: 'title' }, 'Pose library'),
        h('div', { class: 'grow' }),
        h('button', { class: 'small', title: 'Save the current pose (all bones, or the selected ones)', onclick: () => run('pose.save') }, '+ Save pose')
      ),
      this.grid
    );
    host.append(this.el);
    for (const ev of ['poses', 'model', 'project']) app.on(ev, () => this.render());
    this.render();
  }

  render() {
    clear(this.grid);
    this.toggle.textContent = this.collapsed ? '▸' : '▾';
    this.grid.classList.toggle('hidden', this.collapsed);
    const poses = app.project.poses || [];
    if (!poses.length) {
      this.grid.append(h('div', { class: 'muted', style: { gridColumn: '1 / -1', fontSize: '12px' } }, 'Saved poses appear here — reuse them in any clip.'));
      return;
    }
    for (const p of poses) {
      this.grid.append(
        h(
          'div',
          {
            class: 'pose-card',
            title: `${p.name} — ${Object.keys(p.bones).length} bones\nClick to apply at the playhead`,
            onclick: (e) => this.menu(e, p),
            oncontextmenu: (e) => (e.preventDefault(), this.menu(e, p)),
          },
          p.thumb ? h('img', { src: p.thumb, alt: p.name }) : h('div', { style: { aspectRatio: 1, background: '#0d0f14' } }),
          h('div', { class: 'pn' }, p.name)
        )
      );
    }
  }

  menu(e, p) {
    const selected = app.sel.bones.size ? new Set(app.sel.bones) : null;
    popupMenu(
      [
        { header: p.name },
        { label: 'Apply (key at playhead)', run: () => applyPoseData(p.bones, { label: `Apply pose ${p.name}` }) },
        { label: `Apply to selected bones${selected ? ` (${selected.size})` : ''}`, disabled: !selected, run: () => applyPoseData(p.bones, { only: selected, label: `Apply pose ${p.name}` }) },
        { label: 'Apply mirrored', run: () => applyPoseData(p.bones, { mirror: true, label: `Apply mirrored ${p.name}` }) },
        { label: 'Blend 50% toward pose', run: () => applyPoseData(p.bones, { blend: 0.5, only: selected, label: `Blend pose ${p.name}` }) },
        'sep',
        {
          label: 'Rename…',
          run: async () => {
            const n = await promptDialog('Rename pose', p.name);
            if (n) app.updatePoses('Rename pose', (arr) => arr.map((x) => (x.id === p.id ? { ...x, name: n } : x)));
          },
        },
        {
          label: 'Delete',
          run: async () => {
            if (await confirmDialog('Delete pose', `Delete "${p.name}" from the library?`, { ok: 'Delete', danger: true })) app.updatePoses('Delete pose', (arr) => arr.filter((x) => x.id !== p.id));
          },
        },
      ],
      e.clientX,
      e.clientY
    );
  }
}
