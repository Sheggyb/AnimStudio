// Graph editor: animation curves of the active bone (active layer). Rotations are shown as
// unwrapped Euler XYZ degrees; dragging a point edits that Euler component of the key.
import * as THREE from 'three';
import { app } from '../app/state.js';
import { boneTitle } from '../core/rig.js';
import { sample, retimeKeys, mergeTimes, INTERP_NAMES } from '../core/channel.js';
import { pruneLayer } from '../core/clip.js';
import { tv, LABEL_W, RULER_H, drawRuler, drawPlayhead, setupCanvas } from './timeview.js';
import { h } from './dom.js';

const CH = [
  { id: 'rx', type: 'rot', comp: 0, label: 'Rotation X', color: '#f87171' },
  { id: 'ry', type: 'rot', comp: 1, label: 'Rotation Y', color: '#4ade80' },
  { id: 'rz', type: 'rot', comp: 2, label: 'Rotation Z', color: '#60a5fa' },
  { id: 'px', type: 'pos', comp: 0, label: 'Position X', color: '#fca5a5' },
  { id: 'py', type: 'pos', comp: 1, label: 'Position Y', color: '#86efac' },
  { id: 'pz', type: 'pos', comp: 2, label: 'Position Z', color: '#93c5fd' },
];
const DEG = 180 / Math.PI;
const POS_SCALE = 100; // show positions in centimetres (1 unit = 1 m)
const e = new THREE.Euler();
const q = new THREE.Quaternion();

