import { useEffect, useMemo, useState } from 'react';
import {
  AndroidImportSourcePicker,
  AndroidLibraryStore,
  ElectronImportSourcePicker,
  ElectronLibraryStore,
  MemoryImportSourcePicker,
  MemoryLibraryStore,
  initAndroidBridge,
} from '../../../packages/fs-adapter/src/index';
import {
  createIdbPersistentIndex,
  createMemoryPersistentIndex,
} from '../../../packages/core/src/index';
import { LibraryBrowser } from '../../../packages/ui/src/index';
import { MobileApp } from '../../../packages/ui/src/mobile/MobileApp';

type Platform = 'android' | 'electron' | 'web';

/**
 * 平台检测（同步）。注意不能只看 window.kanituAndroid：该桥是首次调用时才异步注册的，
 * 启动时必然为 undefined。Capacitor 的 native bridge 在 WebView 加载早期就会注入
 * window.androidBridge（Android 专有，Capacitor 源码也以此判别平台），用它最可靠。
 */
function detectPlatform(): Platform {
  if (window.kanituDesktop?.platform === 'electron') return 'electron';
  const w = window as { androidBridge?: unknown; Capacitor?: { getPlatform?: () => string } };
  if (window.kanituAndroid?.platform === 'android') return 'android';
  try {
    if (w.Capacitor?.getPlatform?.() === 'android') return 'android';
  } catch {
    // ignore
  }
  if (typeof w.androidBridge !== 'undefined') return 'android';
  return 'web';
}

export default function App() {
  const platform = useMemo(detectPlatform, []);
  const [androidReady, setAndroidReady] = useState(platform !== 'android');

  // Android：启动即注册桥（window.kanituAndroid），完成后才进入 UI，
  // 避免 UI/适配器读取桥时出现竞态。
  useEffect(() => {
    if (platform !== 'android') return;
    let cancelled = false;
    void initAndroidBridge()
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) setAndroidReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  const adapters = useMemo(() => {
    if (platform === 'android') {
      return {
        picker: new AndroidImportSourcePicker(),
        store: new AndroidLibraryStore(),
      };
    }
    if (platform === 'electron') {
      return {
        picker: new ElectronImportSourcePicker(),
        store: new ElectronLibraryStore(),
      };
    }
    return {
      picker: MemoryImportSourcePicker.fromDemo(),
      store: new MemoryLibraryStore(),
    };
  }, [platform]);

  const [index] = useState(() =>
    platform === 'android' || platform === 'electron'
      ? createIdbPersistentIndex()
      : createMemoryPersistentIndex(),
  );

  if (platform === 'android') {
    if (!androidReady) {
      return (
        <div className="h-screen w-full flex flex-col items-center justify-center gap-3 bg-base-100 text-base-content">
          <span className="w-12 h-12 rounded-2xl bg-gradient-to-br from-sky-500 to-violet-500 flex items-center justify-center text-white text-2xl">图</span>
          <span className="loading loading-spinner loading-md text-primary" aria-label="启动中" />
        </div>
      );
    }
    return <MobileApp picker={adapters.picker} store={adapters.store} index={index} />;
  }

  return <LibraryBrowser picker={adapters.picker} store={adapters.store} index={index} />;
}
