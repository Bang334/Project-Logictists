const fs = require("fs");
const cp = require("child_process");
const config = require("dotenv").parse(fs.readFileSync(".env"));
const url = new URL(config.AUTH_TEST_DATABASE_URL);
if (
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  url.pathname !== "/tms_auth_test"
)
  throw new Error("Local isolated test PostgreSQL required");
url.pathname = "/tms_driver_test_20261007";
const env = {
  ...process.env,
  ...config,
  DATABASE_URL: url.href,
  DIRECT_URL: url.href,
  TEST_DATABASE_URL: url.href,
  REDIS_URL: "redis://127.0.0.1:56389",
  PORT: "4013",
  OUTBOX_WORKER_ENABLED: process.argv[2] === "dist/src/main.js" ? "true" : "false",
};
const result = cp.spawnSync(process.execPath, process.argv.slice(2), {
  env,
  stdio: "inherit",
  windowsHide: true,
});
process.exitCode = result.status ?? 1;
