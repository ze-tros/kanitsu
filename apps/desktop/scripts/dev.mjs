import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..', '..');
const webDir = path.join(root, 'apps', 'web');
const desktopDir = path.join(root, 'apps', 'desktop');
const viteJs = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const DEFAULT_DEV_PORT = 5173;
const MAX_PORT_ATTEMPTS = 20;

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort) {
  const endPort = Math.min(65535, startPort + MAX_PORT_ATTEMPTS - 1);
  for (let port = startPort; port <= endPort; port++) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No available development port in ${startPort}-${endPort}`);
}

const configuredPort = Number.parseInt(process.env.KANITU_DEV_PORT ?? '', 10);
const preferredPort = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
  ? configuredPort
  : DEFAULT_DEV_PORT;
const devPort = await findAvailablePort(preferredPort);
const devServerUrl = `http://127.0.0.1:${devPort}`;

if (devPort !== preferredPort) {
  console.log(`Port ${preferredPort} is in use; using ${devPort} for this desktop session.`);
}

console.log('Starting Vite dev server...');
const vite = spawn(
  process.execPath,
  [viteJs, '--host', '127.0.0.1', '--port', String(devPort), '--strictPort'],
  { cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'] },
);

let electron = null;
let electronStarted = false;
let shutdownPromise = null;
let requestedExitCode = 0;

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function stopChild(child) {
  if (!child || hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let forceTimer = null;
    let giveUpTimer = null;
    const finish = () => {
      if (forceTimer) clearTimeout(forceTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      child.removeListener('close', finish);
      resolve();
    };
    child.once('close', finish);
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      if (hasExited(child)) {
        finish();
        return;
      }
      child.kill('SIGKILL');
      // A broken child handle must not keep the launcher alive forever.
      giveUpTimer = setTimeout(finish, 1000);
    }, 2500);
  });
}

function shutdown(exitCode, exitedChild = null) {
  requestedExitCode = Math.max(requestedExitCode, exitCode ?? 0);
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = Promise.all([
    electron !== exitedChild ? stopChild(electron) : Promise.resolve(),
    vite !== exitedChild ? stopChild(vite) : Promise.resolve(),
  ]).then(() => {
    process.exitCode = requestedExitCode;
  });
  return shutdownPromise;
}

function startElectron() {
  if (electronStarted) return;
  electronStarted = true;
  console.log('Starting Electron:', electronPath);
  // 控制台 UTF-8 由主进程在启动时执行 chcp 65001（见 main.ts），这里直接 spawn。
  electron = spawn(electronPath, ['.'], {
    cwd: desktopDir,
    env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl },
    stdio: 'inherit',
  });
  electron.on('error', (err) => {
    console.error('Electron spawn failed:', err);
    void shutdown(1, electron);
  });
  electron.on('exit', (code) => {
    void shutdown(code ?? 0, electron);
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
  void shutdown(1, vite);
});

vite.on('exit', (code) => {
  void shutdown(code ?? 0, vite);
});

process.once('SIGINT', () => void shutdown(130));
process.once('SIGTERM', () => void shutdown(143));
