import { defineConfig } from '@playwright/test';
if (!process.env.FLEET_TEST_DATABASE_URL) throw new Error('Set isolated FLEET_TEST_DATABASE_URL');
export default defineConfig({
  testDir: './tests', testMatch: 'fleet.spec.ts', workers: 1, timeout: 90000,
  use: { baseURL: 'http://127.0.0.1:5177', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'off' },
  webServer: [
    { command: 'node scripts/with-fleet-test-env.cjs tests/fleet-test-app.cjs', cwd: '../backend', url: 'http://127.0.0.1:4017/auth/profile', reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5177', url: 'http://127.0.0.1:5177', env: { VITE_API_URL: 'http://127.0.0.1:4017', VITE_MAPBOX_TOKEN: '' }, reuseExistingServer: false },
  ],
});
