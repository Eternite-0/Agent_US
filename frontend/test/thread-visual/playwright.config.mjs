import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = process.env.E2E_VISUAL_PORT ?? '4183';
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: '.',
  testMatch: 'visual.spec.mjs',
  workers: 1,
  outputDir: mkdtempSync(join(tmpdir(), 'agent-us-thread-visual-')),
  timeout: 65_000,
  projects: [
    { name: '1440x960', use: { viewport: { width: 1440, height: 960 } } },
    { name: '1280x800', use: { viewport: { width: 1280, height: 800 } } },
    { name: '780x650', use: { viewport: { width: 780, height: 650 } } },
  ],
  expect: { timeout: 10_000 },
  use: {
    baseURL, browserName: 'chromium',
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
