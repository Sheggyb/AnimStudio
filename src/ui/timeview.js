// Shared horizontal time view for the dope sheet and graph editor.
import { app } from '../app/state.js';

export const LABEL_W = 200;
export const RULER_H = 24;

export const tv = {
  t0: 0, // time at the left edge of the lanes
  pps: 120, // pixels per second
  x(t) {
    return LABEL_W + (t - this.t0) * this.pps;
  },
  t(x) {
    return (x - LABEL_W) / this.pps + this.t0;
  },
  fit(width, duration = app.duration) {
    const lane = Math.max(50, width - LABEL_W - 24);
    this.pps = lane / Math.max(duration, 0.2);
    this.t0 = -12 / this.pps;
    app.emit('timeview');
  },
  zoomAt(x, factor) {
    const t = this.t(x);
    this.pps = Math.min(4000, Math.max(8, this.pps * factor));
    this.t0 = t - (x - LABEL_W) / this.pps;
    app.emit('timeview');
  },
  pan(dx) {
    this.t0 -= dx / this.pps;
    app.emit('timeview');
  },
  /** Keep the playhead visible while playing. */
  follow(width) {
    const x = this.x(app.time);
    if (x > width - 30 || x < LABEL_W) {
      this.t0 = app.time - 20 / this.pps;
      app.emit('timeview');
    }
  },
};

/** Draw the time ruler (frames) shared by both editors. */
export function drawRuler(g, w, { range = app.range, markers = [] } = {}) {
  const fps = app.fps;
  const d = app.duration;
  g.fillStyle = '#15181f';
  g.fillRect(0, 0, w, RULER_H);
  g.strokeStyle = '#2c3240';
  g.beginPath();
  g.moveTo(0, RULER_H - 0.5);
  g.lineTo(w, RULER_H - 0.5);
  g.stroke();
  // clip extent
  const x0 = Math.max(LABEL_W, tv.x(0));
  const x1 = Math.min(w, tv.x(d));
  g.fillStyle = '#1b2030';
  g.fillRect(x0, 0, Math.max(0, x1 - x0), RULER_H);
  if (range) {
    const a = Math.max(LABEL_W, tv.x(range[0]));
    const b = Math.min(w, tv.x(range[1]));
    g.fillStyle = '#3b82f655';
    g.fillRect(a, 0, Math.max(0, b - a), RULER_H);
  }
  const framePx = tv.pps / fps;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const label = steps.find((s) => s * framePx >= 46) || 1200;
  const minor = steps.find((s) => s * framePx >= 7) || label;
  const fStart = Math.floor(tv.t(LABEL_W) * fps);
  const fEnd = Math.ceil(tv.t(w) * fps);
  g.font = '10.5px Consolas, monospace';
  g.textBaseline = 'middle';
  for (let f = Math.ceil(fStart / minor) * minor; f <= fEnd; f += minor) {
    const x = Math.round(tv.x(f / fps)) + 0.5;
    if (x < LABEL_W) continue;
    const major = f % label === 0;
    g.strokeStyle = major ? '#4b5468' : '#323848';
    g.beginPath();
    g.moveTo(x, major ? 6 : 15);
    g.lineTo(x, RULER_H);
    g.stroke();
    if (major) {
      g.fillStyle = '#8b94a7';
      g.fillText(String(f), x + 3, 9);
    }
  }
  for (const m of markers) {
    const x = tv.x(m.t);
    if (x < LABEL_W || x > w) continue;
    g.fillStyle = m.color || '#22d3ee';
    g.beginPath();
    g.moveTo(x, RULER_H - 9);
    g.lineTo(x + 4, RULER_H - 5);
    g.lineTo(x, RULER_H - 1);
    g.lineTo(x - 4, RULER_H - 5);
    g.closePath();
    g.fill();
  }
  // label column header
  g.fillStyle = '#15181f';
  g.fillRect(0, 0, LABEL_W, RULER_H);
  g.fillStyle = '#7a8396';
  g.font = '11px Segoe UI, system-ui, sans-serif';
  g.fillText(`${Math.round(app.time * fps)} / ${Math.round(d * fps)} f  ·  ${app.time.toFixed(2)}s`, 10, 12);
}

export function drawPlayhead(g, w, h) {
  const x = Math.round(tv.x(app.time)) + 0.5;
  if (x < LABEL_W || x > w) return;
  g.strokeStyle = '#ef4444';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(x, 0);
  g.lineTo(x, h);
  g.stroke();
  g.lineWidth = 1;
  g.fillStyle = '#ef4444';
  const f = String(Math.round(app.time * app.fps));
  g.font = 'bold 10.5px Consolas, monospace';
  const tw = g.measureText(f).width + 8;
  g.beginPath();
  g.roundRect(x - tw / 2, 2, tw, 15, 3);
  g.fill();
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.fillText(f, x - tw / 2 + 4, 10);
}

export function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}
