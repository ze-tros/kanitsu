/**
 * 隐私模糊预览：小画布真高斯（downscale → Gaussian → upscale）。
 *
 * 最初的方案是 CSS `filter: blur()` 高斯模糊：每张卡都要在显示分辨率下做
 * 一次卷积光栅化，隐私模式整屏滚动时是稳定的掉帧来源。第一版替代方案是
 * 降采样重采样（缩到 24px 再放大），性能达标但"糊"来自插值核，观感是
 * "低分辨率图被拉伸"而非失焦。现在把高斯从显示路径挪到生成路径：普通尺寸
 * 缩略图（默认 512px）先缩到 BLUR_PREVIEW_IN_PX 级别，在这个微小画布上做
 * 一次真·高斯（ctx.filter blur，几万像素的卷积，微秒级），再平滑放大到
 * OUT 级别——观感回到真高斯的磨砂/失焦质感。展示端是普通 <img>，无
 * filter 光栅化，快速滚动零持续开销。
 *
 * 结果按「文件身份（id/mtime/size）+ 管线版本」记忆，不按 Blob 对象身份：
 * 缩略图 LRU 淘汰重读、封面/单元格等不同入口拿到的是不同的 Blob 对象，
 * 但文件身份相同，应当命中同一份结果。双层缓存：
 * - 会话内存 LRU（Map）：同步命中，虚拟列表反复挂载零等待。
 * - IndexedDB 持久层（尽力而为）：进程重启 / WebView 被系统回收后重进时
 *   直接从盘上恢复（每张几 KB），不再整屏以限流速度重新生成；打开或读写
 *   失败一律静默降级为纯内存。
 *
 * 兜底链：ctx.filter 不可用（老 Safari 等）→ 退回缩放模糊（无高斯但隐私
 * 等效）；canvas / createImageBitmap 失败 → 该键记入负缓存不再重试，调用方
 * 拿源 Blob 走 CSS blur 兜底，隐私不降级。
 */
const BLUR_PREVIEW_IN_PX = 128;
const BLUR_PREVIEW_OUT_PX = 256;
const BLUR_PREVIEW_TYPE = 'image/jpeg';
const BLUR_PREVIEW_QUALITY = 0.85;
/**
 * 高斯强度按长边比例定义：blur 参数 = 长边 × SIGMA_FRACTION × 2（σ = 长边的
 * 2%）。源是普通尺寸缩略图（默认 512px，检查器/封面可能是别的尺寸），缩到
 * IN 后长边不一定恰好等于 IN_PX，固定像素半径会让观感随源尺寸漂移。σ 占比
 * 锚定旧的降采样方案并略轻——同等 σ 下真高斯的观感比插值糊更重。
 */
const BLUR_PREVIEW_SIGMA_FRACTION = 0.02;
/** 管线版本：任何影响输出的参数 / 步骤变化都要 bump，持久层旧条目整体失效。 */
const PIPELINE_VERSION = 3;

// —— 会话内存层（LRU，按文件身份键）——
const MAX_MEMORY_ENTRIES = 2048;
// Map 迭代序即 LRU 序（最久未用在前）。
const previews = new Map<string, Blob>();
/** 生成失败的键（负缓存）：挂载洪峰下防住对同一坏键的重试风暴。 */
const failedKeys = new Set<string>();
const MAX_FAILED_KEYS = 512;
/** 源 Blob → 进行中的生成，按身份键供并发挂载去重。 */
const pending = new Map<string, Promise<Blob>>();

function previewKey(identity: string): string {
  return `${identity}\u0000bpv${PIPELINE_VERSION}`;
}

function memGet(key: string): Blob | null {
  const hit = previews.get(key);
  if (!hit) return null;
  // 刷新 LRU 顺序。
  previews.delete(key);
  previews.set(key, hit);
  return hit;
}

function memSet(key: string, blob: Blob): void {
  previews.delete(key);
  previews.set(key, blob);
  while (previews.size > MAX_MEMORY_ENTRIES) {
    const oldest = previews.keys().next().value;
    if (oldest === undefined) break;
    previews.delete(oldest);
  }
}

/** 同步窥探已生成的糊化预览（仅查内存层）；null 表示需走异步路径。 */
export function peekBlurPreviewBlob(identity: string): Blob | null {
  return memGet(previewKey(identity));
}

