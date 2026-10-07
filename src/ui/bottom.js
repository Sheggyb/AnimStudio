// Bottom area: transport bar + Dope Sheet / Graph editor tabs.
import { app } from '../app/state.js';
import { run, shortcutText } from '../app/commands.js';
import { INTERP_NAMES } from '../core/channel.js';
import { h, clear } from './dom.js';
import { DopeSheet } from './dopesheet.js';
import { GraphEditor } from './graph.js';
import { tv } from './timeview.js';

export class Bottom {
  constructor(host) {
    this.host = host;
    const btn = (label, cmd, title, cls = 'tbtn') => h('button', { class: cls, title: `${title}${shortcutText(cmd) ? ` (${shortcutText(cmd)})` : ''}`, onclick: () => run(cmd) }, label);
    this.playBtn = btn('▶', 'play.toggle', 'Play / pause', 'tbtn play primary');
    this.frameInput = h('input', {
      type: 'number',
      min: 0,
      step: 1,
      title: 'Current frame',
      onchange: (e) => {
        app.setPlaying(false);
        app.setTime(+e.target.value / app.fps, { snap: true });
      },
    });
    this.total = h('span', { class: 'muted' });
    this.secs = h('span', { class: 'muted' });
    this.fpsSel = h(
      'select',
      { title: 'Frames per second used for snapping, display and baking', onchange: (e) => (app.set('fps', +e.target.value), app.emit('timeview')) },
      [12, 15, 24, 25, 30, 48, 50, 60].map((f) => h('option', { value: f }, `${f} fps`))
    );
    this.speedSel = h(
      'select',
      { title: 'Playback speed', onchange: (e) => app.set('speed', +e.target.value) },
      [0.1, 0.25, 0.5, 1, 1.5, 2].map((s) => h('option', { value: s }, `${s}×`))
    );
    this.loopBtn = h('button', { class: 'tbtn', title: 'Loop playback', onclick: () => app.set('loopPlayback', !app.settings.loopPlayback) }, '⟲');
    this.rangeChip = h('span', { class: 'chip hidden', title: 'Timeline range (Shift+drag on the ruler). Double-click the ruler to clear.' });
    this.autoKey = h('button', { class: 'tbtn autokey', title: 'Auto-key: posing writes keys automatically', onclick: () => app.set('autoKey', !app.settings.autoKey) }, '● Auto-key');
    this.interpSel = h(
      'select',
      { title: 'Interpolation for new keys', onchange: (e) => app.set('interp', +e.target.value) },
      [1, 0, 2, 3].map((m) => h('option', { value: m }, `New keys: ${INTERP_NAMES[m]}`))
    );
    this.layerChip = h('span', { class: 'chip', style: { cursor: 'pointer' }, title: 'Active layer (keys go here) — click to manage layers', onclick: () => run('panel.layers') });
    this.tabDope = h('button', { onclick: () => this.setTab('dope') }, 'Dope Sheet');
    this.tabGraph = h('button', { onclick: () => this.setTab('graph') }, 'Graph Editor');
    const bar = h(
      'div',
      { class: 'transport' },
      btn('⏮', 'time.start', 'First frame'),
      btn('◆◀', 'time.prevKey', 'Previous key'),
      btn('◀', 'time.prevFrame', 'Previous frame'),
      this.playBtn,
      btn('▶', 'time.nextFrame', 'Next frame'),
      btn('▶◆', 'time.nextKey', 'Next key'),
      btn('⏭', 'time.end', 'Last frame'),
      h('div', { class: 'timebox' }, this.frameInput, this.total, this.secs),
      h('div', { class: 'tsep' }),
      this.loopBtn,
      this.speedSel,
      this.fpsSel,
      this.rangeChip,
      h('div', { class: 'tsep' }),
      this.autoKey,
      btn('◆ Key', 'key.selected', 'Key selected bones'),
      this.interpSel,
      this.layerChip,
      h('div', { class: 'grow' }),
      h('div', { class: 'tabs', style: { border: 0, background: 'transparent' } }, this.tabDope, this.tabGraph)
    );
    this.editorHost = h('div', { class: 'editor-host' });
    this.dopeHost = h('div', { class: 'editor-host', style: { position: 'absolute', inset: 0 } });
    this.graphHost = h('div', { class: 'editor-host', style: { position: 'absolute', inset: 0 } });
    this.editorHost.append(this.dopeHost, this.graphHost);
    host.append(bar, this.editorHost);
    this.dope = new DopeSheet(this.dopeHost);
    this.graph = new GraphEditor(this.graphHost);
    this.setTab(app.settings.bottomTab || 'dope');

    const sync = () => this.sync();
    for (const ev of ['time', 'play', 'settings', 'clipSelect', 'clip', 'layer', 'range', 'model']) app.on(ev, sync);
    app.on('play', () => app.playing && requestAnimationFrame(() => tv.follow(this.editorHost.clientWidth)));
    const fit = () => requestAnimationFrame(() => tv.fit(this.editorHost.clientWidth));
    app.on('clipSelect', fit);
    app.on('model', fit);
    app.on('time', () => app.playing && tv.follow(this.editorHost.clientWidth));
    sync();
  }

  setTab(t) {
    app.set('bottomTab', t);
    this.tabDope.classList.toggle('on', t === 'dope');
    this.tabGraph.classList.toggle('on', t === 'graph');
    this.dopeHost.classList.toggle('hidden', t !== 'dope');
    this.graphHost.classList.toggle('hidden', t !== 'graph');
    this.dope.visible = t === 'dope';
    this.graph.visible = t === 'graph';
    (t === 'dope' ? this.dope : this.graph).draw();
  }

  sync() {
    const s = app.settings;
    this.playBtn.textContent = app.playing ? '❚❚' : '▶';
    if (document.activeElement !== this.frameInput) this.frameInput.value = Math.round(app.time * app.fps);
    this.total.textContent = `/ ${Math.round(app.duration * app.fps)}`;
    this.secs.textContent = `${app.time.toFixed(2)}s`;
    this.fpsSel.value = s.fps;
    this.speedSel.value = s.speed;
    this.loopBtn.classList.toggle('on', s.loopPlayback);
    this.autoKey.classList.toggle('on', s.autoKey);
    this.interpSel.value = s.interp;
    const L = app.layer;
    this.layerChip.textContent = L ? `Layer: ${L.name}${L.mode !== 'base' ? ` (${L.mode})` : ''}${L.mute ? ' · muted' : ''}` : 'No layer';
    if (app.range) {
      const f = (t) => Math.round(t * app.fps);
      clear(this.rangeChip).append(`Range ${f(app.range[0])}–${f(app.range[1])}`, h('button', { class: 'ghost small', style: { padding: '0 4px' }, title: 'Clear range', onclick: () => app.setRange(null) }, '✕'));
      this.rangeChip.classList.remove('hidden');
    } else this.rangeChip.classList.add('hidden');
  }

  get active() {
    return app.settings.bottomTab === 'graph' ? this.graph : this.dope;
  }
}
