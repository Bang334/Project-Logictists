import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', workers: 1, timeout: 45000,
  use: { baseURL: 'http://localhost:5173', viewport: { width: 1440, height: 1000 }, trace: 'off', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'node scripts/with-auth-test-env.cjs dist/src/main.js', cwd: '../backend', url: 'http://localhost:4011/auth/profile', reuseExistingServer: !process.env.CI },
    { command: 'npm run dev -- --host 127.0.0.1 --port 5173', url: 'http://localhost:5173', env: { VITE_API_URL: 'http://localhost:4011' }, reuseExistingServer: !process.env.CI },
  ],
});
