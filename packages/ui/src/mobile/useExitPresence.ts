import { useEffect, useState } from 'react';

/**
 * 条件渲染组件的退场动画：open 变 false 后组件多保留 exitMs 毫秒
 * （期间 exiting 为 true，用于挂滑出/淡出动画类），计时结束才真正卸载。
 */
export function useExitPresence(open: boolean, exitMs: number) {
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const t = window.setTimeout(() => setPresent(false), exitMs);
    return () => window.clearTimeout(t);
  }, [open, present, exitMs]);
  return { present, exiting: present && !open };
}
