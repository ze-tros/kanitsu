import { useEffect, type RefObject } from 'react';
import { recordScrollWrite } from './fpsMonitor';

export interface WheelSmoothOptions {
  /** 每 16.7ms 向目标逼近的比例（0~1），越小越绵长。默认 0.16。 */
  lerp?: number;
  /** deltaMode=1（按"行"）时每行换算像素数。默认 33。 */
  lineHeight?: number;
  /**
   * 实际写入 scrollTop 的最小间隔（ms）。高刷屏（120/240Hz）上每帧写位置会让
   * 合成管线在极短的帧预算内持续提交，导致掉帧；内容帧率封顶 60Hz 与手机信息流
   * 一致。默认 16.7。
   */
  writeIntervalMs?: number;
  /**
   * 到达吸附阈值（px）：距目标小于该值就直接写目标并停止，避免指数缓动的
   * 渐近尾巴（最后几十像素以极慢速度爬行）造成“太拖沓”的手感。默认 2。
   */
  arriveEps?: number;
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
  const writeIntervalMs = options.writeIntervalMs ?? 16.7;
  const arriveEps = options.arriveEps ?? 2;

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
    let lastWrite = 0;

    const clampTarget = (): void => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      target = Math.max(0, Math.min(target, max));
    };

    const step = (time: number): void => {
      const current = el.scrollTop;
      const diff = target - current;
      // 到达吸附：距目标足够近时直接落位并停止。指数缓动是渐近收敛的，
      // 若等到 0.5px 才停，最后几十像素会以 30px/s 左右的极慢速度“爬”很久。
      if (Math.abs(diff) < arriveEps) {
        el.scrollTop = target;
        running = false;
        raf = 0;
        return;
      }
      const dt = lastTime ? Math.min(64, time - lastTime) : 16.7;
      lastTime = time;
      // 帧率无关的指数缓动：60/120/144Hz 下手感一致。
      const factor = 1 - Math.pow(1 - lerp, dt / 16.7);
      const next = current + diff * factor;
      // 内容帧率封顶 60Hz：高刷屏上值仍按每帧（vsync）逼近，但 scrollTop 写入
      // 不超过 writeIntervalMs 一次——合成提交压力从“每帧提交”降为稳定 60Hz，
      // 掉帧主因（240Hz 屏 4.17ms 预算下持续提交）随之消除。
      if (time - lastWrite >= writeIntervalMs) {
        lastWrite = time;
        el.scrollTop = next;
        recordScrollWrite();
      }
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
