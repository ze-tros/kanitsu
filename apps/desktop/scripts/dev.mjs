import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..', '..');
const webDir = path.join(root, 'apps', 'web');
const desktopDir = path.join(root, 'apps', 'desktop');
const viteJs = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const require = createRequire(import.meta.url);
const electronPath = require('electron');

console.log('Starting Vite dev server...');
const vite = spawn(
  process.execPath,
  [viteJs, '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
  { cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'] },
);

let electron = null;
let electronStarted = false;

function startElectron() {
  if (electronStarted) return;
  electronStarted = true;
  console.log('Starting Electron:', electronPath);
  // 控制台 UTF-8 由主进程在启动时执行 chcp 65001（见 main.ts），这里直接 spawn。
  electron = spawn(electronPath, ['.'], {
    cwd: desktopDir,
    env: { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' },
    stdio: 'inherit',
  });
  electron.on('error', (err) => {
    console.error('Electron spawn failed:', err);
    vite.kill('SIGTERM');
    process.exit(1);
  });
  electron.on('exit', (code) => {
    vite.kill('SIGTERM');
    process.exit(code ?? 0);
  });
}

function watchViteOutput(chunk) {
  process.stdout.write(chunk);
  const text = String(chunk);
  if (text.includes('Local:') || text.includes('ready in')) {
    startElectron();
  }
}

vite.stdout.on('data', watchViteOutput);
vite.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  const text = String(chunk);
  if (text.includes('Local:') || text.includes('ready in')) startElectron();
});

vite.on('error', (err) => {
  console.error('Vite spawn failed:', err);
  process.exit(1);
});

vite.on('exit', (code) => {
  if (electron && !electron.killed) electron.kill('SIGTERM');
  process.exit(code ?? 0);
});