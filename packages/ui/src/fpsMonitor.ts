/**
 * 帧率 / 掉帧监测（供设置页“调试”面板与排查滚动卡顿使用）。
 *
 * 一条常驻 rAF 链测量每帧间隔：
 *  - 帧率：最近 1 秒帧数估算；
 *  - 平均 / p95 / 最大帧间隔；
 *  - 掉帧：帧间隔 > 33.3ms（连 30fps 都保不住）；
 *  - 卡顿帧：> 50ms（超出长任务红线一半，几乎必然可感知）；
 *  - 滚动回调耗时：LibraryBrowser 在 onScroll 的 rAF 里用 recordScrollFrame 上报，
 *    用于区分“JS 调度开销”与“渲染/绘画开销”（后者以 DevTools Performance 为准）。
 */
export interface FpsStats {
  /** 最近 1s 帧数估算。 */
  fps: number;
  /** 最近 1s 平均帧间隔（ms）。 */
  avgFrameMs: number;
  /** 最近 1s 帧间隔 p95（ms）。 */
  p95FrameMs: number;
  /** 最近 1s 最大帧间隔（ms）。 */
  maxFrameMs: number;
  /** 最近 1s 掉帧数（帧间隔 > 33.3ms）。 */
  dropped: number;
  /** 最近 1s 卡顿帧数（帧间隔 > 50ms）。 */
  jankFrames: number;
  /** 累计帧数。 */
  totalFrames: number;
  /** 累计掉帧数。 */
  totalDropped: number;
  /** 滚动回调样本数。 */
  scrollSamples: number;
  /** 最近 1s 的 scrollTop 写入次数（应≈60Hz 节流上限）。 */
  scrollWrites: number;
  /** 滚动回调平均耗时（ms）。 */
  scrollAvgMs: number;
  /** 滚动回调最大耗时（ms）。 */
  scrollMaxMs: number;
  /** 滚动回调 p95（ms）。 */
  scrollP95Ms: number;
}

const DROP_MS = 1000 / 30;
const JANK_MS = 50;
const WINDOW_MS = 1000;
const MAX_SCROLL_SAMPLES = 200;

/** 最近 1s 的帧间隔样本（t=结束时间戳，gap=间隔 ms）。 */
const samples: { t: number; gap: number }[] = [];
const scrollMs: number[] = [];
const scrollWriteTs: number[] = [];

let rafId = 0;
let running = false;
let lastTime = 0;
let totalFrames = 0;
let totalDropped = 0;
let lastReportAt = 0;
let onUpdate: ((s: FpsStats) => void) | null = null;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function compute(now: number): FpsStats {
  const cutoff = now - WINDOW_MS;
  while (samples.length > 0 && samples[0]!.t < cutoff) samples.shift();
  const gaps = samples.map((s) => s.gap);
  const avg = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const sorted = [...gaps].sort((a, b) => a - b);
  const scrollSorted = [...scrollMs].sort((a, b) => a - b);
  return {
    fps: avg > 0 ? 1000 / avg : 0,
    avgFrameMs: avg,
    p95FrameMs: percentile(sorted, 95),
    maxFrameMs: sorted.length > 0 ? sorted[sorted.length - 1]! : 0,
    dropped: gaps.filter((g) => g > DROP_MS).length,
    jankFrames: gaps.filter((g) => g > JANK_MS).length,
    totalFrames,
    totalDropped,
    scrollSamples: scrollMs.length,
    scrollAvgMs: scrollMs.length > 0 ? scrollMs.reduce((a, b) => a + b, 0) / scrollMs.length : 0,
    scrollMaxMs: scrollSorted.length > 0 ? scrollSorted[scrollSorted.length - 1]! : 0,
    scrollP95Ms: percentile(scrollSorted, 95),
    scrollWrites: scrollWriteTs.filter((t) => now - t <= WINDOW_MS).length,
  };
}

function tick(now: number): void {
  if (lastTime !== 0) {
    const gap = now - lastTime;
    if (gap < 2000) {
      // 排除切后台/休眠这类长间隔，避免污染统计。
      samples.push({ t: now, gap });
      totalFrames++;
      if (gap > DROP_MS) totalDropped++;
    }
  }
  lastTime = now;
  if (onUpdate && now - lastReportAt >= 500) {
    lastReportAt = now;
    onUpdate(compute(now));
  }
  rafId = requestAnimationFrame(tick);
}

/** 启动监测：监听器每 ~500ms 收到一次统计（幂等）。 */
export function startFpsMonitor(listener: (s: FpsStats) => void): void {
  onUpdate = listener;
  if (running) return;
  running = true;
  lastTime = 0;
  rafId = requestAnimationFrame(tick);
}

/** 停止监测（关闭调试面板时调用）。 */
export function stopFpsMonitor(): void {
  onUpdate = null;
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);
  rafId = 0;
  lastTime = 0;
}

/** 清空全部统计。 */
export function resetFpsMonitor(): void {
  samples.length = 0;
  scrollMs.length = 0;
  scrollWriteTs.length = 0;
  totalFrames = 0;
  totalDropped = 0;
  lastTime = 0;
}

/** 单次获取当前统计。 */
export function getFpsStats(): FpsStats {
  return compute(performance.now());
}

/** 记录一次滚动回调耗时（LibraryBrowser 的 onScroll rAF 内上报）。 */
export function recordScrollFrame(ms: number): void {
  scrollMs.push(ms);
  if (scrollMs.length > MAX_SCROLL_SAMPLES) scrollMs.shift();
}

/** 记录一次 scrollTop 写入（smoothScroll 60Hz 节流内上报，验证封顶生效）。 */
export function recordScrollWrite(): void {
  scrollWriteTs.push(performance.now());
  while (scrollWriteTs.length > 0 && scrollWriteTs[0]! < performance.now() - WINDOW_MS) {
    scrollWriteTs.shift();
  }
}
