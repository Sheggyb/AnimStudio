// "Motion from video": film yourself (or load any clip), the character copies the movement.
import { app } from '../app/state.js';
import { landmarksToClip, cycleAverage } from '../core/videomotion.js';
import { loopFix, reduceKeys } from '../core/ops.js';
import { moveOnCharacter } from '../io/library.js';
import { trackVideo, ensureDuration, BONES, QUALITIES } from '../io/posetrack.js';
import { h, toast } from './dom.js';
import { openModal } from './dialog.js';

export const VIDEO_DEFAULTS = { name: 'Video move', loop: false, inPlace: true, faceForward: true, mirror: false, smooth: 1.5, quality: 'best' };

/** Tracked landmarks -> clip on the current character (not yet added). */
export function buildVideoClip(track, opts = {}) {
  const o = { ...VIDEO_DEFAULTS, ...opts };
  let { clip: std, info } = landmarksToClip(track, o);
  if (o.loop) {
    // One clean cycle averaged from all the repeats (walks, runs, dances…).
    const cyc = cycleAverage(std, { fps: track.fps || 30 });
    if (cyc) {
      std = cyc.clip;
      info = { ...info, cycles: cyc.cycles, period: cyc.period };
    }
  }
  const clip = moveOnCharacter(std, app.rig, o.name);
  if (o.loop) loopFix(clip, { rig: app.rig }, { frames: 6, fps: app.fps || 30 });
  reduceKeys(clip, { rig: app.rig }, { angle: 0.6, distance: 0.003 }); // fewer keys = easier to tweak by hand
  clip.loop = !!o.loop;
  clip.meta = { ...std.meta, recipe: { video: { ...o } } };
  return { clip, info };
}

/** Add (or replace `replaceId`) and select the clip. */
function commit(clip, replaceId) {
  if (replaceId && app.clips.some((c) => c.id === replaceId)) {
    clip.id = replaceId;
    app.editClips('Video motion: update clip', (arr) => arr.map((c) => (c.id === replaceId ? clip : c)));
    app.selectClip(replaceId);
  } else app.addClip(clip, 'Video motion: add clip');
  app.setTime?.(0);
  return app.committedClip;
}

/** Capture from a video URL without UI (bridge / MCP). */
export async function captureFromUrl(url, opts = {}) {
  const blob = await (await fetch(url)).blob();
  const video = h('video', { muted: true, playsInline: true, preload: 'auto' });
  video.src = URL.createObjectURL(blob);
  await new Promise((res, rej) => ((video.onloadeddata = res), (video.onerror = () => rej(new Error('Could not read that video')))));
  try {
    const track = await trackVideo(video, { t0: opts.start ?? 0, t1: opts.end ?? null, quality: opts.quality || 'best', device: opts.device || 'GPU' });
    const { clip, info } = buildVideoClip(track, opts);
    const c = commit(clip, null);
    return { clip: c.name, duration: +c.duration.toFixed(3), frames: info.frames, tracked: track.found, legs: info.legs, arms: info.arms, airborne: info.jumps, cycles: info.cycles || 0 };
  } finally {
    URL.revokeObjectURL(video.src);
  }
}

