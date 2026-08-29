import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(webDir, '../../packages');

function pkg(...parts: string[]): string {
  return path.join(packagesDir, ...parts);
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

export default defineConfig({
  // 相对路径产物：兼容 file:// / 自定义协议 / asar 打包加载。
  base: './',
  resolve: {
    alias: {
      '@kanitsu/core': pkg('core', 'src', 'index.ts'),
      '@kanitsu/fs-adapter': pkg('fs-adapter', 'src', 'index.ts'),
      '@kanitsu/organizer': pkg('organizer', 'src', 'index.ts'),
      '@kanitsu/cover-picker': pkg('cover-picker', 'src', 'index.ts'),
      '@kanitsu/image-pipeline': pkg('image-pipeline', 'src', 'index.ts'),
      '@kanitsu/ui': pkg('ui', 'src', 'index.ts'),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'watch-kanitsu-packages',
      configureServer(server) {
        const packagesPath = normalize(packagesDir);
        server.watcher.add(packagesPath);
        server.watcher.on('all', (_event, file) => {
          const changed = normalize(file);
          if (changed.startsWith(`${packagesPath}/`)) {
            server.ws.send({ type: 'full-reload' });
          }
        });
      },
    },
  ],
  server: {
    fs: { allow: ['../..'] },
  },
  optimizeDeps: {
    exclude: [
      '@kanitsu/core',
      '@kanitsu/fs-adapter',
      '@kanitsu/organizer',
      '@kanitsu/cover-picker',
      '@kanitsu/image-pipeline',
      '@kanitsu/ui',
    ],
  },
});