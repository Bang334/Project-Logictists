// Uses only the named, isolated acceptance container; never reads operational .env.
const { spawnSync } = require('node:child_process');
let target = process.env.ORDER_ACCEPTANCE_DATABASE_URL;
if (!target) {
  const inspected = spawnSync('docker', ['inspect', 'tms-order-cancel-test-20261103'], { encoding: 'utf8', windowsHide: true });
  if (inspected.status) throw new Error('Start isolated acceptance container or set ORDER_ACCEPTANCE_DATABASE_URL');
  const container = JSON.parse(inspected.stdout)[0];
  const binding = container.NetworkSettings.Ports['5432/tcp']?.[0];
  if (binding?.HostIp !== '127.0.0.1') throw new Error('Test PostgreSQL must bind localhost');
  const password = container.Config.Env.find(v => v.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length);
  if (!password) throw new Error('Missing test database password');
  target = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${binding.HostPort}/tms_order_acceptance_20261018`;
}
const url = new URL(target);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/tms_order_acceptance_20261018') throw new Error('Only isolated acceptance database allowed');
const result = spawnSync(process.execPath, process.argv.slice(2), { windowsHide: true, stdio: 'inherit', env: {
  ...process.env, ORDER_ACCEPTANCE_DATABASE_URL: target, DATABASE_URL: target, DIRECT_URL: target,
  JWT_SECRET: 'order-acceptance-test-only-secret-32-characters', AUTH_DEMO_PASSWORD: 'Order-test-only-2026!', MAPBOX_ACCESS_TOKEN: '', OUTBOX_WORKER_ENABLED: 'false',
} });
process.exitCode = result.status ?? 1;
