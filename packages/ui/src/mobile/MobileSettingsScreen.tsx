import { useEffect, useState } from 'react';
import type { CustomOrganizeRule } from '../../../organizer/src/index';
import type { KanituAndroidBridge } from '../../../fs-adapter/src/android';
import { OrganizeRulesManager } from '../OrganizeRulesModal';
import { getRendererThumbnailStats, clearThumbnailCache, type RendererThumbnailStats } from '../thumbnailCache';
import {
  clearDebugLogs,
  getDebugLogs,
  getLogLevelPref,
  isPrefetchEnabled,
  setLogLevelPref,
  setPrefetchEnabled,
  type LogEntry,
  type LogLevel,
} from '../debugLog';
import { applyThemeMode, formatBytes, loadThemeMode, type ThemeMode } from './mobileShared';
import { Z_SETTINGS } from './zindex';

const LEVEL_LABELS: ReadonlyArray<[LogLevel, string]> = [
  ['debug', '调试'],
  ['info', '信息'],
  ['warn', '警告'],
  ['error', '仅错误'],
];

/** ui 包不直接依赖 fs-adapter/android 的全局声明，这里做类型化读取。 */
function androidBridge(): KanituAndroidBridge | undefined {
  return (window as unknown as { kanituAndroid?: KanituAndroidBridge }).kanituAndroid;
}

/**
 * 移动端设置页：全屏列表式布局。
 * 复用桌面端的规则管理器与调试/缓存逻辑，桥接改用 window.kanituAndroid。
 */
