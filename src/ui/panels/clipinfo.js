// Right panel › Clip: properties, events and analysis (the "learn from it" tab).
import { app } from '../../app/state.js';
import { run } from '../../app/commands.js';
import { GROUPS, GROUP_BY_ID, boneTitle } from '../../core/rig.js';
import { clipKeyCount } from '../../core/clip.js';
import { motionProfile, loopError, rangeOfMotion, keyPoseTimes } from '../../core/analysis.js';
import { footReport } from '../../core/contacts.js';
import { h, clear, debounce } from '../dom.js';
import { promptDialog } from '../dialog.js';

export class ClipPanel {
  constructor(host) {
    this.el = h('div', { class: 'tab-body' });
    host.append(this.el);
    this.analysis = null;
    this.analysisKey = '';
    const r = debounce(() => this.render(), 120);
    for (const ev of ['clip', 'clipSelect', 'model', 'selection', 'clips']) app.on(ev, r);
    this.render();
  }

  analyze(clip) {
    const key = `${clip.id}|${app.version}`;
    if (key !== this.analysisKey) {
      this.analysisKey = key;
      const prof = motionProfile(clip, app.rig, { fps: app.fps });
      const feet = app.rig.ik['foot.L'] || app.rig.ik['foot.R'] ? footReport(clip, app.rig, { fps: app.fps }) : null;
      this.analysis = { prof, loop: loopError(clip, app.rig), feet };
    }
    return this.analysis;
  }

