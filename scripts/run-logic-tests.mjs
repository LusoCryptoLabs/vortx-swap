// Runs the pure logic/crypto gate under tests/logic (test_*.mjs), one process per suite.
// These suites are not pnpm workspace members, so `pnpm -r test` skips them; this runner is
// what `pnpm test` (root) invokes so a plain `pnpm test` actually exercises them. Each suite
// process.exit(1)s on failure; the first failing suite fails the whole run.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'tests', 'logic');

const suites = readdirSync(dir)
  .filter((f) => f.startsWith('test_') && f.endsWith('.mjs'))
  .sort();

if (suites.length === 0) {
  console.error('no logic suites found under tests/logic');
  process.exit(1);
}

let failed = 0;
for (const s of suites) {
  console.log(`> ${s}`);
  const r = spawnSync(process.execPath, [join(dir, s)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    console.error(`FAILED: ${s} (exit ${r.status})`);
  }
}

console.log(`\n${suites.length - failed}/${suites.length} logic suites passed`);
process.exit(failed === 0 ? 0 : 1);
