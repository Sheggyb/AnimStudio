// Move Maker: pick a movement from the animation packs (or your saved moves, or the current
// clip), preview it on the loaded character, adjust it with simple sliders, then add it as an
// editable clip.
import { app } from '../app/state.js';
import { loadAnimSource } from '../io/animsource.js';
import { retargetClip } from '../core/retarget.js';
import { applyStyle, STYLE_DEFAULTS } from '../core/style.js';
import { CATEGORIES, buildCatalog, sourceLabel, prettyMove, canonicalName } from '../core/movecatalog.js';
import { h, clear, toast, rafThrottle } from './dom.js';
import { formDialog, confirmDialog, promptDialog } from './dialog.js';
import { listLibrary, loadMove, saveMove, deleteMove, buildStandardMove, moveOnCharacter, standardRig } from '../io/library.js';
import { packSources } from '../io/packs.js';
import { makeLayer } from '../core/clip.js';
import { busy } from '../app/session.js';

const SLIDERS = [
  { group: 'Timing', items: [['speed', 'Speed', 0.3, 3, 0.05, (v) => `${v.toFixed(2)}×`]] },
  {
    group: 'Energy',
    items: [
      ['intensity', 'Whole body', 0, 2, 0.05, pct],
      ['arms', 'Arm swing', 0, 2.5, 0.05, pct],
      ['legs', 'Stride / legs', 0, 2, 0.05, pct],
      ['bounce', 'Bounce (hips)', 0, 3, 0.05, pct],
    ],
  },
  {
    group: 'Posture',
    items: [
      ['lean', 'Lean back ↔ forward', -40, 40, 1, deg],
      ['crouch', 'Crouch (feet stay)', 0, 1, 0.01, pct],
      ['armsOut', 'Arms in ↔ out', -40, 60, 1, deg],
      ['headLevel', 'Keep head level', 0, 1, 0.05, pct],
      ['headNod', 'Head up ↔ down', -40, 40, 1, deg],
      ['headTurn', 'Head turn R ↔ L', -60, 60, 1, deg],
    ],
  },
  {
    group: 'Feel',
    items: [
      ['smooth', 'Smoothness', 0, 10, 1, (v) => (v ? `${v} f` : 'off')],
      ['life', 'Add life (wobble)', 0, 10, 0.25, deg],
    ],
  },
];
function pct(v) {
  return `${Math.round(v * 100)}%`;
}
function deg(v) {
  return `${Math.round(v)}°`;
}

export class MoveMaker {
  constructor(viewport) {
    this.vp = viewport;
    this.active = false;
    this.category = 'all';
    this.query = '';
    this.update = rafThrottle(() => this.rebuild());
  }

  async open({ fromClip = false } = {}) {
    if (!app.model) return toast('Open a model first', 'err');
    if (!app.rig?.humanoid) toast('This character has no recognised body skeleton yet — build one first (Tools › Build skeleton) for best results', 'err', { ms: 7000 });
    if (this.vp.builder) return toast('Finish or cancel the skeleton builder first', 'err');
    if (this.active) this.close();
    this.active = true;
    app.setPlaying(false);
    app.clearBones();
    this.params = { ...STYLE_DEFAULTS };
    this.base = null;
    this.sel = null;
    this.target = null;
    this.buildPanel();
    this.vp.frameModel('persp', 350);
    await this.loadCatalog();
    this.library = await listLibrary();
    this.source ||= 'ref';
    if (this.source === 'mine' && !this.library.length) this.source = 'ref';
    this.renderPick();
    if (fromClip && app.clip) this.useCurrentClip();
  }

  async refreshLibrary() {
    this.library = await listLibrary();
    if (this.step === 'pick') this.renderPick();
  }

  close() {
    this.active = false;
    this.vp.setPreview(null);
    this.panel?.remove();
    this.panel = null;
  }