export function MobileSettingsScreen({
  rules,
  onChange,
  onBack,
}: {
  rules: CustomOrganizeRule[];
  onChange: (rules: CustomOrganizeRule[]) => void;
  onBack: () => void;
}) {
  const [theme, setTheme] = useState<ThemeMode>(() => loadThemeMode());

  useEffect(() => {
    applyThemeMode(theme);
  }, [theme]);

  return (
    <div className="fixed inset-0 bg-base-100 flex flex-col" style={{ zIndex: Z_SETTINGS }}>
      <header
        className="shrink-0 bg-base-100 border-b border-base-300/70 flex items-center gap-1 px-1"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <button className="w-11 h-11 flex items-center justify-center active:opacity-60" onClick={onBack} aria-label="返回">
          <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h1 className="text-lg font-semibold">设置</h1>
      </header>

      <main className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 flex flex-col gap-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)' }}>
        <section className="rounded-2xl border border-base-300 bg-base-200/40 p-4">
          <h2 className="text-sm font-semibold mb-3">外观</h2>
          <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-base-300/50">
            {(
              [
                ['system', '跟随系统'],
                ['light', '浅色'],
                ['dark', '深色'],
              ] as [ThemeMode, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                className={`py-2 rounded-lg text-sm transition-colors ${theme === value ? 'bg-base-100 shadow font-medium' : 'opacity-70'}`}
                onClick={() => setTheme(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-base-300 bg-base-200/40 p-4">
          <h2 className="text-sm font-semibold mb-3">整理规则</h2>
          <OrganizeRulesManager rules={rules} onChange={onChange} />
        </section>

        <MobilePerformanceSection />
        <MobileCacheSection />
        <MobileLogSection />

        <section className="rounded-2xl border border-base-300 bg-base-200/40 p-4">
          <h2 className="text-sm font-semibold mb-1">关于</h2>
          <p className="text-xs opacity-60">全能看图王 · Android 模式 v{androidBridge()?.version ?? '0.1.0'}</p>
        </section>
      </main>
    </div>
  );
}

/** 性能：后台预取开关。 */
function MobilePerformanceSection() {
  const [prefetch, setPrefetch] = useState<boolean>(() => isPrefetchEnabled());
  useEffect(() => {
    setPrefetchEnabled(prefetch);
  }, [prefetch]);

  return (
    <section className="rounded-2xl border border-base-300 bg-base-200/40 p-4">
      <h2 className="text-sm font-semibold mb-2">性能</h2>
      <label className="flex items-center justify-between gap-3 py-1">
        <span className="text-sm">
          后台预取
          <span className="block text-xs opacity-60 mt-0.5">预生成当前目录 / 子文件夹 / 全库缩略图，滚动更流畅。</span>
        </span>
        <input type="checkbox" className="toggle toggle-primary shrink-0" checked={prefetch} onChange={(e) => setPrefetch(e.target.checked)} />
      </label>
    </section>
  );
}

/** 缓存：渲染端 + Android 原生统计与清除。 */
function MobileCacheSection() {
  const [renderer, setRenderer] = useState<RendererThumbnailStats>(() => getRendererThumbnailStats());
  const [nativeStats, setNativeStats] = useState<{ diskFiles: number; diskBytes: number; inFlight: number } | null>(null);
  const [clearResult, setClearResult] = useState('');

  useEffect(() => {
    const refresh = (): void => {
      setRenderer(getRendererThumbnailStats());
      void androidBridge()
        ?.getThumbnailStats?.()
        .then((s) => setNativeStats(s))
        .catch(() => setNativeStats(null));
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, []);

  const hitRate = renderer.requests > 0 ? Math.round((renderer.cacheHits / renderer.requests) * 100) : 0;

  const handleClearRenderer = (): void => {
    const before = getRendererThumbnailStats();
    clearThumbnailCache();
    setClearResult(`内存缓存已清空（此前 ${before.entries} 条 / ${formatBytes(before.bytes)}）`);
  };

  const handleClearNative = async (): Promise<void> => {
    try {
      await androidBridge()?.clearCaches?.();
      setClearResult('磁盘缓存已清空。重新浏览时将重新生成缩略图。');
    } catch (err) {
      setClearResult(`清除失败：${String(err)}`);
    }
  };

  return (
    <section className="rounded-2xl border border-base-300 bg-base-200/40 p-4">
      <h2 className="text-sm font-semibold mb-3">缓存</h2>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-base-100 p-2.5">
          <div className="text-lg font-semibold tabular-nums">{renderer.entries}</div>
          <div className="text-[11px] opacity-60">内存条目</div>
        </div>
        <div className="rounded-xl bg-base-100 p-2.5">
          <div className="text-lg font-semibold tabular-nums">{formatBytes(renderer.bytes)}</div>
          <div className="text-[11px] opacity-600">内存占用</div>
        </div>
        <div className="rounded-xl bg-base-100 p-2.5">
          <div className="text-lg font-semibold tabular-nums">{hitRate}%</div>
          <div className="text-[11px] opacity-60">命中率</div>
        </div>
        {nativeStats && (
          <>
            <div className="rounded-xl bg-base-100 p-2.5">
              <div className="text-lg font-semibold tabular-nums">{nativeStats.diskFiles}</div>
              <div className="text-[11px] opacity-60">磁盘文件</div>
            </div>
            <div className="rounded-xl bg-base-100 p-2.5">
              <div className="text-lg font-semibold tabular-nums">{formatBytes(nativeStats.diskBytes)}</div>
              <div className="text-[11px] opacity-60">磁盘占用</div>
            </div>
            <div className="rounded-xl bg-base-100 p-2.5">
              <div className="text-lg font-semibold tabular-nums">{nativeStats.inFlight}</div>
              <div className="text-[11px] opacity-60">解码中</div>
            </div>
          </>
        )}
      </div>
      <div className="flex gap-2 mt-3">
        <button className="flex-1 py-2 rounded-xl bg-base-300/70 text-sm active:bg-base-300" onClick={handleClearRenderer}>
          清除内存缓存
        </button>
        <button className="flex-1 py-2 rounded-xl bg-base-300/70 text-sm active:bg-base-300" onClick={() => void handleClearNative()}>
          清除磁盘缓存
        </button>
      </div>
      {clearResult && <p className="text-xs opacity-70 mt-2 leading-relaxed">{clearResult}</p>}
    </section>
  );
}

/** 调试：日志等级 + 渲染端 / 原生日志。 */
function MobileLogSection() {
  const [level, setLevel] = useState<LogLevel>(() => getLogLevelPref());
  const [logs, setLogs] = useState<readonly LogEntry[]>(() => getDebugLogs());
  const [nativeLogs, setNativeLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  useEffect(() => {
    setLogLevelPref(level);
    void androidBridge()?.setLogLevel?.(level);
  }, [level]);

  useEffect(() => {
    if (!showLogs) return;
    const refresh = (): void => setLogs(getDebugLogs());
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [showLogs]);

  const refreshNativeLogs = async (): Promise<void> => {
    const lines = (await androidBridge()?.readLogs?.(200)) ?? [];
    setNativeLogs(lines);
    setShowLogs(true);
  };

  const fmtTime = (t: number): string => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });

  return (
    <section className="rounded-2xl border border-base-300 bg-base-200/40 p-4">
      <h2 className="text-sm font-semibold mb-2">调试</h2>
      <label className="flex items-center justify-between gap-3 py-1">
        <span className="text-sm">日志等级</span>
        <select className="select select-sm select-bordered rounded-lg" value={level} onChange={(e) => setLevel(e.target.value as LogLevel)}>
          {LEVEL_LABELS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2 mt-2">
        <button className="flex-1 py-2 rounded-xl bg-base-300/70 text-sm active:bg-base-300" onClick={() => setShowLogs((v) => !v)}>
          {showLogs ? '收起日志' : '查看日志'}
        </button>
        <button className="flex-1 py-2 rounded-xl bg-base-300/70 text-sm active:bg-base-300" onClick={() => void refreshNativeLogs()}>
          读取原生日志
        </button>
        <button
          className="py-2 px-3 rounded-xl bg-base-300/70 text-sm active:bg-base-300"
          onClick={() => {
            clearDebugLogs();
            setLogs([]);
          }}
        >
          清空
        </button>
      </div>
      {showLogs && (
        <div className="mt-3 max-h-64 overflow-y-auto rounded-xl bg-base-100 p-2">
          {nativeLogs.length > 0 && (
            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all leading-4 mb-2 opacity-80">{nativeLogs.join('\n')}</pre>
          )}
          {logs.length === 0 && nativeLogs.length === 0 ? (
            <div className="text-xs opacity-60 py-2">暂无日志。</div>
          ) : (
            logs
              .slice(-80)
              .map((entry, i) => (
                <div key={i} className="text-[11px] font-mono leading-4 break-all">
                  <span className="opacity-50">{fmtTime(entry.time)} </span>
                  <span className={entry.level === 'error' ? 'text-error' : entry.level === 'warn' ? 'text-warning' : 'opacity-70'}>[{entry.tag}]</span>{' '}
                  {entry.message}
                </div>
              ))
          )}
        </div>
      )}
    </section>
  );
}