/**
 * 取源 Blob 的糊化预览；失败时 resolve 源 Blob 本身（调用方据
 * `out !== source` 判定退化，走 CSS blur 兜底）。
 */
export function getBlurPreviewBlob(source: Blob, identity: string): Promise<Blob> {
  const key = previewKey(identity);
  const settled = memGet(key);
  if (settled) return Promise.resolve(settled);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const task = (async (): Promise<Blob> => {
    if (failedKeys.has(key)) return source;
    // 持久层查询不占生成并发槽：一次几毫秒的 IDB 读不该挤占渲染。
    const persisted = await idbGetPreview(key).catch(() => null);
    if (persisted) {
      memSet(key, persisted);
      return persisted;
    }
    await acquireRenderSlot();
    try {
      const out = await renderBlurPreview(source);
      memSet(key, out);
      void idbPutPreview(key, out);
      return out;
    } catch (err) {
      // 回落是静默生效的（调用方拿源 Blob + CSS blur），但必须留痕：
      // 没有这条告警就无法区分“生成路径生效”和“一直在付 CSS blur 成本”。
      console.warn('[blurPreview] degrade failed, falling back to CSS blur', err);
      failedKeys.add(key);
      if (failedKeys.size > MAX_FAILED_KEYS) {
        const oldest = failedKeys.values().next().value;
        if (oldest !== undefined) failedKeys.delete(oldest);
      }
      return source;
    } finally {
      releaseRenderSlot();
    }
  })();
  const settledTask = task.finally(() => {
    pending.delete(key);
  });
  pending.set(key, settledTask);
  return settledTask;
}

/** 清空模糊预览缓存（内存 + 负缓存 + 持久层），供设置页“清除缓存”使用。 */
export function clearBlurPreviewCaches(): void {
  previews.clear();
  failedKeys.clear();
  void openPreviewDb().then((db) => {
    if (!db) return;
    try {
      db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).clear();
    } catch {
      // 持久层失败静默：内存层已清空即可。
    }
  });
}

// —— IndexedDB 持久层（尽力而为：不可用 / 失败一律静默降级为纯内存）——
const IDB_NAME = 'kanitsu-blur-preview';
const IDB_STORE = 'previews';
const IDB_META = '__meta__';
/** 条数上限：256px JPEG 每张几 KB～十几 KB，3000 张约数十 MB，超出按最旧淘汰。 */
const MAX_PERSISTED_ENTRIES = 3000;
/** 每 N 次写入检查一次持久层容量（count 本身也是一次 IDB 往返）。 */
const PRUNE_CHECK_INTERVAL = 128;
let dbPromise: Promise<IDBDatabase | null> | null = null;
let putCount = 0;

function openPreviewDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(IDB_STORE, { keyPath: 'key' });
        store.createIndex('t', 't');
      };
      req.onsuccess = () => {
        const db = req.result;
        checkPipelineVersion(db)
          .catch(() => undefined)
          .then(() => resolve(db));
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** 管线版本不匹配（参数调整后的旧数据）时整体清空，避免陈旧观感长期残留。 */
async function checkPipelineVersion(db: IDBDatabase): Promise<void> {
  const meta = await new Promise<{ version?: number } | null>((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_META);
    req.onsuccess = () => resolve((req.result as { version?: number } | undefined) ?? null);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  if (meta?.version === PIPELINE_VERSION) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
    tx.objectStore(IDB_STORE).put({ key: IDB_META, version: PIPELINE_VERSION, t: 0 });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function idbGetPreview(key: string): Promise<Blob | null> {
  const db = await openPreviewDb();
  if (!db) return null;
  return new Promise<Blob | null>((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve((req.result as { blob?: Blob } | undefined)?.blob ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutPreview(key: string, blob: Blob): Promise<void> {
  try {
    const db = await openPreviewDb();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ key, blob, t: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    putCount++;
    if (putCount % PRUNE_CHECK_INTERVAL === 0) void prunePreviewDb(db);
  } catch {
    // 持久层失败静默：内存层照常工作。
  }
}

/** 超出条数上限时按 t 最旧开始删除，删到 3/4 为止（留出写入余量）。 */
async function prunePreviewDb(db: IDBDatabase): Promise<void> {
  const count = await new Promise<number>((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => 0);
  if (count <= MAX_PERSISTED_ENTRIES) return;
  let toDelete = count - Math.floor((MAX_PERSISTED_ENTRIES * 3) / 4);
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.oncomplete = done;
    tx.onerror = done;
    tx.onabort = done;
    const cursorReq = tx.objectStore(IDB_STORE).index('t').openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || toDelete <= 0) return;
      // meta 行（t=0）会被排在最前，跳过不删。
      if (cursor.primaryKey !== IDB_META) {
        toDelete--;
        cursor.delete();
      }
      cursor.continue();
    };
  }).catch(() => undefined);
}

/**
 * 生成并发上限：极快滑动会瞬间排入几十张，若任由并行，解码 + canvas 光栅化
 * 洪峰会挤占渲染提交。任务本身很轻（128px 画布上的高斯 + 256px 编码），
 * 4 路并行足够拉起冷启动填充速度，同时仍保证渲染帧有插队机会。
 */
const MAX_PARALLEL_RENDERS = 4;
let activeRenders = 0;
const renderWaiters: Array<() => void> = [];

function acquireRenderSlot(): Promise<void> {
  return new Promise((resolve) => {
    const take = (): void => {
      activeRenders++;
      resolve();
    };
    if (activeRenders < MAX_PARALLEL_RENDERS) take();
    else renderWaiters.push(take);
  });
}

function releaseRenderSlot(): void {
  activeRenders--;
  const next = renderWaiters.shift();
  if (next) next();
}

/** 三段糊化：先缩到 IN 级别丢掉细节，小画布上做一次真高斯，再平滑放大到 OUT 级别。 */
async function renderBlurPreview(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const { width: w, height: h } = bitmap;
    const inScale = Math.min(1, BLUR_PREVIEW_IN_PX / Math.max(w, h, 1));
    const sw = Math.max(1, Math.round(w * inScale));
    const sh = Math.max(1, Math.round(h * inScale));
    const down = document.createElement('canvas');
    down.width = sw;
    down.height = sh;
    const dctx = down.getContext('2d');
    if (!dctx) throw new Error('canvas 2d unavailable');
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(bitmap, 0, 0, sw, sh);

    // 小画布上的一次性真高斯：几万像素的卷积，微秒级。不支持 ctx.filter
    // 的引擎退回缩放模糊（放大源保持 down），隐私强度不变、观感降一档。
    let blurred: CanvasImageSource = down;
    if ('filter' in dctx) {
      const mid = document.createElement('canvas');
      mid.width = sw;
      mid.height = sh;
      const mctx = mid.getContext('2d');
      if (!mctx) throw new Error('canvas 2d unavailable');
      mctx.filter = `blur(${Math.max(1, Math.max(sw, sh) * BLUR_PREVIEW_SIGMA_FRACTION * 2)}px)`;
      const ox = (sw * (BLUR_PREVIEW_OVERSCAN - 1)) / 2;
      const oy = (sh * (BLUR_PREVIEW_OVERSCAN - 1)) / 2;
      mctx.drawImage(down, -ox, -oy, sw * BLUR_PREVIEW_OVERSCAN, sh * BLUR_PREVIEW_OVERSCAN);
      blurred = mid;
    }

    const k = BLUR_PREVIEW_OUT_PX / BLUR_PREVIEW_IN_PX;
    const up = document.createElement('canvas');
    up.width = Math.max(1, Math.round(sw * k));
    up.height = Math.max(1, Math.round(sh * k));
    const uctx = up.getContext('2d');
    if (!uctx) throw new Error('canvas 2d unavailable');
    uctx.imageSmoothingQuality = 'high';
    uctx.drawImage(blurred, 0, 0, up.width, up.height);

    return await new Promise<Blob>((resolve, reject) => {
      up.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
        BLUR_PREVIEW_TYPE,
        BLUR_PREVIEW_QUALITY,
      );
    });
  } finally {
    bitmap.close();
  }
}

/**
 * 高斯把画布外当作透明，源图恰好铺满画布时四边会拉入半透明边（JPEG 编码
 * 把 alpha 合成到黑底即成黑边）。源图按 OVERSCAN 放大绘制，让模糊尾巴落在
 * 画布外再被裁掉。带缩放的绘制上 filter 半径语义各引擎有差异，但最多差
 * OVERSCAN 这 ~15%，属观感参数可接受。
 */
const BLUR_PREVIEW_OVERSCAN = 1.15;