  // ------------------------------------------------------------------ layout
  buildPanel() {
    this.pickBox = h('div', { class: 'col', style: { gap: '8px' } });
    this.adjBox = h('div', { class: 'col hidden', style: { gap: '8px' } });
    this.status = h('div', { class: 'mm-status muted' }, 'Pick a move to preview it on your character.');
    this.nameInput = h('input', { placeholder: 'Clip name', style: { width: '100%' } });
    this.addBtn = h('button', { class: 'primary grow', disabled: true, onclick: () => this.commit(false) }, 'Add as new clip');
    this.replaceBtn = h('button', { class: 'grow hidden', onclick: () => this.commit(true) }, 'Replace');
    this.playBtn = h('button', { class: 'small', title: 'Play / pause the preview', onclick: () => this.togglePlay() }, '❚❚');
    this.tabPick = h('button', { style: { flex: 1 }, onclick: () => this.setStep('pick') }, '1 · Pick a move');
    this.tabAdj = h('button', { style: { flex: 1 }, onclick: () => this.setStep('adjust') }, '2 · Adjust');
    this.panel = h(
      'div',
      { class: 'rb-panel card mm-panel' },
      h('div', { class: 'row' }, h('b', { class: 'grow' }, '✦ Move Maker'), h('button', { class: 'ghost icon', title: 'Close', onclick: () => this.close() }, '✕')),
      h('div', { class: 'seg', style: { width: '100%' } }, this.tabPick, this.tabAdj),
      h('div', { class: 'row' }, this.playBtn, this.status),
      h('div', { class: 'rb-body' }, this.pickBox, this.adjBox),
      h('div', { class: 'col', style: { gap: '6px' } }, this.nameInput, h('div', { class: 'row' }, this.replaceBtn, this.addBtn))
    );
    document.getElementById('center').append(this.panel);
    this.setStep('pick');
  }

  setStep(step) {
    this.step = step;
    this.pickBox.classList.toggle('hidden', step !== 'pick');
    this.adjBox.classList.toggle('hidden', step !== 'adjust');
    this.tabPick.classList.toggle('on', step === 'pick');
    this.tabAdj.classList.toggle('on', step === 'adjust');
    if (step === 'adjust') this.renderAdjust();
  }

  togglePlay() {
    this.vp.previewPlaying = this.vp.previewPlaying === false;
    this.playBtn.textContent = this.vp.previewPlaying === false ? '▶' : '❚❚';
  }

  // ------------------------------------------------------------------ step 1: pick
  renderPick() {
    if (!this.pickBox) return;
    clear(this.pickBox);
    const cur = app.clip;
    if (cur && cur.layers.some((l) => Object.keys(l.tracks).length))
      this.pickBox.append(
        h('button', { class: 'mm-current', onclick: () => this.useCurrentClip() }, h('b', {}, '✎ Adjust the current clip'), h('span', { class: 'muted' }, cur.name))
      );
    const nMine = this.library?.length || 0;
    if (nMine)
      this.pickBox.append(
        h(
          'div',
          { class: 'seg', style: { width: '100%' } },
          h('button', { class: this.source === 'ref' ? 'on' : '', style: { flex: 1 }, onclick: () => ((this.source = 'ref'), this.renderPick()) }, `Animation packs (${this.catalog?.length || 0})`),
          h('button', { class: this.source === 'mine' ? 'on' : '', style: { flex: 1 }, onclick: () => ((this.source = 'mine'), this.renderPick()) }, `★ My moves (${nMine})`)
        )
      );
    const search = h('input', {
      placeholder: 'Search (walk, sword, dance…)',
      value: this.query,
      style: { flex: 1, minWidth: 0 },
      oninput: (e) => {
        this.query = e.target.value.toLowerCase();
        this.renderList();
      },
    });
    const cat = h(
      'select',
      { title: 'Category', style: { width: '118px' }, onchange: (e) => ((this.category = e.target.value), this.renderList()) },
      [{ id: 'all', label: 'All moves' }, ...CATEGORIES].map((c) => h('option', { value: c.id, selected: c.id === this.category }, c.label))
    );
    this.list = h('div', { class: 'col', style: { gap: '2px' } });
    this.pickBox.append(h('div', { class: 'row mm-search' }, search, cat), this.list);
    this.renderList();
  }

  /** Moves from every pack (packSources is cached; ＋ Add animations refreshes it). */
  async loadCatalog() {
    try {
      this.catalog = buildCatalog(await packSources());
    } catch (e) {
      this.catalog = [];
      toast('Could not read the animation packs: ' + e.message, 'err');
    }
  }

