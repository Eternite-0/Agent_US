import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.RUNTIME_BROWSER_PORT ?? 4182);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid RUNTIME_BROWSER_PORT');
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: '.',
  testMatch: 'double-command.spec.mjs',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL, browserName: 'chromium', viewport: { width: 1440, height: 960 }, locale: 'zh-CN', reducedMotion: 'reduce',
    launchOptions: process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {},
  },
  outputDir: mkdtempSync(join(tmpdir(), 'agent-us-runtime-playwright-')),
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: 'node test/browser-runtime/serve.mjs',
    url: `${baseURL}/v1/health`,
    timeout: 25_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    reuseExistingServer: false,
  },
});
