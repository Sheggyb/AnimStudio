// Dope sheet: keys of every bone in the active layer, grouped by body part.
import { app } from '../app/state.js';
import { GROUPS, boneTitle } from '../core/rig.js';
import { TYPES } from '../core/clip.js';
import { findKey } from '../core/channel.js';
import { keyId, parseKeyId, retimeSelection, timeKey } from '../app/actions.js';
import { run } from '../app/commands.js';
import { popupMenu } from './dom.js';
import { tv, LABEL_W, RULER_H, drawRuler, drawPlayhead, setupCanvas } from './timeview.js';

const ROW = 20;
const INTERP_COLORS = ['#94a3b8', '#4ade80', '#c084fc', '#f87171'];

export class DopeSheet {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    host.append(this.canvas);
    this.scrollY = 0;
    this.userExpand = new Map();
    this.rows = [];
    this.cacheKey = '';
    this.drag = null;
    this.visible = true;
    this.bind();
    new ResizeObserver(() => this.draw()).observe(host);
    const inval = () => {
      this.cacheKey = '';
      this.draw();
    };
    for (const ev of ['clip', 'clipSelect', 'layer', 'model', 'rigNames']) app.on(ev, inval);
    app.on('selection', inval);
    for (const ev of ['time', 'keySel', 'range', 'timeview', 'settings']) app.on(ev, () => this.draw());
  }

  // ------------------------------------------------------------------ data
  buildRows() {
    const clip = app.clip;
    const L = app.layer;
    const rig = app.rig;
    const key = `${clip?.id}|${app.version}|${app.layerId}|${[...app.sel.bones].join(',')}|${[...this.userExpand].join(',')}`;
    if (key === this.cacheKey) return;
    this.cacheKey = key;
    this.rows = [];
    if (!clip || !L || !rig) return;
    const boneKeys = new Map(); // bone -> [{t, interp}]
    for (const bone in L.tracks) {
      const tr = L.tracks[bone];
      const m = new Map();
      for (const k of TYPES) {
        const ch = tr[k];
        if (!ch) continue;
        for (let i = 0; i < ch.times.length; i++) {
          const tk = timeKey(ch.times[i]);
          if (!m.has(tk)) m.set(tk, ch.interp[i]);
        }
      }
      boneKeys.set(bone, [...m].sort((a, b) => a[0] - b[0]).map(([tk, ip]) => ({ t: tk / 1e4, interp: ip })));
    }
    const merge = (bones) => {
      const m = new Map();
      for (const b of bones) for (const k of boneKeys.get(b) || []) if (!m.has(timeKey(k.t))) m.set(timeKey(k.t), k);
      return [...m.values()].sort((a, b) => a.t - b.t);
    };
    const all = [...boneKeys.keys()];
    this.rows.push({ kind: 'summary', label: `All keys · ${L.name}`, bones: all, keys: merge(all) });
    const selNames = new Set([...app.sel.bones].map((i) => rig.names[i]));
    for (const g of GROUPS) {
      const bones = rig.order.filter((i) => rig.group[i] === g.id && (boneKeys.has(rig.names[i]) || app.sel.bones.has(i))).map((i) => rig.names[i]);
      if (!bones.length) continue;
      const hasSel = bones.some((b) => selNames.has(b));
      const expanded = this.userExpand.has(g.id) ? this.userExpand.get(g.id) : hasSel;
      this.rows.push({ kind: 'group', id: g.id, label: g.label, color: g.color, bones, keys: merge(bones), expanded });
      if (expanded)
        for (const b of bones) {
          const i = rig.byName.get(b);
          this.rows.push({ kind: 'bone', bone: b, i, label: boneTitle(rig, i, app.nick), color: g.color, bones: [b], keys: boneKeys.get(b) || [] });
        }
    }
  }

  rowAt(y) {
    const k = Math.floor((y - RULER_H + this.scrollY) / ROW);
    return k >= 0 && k < this.rows.length ? this.rows[k] : null;
  }
  rowY(k) {
    return RULER_H + k * ROW - this.scrollY;
  }

  idsAt(row, t) {
    const ids = [];
    const L = app.layer;
    for (const b of row.bones) {
      const tr = L.tracks[b];
      if (!tr) continue;
      if (TYPES.some((k) => tr[k] && findKey(tr[k], t, 2e-4) >= 0)) ids.push(keyId(b, t));
    }
    return ids;
  }

  keyHit(row, x) {
    let best = null,
      bd = 6;
    for (const k of row.keys) {
      const d = Math.abs(tv.x(k.t) - x);
      if (d < bd) [bd, best] = [d, k];
    }
    return best;
  }

  // ------------------------------------------------------------------ drawing
  draw() {
    if (!this.visible || !this.host.isConnected || !this.host.clientWidth) return;
    this.buildRows();
    const { g, w, h } = setupCanvas(this.canvas);
    g.fillStyle = '#16191f';
    g.fillRect(0, 0, w, h);
    const clip = app.clip;
    if (!clip) {
      g.fillStyle = '#7a8396';
      g.font = '13px Segoe UI, system-ui';
      g.fillText('No clip selected.', LABEL_W + 20, 50);
      return;
    }
    const maxScroll = Math.max(0, this.rows.length * ROW - (h - RULER_H) + 8);
    this.scrollY = Math.min(Math.max(0, this.scrollY), maxScroll);

    // lanes background
    const xEnd = Math.min(w, tv.x(clip.duration));
    this.rows.forEach((row, k) => {
      const y = this.rowY(k);
      if (y + ROW < RULER_H || y > h) return;
      g.fillStyle = row.kind === 'summary' ? '#1d2230' : row.kind === 'group' ? '#1a1e28' : k % 2 ? '#181b22' : '#16191f';
      g.fillRect(LABEL_W, y, w - LABEL_W, ROW);
      if (row.kind === 'bone' && app.sel.bones.has(row.i)) {
        g.fillStyle = '#1e3a6e55';
        g.fillRect(LABEL_W, y, w - LABEL_W, ROW);
      }
    });
    // outside clip shade
    if (xEnd < w) {
      g.fillStyle = '#0d0f1499';
      g.fillRect(Math.max(LABEL_W, xEnd), RULER_H, w - xEnd, h);
    }
    if (tv.x(0) > LABEL_W) {
      g.fillStyle = '#0d0f1499';
      g.fillRect(LABEL_W, RULER_H, tv.x(0) - LABEL_W, h);
    }
    if (app.range) {
      const a = Math.max(LABEL_W, tv.x(app.range[0]));
      const b = Math.min(w, tv.x(app.range[1]));
      g.fillStyle = '#3b82f614';
      g.fillRect(a, RULER_H, b - a, h);
      g.strokeStyle = '#3b82f688';
      g.beginPath();
      g.moveTo(a + 0.5, RULER_H);
      g.lineTo(a + 0.5, h);
      g.moveTo(b - 0.5, RULER_H);
      g.lineTo(b - 0.5, h);
      g.stroke();
    }

    // keys
    const moving = this.drag?.mode === 'move' || this.drag?.mode === 'scale';
    const sel = app.keySel;
    this.rows.forEach((row, k) => {
      const y = this.rowY(k);
      if (y + ROW < RULER_H || y > h) return;
      const cy = y + ROW / 2;
      const size = row.kind === 'bone' ? 5 : 4.2;
      for (const key of row.keys) {
        const x = tv.x(key.t);
        if (x < LABEL_W - 6 || x > w + 6) continue;
        let isSel = false;
        if (row.kind === 'bone') isSel = sel.has(keyId(row.bone, key.t));
        else if (sel.size) isSel = row.bones.some((b) => sel.has(keyId(b, key.t)));
        g.fillStyle = isSel ? '#fbbf24' : row.kind === 'bone' ? INTERP_COLORS[key.interp] || '#94a3b8' : '#6b7a92';
        g.beginPath();
        g.moveTo(x, cy - size);
        g.lineTo(x + size, cy);
        g.lineTo(x, cy + size);
        g.lineTo(x - size, cy);
        g.closePath();
        g.fill();
        if (isSel) {
          g.strokeStyle = '#78350f';
          g.stroke();
        }
      }
    });

    // labels
    g.fillStyle = '#1a1d25';
    g.fillRect(0, RULER_H, LABEL_W, h);
    g.font = '12px Segoe UI, system-ui, sans-serif';
    g.textBaseline = 'middle';
    this.rows.forEach((row, k) => {
      const y = this.rowY(k);
      if (y + ROW < RULER_H || y > h) return;
      const cy = y + ROW / 2;
      if (row.kind === 'bone' && app.sel.bones.has(row.i)) {
        g.fillStyle = row.i === app.sel.active ? '#2a4f86' : '#1e3a6e';
        g.fillRect(0, y, LABEL_W, ROW);
      }
      if (row.kind === 'summary') {
        g.fillStyle = '#c8d0de';
        g.font = '600 12px Segoe UI, system-ui';
        g.fillText(row.label, 10, cy);
        g.font = '12px Segoe UI, system-ui';
      } else if (row.kind === 'group') {
        g.fillStyle = '#8b94a7';
        g.fillText(row.expanded ? '▾' : '▸', 8, cy);
        g.fillStyle = row.color;
        g.fillRect(22, cy - 4, 8, 8);
        g.fillStyle = '#c8d0de';
        g.fillText(`${row.label}  (${row.bones.length})`, 36, cy);
      } else {
        g.fillStyle = row.color;
        g.fillRect(28, cy - 1, 6, 2);
        g.fillStyle = '#d5dbe6';
        const label = row.label.length > 24 ? row.label.slice(0, 23) + '…' : row.label;
        g.fillText(label, 40, cy);
      }
    });
    g.strokeStyle = '#2c3240';
    g.beginPath();
    g.moveTo(LABEL_W - 0.5, RULER_H);
    g.lineTo(LABEL_W - 0.5, h);
    g.stroke();

    // ruler + markers + playhead
    const markers = clip.events.map((e) => ({ t: e.t, color: '#22d3ee' }));
    if (app.keyPoses?.clipId === clip.id) for (const t of app.keyPoses.times) markers.push({ t, color: '#f472b6' });
    drawRuler(g, w, { markers });
    g.save();
    g.beginPath();
    g.rect(LABEL_W, 0, w - LABEL_W, h);
    g.clip();
    drawPlayhead(g, w, h);
    g.restore();

    // box select
    if (this.drag?.mode === 'box') {
      const { x0, y0, x1, y1 } = this.drag;
      g.fillStyle = '#3b82f622';
      g.strokeStyle = '#60a5fa';
      g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      g.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    if (moving && this.drag.label) {
      g.fillStyle = '#0b1220e6';
      g.font = '12px Consolas, monospace';
      const tw = g.measureText(this.drag.label).width + 12;
      g.fillRect(this.drag.lastX + 10, this.drag.lastY - 24, tw, 18);
      g.fillStyle = '#fbbf24';
      g.fillText(this.drag.label, this.drag.lastX + 16, this.drag.lastY - 15);
    }
    if (!this.rows.length || this.rows.length === 1) {
      g.fillStyle = '#7a8396';
      g.font = '12.5px Segoe UI, system-ui';
      g.fillText('No keys on this layer yet — pose a bone and press K (auto-key keys for you).', LABEL_W + 16, RULER_H + 40);
    }
  }

  // ------------------------------------------------------------------ interaction
  bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('dblclick', (e) => this.onDbl(e));
    c.addEventListener('contextmenu', (e) => this.onContext(e));
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.altKey) tv.zoomAt(e.offsetX, Math.exp(-e.deltaY * 0.0015));
        else if (e.shiftKey) tv.pan(-e.deltaY);
        else {
          this.scrollY += e.deltaY;
          this.draw();
        }
      },
      { passive: false }
    );
  }

  onDown(e) {
    if (!app.clip) return;
    const x = e.offsetX,
      y = e.offsetY;
    this.canvas.setPointerCapture(e.pointerId);
    if (e.button === 1) {
      this.drag = { mode: 'pan', x0: x };
      return;
    }
    if (e.button !== 0) return;
    if (y < RULER_H) {
      if (x < LABEL_W) return;
      app.setPlaying(false);
      if (e.shiftKey) {
        const t = app.snap(tv.t(x));
        this.drag = { mode: 'range', t0: t };
        app.setRange([t, t]);
      } else {
        this.drag = { mode: 'scrub' };
        app.setTime(tv.t(x), { snap: true });
      }
      return;
    }
    const row = this.rowAt(y);
    if (x < LABEL_W) {
      if (!row) return;
      if (row.kind === 'group' && x < 20) return this.toggleGroup(row);
      const idx = row.bones.map((b) => app.rig.byName.get(b));
      if (row.kind === 'summary') return;
      app.selectBones(idx, { mode: e.shiftKey ? 'add' : e.ctrlKey ? 'toggle' : 'replace', active: row.kind === 'bone' ? row.i : idx[0] });
      return;
    }
    const hit = row && this.keyHit(row, x);
    if (hit) {
      const ids = this.idsAt(row, hit.t);
      if (e.shiftKey || e.ctrlKey) {
        const allSel = ids.every((id) => app.keySel.has(id));
        ids.forEach((id) => (allSel ? app.keySel.delete(id) : app.keySel.add(id)));
      } else if (!ids.every((id) => app.keySel.has(id))) app.keySel = new Set(ids);
      app.emit('keySel');
      app.setPlaying(false);
      app.setTime(hit.t);
      this.drag = { mode: e.altKey ? 'scale' : 'move', x0: x, origSel: new Set(app.keySel), dt: 0, factor: 1, lastX: x, lastY: y, pivot: app.time };
      return;
    }
    this.drag = { mode: 'box', x0: x, y0: y, x1: x, y1: y, add: e.shiftKey || e.ctrlKey };
  }

  onMove(e) {
    const d = this.drag;
    if (!d) return;
    const x = e.offsetX,
      y = e.offsetY;
    if (d.mode === 'pan') {
      tv.pan(x - d.x0);
      d.x0 = x;
    } else if (d.mode === 'scrub') app.setTime(tv.t(x), { snap: true });
    else if (d.mode === 'range') app.setRange([d.t0, app.snap(tv.t(x))]);
    else if (d.mode === 'box') {
      d.x1 = x;
      d.y1 = y;
      this.draw();
    } else if (d.mode === 'move' || d.mode === 'scale') {
      d.lastX = x;
      d.lastY = y;
      if (d.mode === 'move') {
        const dt = Math.round(((x - d.x0) / tv.pps) * app.fps) / app.fps;
        if (dt === d.dt) return;
        d.dt = dt;
        d.label = `${dt >= 0 ? '+' : ''}${Math.round(dt * app.fps)} f`;
        if (!app.live) app.beginLive('Move keys');
        let next;
        app.updateLive((draft) => (next = retimeSelection(draft, app.layerIndex, d.origSel, (t) => app.snap(t + dt))));
        d.next = next;
      } else {
        const f = Math.max(0.05, 1 + (x - d.x0) / 200);
        if (Math.abs(f - d.factor) < 0.005) return;
        d.factor = f;
        d.label = `×${f.toFixed(2)}`;
        if (!app.live) app.beginLive('Scale keys');
        let next;
        app.updateLive((draft) => (next = retimeSelection(draft, app.layerIndex, d.origSel, (t) => app.snap(d.pivot + (t - d.pivot) * f))));
        d.next = next;
      }
      this.draw();
    }
  }

  onUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.mode === 'move' || d.mode === 'scale') {
      if (app.live && d.next && (d.dt !== 0 || d.factor !== 1)) {
        app.commitLive(d.mode === 'move' ? 'Move keys' : 'Scale keys');
        app.keySel = d.next;
        app.emit('keySel');
      } else app.cancelLive();
    } else if (d.mode === 'box') {
      const [xa, xb] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
      const [ya, yb] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
      const sel = d.add ? new Set(app.keySel) : new Set();
      if (xb - xa < 3 && yb - ya < 3) {
        // plain click on empty lane: clear selection & move playhead
        app.keySel = sel;
        app.emit('keySel');
        app.setTime(tv.t(d.x0), { snap: true });
        return this.draw();
      }
      this.rows.forEach((row, k) => {
        const y = this.rowY(k) + ROW / 2;
        if (y < ya || y > yb) return;
        for (const key of row.keys) {
          const x = tv.x(key.t);
          if (x >= xa && x <= xb) this.idsAt(row, key.t).forEach((id) => sel.add(id));
        }
      });
      app.keySel = sel;
      app.emit('keySel');
    }
    this.draw();
  }

  onDbl(e) {
    if (e.offsetY < RULER_H) {
      app.setRange(null);
      return;
    }
    const row = this.rowAt(e.offsetY);
    if (row?.kind === 'group' && e.offsetX < LABEL_W) this.toggleGroup(row);
  }

  toggleGroup(row) {
    this.userExpand.set(row.id, !row.expanded);
    this.cacheKey = '';
    this.draw();
  }

  onContext(e) {
    e.preventDefault();
    const row = this.rowAt(e.offsetY);
    if (row && e.offsetX >= LABEL_W) {
      const hit = this.keyHit(row, e.offsetX);
      if (hit && !this.idsAt(row, hit.t).every((id) => app.keySel.has(id))) {
        app.keySel = new Set(this.idsAt(row, hit.t));
        app.emit('keySel');
      }
    }
    const has = app.keySel.size > 0;
    popupMenu(
      [
        { header: has ? `${app.keySel.size} key(s) selected` : 'Keys' },
        { label: 'Copy keys', shortcut: 'Ctrl+C', run: () => run('keys.copy'), disabled: !has },
        { label: 'Paste keys at playhead', shortcut: 'Ctrl+V', run: () => run('keys.paste') },
        { label: 'Paste mirrored', run: () => run('keys.pasteMirror') },
        { label: 'Delete keys', shortcut: 'Del', run: () => run('keys.delete'), disabled: !has },
        'sep',
        { label: 'Interpolation: Smooth', run: () => run('keys.interp.smooth') },
        { label: 'Interpolation: Linear', run: () => run('keys.interp.linear') },
        { label: 'Interpolation: Ease in/out', run: () => run('keys.interp.ease') },
        { label: 'Interpolation: Step (hold)', run: () => run('keys.interp.step') },
        'sep',
        { label: 'Select all keys', shortcut: 'Ctrl+A', run: () => run('keys.selectAll') },
        { label: 'Select keys in range', run: () => run('keys.selectRange'), disabled: !app.range },
        row?.kind === 'bone' ? { label: `Select all keys of ${row.label}`, run: () => run('keys.selectBone', row.bone) } : null,
        'sep',
        { label: 'Set range from selected keys', run: () => run('range.fromKeys'), disabled: !has },
        { label: 'Frame all (fit)', shortcut: 'Home', run: () => tv.fit(this.canvas.clientWidth) },
      ],
      e.clientX,
      e.clientY
    );
  }
}

export { parseKeyId };