  renderList() {
    clear(this.list);
    if (this.source === 'mine') return this.renderMine();
    if (!this.catalog) return this.list.append(h('div', { class: 'muted' }, 'Loading animation packs…'));
    if (!this.catalog.length)
      return this.list.append(
        h(
          'div',
          { class: 'card col', style: { gap: '8px', fontSize: '12.5px', lineHeight: 1.5, color: 'var(--text2)' } },
          'No animations yet. Download some (Mixamo .fbx, or a pack such as Quaternius’ free Universal Animation Library), then add them here. They work on every character.',
          h('button', {
            class: 'primary',
            onclick: async () => {
              const { addAnimations } = await import('../app/dialogs.js');
              if (!(await addAnimations())) return;
              await this.loadCatalog();
              this.renderList();
            },
          }, '＋ Add animations…')
        )
      );
    const q = this.query;
    const moves = this.catalog.filter((m) => (this.category === 'all' || m.category === this.category) && (!q || `${m.title} ${m.key}`.toLowerCase().includes(q)));
    if (!moves.length) this.list.append(h('div', { class: 'muted', style: { fontSize: '12px' } }, 'No moves match.'));
    for (const m of moves) {
      const on = this.sel?.move === m;
      const row = h(
        'div',
        { class: 'mm-move' + (on ? ' on' : ''), onclick: () => this.pick(m) },
        h('span', { class: 'grow' }, m.title),
        h('span', { class: 'muted', style: { fontSize: '11px' } }, m.variants.length > 1 ? `${m.variants.length} styles` : `${(m.variants[0].duration || 0).toFixed(1)}s`)
      );
      this.list.append(row);
      if (on) {
        const chips = h(
          'div',
          { class: 'mm-variants' },
          m.variants.length > 1 ? h('div', { class: 'muted', style: { fontSize: '11.5px', width: '100%' } }, 'Style from:') : null,
          m.variants.length > 1
            ? m.variants.map((v) => h('button', { class: 'small' + (this.sel.variant === v ? ' on' : ''), title: `${v.model} › ${v.clip}`, onclick: (e) => (e.stopPropagation(), this.pick(m, v)) }, v.label))
            : h('span', { class: 'muted grow', style: { fontSize: '11px', alignSelf: 'center' } }, `from ${m.variants[0].label}`),
          h('button', { class: 'small', title: 'Save this move (with your Adjust sliders) to ★ My moves, so you can reuse it on any character', onclick: (e) => (e.stopPropagation(), this.makeStandard(m)) }, '★ Save to my moves…')
        );
        this.list.append(chips);
      }
    }
    this.list.querySelector('.mm-move.on')?.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ my library
  renderMine() {
    const q = this.query;
    const items = (this.library || []).filter((it) => (this.category === 'all' || it.category === this.category) && (!q || `${it.name} ${it.file}`.toLowerCase().includes(q)));
    if (!this.library?.length) {
      this.list.append(
        h(
          'div',
          { class: 'card', style: { fontSize: '12.5px', lineHeight: 1.5, color: 'var(--text2)' } },
          h('b', { style: { color: 'var(--text)' } }, 'No saved moves yet. '),
          'Pick a move in Animation packs and press “★ Save to my moves”. Saved moves work on any character.'
        )
      );
      return;
    }
    if (!items.length) this.list.append(h('div', { class: 'muted', style: { fontSize: '12px' } }, 'No moves match.'));
    for (const it of items) {
      const on = this.libSel?.file === it.file;
      this.list.append(
        h(
          'div',
          { class: 'mm-move' + (on ? ' on' : ''), onclick: () => this.pickMine(it) },
          h('span', { class: 'grow' }, '★ ' + (it.name || it.file)),
          h('span', { class: 'muted', style: { fontSize: '11px' } }, `${(it.duration || 0).toFixed(1)}s${it.loop ? ' ⟲' : ''}`)
        )
      );
      if (on)
        this.list.append(
          h(
            'div',
            { class: 'mm-variants' },
            h('button', { class: 'small', onclick: (e) => (e.stopPropagation(), this.setStep('adjust')) }, 'Adjust…'),
            h('button', { class: 'small', onclick: (e) => (e.stopPropagation(), this.renameMine(it)) }, 'Rename'),
            h('button', { class: 'small danger', onclick: (e) => (e.stopPropagation(), this.deleteMine(it)) }, 'Delete'),
            it.note ? h('div', { class: 'muted', style: { fontSize: '11px', width: '100%' } }, it.note) : null
          )
        );
    }
    this.list.querySelector('.mm-move.on')?.scrollIntoView({ block: 'nearest' });
  }

  async pickMine(it) {
    this.libSel = it;
    this.sel = null;
    this.target = null;
    this.renderList();
    this.setStatus(`Loading ★ ${it.name}…`);
    try {
      const { clip } = await loadMove(it.file);
      if (this.libSel !== it) return;
      this.base = moveOnCharacter(clip, app.rig, it.name);
      this.params = { ...STYLE_DEFAULTS };
      this.nameInput.value = this.uniqueName(it.name);
      this.replaceBtn.classList.add('hidden');
      this.addBtn.disabled = false;
      this.setStatus(`★ ${it.name} (your library) — preview playing. Adjust it in step 2.`);
      this.rebuild();
    } catch (e) {
      console.error(e);
      this.setStatus('Could not load: ' + e.message);
    }
  }

  async renameMine(it) {
    const n = await promptDialog('Rename library move', it.name);
    if (!n || n === it.name) return;
    const { data, clip } = await loadMove(it.file);
    await saveMove({ key: data.key || it.name, title: n, category: data.category, clip, sources: data.sources, params: data.params, note: data.note });
    await this.refreshLibrary();
  }

  async deleteMine(it) {
    if (!(await confirmDialog('Delete library move', `Delete ★ ${it.name} from your library? (Clips you already added stay.)`, { ok: 'Delete', danger: true }))) return;
    await deleteMove(it.file);
    this.libSel = null;
    this.base = null;
    this.vp.setPreview(null);
    await this.refreshLibrary();
  }

  /** Blend reference styles of one move into a standard move and save it. */
  async makeStandard(move) {
    const custom = this.sel?.move === move && Object.keys(STYLE_DEFAULTS).some((k) => k !== 'loop' && this.params[k] !== STYLE_DEFAULTS[k]);
    const v = await formDialog({
      title: `★ Save ${move.title} to my moves`,
      intro: 'Saves the move on AnimStudio’s neutral skeleton so it works on any character. With several styles, their timing is lined up and they are blended into one.',
      ok: 'Save',
      wide: true,
      fields: [
        { key: 'name', label: 'Name', type: 'text', value: move.title },
        { key: 'category', label: 'Category', type: 'select', value: move.category, options: CATEGORIES.map((c) => ({ value: c.id, label: c.label })) },
        { key: 'styles', label: 'Blend these styles', type: 'checklist', bulk: true, value: move.variants.map((x) => x.model), options: move.variants.map((x) => ({ value: x.model, label: x.label })) },
        { key: 'adjust', type: 'checkbox', text: 'Also apply my current Adjust sliders', value: custom },
      ],
      validate: (x) => (!x.styles.length ? 'Pick at least one style' : null),
    });
    if (!v) return;
    const b = busy('Building your move…');
    try {
      const variants = move.variants.filter((x) => v.styles.includes(x.model));
      const { clip, used } = await buildStandardMove(move, variants, {
        params: v.adjust ? { ...this.params } : null,
        onProgress: (k, n, x) => b.set(`Blending ${move.title}: ${x.label} (${k + 1}/${n})…`),
      });
      const file = await saveMove({
        key: move.key,
        title: v.name || move.title,
        category: v.category,
        clip,
        sources: variants.map((x) => `${x.model} › ${x.clip}`),
        params: v.adjust ? { ...this.params } : null,
        note: `blend of ${used} style(s)`,
      });
      b.close();
      toast(`★ ${v.name || move.title} saved to your library`, 'ok');
      this.source = 'mine';
      this.library = await listLibrary();
      this.renderPick();
      const it = this.library.find((x) => x.file === file);
      if (it) this.pickMine(it);
    } catch (e) {
      b.close();
      console.error(e);
      toast('Could not build the move: ' + e.message, 'err');
    }
  }

  async saveIntoLibrary() {
    const it = this.libSel;
    if (!it) return;
    const { data, clip } = await loadMove(it.file);
    const std = standardRig();
    const improved = applyStyle(clip, std, this.params, { fps: 30 });
    await saveMove({ key: data.key || it.name, title: it.name, category: data.category, clip: improved, sources: data.sources, params: null, note: `${data.note || ''} · refined ${new Date().toLocaleDateString()}`.trim() });
    toast(`★ ${it.name} updated in your library`, 'ok');
    this.params = { ...STYLE_DEFAULTS };
    await this.refreshLibrary();
    const again = this.library.find((x) => x.file === it.file);
    if (again) await this.pickMine(again);
    this.renderAdjust();
  }

  defaultVariant(m) {
    return m.variants[0];
  }

  async pick(move, variant = null) {
    variant ||= this.defaultVariant(move);
    this.sel = { move, variant };
    this.libSel = null;
    this.target = null;
    this.renderList();
    this.setStatus(`Loading ${move.title} (${variant.label})…`);
    try {
      let base;
      const own = app.model.name === variant.model && app.originals.get(variant.clip);
      if (own) base = own;
      else {
        const src = await loadAnimSource(variant.url, variant.model);
        if (this.sel?.variant !== variant) return; // user picked something else meanwhile
        const clip = src.byName.get(variant.clip);
        if (!clip) throw new Error('clip not found');
        base = retargetClip(clip, src.rig, app.rig, { mode: 'auto', name: move.key }).clip;
      }
      this.base = base;
      this.params = { ...STYLE_DEFAULTS };
      this.nameInput.value = this.uniqueName(move.title);
      this.replaceBtn.classList.add('hidden');
      this.addBtn.disabled = false;
      this.setStatus(`${move.title} · ${variant.label} — preview playing. Adjust it in step 2.`);
      this.rebuild();
    } catch (e) {
      console.error(e);
      this.setStatus(`Could not load: ${e.message}`);
    }
  }

  async useCurrentClip() {
    const c = app.committedClip;
    if (!c) return;
    const recipe = c.meta?.recipe;
    this.target = c;
    if (recipe?.library) {
      const it = (this.library || []).find((x) => x.file === recipe.library);
      if (it) {
        this.source = 'mine';
        await this.pickMine(it);
        this.target = c;
        Object.assign(this.params, recipe.params || {});
      } else this.base = c;
    } else if (recipe) {
      // Re-edit a Move Maker clip from its original source with its saved settings.
      const m = this.catalog?.find((x) => x.variants.some((v) => v.model === recipe.model && v.clip === recipe.clip));
      const v = m?.variants.find((x) => x.model === recipe.model && x.clip === recipe.clip);
      if (m && v) {
        await this.pick(m, v);
        this.target = c;
        Object.assign(this.params, recipe.params);
      } else this.base = c;
    } else {
      this.base = c;
      this.sel = null;
      this.params = { ...STYLE_DEFAULTS };
    }
    this.nameInput.value = c.name;
    this.replaceBtn.textContent = `Replace “${c.name}”`;
    this.replaceBtn.classList.remove('hidden');
    this.addBtn.disabled = false;
    this.setStatus(`Adjusting ${c.name}`);
    this.rebuild();
    this.setStep('adjust');
  }

  uniqueName(base) {
    const used = new Set(app.clips.map((c) => c.name));
    let n = base,
      k = 2;
    while (used.has(n)) n = `${base}_${k++}`;
    return n;
  }

  setStatus(t) {
    this.status.textContent = t;
  }

  // ------------------------------------------------------------------ step 2: adjust
  renderAdjust() {
    clear(this.adjBox);
    if (!this.base) {
      this.adjBox.append(h('div', { class: 'muted' }, 'Pick a move first (step 1).'));
      return;
    }
    const p = this.params;
    for (const g of SLIDERS) {
      this.adjBox.append(h('div', { class: 'sec-title', style: { fontSize: '11px', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.7px', marginTop: '4px' } }, g.group));
      for (const [key, label, min, max, step, fmt] of g.items) {
        const val = h('span', { class: 'mono muted', style: { width: '44px', textAlign: 'right', fontSize: '11.5px' } }, fmt(p[key]));
        const rng = h('input', {
          type: 'range',
          min,
          max,
          step,
          value: p[key],
          oninput: (e) => {
            p[key] = +e.target.value;
            val.textContent = fmt(p[key]);
            this.update();
          },
          ondblclick: () => {
            p[key] = STYLE_DEFAULTS[key];
            rng.value = p[key];
            val.textContent = fmt(p[key]);
            this.update();
          },
          title: 'Double-click to reset',
        });
        this.adjBox.append(h('div', { class: 'rb-slider' }, h('span', {}, label), rng, val));
      }
    }
    const loopNow = p.loop ?? this.base.loop;
    this.adjBox.append(
      h(
        'div',
        { class: 'row wrap', style: { marginTop: '4px' } },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.mirror, onchange: (e) => ((p.mirror = e.target.checked), this.update()) }), 'Mirror (L ↔ R)'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: loopNow, onchange: (e) => ((p.loop = e.target.checked), this.update()) }), 'Loops'),
        h('button', { class: 'small', onclick: () => ((this.params = { ...STYLE_DEFAULTS }), this.renderAdjust(), this.update()) }, 'Reset all')
      ),
      this.libSel && this.source === 'mine'
        ? h('button', { class: 'primary', title: 'Bake these slider changes into the library move itself, so it becomes your new standard', onclick: () => this.saveIntoLibrary() }, `★ Save these changes into “${this.libSel.name}”`)
        : null,
      h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Tip: double-click a slider to reset it. After adding, pose the character to change any frame — your changes go on the “My edits” layer on top.')
    );
  }

