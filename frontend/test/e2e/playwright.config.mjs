import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const live = process.env.E2E_MODE === 'direct';
const port = Number(process.env.E2E_PORT ?? 4179);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid E2E_PORT');
const baseURL = `http://127.0.0.1:${port}`;
const screenshotDir = process.env.E2E_SCREENSHOT_DIR;
if (screenshotDir && !isAbsolute(screenshotDir)) throw new Error('E2E_SCREENSHOT_DIR must be absolute');
if (process.env.E2E_FRONTEND_DIR && !isAbsolute(process.env.E2E_FRONTEND_DIR)) {
  throw new Error('E2E_FRONTEND_DIR must be absolute');
}

export default defineConfig({
  testDir: '.',
  testMatch: live ? 'direct.spec.mjs' : 'sse.spec.mjs',
  // One isolated, resettable fixture server (or throwaway authenticated backend).
  workers: 1,
  retries: 0,
  timeout: live ? 300_000 : 70_000,
  expect: { timeout: 12_000 },
  outputDir: mkdtempSync(join(tmpdir(), 'agent-us-e2e-results-')),
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'zh-CN',
    launchOptions: process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {},
    // In live mode, keep provider traffic and credentials out of recorded artifacts.
    trace: live ? 'off' : 'retain-on-failure',
    screenshot: live ? 'off' : 'only-on-failure',
  },
  webServer: {
    command: 'node test/e2e/serve.mjs',
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { E2E_PORT: String(port) },
    url: `${baseURL}/v1/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    stdout: 'ignore',
    stderr: live ? 'ignore' : 'pipe',
  },
});