export class GraphEditor {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    host.append(this.canvas);
    this.show = { rx: true, ry: true, rz: true, px: false, py: false, pz: false };
    this.v0 = -90;
    this.vpp = 1;
    this.autoFit = true;
    this.sel = new Set(); // "chId|keyIndex"
    this.drag = null;
    this.visible = false;
    this.cacheKey = '';
    this.tools = h(
      'div',
      { class: 'editor-tools' },
      ...['Smooth', 'Linear', 'Ease', 'Step'].map((n, k) => h('button', { title: `Interpolation of selected keys: ${n}`, onclick: () => this.setInterp([1, 0, 2, 3][k]) }, n)),
      h('button', { title: 'Fit curves (F)', onclick: () => this.fit() }, 'Fit')
    );
    host.append(this.tools);
    this.bind();
    new ResizeObserver(() => this.draw()).observe(host);
    const inval = () => {
      this.cacheKey = '';
      this.draw();
    };
    for (const ev of ['clip', 'clipSelect', 'layer', 'model', 'rigNames']) app.on(ev, inval);
    app.on('selection', () => {
      this.sel.clear();
      this.autoFit = true;
      inval();
    });
    for (const ev of ['time', 'range', 'timeview']) app.on(ev, () => this.draw());
  }

  bone() {
    return app.sel.active >= 0 && app.rig ? app.rig.names[app.sel.active] : null;
  }

  // ------------------------------------------------------------------ data
  buildCurves() {
    const clip = app.clip;
    const L = app.layer;
    const bone = this.bone();
    const key = `${clip?.id}|${app.version}|${app.layerId}|${bone}`;
    if (key === this.cacheKey) return this.curves;
    this.cacheKey = key;
    this.curves = [];
    if (!clip || !L || !bone) return this.curves;
    const tr = L.tracks[bone] || {};
    const cycle = clip.loop ? clip.duration : 0;
    for (const type of ['rot', 'pos']) {
      const ch = tr[type];
      if (!ch || !ch.times.length) continue;
      const n = Math.min(600, Math.max(120, Math.round(clip.duration * 60)));
      const grid = [];
      for (let k = 0; k <= n; k++) grid.push((k / n) * clip.duration);
      const times = mergeTimes(grid, Array.from(ch.times));
      const vals = [[], [], []];
      const buf = new Float32Array(4);
      let prev = null;
      for (const t of times) {
        sample(ch, t, buf, cycle);
        let v;
        if (type === 'rot') {
          e.setFromQuaternion(q.fromArray(buf), 'XYZ');
          v = [e.x * DEG, e.y * DEG, e.z * DEG];
          if (prev) for (let c = 0; c < 3; c++) v[c] += Math.round((prev[c] - v[c]) / 360) * 360;
        } else v = [buf[0] * POS_SCALE, buf[1] * POS_SCALE, buf[2] * POS_SCALE];
        prev = v;
        for (let c = 0; c < 3; c++) vals[c].push(v[c]);
      }
      const keyIdx = Array.from(ch.times, (t) => times.findIndex((x) => Math.abs(x - t) < 1e-4));
      for (let c = 0; c < 3; c++) {
        const def = CH.find((d) => d.type === type && d.comp === c);
        this.curves.push({ def, ch, times, vals: vals[c], keys: Array.from(ch.times, (t, i) => ({ i, t, v: vals[c][keyIdx[i]], interp: ch.interp[i] })) });
      }
    }
    if (this.autoFit) this.fit(false);
    return this.curves;
  }

  fit(redraw = true) {
    const vis = (this.curves || []).filter((c) => this.show[c.def.id]);
    let lo = Infinity,
      hi = -Infinity;
    for (const c of vis) for (const v of c.vals) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    if (!Number.isFinite(lo)) [lo, hi] = [-90, 90];
    if (hi - lo < 10) [lo, hi] = [(lo + hi) / 2 - 5, (lo + hi) / 2 + 5];
    const H = Math.max(40, this.canvas.clientHeight - RULER_H - 16);
    this.vpp = H / ((hi - lo) * 1.12);
    this.v0 = lo - (hi - lo) * 0.06;
    this.autoFit = false;
    if (redraw) {
      tv.fit(this.canvas.clientWidth);
      this.draw();
    }
  }

  y(v) {
    return this.canvas.clientHeight - 8 - (v - this.v0) * this.vpp;
  }
  v(y) {
    return (this.canvas.clientHeight - 8 - y) / this.vpp + this.v0;
  }

  // ------------------------------------------------------------------ draw
  draw() {
    if (!this.visible || !this.host.clientWidth) return;
    const { g, w, h: H } = setupCanvas(this.canvas);
    g.fillStyle = '#14171d';
    g.fillRect(0, 0, w, H);
    const clip = app.clip;
    const bone = this.bone();
    const curves = this.buildCurves();
    g.save();
    g.beginPath();
    g.rect(LABEL_W, RULER_H, w - LABEL_W, H - RULER_H);
    g.clip();
    // value grid
    const range = (H - RULER_H) / this.vpp;
    const stepCands = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 45, 90, 180, 360];
    const step = stepCands.find((s) => (s * (H - RULER_H)) / range >= 28) || 720;
    g.font = '10.5px Consolas, monospace';
    g.textBaseline = 'middle';
    for (let v = Math.ceil(this.v(H) / step) * step; v <= this.v(RULER_H); v += step) {
      const y = Math.round(this.y(v)) + 0.5;
      g.strokeStyle = Math.abs(v) < 1e-9 ? '#3e4659' : '#21252f';
      g.beginPath();
      g.moveTo(LABEL_W, y);
      g.lineTo(w, y);
      g.stroke();
    }
    if (clip) {
      const xe = tv.x(clip.duration);
      if (xe < w) {
        g.fillStyle = '#0c0e1299';
        g.fillRect(xe, RULER_H, w - xe, H);
      }
      if (app.range) {
        g.fillStyle = '#3b82f612';
        g.fillRect(tv.x(app.range[0]), RULER_H, tv.x(app.range[1]) - tv.x(app.range[0]), H);
      }
    }
    // curves
    for (const c of curves) {
      if (!this.show[c.def.id]) continue;
      g.strokeStyle = c.def.color;
      g.lineWidth = 1.6;
      g.beginPath();
      c.times.forEach((t, k) => {
        const x = tv.x(t),
          y = this.y(c.vals[k]);
        k ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.stroke();
      g.lineWidth = 1;
      for (const key of c.keys) {
        const x = tv.x(key.t),
          y = this.y(key.v);
        if (x < LABEL_W - 4 || x > w + 4) continue;
        const s = this.sel.has(`${c.def.id}|${key.i}`);
        g.fillStyle = s ? '#fbbf24' : '#0f1115';
        g.strokeStyle = s ? '#fbbf24' : c.def.color;
        g.beginPath();
        if (key.interp === 3) g.rect(x - 3.5, y - 3.5, 7, 7);
        else g.arc(x, y, s ? 4.5 : 3.5, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    }
    drawPlayhead(g, w, H);
    if (this.drag?.mode === 'box') {
      const { x0, y0, x1, y1 } = this.drag;
      g.fillStyle = '#3b82f622';
      g.strokeStyle = '#60a5fa';
      g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      g.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    if (this.drag?.label) {
      g.fillStyle = '#0b1220e6';
      g.font = '12px Consolas, monospace';
      const tw = g.measureText(this.drag.label).width + 12;
      g.fillRect(this.drag.lastX + 12, this.drag.lastY - 26, tw, 18);
      g.fillStyle = '#fbbf24';
      g.fillText(this.drag.label, this.drag.lastX + 18, this.drag.lastY - 17);
    }
    g.restore();

    // label column: channel toggles + axis labels
    g.fillStyle = '#1a1d25';
    g.fillRect(0, RULER_H, LABEL_W, H);
    g.font = '12px Segoe UI, system-ui';
    g.textBaseline = 'middle';
    if (!bone) {
      g.fillStyle = '#7a8396';
      g.fillText('Select a bone to see its curves', 12, RULER_H + 22);
    } else {
      g.fillStyle = '#dde2ec';
      g.font = '600 12px Segoe UI, system-ui';
      const title = boneTitle(app.rig, app.sel.active, app.nick);
      g.fillText(title.length > 26 ? title.slice(0, 25) + '…' : title, 12, RULER_H + 14);
      g.font = '12px Segoe UI, system-ui';
      const have = new Set(curves.map((c) => c.def.id));
      CH.forEach((d, k) => {
        const y = RULER_H + 36 + k * 20;
        const on = this.show[d.id];
        g.fillStyle = have.has(d.id) ? (on ? d.color : '#4b5263') : '#30353f';
        g.fillRect(12, y - 5, 10, 10);
        g.fillStyle = have.has(d.id) ? (on ? '#d5dbe6' : '#7a8396') : '#4b5263';
        g.fillText(d.label + (d.type === 'pos' ? ' (cm)' : ' (°)'), 30, y);
      });
      if (!curves.length) {
        g.fillStyle = '#7a8396';
        g.fillText('No keys on this layer.', 12, RULER_H + 168);
      }
      g.fillStyle = '#5c6578';
      g.font = '10.5px Consolas, monospace';
      g.textAlign = 'right';
      for (let v = Math.ceil(this.v(H) / step) * step; v <= this.v(RULER_H + 10); v += step) g.fillText(+v.toFixed(1) + '', LABEL_W - 6, this.y(v));
      g.textAlign = 'left';
    }
    g.strokeStyle = '#2c3240';
    g.beginPath();
    g.moveTo(LABEL_W - 0.5, RULER_H);
    g.lineTo(LABEL_W - 0.5, H);
    g.stroke();
    drawRuler(g, w, {});
  }

  // ------------------------------------------------------------------ interaction
  hit(x, y) {
    let best = null,
      bd = 7;
    for (const c of this.curves || []) {
      if (!this.show[c.def.id]) continue;
      for (const k of c.keys) {
        const d = Math.hypot(tv.x(k.t) - x, this.y(k.v) - y);
        if (d < bd) [bd, best] = [d, { c, k }];
      }
    }
    return best;
  }

  bind() {
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (ev) => this.onDown(ev));
    cv.addEventListener('pointermove', (ev) => this.onMove(ev));
    cv.addEventListener('pointerup', () => this.onUp());
    cv.addEventListener('dblclick', (ev) => ev.offsetX > LABEL_W && ev.offsetY > RULER_H && !this.hit(ev.offsetX, ev.offsetY) && this.fit());
    cv.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        if (ev.ctrlKey) tv.zoomAt(ev.offsetX, Math.exp(-ev.deltaY * 0.0015));
        else if (ev.shiftKey) tv.pan(-ev.deltaY);
        else {
          const v = this.v(ev.offsetY);
          this.vpp *= Math.exp(-ev.deltaY * 0.0015);
          this.v0 = v - (this.canvas.clientHeight - 8 - ev.offsetY) / this.vpp;
          this.draw();
        }
      },
      { passive: false }
    );
  }

  onDown(ev) {
    const x = ev.offsetX,
      y = ev.offsetY;
    this.canvas.setPointerCapture(ev.pointerId);
    if (ev.button === 1) {
      this.drag = { mode: 'pan', x, y };
      return;
    }
    if (y < RULER_H) {
      if (x > LABEL_W) {
        app.setPlaying(false);
        this.drag = { mode: 'scrub' };
        app.setTime(tv.t(x), { snap: true });
      }
      return;
    }
    if (x < LABEL_W) {
      const k = Math.floor((y - RULER_H - 26) / 20);
      if (k >= 0 && k < CH.length) {
        this.show[CH[k].id] = !this.show[CH[k].id];
        this.draw();
      }
      return;
    }
    const hit = this.hit(x, y);
    if (hit) {
      const id = `${hit.c.def.id}|${hit.k.i}`;
      if (ev.shiftKey) this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id);
      else if (!this.sel.has(id)) this.sel = new Set([id]);
      app.setPlaying(false);
      app.setTime(hit.k.t);
      this.drag = { mode: 'move', x0: x, y0: y, lastX: x, lastY: y, axis: null, free: ev.altKey, orig: new Set(this.sel) };
      this.draw();
      return;
    }
    this.drag = { mode: 'box', x0: x, y0: y, x1: x, y1: y, add: ev.shiftKey };
  }

  onMove(ev) {
    const d = this.drag;
    if (!d) return;
    const x = ev.offsetX,
      y = ev.offsetY;
    if (d.mode === 'pan') {
      tv.pan(x - d.x);
      this.v0 += (y - d.y) / this.vpp;
      d.x = x;
      d.y = y;
      this.draw();
    } else if (d.mode === 'scrub') app.setTime(tv.t(x), { snap: true });
    else if (d.mode === 'box') {
      d.x1 = x;
      d.y1 = y;
      this.draw();
    } else if (d.mode === 'move') {
      d.lastX = x;
      d.lastY = y;
      if (!d.axis && !d.free && Math.hypot(x - d.x0, y - d.y0) > 4) d.axis = Math.abs(x - d.x0) > Math.abs(y - d.y0) ? 'time' : 'value';
      if (!d.axis && !d.free) return;
      const dt = d.axis === 'value' ? 0 : Math.round(((x - d.x0) / tv.pps) * app.fps) / app.fps;
      const dv = d.axis === 'time' ? 0 : -(y - d.y0) / this.vpp;
      d.label = d.axis === 'time' ? `${dt >= 0 ? '+' : ''}${Math.round(dt * app.fps)} f` : `${dv >= 0 ? '+' : ''}${dv.toFixed(1)}`;
      this.applyMove(dt, dv, d.orig);
    }
  }

  applyMove(dt, dv, sel) {
    const bone = this.bone();
    if (!bone) return;
    if (!app.live) app.beginLive('Edit curves');
    const byType = { rot: new Map(), pos: new Map() };
    for (const id of sel) {
      const [chId, idx] = id.split('|');
      const def = CH.find((c) => c.id === chId);
      const m = byType[def.type];
      if (!m.has(+idx)) m.set(+idx, new Set());
      m.get(+idx).add(def.comp);
    }
    app.updateLive((draft) => {
      const L = draft.layers[app.layerIndex];
      const tr = L.tracks[bone];
      if (!tr) return;
      for (const type of ['rot', 'pos']) {
        const ch = tr[type];
        const m = byType[type];
        if (!ch || !m.size) continue;
        if (dv !== 0)
          for (const [i, comps] of m) {
            if (type === 'rot') {
              e.setFromQuaternion(q.fromArray(ch.values, i * 4), 'XYZ');
              const arr = [e.x, e.y, e.z];
              for (const c of comps) arr[c] += dv / DEG;
              q.setFromEuler(e.set(arr[0], arr[1], arr[2], 'XYZ'));
              // keep hemisphere continuity with the original key
              const o = i * 4;
              if (q.x * ch.values[o] + q.y * ch.values[o + 1] + q.z * ch.values[o + 2] + q.w * ch.values[o + 3] < 0) q.set(-q.x, -q.y, -q.z, -q.w);
              q.toArray(ch.values, o);
            } else for (const c of comps) ch.values[i * 3 + c] += dv / POS_SCALE;
          }
        if (dt !== 0) retimeKeys(ch, [...m.keys()], (t) => Math.min(draft.duration, Math.max(0, app.snap(t + dt))));
      }
      pruneLayer(L);
    });
    this.draw();
  }

  onUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.mode === 'move') {
      if (app.live) {
        // indices may have changed after a retime: re-select by time
        app.commitLive('Edit curves');
        this.cacheKey = '';
      }
    } else if (d.mode === 'box') {
      const [xa, xb] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
      const [ya, yb] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
      if (!d.add) this.sel.clear();
      if (xb - xa < 3 && yb - ya < 3) app.setTime(tv.t(d.x0), { snap: true });
      else
        for (const c of this.curves || []) {
          if (!this.show[c.def.id]) continue;
          for (const k of c.keys) {
            const x = tv.x(k.t),
              y = this.y(k.v);
            if (x >= xa && x <= xb && y >= ya && y <= yb) this.sel.add(`${c.def.id}|${k.i}`);
          }
        }
    }
    this.draw();
  }

  setInterp(mode) {
    const bone = this.bone();
    if (!bone || !this.sel.size) return;
    const sel = new Set(this.sel);
    app.edit(`Interpolation: ${INTERP_NAMES[mode]}`, (draft) => {
      const tr = draft.layers[app.layerIndex].tracks[bone];
      if (!tr) return false;
      for (const id of sel) {
        const [chId, idx] = id.split('|');
        const def = CH.find((c) => c.id === chId);
        if (tr[def.type]) tr[def.type].interp[+idx] = mode;
      }
    });
  }
}
