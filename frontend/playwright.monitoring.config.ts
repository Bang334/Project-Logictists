import { defineConfig } from '@playwright/test';
if (!process.env.MONITOR_TEST_DATABASE_URL) throw new Error('Set isolated MONITOR_TEST_DATABASE_URL');
export default defineConfig({
  testDir: './tests', testMatch: 'monitoring.spec.ts', workers: 1, timeout: 90000,
  use: { baseURL: 'http://127.0.0.1:5179', viewport: { width: 1440, height: 1000 }, trace: 'off', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'node scripts/with-monitor-test-env.cjs tests/monitor-test-app.cjs', cwd: '../backend', url: 'http://127.0.0.1:4019/auth/profile', reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5179', url: 'http://127.0.0.1:5179', env: { VITE_API_URL: 'http://127.0.0.1:4019', VITE_SOCKET_URL: 'http://127.0.0.1:4019', VITE_MAPBOX_TOKEN: '' }, reuseExistingServer: false },
  ],
});
