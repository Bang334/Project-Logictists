const { spawn } = require('node:child_process');
const target = process.env.FLEET_TEST_DATABASE_URL;
if (!target) throw new Error('FLEET_TEST_DATABASE_URL is required');
const url = new URL(target);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/tms_fleet_test') throw new Error('Only isolated tms_fleet_test is allowed');
const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit', env: {
  ...process.env, DATABASE_URL: target, DIRECT_URL: target,
} });
child.on('exit', code => { process.exitCode = code ?? 1; });
child.on('error', () => { process.exitCode = 1; });