  rebuild() {
    if (!this.active || !this.base) return;
    try {
      this.result = applyStyle(this.base, app.rig, this.params, { fps: app.fps });
      this.vp.setPreview(this.result);
    } catch (e) {
      console.error(e);
      this.setStatus('Preview failed: ' + e.message);
    }
  }

  commit(replace) {
    if (!this.result) return;
    const clip = applyStyle(this.base, app.rig, this.params, { fps: app.fps });
    // Your own changes go on a layer on top, so the motion underneath stays intact and the
    // edits are easy to see, tweak, mute or weight.
    const edits = makeLayer('My edits', 'additive');
    clip.layers.push(edits);
    const toEdits = () => app.setLayer(edits.id);
    const sel = this.sel;
    if (!sel && this.libSel && this.source === 'mine' && !this.target) {
      clip.meta = { source: 'derived', note: `Move Maker · ★ ${this.libSel.name} (my library)`, recipe: { library: this.libSel.file, params: { ...this.params } } };
      clip.name = this.uniqueName(this.nameInput.value.trim() || this.libSel.name);
      app.addClip(clip, 'Move Maker: add clip');
      toEdits();
      toast(`Added “${clip.name}”`, 'ok');
      this.target = app.committedClip;
      this.replaceBtn.textContent = `Replace “${clip.name}”`;
      this.replaceBtn.classList.remove('hidden');
      return;
    }
    clip.meta = {
      source: 'derived',
      note: sel ? `Move Maker · ${sel.move.title} (${sel.variant.label})` : `Move Maker · adjusted ${this.target?.name}`,
      recipe: sel ? { model: sel.variant.model, clip: sel.variant.clip, params: { ...this.params } } : this.target?.meta?.recipe || null,
    };
    if (replace && this.target) {
      const id = this.target.id;
      clip.id = id;
      clip.name = this.nameInput.value.trim() || this.target.name;
      if (clip.name !== this.target.name) clip.name = this.uniqueName(clip.name);
      // Keep the edits already made on the clip being replaced.
      const old = this.target.layers.filter((l) => l.mode !== 'base');
      if (old.length) clip.layers = [clip.layers[0], ...old];
      app.editClips('Move Maker: replace clip', (arr) => arr.map((c) => (c.id === id ? clip : c)));
      app.selectClip(id);
      app.setLayer((clip.layers.find((l) => l.name === 'My edits') || clip.layers[clip.layers.length - 1]).id);
      toast(`Updated “${clip.name}”`, 'ok');
    } else {
      clip.name = this.uniqueName(this.nameInput.value.trim() || 'Move');
      app.addClip(clip, 'Move Maker: add clip');
      toEdits();
      toast(`Added “${clip.name}” — pose it to change it (your changes go on the “My edits” layer)`, 'ok', { ms: 5000 });
      this.target = app.committedClip;
      this.replaceBtn.textContent = `Replace “${clip.name}”`;
      this.replaceBtn.classList.remove('hidden');
    }
  }
}

export { prettyMove, canonicalName, sourceLabel };
