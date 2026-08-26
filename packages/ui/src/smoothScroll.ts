import { useEffect, type RefObject } from 'react';
import { recordScrollWrite } from './fpsMonitor';

export interface WheelSmoothOptions {
  /** 松手/惯性阶段的每 16.7ms 逼近比例（0~1）。默认 0.3（~60ms 收尾）。 */
  lerp?: number;
  /** 输入活跃阶段的每 16.7ms 逼近比例（0~1）。默认 0.5（跟手但不生硬）。 */
  activeLerp?: number;
  /** deltaMode=1（按"行"）时每行换算像素数。默认 33。 */
  lineHeight?: number;
  /**
   * scrollTop 写入限频（ms）。0 = 每帧写入（跟手优先）；16.7 = 60Hz（最省）。
   * 默认 8.3（120Hz 内容帧率）：240Hz 屏上仍足够跟手，但主线程布局/提交
   * 工作量比“每帧写”减半——生产版实测每帧写位置是掉帧主因。
   */
  writeIntervalMs?: number;
  /** 到达吸附阈值（px）：松手后距目标小于该值直接落位停止。默认 2。 */
  arriveEps?: number;
  /** 距最后一次滚轮输入多久内视为“输入活跃”（ms）。默认 70。 */
  inputActiveMs?: number;
}

/**
 * 滚轮平滑滚动（类手机信息流手感，零依赖）。
 *
 * 原生滚轮是离散"档位"，一味缓动会两头拖沓：
 *  - 开始慢（等缓动起速）→ 不跟手；
 *  - 结尾慢（渐近收敛）→ 拖泥带水。
 *
 * 本实现分两段：
 *  - 输入活跃期（滚轮事件到来的 ~70ms 内）：activeLerp 快速逼近，近乎 1:1 跟手，
 *    首帧（≤1 个 vsync）就开始移动；
 *  - 松手后：惯性缓动快速收尾（lerp 0.3 + 2px 吸附即停）。
 * 每秒最多 writeIntervalMs 写一次 scrollTop（默认 0 = 每帧），超过则跳过；
 * 本地变量跟踪位置，避免每帧读 el.scrollTop 触发强制同步布局。
 */
export function useWheelSmoothScroll(
  elRef: RefObject<HTMLElement | null>,
  options: WheelSmoothOptions = {},
): void {
  const lerp = options.lerp ?? 0.3;
  const activeLerp = options.activeLerp ?? 0.5;
  const lineHeight = options.lineHeight ?? 33;
  const writeIntervalMs = options.writeIntervalMs ?? 8.3;
  const arriveEps = options.arriveEps ?? 2;
  const inputActiveMs = options.inputActiveMs ?? 70;

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return; // 减少动态效果：回退原生滚动
    }

    // 本地跟踪当前位置；只在滚轮输入/外部变更时读一次 DOM，避免每帧强制布局。
    let current = el.scrollTop;
    let target = current;
    let raf = 0;
    let running = false;
    let lastTime = 0;
    let lastWrite = 0;
    let lastInputAt = 0;

    const clampTarget = (): void => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      target = Math.max(0, Math.min(target, max));
    };

    const rebase = (): void => {
      current = el.scrollTop;
      target = current;
    };

    const step = (time: number): void => {
      const diff = target - current;
      const active = time - lastInputAt < inputActiveMs;
      if (!active && Math.abs(diff) < arriveEps) {
        // 松手后到位吸附：直接落位并停止，去掉渐近尾巴。
        el.scrollTop = target;
        current = target;
        running = false;
        raf = 0;
        recordScrollWrite();
        return;
      }
      if (Math.abs(diff) < 0.1) {
        // 已跟上目标（输入中或刚停）：暂停循环，下一次滚轮事件再唤醒。
        running = false;
        raf = 0;
        return;
      }
      const dt = lastTime ? Math.min(64, time - lastTime) : 16.7;
      lastTime = time;
      const base = active ? activeLerp : lerp;
      const factor = 1 - Math.pow(1 - base, dt / 16.7);
      const next = current + diff * factor;
      if (time - lastWrite >= writeIntervalMs) {
        lastWrite = time;
        el.scrollTop = next;
        current = next;
        recordScrollWrite();
      }
      raf = requestAnimationFrame(step);
    };

    const start = (): void => {
      if (running) return;
      running = true;
      lastTime = 0;
      lastWrite = 0;
      raf = requestAnimationFrame(step);
    };

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      // 新一轮输入以实际位置为基准累计，避免从陈旧目标“跳”过去。
      if (!running) rebase();
      const raw =
        e.deltaMode === 1
          ? e.deltaY * lineHeight
          : e.deltaMode === 2
            ? e.deltaY * el.clientHeight
            : e.deltaY;
      target += raw;
      clampTarget();
      lastInputAt = performance.now();
      if (!running) start();
    };

    const onScroll = (): void => {
      // 非本循环写入的滚动（滚动条拖拽 / 切目录恢复 / 键盘）实时重对齐。
      if (Math.abs(el.scrollTop - current) > 1) rebase();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [elRef, lerp, activeLerp, lineHeight, writeIntervalMs, arriveEps, inputActiveMs]);
}
