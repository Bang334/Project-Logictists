require('dotenv').config({ quiet: true });

const { hostname, pathname } = new URL(
  process.env.TEST_DATABASE_URL || 'postgresql://missing:missing@invalid/missing',
);

if (!process.env.TEST_DATABASE_URL) {
  console.error(
    'TEST_DATABASE_URL is required. Point it to a separate disposable PostgreSQL database.',
  );
  process.exit(1);
}

if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
  console.error('TEST_DATABASE_URL must not be the same as DATABASE_URL.');
  process.exit(1);
}

const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
if (!isLocal && process.env.ALLOW_REMOTE_TEST_DATABASE !== 'true') {
  console.error(
    'Remote integration-test databases require ALLOW_REMOTE_TEST_DATABASE=true.',
  );
  process.exit(1);
}

if (!pathname.toLowerCase().includes('test')) {
  console.error('TEST_DATABASE_URL database name must contain "test".');
  process.exit(1);
}
