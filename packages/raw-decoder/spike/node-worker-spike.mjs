// Phase 0 spike: 在 Node worker_threads 中直接加载 libraw-wasm 的 emscripten 模块,
// 验证缩略图(内嵌预览)与完整解码链路。
// 用法: node spike/node-worker-spike.mjs <raw文件路径> [--full] [--half]
//       node spike/node-worker-spike.mjs --init   (只验证模块加载)
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('libraw-wasm/package.json'));
const LIBRAW_JS = pathToFileURL(path.join(pkgDir, 'dist/libraw.js')).href;
const LIBRAW_WASM = path.join(pkgDir, 'dist/libraw.wasm');

const rawFile = process.argv[2];
const doFull = process.argv.includes('--full');
const doHalf = process.argv.includes('--half');
const initOnly = process.argv.includes('--init') || !rawFile;

// 在 worker 内运行的代码(字符串注入):CJS 环境,require 可用。
const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');

(async () => {
  const send = (msg) => parentPort.postMessage(msg);
  const t0 = Date.now();
  const factory = (await import(workerData.librawJs)).default;
  const wasmBinary = readFileSync(workerData.librawWasm);
  const mod = await factory({ wasmBinary, noInitialRun: true });
  const tInit = Date.now() - t0;
  const inst = new mod.LibRaw();
  const job = workerData.job;
  const result = { tInit };
  if (job) {
    const t1 = Date.now();
    await inst.open(new Uint8Array(job.bytes), job.settings ?? {});
    result.tOpen = Date.now() - t1;
    const meta = await inst.metadata(true);
    result.make = meta.make;
    result.model = meta.model;
    result.w = meta.width;
    result.h = meta.height;
    result.flip = meta.flip;
    result.thumbW = meta.thumb_width;
    result.thumbH = meta.thumb_height;
    result.thumbFormat = meta.thumb_format;
    if (job.want.includes('thumb')) {
      const t2 = Date.now();
      const thumb = await inst.thumbnailData();
      result.tThumb = Date.now() - t2;
      result.thumbBytes = thumb?.data?.byteLength ?? 0;
      result.thumbFmt = thumb?.format;
      result.thumbDataW = thumb?.width;
      result.thumbDataH = thumb?.height;
    }
    if (job.want.includes('full')) {
      const t3 = Date.now();
      const img = await inst.imageData();
      result.tFull = Date.now() - t3;
      result.fullW = img?.width;
      result.fullH = img?.height;
      result.fullBytes = img?.data?.byteLength ?? 0;
      result.fullBits = img?.bits;
      result.fullColors = img?.colors;
    }
  }
  parentPort.postMessage({ ok: true, result });
})().catch((err) => {
  const detail = err instanceof Error ? err.stack : JSON.stringify(err, Object.getOwnPropertyNames(err)) ?? String(err);
  parentPort.postMessage({ ok: false, error: detail });
});
`;

function spawnWorker(job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { librawJs: LIBRAW_JS, librawWasm: LIBRAW_WASM, job },
      resourceLimits: { maxOldGenerationSizeMb: 2048 },
    });
    worker.on('message', (m) => {
      if (m.ok) resolve(m.result);
      else reject(new Error(typeof m.error === 'string' ? m.error : JSON.stringify(m.error)));
    });
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
  });
}

if (initOnly) {
  const r = await spawnWorker(null);
  console.log(`[init-only] OK — 模块加载+wasm编译 ${r.tInit}ms`);
  process.exit(0);
}

const { readFile } = await import('node:fs/promises');
const buf = await readFile(rawFile);
const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const name = path.basename(rawFile);

const rThumb = await spawnJob('thumb', ['thumb']);
const rHalf = doHalf ? await spawnJob('full-half', ['full'], { halfSize: true }) : null;
const rFull = doFull ? await spawnJob('full', ['full']) : null;

function spawnJob(label, want, extra = {}) {
  return spawnWorker({ bytes, want, settings: { useCameraWb: true, outputColor: 1, outputBps: 8, ...extra } })
    .then((r) => { console.log(`[${label}] ${name}`, JSON.stringify(r)); return r; });
}
