// Tiny test runner: `npm test` (or `node tests/run.js <file filter>`)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Skip } from './helpers.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js'));
const only = process.argv[2];
let pass = 0,
  fail = 0,
  skip = 0;
const needed = new Set(); // files that skipped tests were missing
for (const f of files) {
  if (only && !f.includes(only)) continue;
  const mod = await import(pathToFileURL(path.join(dir, f)).href);
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn !== 'function') continue;
    const t0 = performance.now();
    try {
      await fn();
      pass++;
      console.log(`  \x1b[32m✓\x1b[0m ${f.replace('.test.js', '')} › ${name} \x1b[90m${(performance.now() - t0).toFixed(0)}ms\x1b[0m`);
    } catch (e) {
      if (e instanceof Skip) {
        skip++;
        needed.add(e.message.replace(/^needs /, ''));
        console.log(`  \x1b[33m-\x1b[0m ${f.replace('.test.js', '')} › ${name} \x1b[90mskipped (${e.message})\x1b[0m`);
        continue;
      }
      fail++;
      console.log(`  \x1b[31m✗ ${f.replace('.test.js', '')} › ${name}\x1b[0m\n    ${e.stack?.split('\n').slice(0, 4).join('\n    ')}`);
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
if (skip) console.log(`\x1b[90mSkipped tests use animation files that are not in the repository: ${[...needed].join(', ')}. See tests/helpers.js.\x1b[0m`);
process.exit(fail ? 1 : 0);
