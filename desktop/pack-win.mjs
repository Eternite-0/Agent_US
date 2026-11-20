import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const electronDist = join(__dirname, 'node_modules', 'electron', 'dist');
const frontendDist = join(rootDir, 'frontend', 'dist');
const backendDir = join(rootDir, 'backend');
const outDir = join(__dirname, 'release', 'win-unpacked');

if (!existsSync(join(electronDist, 'electron.exe'))) {
  throw new Error(`Missing Electron runtime at ${electronDist}. Run npm install in desktop/ first.`);
}
if (!existsSync(join(frontendDist, 'index.html'))) {
  throw new Error(`Missing frontend build at ${frontendDist}. Run npm --prefix ../frontend run build first.`);
}

console.log('[pack-win] Preparing release/win-unpacked ...');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. Copy Electron runtime
cpSync(electronDist, outDir, { recursive: true });
const defaultAsar = join(outDir, 'resources', 'default_app.asar');
if (existsSync(defaultAsar)) rmSync(defaultAsar, { force: true });

// 2. Rename executable to Codex Agent.exe
renameSync(join(outDir, 'electron.exe'), join(outDir, 'Codex Agent.exe'));

// 3. Copy desktop app main/preload/package.json into resources/app
const appDir = join(outDir, 'resources', 'app');
mkdirSync(appDir, { recursive: true });
for (const file of ['main.mjs', 'preload.cjs', 'package.json', 'extension-hub.mjs', 'catalog-seed.json']) {
  cpSync(join(__dirname, file), join(appDir, file));
}

// 4. Bundle frontend/dist -> resources/frontend-dist
cpSync(frontendDist, join(outDir, 'resources', 'frontend-dist'), { recursive: true });

// 5. Bundle backend -> resources/backend (src, package.json, node_modules, optional config)
const resBackend = join(outDir, 'resources', 'backend');
mkdirSync(resBackend, { recursive: true });
cpSync(join(backendDir, 'src'), join(resBackend, 'src'), { recursive: true });
cpSync(join(backendDir, 'package.json'), join(resBackend, 'package.json'));
cpSync(join(backendDir, 'node_modules'), join(resBackend, 'node_modules'), { recursive: true });

console.log(`[pack-win] Built standalone Windows desktop app: ${join(outDir, 'Codex Agent.exe')}`);
