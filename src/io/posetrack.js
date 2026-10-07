// Body tracking in video with MediaPipe Pose Landmarker (vendored in /vendor/mediapipe, runs
// fully in the browser, nothing is uploaded).
const BASE = new URL('../../vendor/mediapipe/', import.meta.url).href;
export const QUALITIES = {
  best: { label: 'Best (slower)', file: 'pose_landmarker_heavy.task' },
  fast: { label: 'Fast', file: 'pose_landmarker_full.task' },
};

let lib = null;
const cache = new Map(); // quality -> landmarker
let lastTs = 0; // VIDEO mode needs timestamps that always increase, across runs too

async function landmarker(quality, onStatus, device = 'GPU') {
  const key = quality + device;
  if (cache.has(key)) return cache.get(key);
  onStatus?.('Loading the body tracker…');
  lib ||= await import(BASE + 'vision_bundle.mjs');
  const files = await lib.FilesetResolver.forVisionTasks(BASE + 'wasm');
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: BASE + QUALITIES[quality].file, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  let lm;
  try {
    lm = await lib.PoseLandmarker.createFromOptions(files, opts(device));
  } catch (e) {
    console.warn('Pose tracker: GPU unavailable, using CPU', e);
    lm = await lib.PoseLandmarker.createFromOptions(files, opts('CPU'));
  }
  cache.set(key, lm);
  return lm;
}

/** MediaRecorder webm files report an Infinity duration until the end has been seen. */
export async function ensureDuration(video) {
  if (!video.duration || !isFinite(video.duration)) {
    await new Promise((res) => {
      const done = () => (video.removeEventListener('durationchange', check), res());
      const check = () => isFinite(video.duration) && done();
      video.addEventListener('durationchange', check);
      video.currentTime = 1e7;
      setTimeout(done, 3000);
    });
    video.currentTime = 0;
  }
  return video.duration;
}

function seek(video, t) {
  return new Promise((res) => {
    if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) return res();
    const done = () => (clearTimeout(timer), video.removeEventListener('seeked', done), res());
    const timer = setTimeout(done, 2000);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

const pack = (list) => (list ? list.map((p) => [p.x, p.y, p.z, p.visibility ?? 1]) : null);

/**
 * Track the body in `video` from t0 to t1 (seconds), one sample per frame at `fps`.
 * onFrame(k, total, landmarks|null) is called after each frame (for drawing / progress).
 * Returns { fps, width, height, frames: [{ world, image }] } (null entries where no one was found).
 */
export async function trackVideo(video, { t0 = 0, t1 = null, fps = 30, quality = 'best', device = 'GPU', onStatus = null, onFrame = null, signal = null } = {}) {
  const lm = await landmarker(quality, onStatus, device);
  const dur = await ensureDuration(video);
  t1 = Math.min(t1 ?? dur, dur);
  if (t1 - t0 < 0.1) throw new Error('The selected part of the video is too short.');
  video.pause();
  const total = Math.max(2, Math.floor((t1 - t0) * fps) + 1);
  const frames = [];
  let found = 0;
  onStatus?.('Tracking…');
  for (let k = 0; k < total; k++) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    await seek(video, Math.min(t1, t0 + k / fps));
    lastTs = Math.max(lastTs + 1, Math.round(performance.now()));
    const r = lm.detectForVideo(video, lastTs);
    const image = pack(r.landmarks?.[0]);
    const world = pack(r.worldLandmarks?.[0]);
    if (world) found++;
    frames.push({ world, image });
    onFrame?.(k, total, image);
    if (k % 4 === 3) await new Promise((res) => setTimeout(res)); // keep the page responsive
  }
  if (found < Math.max(2, total * 0.3)) throw new Error(`A person was found in only ${found} of ${total} frames. Use a video where the whole body is clearly visible.`);
  return { fps, width: video.videoWidth, height: video.videoHeight, frames, found };
}

/** Skeleton lines between landmarks, for drawing the overlay. */
export const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31], [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
  [15, 19], [16, 20], [0, 7], [0, 8],
];
