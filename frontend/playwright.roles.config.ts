import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'three-roles.spec.ts', workers: 1, timeout: 60000,
  outputDir: 'test-results/three-roles',
  use: { timezoneId: 'Asia/Ho_Chi_Minh', baseURL: 'http://127.0.0.1:5182', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'off' },
  webServer: [
    { command: 'node tests/three-roles-app.cjs', cwd: '../backend', url: 'http://127.0.0.1:4022/auth/profile', reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5182', url: 'http://127.0.0.1:5182', env: { VITE_API_URL: 'http://127.0.0.1:4022', VITE_MAPBOX_TOKEN: '' }, reuseExistingServer: false },
  ],
});