export function openVideoMotion() {
  if (!app.rig) return toast('Load a character first', 'warn');
  const o = { ...VIDEO_DEFAULTS };
  let track = null; // last tracking result, so settings can be changed without tracking again
  let madeId = null;
  let stream = null;
  let recorder = null;
  let abort = null;
  let objectUrl = null;

  const video = h('video', { controls: true, muted: true, playsInline: true, style: { width: '100%', maxHeight: '46vh', background: '#000', borderRadius: '6px', display: 'block' } });
  const overlay = h('canvas', { style: { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' } });
  const empty = h(
    'div',
    { class: 'col', style: { alignItems: 'center', justifyContent: 'center', gap: '10px', minHeight: '220px', border: '2px dashed var(--line2)', borderRadius: '8px', color: 'var(--text2)', textAlign: 'center', padding: '20px' } },
    h('div', { style: { fontSize: '30px' } }, '🎥'),
    h('div', { style: { fontSize: '14px' } }, 'Drop a video here, choose a file, or record yourself with the webcam.'),
    h('div', { class: 'muted', style: { fontSize: '12px', maxWidth: '460px' } }, 'Tips: the whole body in view, one person, steady camera, good light. Act the move facing the camera (or from the side for walks and runs). Everything stays on your PC.')
  );
  const stage = h('div', { style: { position: 'relative' }, class: 'hidden' }, video, overlay);
  const status = h('div', { class: 'muted', style: { fontSize: '12.5px', minHeight: '18px' } });
  const setStatus = (t, kind = '') => ((status.textContent = t), (status.style.color = kind === 'err' ? 'var(--danger, #f87171)' : kind === 'ok' ? 'var(--ok, #4ade80)' : ''));

  const fileInput = h('input', { type: 'file', accept: 'video/*', class: 'hidden', onchange: (e) => e.target.files[0] && loadFile(e.target.files[0]) });
  const recBtn = h('button', { onclick: () => toggleRecord() }, '● Record webcam');
  const startIn = h('input', { type: 'number', min: 0, step: 0.1, value: 0, style: { width: '70px' } });
  const endIn = h('input', { type: 'number', min: 0, step: 0.1, value: 0, style: { width: '70px' } });
  const trimRow = h(
    'div',
    { class: 'row wrap hidden', style: { gap: '8px' } },
    h('span', { class: 'muted' }, 'Use from'),
    startIn,
    h('button', { class: 'small', title: 'Start at the current video time', onclick: () => (startIn.value = video.currentTime.toFixed(2)) }, '⇤ here'),
    h('span', { class: 'muted' }, 'to'),
    endIn,
    h('button', { class: 'small', title: 'End at the current video time', onclick: () => (endIn.value = video.currentTime.toFixed(2)) }, 'here ⇥'),
    h('span', { class: 'muted' }, 's')
  );

  const nameIn = h('input', { type: 'text', value: o.name, oninput: (e) => (o.name = e.target.value) });
  const check = (key, text, title) => h('label', { class: 'check', title }, h('input', { type: 'checkbox', checked: o[key], onchange: (e) => ((o[key] = e.target.checked), rebuildSoon()) }), h('span', {}, text));
  const mirrorBox = check('mirror', 'Mirror (selfie video)', 'Swap left and right — webcam and selfie videos are mirrored');
  const smoothIn = h('input', { type: 'range', min: 0, max: 4, step: 0.25, value: o.smooth, oninput: (e) => ((o.smooth = +e.target.value), rebuildSoon()) });
  const qualSel = h('select', { onchange: (e) => (o.quality = e.target.value) }, Object.entries(QUALITIES).map(([k, q]) => h('option', { value: k, selected: k === o.quality }, q.label)));
  const options = h(
    'div',
    { class: 'col', style: { gap: '8px', minWidth: '220px' } },
    h('label', { class: 'field' }, h('span', {}, 'Clip name'), nameIn),
    check('loop', 'Loop (walk, run, idle, dance)', 'Finds the repeating cycle, averages all repeats into one clean loop'),
    check('inPlace', 'Stay in place', 'Keep the character on the spot (best for game moves)'),
    check('faceForward', 'Face forward', 'Turn the character to face the front, even if you filmed from the side'),
    mirrorBox,
    h('label', { class: 'field', title: 'Removes camera jitter. More = calmer, less = snappier' }, h('span', {}, 'Smoothness'), smoothIn),
    h('label', { class: 'field' }, h('span', {}, 'Tracking quality'), qualSel)
  );

  const body = h(
    'div',
    { class: 'row', style: { alignItems: 'flex-start', gap: '16px' } },
    h('div', { class: 'col grow', style: { gap: '8px', minWidth: 0 } }, empty, stage, h('div', { class: 'row wrap', style: { gap: '8px' } }, h('button', { onclick: () => fileInput.click() }, '📂 Choose video…'), recBtn, fileInput), trimRow, status),
    options
  );

  const m = openModal({
    title: '🎥 Motion from video',
    body,
    wide: true,
    buttons: [
      { label: 'Close', value: null },
      { label: 'Capture motion', primary: true, onClick: () => (capture(), false) },
    ],
  });
  const captureBtn = m.buttons['Capture motion'];
  captureBtn.disabled = true;
  m.result.then(() => {
    abort?.abort();
    stopStream();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  // Drag & drop a video file onto the dialog.
  m.el.addEventListener('dragover', (e) => (e.preventDefault(), e.stopPropagation()));
  m.el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(x.name));
    if (f) loadFile(f);
    else toast('Drop a video file (mp4, webm, mov)', 'warn');
  });

  async function useSource(src, { live = false } = {}) {
    empty.classList.add('hidden');
    stage.classList.remove('hidden');
    clearOverlay();
    track = null;
    madeId = null;
    if (live) {
      video.srcObject = src;
      video.controls = false;
      trimRow.classList.add('hidden');
      captureBtn.disabled = true;
      await video.play().catch(() => {});
      return;
    }
    video.srcObject = null;
    video.controls = true;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    video.src = objectUrl = src;
    await new Promise((res) => (video.onloadeddata = res));
    const d = await ensureDuration(video);
    startIn.value = 0;
    startIn.max = endIn.max = d.toFixed(2);
    endIn.value = d.toFixed(2);
    trimRow.classList.remove('hidden');
    captureBtn.disabled = false;
    setStatus(`${d.toFixed(1)} s of video. Trim it if you like, then press Capture motion.`);
  }

  function loadFile(file) {
    if (recorder) return;
    stopStream();
    o.name = nameIn.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 40) || o.name;
    useSource(URL.createObjectURL(file)).catch((e) => setStatus('Could not play that video: ' + e.message, 'err'));
  }

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function toggleRecord() {
    if (recorder) {
      recorder.stop();
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    } catch (e) {
      return setStatus('No webcam access: ' + e.message, 'err');
    }
    await useSource(stream, { live: true });
    o.mirror = mirrorBox.querySelector('input').checked = true;
    video.style.transform = 'scaleX(-1)'; // show it like a mirror while recording
    for (let k = 3; k > 0; k--) {
      setStatus(`Get in position… recording starts in ${k}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      recorder = null;
      recBtn.textContent = '● Record webcam';
      stopStream();
      video.style.transform = '';
      await useSource(URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })));
      o.name = nameIn.value = o.name === VIDEO_DEFAULTS.name ? 'Webcam move' : o.name;
    };
    recorder.start(250);
    recBtn.textContent = '■ Stop recording';
    setStatus('Recording… do the move, then press Stop.');
  }

  function clearOverlay() {
    overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  }
  function draw(lm) {
    const w = (overlay.width = video.clientWidth * devicePixelRatio);
    const hh = (overlay.height = video.clientHeight * devicePixelRatio);
    const g = overlay.getContext('2d');
    g.clearRect(0, 0, w, hh);
    if (!lm) return;
    // Fit the video's picture inside the element (object-fit: contain).
    const s = Math.min(w / video.videoWidth, hh / video.videoHeight);
    const ox = (w - video.videoWidth * s) / 2;
    const oy = (hh - video.videoHeight * s) / 2;
    const P = (i) => [ox + lm[i][0] * video.videoWidth * s, oy + lm[i][1] * video.videoHeight * s];
    g.lineWidth = 3 * devicePixelRatio;
    g.strokeStyle = '#38bdf8';
    for (const [a, b] of BONES) {
      g.beginPath();
      g.moveTo(...P(a));
      g.lineTo(...P(b));
      g.stroke();
    }
    g.fillStyle = '#f472b6';
    for (let i = 11; i < 33; i++) {
      const [x, y] = P(i);
      g.beginPath();
      g.arc(x, y, 3.5 * devicePixelRatio, 0, Math.PI * 2);
      g.fill();
    }
  }

  async function capture() {
    if (abort) return abort.abort();
    const t0 = Math.max(0, +startIn.value || 0);
    const t1 = Math.max(t0, +endIn.value || video.duration);
    abort = new AbortController();
    captureBtn.textContent = 'Stop';
    try {
      track = await trackVideo(video, {
        t0,
        t1,
        fps: app.fps || 30,
        quality: o.quality,
        signal: abort.signal,
        onStatus: setStatus,
        onFrame: (k, total, lm) => (draw(lm), setStatus(`Tracking your movement… ${Math.round(((k + 1) / total) * 100)}%`)),
      });
      madeId = null;
      make();
    } catch (e) {
      if (e.name === 'AbortError') setStatus('Stopped.');
      else {
        console.error(e);
        setStatus(e.message, 'err');
      }
    } finally {
      abort = null;
      captureBtn.textContent = track ? 'Capture again' : 'Capture motion';
    }
  }

  function make() {
    if (!track) return;
    try {
      const { clip, info } = buildVideoClip(track, o);
      const c = commit(clip, madeId);
      madeId = c.id;
      app.setPlaying?.(true);
      const notes = [];
      if (!info.legs) notes.push('legs not visible — they stay still');
      if (!info.arms) notes.push('arms not clearly visible');
      if (info.cycles) notes.unshift(`${info.cycles} cycles of ${info.period.toFixed(2)} s averaged into one loop`);
      else if (o.loop) notes.unshift('no repeating cycle found — the whole capture loops');
      setStatus(`✓ “${c.name}” is on your character and playing (${track.found}/${track.frames.length} frames tracked${notes.length ? '; ' + notes.join(', ') : ''}). Change the options on the right to update it, or tweak it in the Move Maker.`, 'ok');
    } catch (e) {
      console.error(e);
      setStatus(e.message, 'err');
    }
  }

  let timer = 0;
  function rebuildSoon() {
    if (!track) return;
    clearTimeout(timer);
    timer = setTimeout(make, 250);
  }
}
