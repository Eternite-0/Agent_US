import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = '4183';
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: '.',
  testMatch: 'visual.spec.mjs',
  workers: 1,
  outputDir: mkdtempSync(join(tmpdir(), 'agent-us-thread-visual-')),
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL, browserName: 'chromium', viewport: { width: 1440, height: 1000 },
    colorScheme: 'light', locale: 'zh-CN', reducedMotion: 'reduce',
    launchOptions: process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: 'node test/e2e/serve.mjs', cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { E2E_MODE: 'fixture', E2E_PORT: port }, url: `${baseURL}/v1/health`,
    timeout: 30_000, reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
