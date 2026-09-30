// Creates the localhost-only PostgreSQL container described by backend/.env.
// It never writes credentials, resets a database, or removes an existing container.
const fs = require('fs');
const cp = require('child_process');

const config = require('dotenv').parse(fs.readFileSync('.env'));
if (!config.AUTH_TEST_DATABASE_URL || !config.AUTH_TEST_CONTAINER) {
  throw new Error('AUTH_TEST_DATABASE_URL and AUTH_TEST_CONTAINER are required in backend/.env');
}

const target = new URL(config.AUTH_TEST_DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/tms_auth_test') {
  throw new Error('Only isolated localhost tms_auth_test is allowed');
}
if (!/^tms-auth-test-[a-z0-9-]+$/i.test(config.AUTH_TEST_CONTAINER)) {
  throw new Error('AUTH_TEST_CONTAINER must start with tms-auth-test-');
}

const existing = cp.spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', config.AUTH_TEST_CONTAINER], { encoding: 'utf8' });
if (existing.status === 0) {
  if (existing.stdout.trim() !== 'true') {
    const started = cp.spawnSync('docker', ['start', config.AUTH_TEST_CONTAINER], { encoding: 'utf8' });
    if (started.status) throw new Error(started.stderr || 'Cannot start isolated PostgreSQL container');
  }
  console.log('Isolated PostgreSQL container is running:', config.AUTH_TEST_CONTAINER);
  process.exit(0);
}
if (!/no such (object|container)/i.test(existing.stderr || '')) {
  throw new Error(existing.stderr || 'Docker is unavailable');
}

const port = target.port || '5432';
const user = decodeURIComponent(target.username || 'postgres');
const password = decodeURIComponent(target.password);
if (!password) throw new Error('AUTH_TEST_DATABASE_URL must contain a password');

const result = cp.spawnSync(
  'docker',
  ['run', '-d', '--name', config.AUTH_TEST_CONTAINER, '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_USER=${user}`, '-e', 'POSTGRES_DB=tms_auth_test', '-p', `127.0.0.1:${port}:5432`, 'postgres:16'],
  { env: { ...process.env, POSTGRES_PASSWORD: password }, encoding: 'utf8' },
);
if (result.status) throw new Error(result.stderr || 'Cannot create isolated PostgreSQL container');
console.log('Created isolated PostgreSQL container:', config.AUTH_TEST_CONTAINER);
