import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'audit.spec.ts', workers: 1, timeout: 90000,
  use: { baseURL: 'http://127.0.0.1:5178', viewport: { width: 1440, height: 1000 }, trace: 'off', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'node scripts/with-audit-test-env.cjs tests/audit-app.cjs', cwd: '../backend', url: 'http://127.0.0.1:4018/auth/profile', reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5178', url: 'http://127.0.0.1:5178', env: { VITE_API_URL: 'http://127.0.0.1:4018', VITE_MAPBOX_TOKEN: '' }, reuseExistingServer: false },
  ],
});
