import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(webDir, '../../packages');

// 应用版本单一来源：desktop 包的 version（发布 tag 与它一一对应，见仓库发布约定）。
// 构建期注入到 import.meta.env.KANITSU_VERSION，移动端「关于」页据此显示，
// 替换过去散落的 0.1.0 / 1.0 写死副本。
const desktopPackage = JSON.parse(
  readFileSync(path.resolve(webDir, '../desktop/package.json'), 'utf8'),
) as { version?: string };

function pkg(...parts: string[]): string {
  return path.join(packagesDir, ...parts);
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

export default defineConfig({
  // 相对路径产物：兼容 file:// / 自定义协议 / asar 打包加载。
  base: './',
  define: {
    'import.meta.env.KANITSU_VERSION': JSON.stringify(desktopPackage.version ?? ''),
  },
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
      // emscripten 产物(运行期 wasm 实例化 + 内部 worker),预打包会破坏其
      // import.meta.url 语义;已通过 wasmBinary 注入加载,不需要预打包。
      'libraw-wasm',
    ],
  },
});