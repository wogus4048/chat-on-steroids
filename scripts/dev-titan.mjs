import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run dev:titan -- [--root ABSOLUTE_PATH] [--port PORT]');
  process.exit(0);
}
let root = '/Users/giljaehyun/Titan/.runtime/cos-dev';
let port = '18765';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) root = args[++i];
  else if (args[i] === '--port' && args[i + 1]) port = args[++i];
  else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
}
if (!path.isAbsolute(root) || !/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535 ||
  (Number(port) >= 8765 && Number(port) <= 8769)) throw new Error('Use an absolute root and a dedicated port outside 8765–8769.');
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [path.join(checkout, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev'], {
  cwd: checkout,
  stdio: 'inherit',
  env: { ...process.env, TITAN_COS_DEV_ROOT: root, CLF_BRIDGE_PORTS: port, TITAN_COS_DEV_INSTANCE: randomUUID() }
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
