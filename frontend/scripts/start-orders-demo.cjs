const fs = require('fs'), path = require('path'), cp = require('child_process');
const config = require('../../backend/node_modules/dotenv').parse(fs.readFileSync(path.resolve(__dirname, '../../backend/.env')));
const token = config.MAPBOX_ACCESS_TOKEN;
if (!token?.startsWith('pk.')) throw new Error('Mapbox browser demo requires a public token (pk.), never a secret token');
const child = cp.spawn(process.execPath, [path.resolve(__dirname, '../node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5174', '--strictPort'], {
  cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true,
  env: { ...process.env, VITE_API_URL: 'http://localhost:4012', VITE_MAPBOX_TOKEN: token },
});
child.on('error', () => { console.error('Cannot start orders web demo'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
