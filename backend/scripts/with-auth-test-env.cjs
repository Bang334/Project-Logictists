const fs=require('fs');
const cp=require('child_process');
const config=require('dotenv').parse(fs.readFileSync('.env'));
if(!config.AUTH_TEST_DATABASE_URL) throw new Error('AUTH_TEST_DATABASE_URL is required in backend/.env');
Object.assign(process.env,config,{
  DATABASE_URL:config.AUTH_TEST_DATABASE_URL,
  DIRECT_URL:config.AUTH_TEST_DATABASE_URL,
  PORT:config.AUTH_TEST_PORT||'4011',
  AUTH_LOGIN_WINDOW_SECONDS:config.AUTH_TEST_LOGIN_WINDOW_SECONDS||config.AUTH_LOGIN_WINDOW_SECONDS||'10',
});
const args=process.argv.slice(2);
if(!args.length) throw new Error('Expected executable JS file and arguments');
const result=cp.spawnSync(process.execPath,args,{stdio:'inherit',env:process.env});
process.exitCode=result.status ?? 1;
