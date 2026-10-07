import { defineConfig } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const config = require('../backend/node_modules/dotenv').parse(readFileSync('../backend/.env'));
const mapToken = config.MAPBOX_ACCESS_TOKEN;
if (!mapToken?.startsWith('pk.')) throw new Error('Browser test needs an existing public Mapbox token; never expose a secret token');
export default defineConfig({
  testDir: './tests', testMatch: 'orders.spec.ts', workers: 1, timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:5174', viewport: { width: 1440, height: 1000 }, trace: 'off', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'node scripts/with-merge-test-env.cjs dist/src/main.js', cwd: '../backend', url: 'http://localhost:4012/auth/profile', reuseExistingServer: false },
    { command: 'npm run dev -- --host 127.0.0.1 --port 5174', url: 'http://127.0.0.1:5174', env: { VITE_API_URL: 'http://localhost:4012', VITE_MAPBOX_TOKEN: mapToken }, reuseExistingServer: false },
  ],
});
