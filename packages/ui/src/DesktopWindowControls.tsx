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
    <div className="desktop-window-controls titlebar-no-drag" role="group" aria-label="窗口控制">
      <button type="button" aria-label="最小化" title="最小化" onClick={() => void bridge?.minimizeWindow?.()}>
        <Minus size={14} weight="bold" />
      </button>
      <button type="button" aria-label={maximized ? '还原' : '最大化'} title={maximized ? '还原' : '最大化'} onClick={toggleMaximize}>
        {maximized ? <span className="desktop-restore-icon" aria-hidden="true" /> : <span className="desktop-maximize-icon" aria-hidden="true" />}
      </button>
      <button type="button" className="is-close" aria-label="关闭" title="关闭" onClick={() => void bridge?.closeWindow?.()}>
        <X size={14} />
      </button>
    </div>
  );
}
