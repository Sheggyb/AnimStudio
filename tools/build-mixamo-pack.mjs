// Build an animation pack from a folder of animation files (e.g. your Mixamo .fbx downloads).
//
//   node tools/build-mixamo-pack.mjs [folder] [pack name]
//   (defaults: AnimStudio/mixamo, "Mixamo Pack")
//
// The same thing the start page's "＋ Add animations" does, for a whole folder at once: the
// pack holds the skeleton once and every file's animation as a clip named after the file, so
// ✦ Moves can preview and retarget them like any other pack. It rebuilds the pack from
// everything in the folder, so run it again whenever more files arrive.
// Packs made from downloads are for your own projects; check the source's terms before sharing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Minimal browser bits GLTFExporter needs in Node.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((b) => ((this.result = b), this.onloadend?.(), this.onload?.({ target: this })));
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(b).toString('base64')}`;
      this.onloadend?.();
      this.onload?.({ target: this });
    });
  }
};
globalThis.self ??= globalThis;

const { readAnimationFiles, buildPack } = await import('../src/io/packbuild.js');

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.argv[2] || path.join(APP, 'mixamo'));
const NAME = (process.argv[3] || 'Mixamo Pack').replace(/\.glb$/i, '');
const OUT_DIR = path.join(APP, 'animations');

const names = fs.existsSync(SRC) ? fs.readdirSync(SRC).filter((f) => /\.(fbx|glb)$/i.test(f)).sort() : [];
if (!names.length) {
  console.log('No .fbx or .glb files in', SRC);
  process.exit(0);
}
const files = names.map((name) => {
  const b = fs.readFileSync(path.join(SRC, name));
  return { name, buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
});
const { groups, skipped } = await readAnimationFiles(files);
if (!groups.length) {
  console.log('No usable animations:\n  ' + skipped.map((s) => `${s.name}: ${s.error}`).join('\n  '));
  process.exit(1);
}
// The biggest skeleton family becomes the pack; files from other characters are reported.
groups.sort((a, b) => b.clips.length - a.clips.length);
for (const g of groups.slice(1)) skipped.push(...g.files.map((name) => ({ name, error: 'different character than the other files' })));
const glb = await buildPack(groups[0]);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `${NAME}.glb`), Buffer.from(glb));
console.log(`${NAME}.glb: ${groups[0].clips.length} moves, ${(glb.byteLength / 1e6).toFixed(1)} MB${skipped.length ? `; skipped ${skipped.length}:\n  ${skipped.map((s) => `${s.name}: ${s.error}`).join('\n  ')}` : ''}`);
