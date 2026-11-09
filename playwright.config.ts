import { defineConfig } from '@playwright/test';

const port = Number(process.env.MAZAL_BROWSER_PORT ?? '5497');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('MAZAL_BROWSER_PORT must be an integer between 1024 and 65535.');
const browserName = process.env.MAZAL_BROWSER_ENGINE ?? 'chromium';
if (browserName !== 'chromium' && browserName !== 'webkit') throw new Error('MAZAL_BROWSER_ENGINE must be chromium or webkit.');

export default defineConfig({
  testDir: './tests/desktop',
  outputDir: './outputs/browser-tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/browser-test-server.mjs',
    url: `http://127.0.0.1:${port}/api/state`,
    env: { MAZAL_BROWSER_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
