import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function collectJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

for (const dir of ['src', 'test', 'scripts']) {
  for (const file of collectJsFiles(dir)) {
    const run = spawnSync(process.execPath, ['--check', file], {
      stdio: 'inherit',
    });
    if (run.status !== 0) process.exit(1);
  }
}
