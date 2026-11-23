import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (!['fixture', 'direct'].includes(mode)) throw new Error('Expected fixture or direct');
if (mode === 'direct') {
  const required = ['E2E_PROVIDER_ENDPOINT', 'E2E_PROVIDER_MODEL', 'E2E_PROVIDER_API_KEY'];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    console.log(`Direct E2E skipped (opt-in; set ${missing.join(', ')}). No backend was started.`);
    process.exit(0);
  }
  let endpoint;
  try { endpoint = new URL(process.env.E2E_PROVIDER_ENDPOINT); } catch { /* handled below */ }
  if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    console.error('E2E_PROVIDER_ENDPOINT must be an HTTP(S) base URL without credentials, a query, or a fragment.');
    process.exit(1);
  }
}

// Prevent caller debug flags from logging HTTP headers; start with a minimal,
// explicit environment rather than inheriting production backend/provider settings.
const safeNames = [
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'ComSpec',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'XDG_CACHE_HOME', 'CI',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'PLAYWRIGHT_BROWSERS_PATH',
  'E2E_PORT', 'E2E_CHROMIUM_PATH', 'E2E_FRONTEND_DIR', 'E2E_SCREENSHOT_DIR', 'E2E_CAPTURE_BASELINE',
  ...(mode === 'direct' ? ['E2E_PROVIDER_ENDPOINT', 'E2E_PROVIDER_MODEL', 'E2E_PROVIDER_API_KEY'] : []),
];
const env = Object.fromEntries(safeNames.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../../node_modules/@playwright/test/cli.js', import.meta.url)),
  'test', '--config', fileURLToPath(new URL('./playwright.config.mjs', import.meta.url)),
  ...process.argv.slice(3),
], { stdio: 'inherit', env: { ...env, E2E_MODE: mode } });
process.exitCode = result.status ?? 1;
