import { defineConfig } from '@playwright/test';
import acceptance from './playwright.order-acceptance.config';
export default defineConfig({ ...acceptance, testMatch: 'order-cancellation.spec.ts', webServer: [
  { command: 'node scripts/with-order-acceptance-env.cjs tests/order-cancellation-app.cjs', cwd: '../backend', url: 'http://127.0.0.1:4018/auth/profile', reuseExistingServer: false },
  { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5178', url: 'http://127.0.0.1:5178', env: { VITE_API_URL: 'http://127.0.0.1:4018', VITE_MAPBOX_TOKEN: '' }, reuseExistingServer: false },
] });
