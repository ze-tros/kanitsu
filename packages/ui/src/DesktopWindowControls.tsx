import { useEffect, useState } from 'react';
import type { KanitsuDesktopBridge } from '../../fs-adapter/src/electron';

/* 窗口键字形用 Windows 系统字体 Segoe Fluent Icons（Win10 为 Segoe MDL2 Assets）——
   与系统标题栏同款的原生字形（U+E921/E922/E923/E8BB），零依赖、字重即原生标准。
   组件仅在 Electron 下渲染且产品只发 Windows 包，字体必然存在。 */
const GLYPH = { minimize: '\uE921', maximize: '\uE922', restore: '\uE923', close: '\uE8BB' } as const;

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
        <span className="dk-wc-glyph" aria-hidden="true">{GLYPH.minimize}</span>
      </button>
      <button type="button" aria-label={maximized ? '还原' : '最大化'} title={maximized ? '还原' : '最大化'} onClick={toggleMaximize}>
        <span className="dk-wc-glyph" aria-hidden="true">{maximized ? GLYPH.restore : GLYPH.maximize}</span>
      </button>
      <button type="button" className="close" aria-label="关闭" title="关闭" onClick={() => void bridge?.closeWindow?.()}>
        <span className="dk-wc-glyph" aria-hidden="true">{GLYPH.close}</span>
      </button>
    </div>
  );
}
