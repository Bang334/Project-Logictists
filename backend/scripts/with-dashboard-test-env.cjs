const { spawn } = require('node:child_process');
const value = process.env.DASHBOARD_TEST_DATABASE_URL;
if (!value) throw new Error('DASHBOARD_TEST_DATABASE_URL required');
const url = new URL(value);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/tms_dashboard_test') throw new Error('Only isolated tms_dashboard_test allowed');
const child = spawn(process.execPath, process.argv.slice(2), { windowsHide: true, stdio: 'inherit', env: {
  ...process.env, DATABASE_URL: value, DIRECT_URL: value,
  JWT_SECRET: 'dashboard-test-only-secret-at-least-32-characters', AUTH_DEMO_PASSWORD: 'Dashboard-test-only-2026!',
  STORAGE_ROOT: require('node:path').resolve('node_modules/.cache/dashboard-storage'),
} });
child.on('exit', code => { process.exitCode = code ?? 1; });
child.on('error', () => { process.exitCode = 1; });
