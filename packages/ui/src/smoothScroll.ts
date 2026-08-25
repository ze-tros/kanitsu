import { useEffect, type RefObject } from 'react';

export interface WheelSmoothOptions {
  /** 每 16.7ms 向目标逼近的比例（0~1），越小越绵长。默认 0.16。 */
  lerp?: number;
  /** deltaMode=1（按"行"）时每行换算像素数。默认 33。 */
  lineHeight?: number;
}

/**
 * 滚轮平滑滚动（类手机信息流手感，零依赖）。
 *
 * 原生滚轮是离散"档位"：一挡 = 一段增量（Windows 鼠标约 100~120px），浏览器
 * 一下跳到位；配合虚拟化换行，画面容易表现为"跳两次、不跟手"。
 * 手机信息流顺滑的本质是"1:1 跟手 ＋ 指数缓动/惯性"。
 *
 * 这里接管主滚动区的 wheel 事件：
 *  - 把滚轮增量累加到一个"目标位置"；
 *  - rAF 每帧按指数缓动逼近目标（dt 归一化，帧率无关）；
 *  - 一轮滚轮回合只有一条连续动线，不再出现"原生一跳 + 补位一跳"；
 *  - 尊重 prefers-reduced-motion：系统开启"减少动态效果"时回退原生滚动。
 *
 * 只拦截滚轮：滚动条拖拽、键盘、触屏、程序化恢复位置均走原生路径。
 */
export function useWheelSmoothScroll(
  elRef: RefObject<HTMLElement | null>,
  options: WheelSmoothOptions = {},
): void {
  const lerp = options.lerp ?? 0.16;
  const lineHeight = options.lineHeight ?? 33;

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return; // 减少动态效果：回退原生滚动
    }

    let target = el.scrollTop;
    let raf = 0;
    let running = false;
    let lastTime = 0;

    const clampTarget = (): void => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      target = Math.max(0, Math.min(target, max));
    };

    const step = (time: number): void => {
      const current = el.scrollTop;
      const diff = target - current;
      if (Math.abs(diff) < 0.5) {
        el.scrollTop = target;
        running = false;
        raf = 0;
        return;
      }
      const dt = lastTime ? Math.min(64, time - lastTime) : 16.7;
      lastTime = time;
      // 帧率无关的指数缓动：60/120/144Hz 下手感一致。
      const factor = 1 - Math.pow(1 - lerp, dt / 16.7);
      el.scrollTop = current + diff * factor;
      raf = requestAnimationFrame(step);
    };

    const start = (): void => {
      if (running) return;
      running = true;
      lastTime = 0;
      raf = requestAnimationFrame(step);
    };

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      // 外部把滚动位置改掉（切目录恢复位置等）后，下一轮滚轮以当前为基准
      // 重新累计，避免从陈旧目标"跳"过去。
      if (!running) target = el.scrollTop;
      const raw =
        e.deltaMode === 1
          ? e.deltaY * lineHeight
          : e.deltaMode === 2
            ? e.deltaY * el.clientHeight
            : e.deltaY;
      target += raw;
      clampTarget();
      start();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [elRef, lerp, lineHeight]);
}
