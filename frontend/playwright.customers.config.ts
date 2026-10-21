import { defineConfig } from '@playwright/test';
if (!process.env.CUSTOMER_TEST_DATABASE_URL) throw new Error('Set an explicit isolated CUSTOMER_TEST_DATABASE_URL');
export default defineConfig({
  testDir: './tests', testMatch: 'customers.spec.ts', workers: 1, timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:5176', viewport: { width: 1440, height: 1000 }, trace: 'off', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'node scripts/with-customer-test-env.cjs tests/customer-test-app.cjs', cwd: '../backend', url: 'http://127.0.0.1:4016/auth/profile', reuseExistingServer: false },
    { command: 'npm run dev -- --host 127.0.0.1 --port 5176', url: 'http://127.0.0.1:5176', env: { VITE_API_URL: 'http://127.0.0.1:4016', VITE_MAPBOX_TOKEN: '' }, reuseExistingServer: false },
  ],
});
