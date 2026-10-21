const { spawn } = require('node:child_process');
const target = process.env.ORDER_ACCEPTANCE_DATABASE_URL;
if (!target) throw new Error('ORDER_ACCEPTANCE_DATABASE_URL required');
const url = new URL(target);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/tms_order_acceptance_20261018') throw new Error('Only isolated order acceptance database allowed');
const child = spawn(process.execPath, process.argv.slice(2), { windowsHide: true, stdio: 'inherit', env: {
  ...process.env, DATABASE_URL: target, DIRECT_URL: target,
  JWT_SECRET: 'order-acceptance-test-only-secret-32-characters', AUTH_DEMO_PASSWORD: 'Order-test-only-2026!',
  MAPBOX_ACCESS_TOKEN: '', OUTBOX_WORKER_ENABLED: 'false',
} });
child.on('exit', code => { process.exitCode = code ?? 1; });
child.on('error', () => { process.exitCode = 1; });
