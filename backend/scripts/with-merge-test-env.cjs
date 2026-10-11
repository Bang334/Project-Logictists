const fs = require('fs'), cp = require('child_process'), path = require('path');
const config = require('dotenv').parse(fs.readFileSync('.env'));
const target = new URL(config.AUTH_TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/tms_auth_test') throw new Error('Refusing non-isolated PostgreSQL');
target.pathname = '/tms_merge_test_20261011';
const redisTestUrl = process.env.MERGE_TEST_REDIS_URL || 'redis://127.0.0.1:56389';
if (!['localhost', '127.0.0.1'].includes(new URL(redisTestUrl).hostname)) throw new Error('Local test Redis required');
const env = { ...process.env, ...config, DATABASE_URL: target.href, DIRECT_URL: target.href, TEST_DATABASE_URL: target.href,
  REDIS_URL: redisTestUrl, PORT: '4012', WEB_ORIGIN: 'http://127.0.0.1:5174', CORS_ORIGIN: 'http://127.0.0.1:5174',
  OPTIMIZER_URL: 'http://127.0.0.1:18012', OUTBOX_POLL_INTERVAL_MS: '250', OUTBOX_WORKER_ENABLED: 'true' };
delete env.OUTBOX_NOTIFICATION_WEBHOOK_URL;
delete env.OUTBOX_NOTIFICATION_WEBHOOK_SECRET;
const args = process.argv.slice(2);
const withOptimizer = args[0] === '--optimizer';
if (withOptimizer) args.shift();
if (!args.length) throw new Error('Expected JS executable');
(async () => {
  let engine;
  try {
    if (withOptimizer) {
      engine = cp.spawn(path.resolve('../optimizer/.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '18012'], { cwd: path.resolve('../optimizer'), windowsHide: true, stdio: 'ignore' });
      let failure; engine.on('error', error => { failure = error; });
      let ready = false, lastProbeError;
      for (let n = 0; n < 60 && !ready; n++) {
        if (failure || engine.exitCode !== null) throw new Error('Local optimizer could not start');
        try { ready = (await fetch(env.OPTIMIZER_URL + '/health')).ok; } catch (error) { lastProbeError = error; }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!ready) throw new Error('Local optimizer unavailable', { cause: lastProbeError });
    }
    const result = cp.spawnSync(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
    process.exitCode = result.status ?? 1;
  } finally { engine?.kill(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
