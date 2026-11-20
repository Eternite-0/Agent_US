import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const electronDist = join(__dirname, 'node_modules', 'electron', 'dist');
const frontendDist = join(rootDir, 'frontend', 'dist');
const backendDir = join(rootDir, 'backend');
const releaseDir = join(__dirname, 'release');
const stageDir = join(releaseDir, '.stage');
const unpackedOnly = process.argv.includes('--unpacked');

const DEV_ONLY_BACKEND_PACKAGES = new Set(['typescript', 'prettier', '.bin']);
const FORBIDDEN_FILENAMES = new Set([
  '.dev-token',
  '.pool-key',
  '.provider-env.json',
  'agent.db',
  'agent.db-wal',
  'agent.db-shm',
]);

if (!existsSync(join(electronDist, 'electron.exe'))) {
  throw new Error(
    `Missing Electron runtime at ${electronDist}. Run npm install in desktop/ first.`,
  );
}
if (!existsSync(join(frontendDist, 'index.html'))) {
  throw new Error(
    `Missing frontend build at ${frontendDist}. Run npm --prefix ../frontend run build first.`,
  );
}
if (!existsSync(join(backendDir, 'src', 'main.js'))) {
  throw new Error(`Missing backend entrypoint at ${join(backendDir, 'src', 'main.js')}.`);
}
if (!existsSync(join(backendDir, 'node_modules'))) {
  throw new Error(`Missing backend/node_modules. Run npm install in backend/ first.`);
}

function copyBackendClean(destBackendDir) {
  mkdirSync(destBackendDir, { recursive: true });
  cpSync(join(backendDir, 'src'), join(destBackendDir, 'src'), { recursive: true });
  cpSync(join(backendDir, 'package.json'), join(destBackendDir, 'package.json'));

  const srcNm = join(backendDir, 'node_modules');
  const dstNm = join(destBackendDir, 'node_modules');
  mkdirSync(dstNm, { recursive: true });
  for (const entry of readdirSync(srcNm)) {
    if (DEV_ONLY_BACKEND_PACKAGES.has(entry)) continue;
    cpSync(join(srcNm, entry), join(dstNm, entry), { recursive: true });
  }
}

function auditStagedPayload(dir) {
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur)) {
      const full = join(cur, entry);
      if (
        FORBIDDEN_FILENAMES.has(entry) ||
        entry.endsWith('.sqlite') ||
        entry.endsWith('.db') ||
        entry === 'var'
      ) {
        throw new Error(`[pack-win] Refusing to bundle sensitive/runtime file: ${full}`);
      }
      if (statSync(full).isDirectory()) {
        stack.push(full);
      }
    }
  }
}

console.log('[pack-win] Staging clean frontend + backend runtime payload ...');
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const stagedFrontend = join(stageDir, 'frontend-dist');
const stagedBackend = join(stageDir, 'backend');
cpSync(frontendDist, stagedFrontend, { recursive: true });
copyBackendClean(stagedBackend);
auditStagedPayload(stageDir);

if (unpackedOnly) {
  const outDir = join(releaseDir, 'win-unpacked');
  console.log('[pack-win] Building unpacked Windows app in release/win-unpacked ...');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  cpSync(electronDist, outDir, { recursive: true });
  const defaultAsar = join(outDir, 'resources', 'default_app.asar');
  if (existsSync(defaultAsar)) rmSync(defaultAsar, { force: true });
  renameSync(join(outDir, 'electron.exe'), join(outDir, 'Agent_US.exe'));

  const appDir = join(outDir, 'resources', 'app');
  mkdirSync(appDir, { recursive: true });
  for (const file of [
    'main.mjs',
    'preload.cjs',
    'package.json',
    'extension-hub.mjs',
    'catalog-seed.json',
  ]) {
    cpSync(join(__dirname, file), join(appDir, file));
  }
  const iconPng = join(__dirname, 'assets', 'icon.png');
  if (existsSync(iconPng)) {
    cpSync(iconPng, join(outDir, 'resources', 'icon.png'));
  }
  cpSync(stagedFrontend, join(outDir, 'resources', 'frontend-dist'), { recursive: true });
  cpSync(stagedBackend, join(outDir, 'resources', 'backend'), { recursive: true });
  rmSync(stageDir, { recursive: true, force: true });
  console.log(`[pack-win] Built unpacked Windows app: ${join(outDir, 'Agent_US.exe')}`);
  process.exit(0);
}

console.log('[pack-win] Invoking electron-builder for Windows NSIS + Portable .exe ...');
const ebCli = join(__dirname, 'node_modules', 'electron-builder', 'cli.js');
const result = spawnSync(process.execPath, [ebCli, '--win', '--x64', '--publish', 'never'], {
  cwd: __dirname,
  stdio: 'inherit',
});
rmSync(stageDir, { recursive: true, force: true });
if (result.status !== 0) {
  throw new Error(`electron-builder failed with exit code ${result.status}`);
}
console.log('[pack-win] Windows .exe release artifacts built in desktop/release/');
