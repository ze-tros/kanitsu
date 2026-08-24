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
  resolve: {
    alias: {
      '@kanitu/core': pkg('core', 'src', 'index.ts'),
      '@kanitu/fs-adapter': pkg('fs-adapter', 'src', 'index.ts'),
      '@kanitu/organizer': pkg('organizer', 'src', 'index.ts'),
      '@kanitu/cover-picker': pkg('cover-picker', 'src', 'index.ts'),
      '@kanitu/image-pipeline': pkg('image-pipeline', 'src', 'index.ts'),
      '@kanitu/ui': pkg('ui', 'src', 'index.ts'),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'watch-kanitu-packages',
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
      '@kanitu/core',
      '@kanitu/fs-adapter',
      '@kanitu/organizer',
      '@kanitu/cover-picker',
      '@kanitu/image-pipeline',
      '@kanitu/ui',
    ],
  },
});