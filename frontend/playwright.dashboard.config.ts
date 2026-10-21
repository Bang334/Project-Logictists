import { defineConfig } from '@playwright/test';
if (!process.env.DASHBOARD_TEST_DATABASE_URL) throw new Error('Set isolated DASHBOARD_TEST_DATABASE_URL');
export default defineConfig({
  testDir: './tests', testMatch: 'dashboard.spec.ts', workers: 1, timeout: 90000,
  use: { baseURL: 'http://127.0.0.1:5180', viewport: { width: 1440, height: 1000 }, trace: 'off', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'node scripts/with-dashboard-test-env.cjs tests/dashboard-test-app.cjs', cwd: '../backend', url: 'http://127.0.0.1:4020/auth/profile', reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5180', url: 'http://127.0.0.1:5180', env: { VITE_API_URL: 'http://127.0.0.1:4020', VITE_SOCKET_URL: 'http://127.0.0.1:4020', VITE_MAPBOX_TOKEN: '' }, reuseExistingServer: false },
  ],
});
