import { defineConfig } from '@playwright/test';
if (!process.env.ORDER_ACCEPTANCE_DATABASE_URL) throw new Error('Set isolated ORDER_ACCEPTANCE_DATABASE_URL');
export default defineConfig({
  testDir: './tests', testMatch: 'order-acceptance.spec.ts', workers: 1, timeout: 90000,
  use: { baseURL: 'http://127.0.0.1:5178', viewport: { width: 1440, height: 1000 }, trace: 'off', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'node scripts/with-order-acceptance-env.cjs tests/order-acceptance-app.cjs', cwd: '../backend', url: 'http://127.0.0.1:4018/auth/profile', reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5178', url: 'http://127.0.0.1:5178', env: { VITE_API_URL: 'http://127.0.0.1:4018', VITE_MAPBOX_TOKEN: '' }, reuseExistingServer: false },
  ],
});
