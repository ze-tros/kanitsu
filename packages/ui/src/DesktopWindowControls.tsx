import { useEffect, useState } from 'react';
import { Minus, X } from '@phosphor-icons/react';
import type { KanitsuDesktopBridge } from '../../fs-adapter/src/electron';

export function DesktopWindowControls() {
  const bridge = (window as { kanitsuDesktop?: KanitsuDesktopBridge }).kanitsuDesktop;
  const isElectron = bridge?.platform === 'electron';
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isElectron) return;
    let alive = true;
    void bridge?.isWindowMaximized?.().then((value) => {
      if (alive) setMaximized(value);
    });
    const off = bridge?.onWindowMaximizedChanged?.((value) => setMaximized(value));
    return () => {
      alive = false;
      off?.();
    };
  }, [bridge, isElectron]);

  if (!isElectron) return null;

  const toggleMaximize = (): void => {
    void bridge?.maximizeWindowToggle?.().then((value) => setMaximized(value));
  };

  return (
    <div className="dk-wc titlebar-no-drag" role="group" aria-label="窗口控制">
      <button type="button" aria-label="最小化" title="最小化" onClick={() => void bridge?.minimizeWindow?.()}>
        <Minus size={14} weight="bold" />
      </button>
      <button type="button" aria-label={maximized ? '还原' : '最大化'} title={maximized ? '还原' : '最大化'} onClick={toggleMaximize}>
        {/* 线框图标用 SVG 画，不靠背景色遮挡，在标题栏和查看器的半透明顶栏上都一致。 */}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
          {maximized ? (
            <>
              <rect x="0.5" y="2.5" width="7" height="7" />
              <path d="M2.5 2.5V0.5h7v7h-2" />
            </>
          ) : (
            <rect x="0.5" y="0.5" width="9" height="9" />
          )}
        </svg>
      </button>
      <button type="button" className="close" aria-label="关闭" title="关闭" onClick={() => void bridge?.closeWindow?.()}>
        <X size={14} />
      </button>
    </div>
  );
}