  /** Feet: when each foot is down, the speed to move the character at, sliding and sinking. */
  feetSection(clip, r) {
    const D = clip.duration || 1;
    const cm = (x) => `${(x * 100).toFixed(1)} cm`;
    const pct = (t) => `${(Math.min(1, Math.max(0, t / D)) * 100).toFixed(2)}%`;
    const strip = h('div', { class: 'foot-strip', title: 'When each foot is down (click a step to jump to it). Ticks: footstep events.' });
    for (const side of ['L', 'R']) {
      const row = h('div', { class: 'foot-row' }, h('span', { class: 'foot-side' }, side));
      const lane = h('div', { class: 'foot-lane' });
      for (const s of r.steps.filter((x) => x.side === side)) {
        const segs = s.from <= s.to ? [[s.from, s.to]] : [[s.from, D], [0, s.to]]; // a step across a loop's seam
        for (const [a, b] of segs)
          lane.append(
            h('div', {
              class: 'foot-down' + (s.slide > 0.015 ? ' slides' : ''),
              style: { left: pct(a), width: `calc(${pct(b)} - ${pct(a)} + 2px)` },
              title: `${side === 'L' ? 'Left' : 'Right'} foot down f${Math.round(s.from * app.fps)}–${Math.round(s.to * app.fps)}${s.slide > 0.002 ? ` · slides ${cm(s.slide)}` : ''}`,
              onclick: () => (app.setPlaying(false), app.setTime(s.from)),
            })
          );
      }
      for (const e of clip.events.filter((x) => x.name === `footstep_${side}` || x.name === 'footstep')) lane.append(h('div', { class: 'foot-tick', style: { left: pct(e.t) } }));
      row.append(lane);
      strip.append(row);
    }
    const speedText = r.speed > 0.05 ? `${r.speed.toFixed(2)} m/s ${r.inPlace ? 'in place' : 'travelling'}` : 'standing';
    const slideBad = r.maxSlide > 0.015;
    return h(
      'div',
      { class: 'section' },
      h('div', { class: 'sec-title' }, 'Feet'),
      r.steps.length ? strip : h('div', { class: 'muted', style: { fontSize: '12px' } }, r.floating ? 'The feet never touch the ground.' : 'No steps found: the feet never stand still on the floor.'),
      h('div', { class: 'stat', title: r.inPlace ? 'The ground moves back under the planted foot at this speed: move the character at it in your game and the feet won’t slide there either.' : 'How fast the hips travel.' }, h('span', {}, 'Speed'), h('span', {}, speedText)),
      r.inPlace && r.speed > 0.05 ? h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Move the character at this speed in your game and the feet stay planted there too.') : null,
      r.steps.length ? h('div', { class: 'stat' }, h('span', {}, 'Sliding while down'), h('span', { style: { color: slideBad ? 'var(--warn)' : 'var(--good)' } }, r.maxSlide > 0.002 ? `up to ${cm(r.maxSlide)}` : 'none')) : null,
      r.sink ? h('div', { class: 'stat' }, h('span', {}, 'Sinks into the floor'), h('span', { style: { color: 'var(--warn)' } }, cm(r.sink))) : null,
      r.floating ? h('div', { class: 'muted', style: { fontSize: '12px', color: 'var(--warn)' } }, `The feet stay ${cm(r.floating)} or more above the floor. Fine for a jump or a fall; otherwise the character floats (add the move again, or lower the hips on My edits).`) : null,
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'small' + (slideBad || r.sink ? ' primary' : ''), title: 'Pin each foot while it stands, with leg IK (on the active layer)', onclick: () => run('op.footplant') }, 'Fix foot sliding…'),
        h('button', { class: 'small', title: 'An event where each foot lands, for footstep sounds', onclick: () => run('op.footsteps') }, 'Add footstep events…')
      )
    );
  }

  render() {
    if (!this.el.isConnected || this.el.offsetParent === null) {
      this.stale = true;
      return;
    }
    this.stale = false;
    clear(this.el);
    const clip = app.clip;
    if (!clip) {
      this.el.append(h('div', { class: 'empty' }, 'No clip selected.'));
      return;
    }
    const fps = app.fps;
    const frames = Math.round(clip.duration * fps);

    // ---- properties
    const name = h('input', { value: clip.name, onchange: (e) => run('clip.rename', e.target.value) });
    const len = h('input', { type: 'number', min: 1, step: 1, value: frames, title: 'Length in frames', onchange: (e) => run('clip.setLength', +e.target.value / fps) });
    this.el.append(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'sec-title' }, 'Clip'),
        h('div', { class: 'field' }, h('span', {}, 'Name'), name),
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'field', style: { flex: 1 } }, h('span', {}, `Length (frames @ ${fps})`), len),
          h('div', { class: 'field' }, h('span', {}, 'Seconds'), h('div', { class: 'mono', style: { padding: '4px 0' } }, clip.duration.toFixed(3)))
        ),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: clip.loop, onchange: () => run('clip.toggleLoop') }), 'Loops (cycle animation)'),
        clip.meta.note ? h('div', { class: 'muted', style: { fontSize: '12px' } }, clip.meta.note) : null,
        h('div', { class: 'muted', style: { fontSize: '12px' } }, `${clip.layers.length} layer(s) · ${clipKeyCount(clip)} keys · ${Object.keys(clip.layers[0].tracks).length} animated bones`)
      )
    );

    // ---- events
    const evList = h('div', { class: 'col', style: { gap: '3px' } });
    clip.events
      .slice()
      .sort((a, b) => a.t - b.t)
      .forEach((ev) => {
        evList.append(
          h(
            'div',
            { class: 'row', style: { fontSize: '12.5px' } },
            h('button', { class: 'small ghost mono', title: 'Jump to event', onclick: () => app.setTime(ev.t) }, `f${Math.round(ev.t * fps)}`),
            h('span', { class: 'grow' }, ev.name),
            h(
              'button',
              {
                class: 'small ghost',
                title: 'Rename',
                onclick: async () => {
                  const n = await promptDialog('Rename event', ev.name);
                  if (n) app.edit('Rename event', (d) => (d.events.find((x) => x.t === ev.t && x.name === ev.name).name = n));
                },
              },
              '✎'
            ),
            h('button', { class: 'small ghost', title: 'Delete', onclick: () => app.edit('Delete event', (d) => (d.events = d.events.filter((x) => !(x.t === ev.t && x.name === ev.name)))) }, '✕')
          )
        );
      });
    this.el.append(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'sec-title' }, 'Events', h('div', { class: 'grow' }), h('button', { class: 'small', onclick: () => run('clip.addEvent') }, '+ At playhead')),
        clip.events.length ? evList : h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Mark moments for your game code: footsteps, hit frames, sounds. Exported in the GLB (animation extras) and the sidecar JSON.')
      )
    );

    // ---- analysis
    if (clip.duration > 0) {
      const { prof, loop, feet } = this.analyze(clip);
      const total = Object.values(prof.groupTravel).reduce((a, b) => a + b, 0) || 1;
      const bars = GROUPS.filter((g) => prof.groupTravel[g.id] > 0)
        .sort((a, b) => prof.groupTravel[b.id] - prof.groupTravel[a.id])
        .map((g) => {
          const pct = (prof.groupTravel[g.id] / total) * 100;
          return h(
            'div',
            { class: 'bar-row', title: `${g.label}: joints travel ${prof.groupTravel[g.id].toFixed(2)} units in total` },
            h('span', {}, g.label),
            h('div', { class: 'bar' }, h('div', { style: { width: pct + '%', background: g.color } })),
            h('span', { class: 'mono muted' }, pct.toFixed(0) + '%')
          );
        });
      const top = [...prof.boneTravel.keys()]
        .filter((i) => prof.boneTravel[i] > 0 && app.rig.kind[i] && !app.rig.kind[i].startsWith('finger'))
        .sort((a, b) => prof.boneTravel[b] - prof.boneTravel[a])
        .slice(0, 5);
      const loopOk = loop.relative < 0.012 && loop.angle < 6;
      this.el.append(
        h(
          'div',
          { class: 'section' },
          h('div', { class: 'sec-title' }, 'What moves (share of motion)'),
          ...bars,
          h(
            'div',
            { class: 'muted', style: { fontSize: '12px' } },
            'Busiest joints: ',
            top.map((i, k) => [k ? ', ' : '', h('a', { href: '#', style: { color: 'var(--accent2)' }, onclick: (e) => (e.preventDefault(), app.selectBones([i])) }, boneTitle(app.rig, i, app.nick))])
          )
        ),
        h(
          'div',
          { class: 'section' },
          h('div', { class: 'sec-title' }, 'Loop & timing'),
          h('div', { class: 'stat' }, h('span', {}, 'Start → end gap'), h('span', { style: { color: loopOk ? 'var(--good)' : 'var(--warn)' } }, `${(loop.relative * 100).toFixed(1)}% body height · ${loop.angle.toFixed(1)}°`)),
          !loopOk && clip.loop ? h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Marked as looping but the ends differ — try Modify › Make seamless loop.') : null,
          h('div', { class: 'stat' }, h('span', {}, 'Peak body speed'), h('span', {}, `${Math.max(...prof.speed).toFixed(2)} u/s at f${prof.speed.indexOf(Math.max(...prof.speed))}`)),
          h(
            'div',
            { class: 'row' },
            h(
              'button',
              {
                class: 'small',
                title: 'Mark the key poses (moments where the body is momentarily still) on the timeline',
                onclick: () => {
                  app.keyPoses = { clipId: clip.id, times: keyPoseTimes(prof) };
                  app.emit('timeview');
                },
              },
              'Show key poses'
            ),
            h('button', { class: 'small', onclick: () => run('tools.keyPoses') }, 'Pose-to-pose copy…')
          ),
          app.keyPoses?.clipId === clip.id ? h('div', { class: 'muted', style: { fontSize: '12px' } }, `Key poses (pink marks): frames ${app.keyPoses.times.map((t) => Math.round(t * fps)).join(', ')}`) : null
        )
      );
      if (feet?.feet.length) this.el.append(this.feetSection(clip, feet));
      const i = app.sel.active;
      if (i >= 0) {
        const rom = rangeOfMotion(clip, app.rig, i, { fps });
        this.el.append(
          h(
            'div',
            { class: 'section' },
            h('div', { class: 'sec-title' }, `Range of motion · ${boneTitle(app.rig, i, app.nick)}`),
            ...['X', 'Y', 'Z'].map((ax, k) => h('div', { class: 'stat' }, h('span', { class: `ax-${ax.toLowerCase()}` }, `Rotation ${ax}`), h('span', { class: 'mono' }, `${rom.min[k].toFixed(0)}° … ${rom.max[k].toFixed(0)}°  (${(rom.max[k] - rom.min[k]).toFixed(0)}°)`)))
          )
        );
      }
    }
  }

  show() {
    if (this.stale) this.render();
  }
}

export { GROUP_BY_ID };
