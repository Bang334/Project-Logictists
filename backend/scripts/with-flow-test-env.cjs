const { spawn } = require('node:child_process');
// Explicit opt-in only: never fall back to .env or operational DATABASE_URL.
const target = process.env.FLOW_TEST_DATABASE_URL;
if (!target) throw new Error('FLOW_TEST_DATABASE_URL required');
const url = new URL(target);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/tms_flow_test_20261105') {
  throw new Error('Only isolated tms_flow_test_20261105 allowed');
}
const child = spawn(process.execPath, process.argv.slice(2), {
  windowsHide: true, stdio: 'inherit', env: {
    ...process.env, DATABASE_URL: target, DIRECT_URL: target, TEST_DATABASE_URL: target,
    JWT_SECRET: 'flow-test-only-secret-at-least-32-characters',
    AUTH_DEMO_PASSWORD: 'Flow-test-only-2026!', OUTBOX_WORKER_ENABLED: 'false',
    REDIS_URL: 'redis://127.0.0.1:56395', OPTIMIZER_URL: 'http://127.0.0.1:18015',
    PORT: '4015', WEB_ORIGIN: 'http://127.0.0.1:5175', CORS_ORIGIN: 'http://127.0.0.1:5175',
    OUTBOX_NOTIFICATION_WEBHOOK_URL: '', OUTBOX_NOTIFICATION_WEBHOOK_SECRET: '',
  },
});
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
