// Explicit local target only. Never falls back to DATABASE_URL or backend/.env.
const { spawn } = require('node:child_process');
const target = process.env.CUSTOMER_TEST_DATABASE_URL;
if (!target) throw new Error('Set CUSTOMER_TEST_DATABASE_URL to an isolated local database');
const url = new URL(target);
if (!['127.0.0.1','localhost'].includes(url.hostname) || !url.pathname.startsWith('/tms_customers_')) throw new Error('Refusing non-customer-test database');
const env = { ...process.env, DATABASE_URL: target, DIRECT_URL: target,
  JWT_SECRET: 'isolated-customer-tests-only-secret-at-least-32-bytes', AUTH_DEMO_PASSWORD: 'Customer-test-only-2026!',
  AUTH_LOGIN_MAX_ATTEMPTS: '1000', AUTH_LOGIN_IP_MAX_ATTEMPTS: '10000', PORT: '4016', CORS_ORIGIN: 'http://127.0.0.1:5176' };
const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit', env });
child.on('exit', code => { process.exitCode = code ?? 1; });
child.on('error', () => { console.error('Cannot launch customer test process'); process.exitCode = 1; });
