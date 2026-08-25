import { useEffect, useState } from 'react';
import type { CustomOrganizeRule } from '../../organizer/src/index';
import type { ThumbnailDebugStats, ClearCacheResult } from '../../fs-adapter/src/electron';
import { ArrowLeftIcon, NavButton } from './NavButton';
import { OrganizeRulesManager } from './OrganizeRulesModal';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { getRendererThumbnailStats, clearThumbnailCache, type RendererThumbnailStats } from './thumbnailCache';
import { startFpsMonitor, stopFpsMonitor, resetFpsMonitor, type FpsStats } from './fpsMonitor';
import {
  clearDebugLogs,
  getDebugLogs,
  getLogLevelPref,
  isPrefetchEnabled,
  setLogLevelPref,
  setPrefetchEnabled,
  type LogEntry,
  type LogLevel,
} from './debugLog';

export function SettingsPage({
  rules,
  onChange,
  onBack,
  runtimeLabel,
  sidebarWidth,
  onSidebarWidthChange,
}: {
  rules: CustomOrganizeRule[];
  onChange: (rules: CustomOrganizeRule[]) => void;
  onBack: () => void;
  runtimeLabel?: string;
  sidebarWidth: number;
  onSidebarWidthChange: (width: number) => void;
}) {
  const [activeTab, setActiveTab] = useState<'general' | 'organize' | 'debug' | 'cache'>('general');

  return (
    <div className="fixed inset-0 z-[120] bg-base-100 flex flex-col titlebar-no-drag">
      <header className="navbar bg-base-200 border-b border-base-300 px-4 shrink-0 min-h-12 titlebar-drag">
        <h1 className="text-lg font-semibold titlebar-no-drag">设置</h1>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside
          className="relative shrink-0 border-r border-base-300 bg-base-200 p-3 flex flex-col gap-1"
          style={{ width: sidebarWidth }}
        >
          <SidebarResizeHandle width={sidebarWidth} onResize={onSidebarWidthChange} />
          <NavButton onClick={onBack} className="w-full" title="返回图库">
            <ArrowLeftIcon />
            <span>返回</span>
          </NavButton>
          <div className="menu-title text-xs opacity-60 px-1 mt-2">设置项</div>
          <NavButton onClick={() => setActiveTab('general')} active={activeTab === 'general'} className="w-full">
            <span>通用</span>
          </NavButton>
          <NavButton onClick={() => setActiveTab('organize')} active={activeTab === 'organize'} className="w-full">
            <span>整理规则</span>
          </NavButton>
          <NavButton onClick={() => setActiveTab('debug')} active={activeTab === 'debug'} className="w-full">
            <span>调试</span>
          </NavButton>
          <NavButton onClick={() => setActiveTab('cache')} active={activeTab === 'cache'} className="w-full">
            <span>缓存</span>
          </NavButton>
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto p-5 lg:p-8">
          <div className="max-w-4xl">
            {activeTab === 'general' && (
              <section className="rounded-box border border-base-300 bg-base-200/50 p-5">
                <h2 className="text-base font-semibold">通用设置</h2>
                <div className="mt-3 flex flex-col gap-2 text-sm opacity-80">
                  <div>运行模式：{runtimeLabel ?? '—'}</div>
                  <div>主题切换：使用图库右上角按钮。</div>
                  <div>自定义整理规则：请在左侧选择“整理规则”。</div>
                </div>
              </section>
            )}
            {activeTab === 'organize' && (
              <section className="rounded-box border border-base-300 bg-base-200/50 p-5">
                <OrganizeRulesManager rules={rules} onChange={onChange} />
              </section>
            )}
            {activeTab === 'debug' && <DebugPanel />}
            {activeTab === 'cache' && <CachePanel />}
          </div>
        </main>
      </div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

const LEVEL_LABELS: ReadonlyArray<[LogLevel, string]> = [
  ['debug', '调试（最详细）'],
  ['info', '信息'],
  ['warn', '警告'],
  ['error', '仅错误'],
];

/** 调试面板：选项（日志等级 / 预取开关）+ 主进程日志 + 渲染端日志。 */
function DebugPanel() {
  const [level, setLevel] = useState<LogLevel>(() => getLogLevelPref());
  const [prefetch, setPrefetch] = useState<boolean>(() => isPrefetchEnabled());
  const [logs, setLogs] = useState<readonly LogEntry[]>(() => getDebugLogs());
  const [mainLogs, setMainLogs] = useState<string[]>([]);
  const [fps, setFps] = useState<FpsStats | null>(null);

  // 调试面板打开期间运行帧率监测（关闭自动停止，避免常驻开销）。
  useEffect(() => {
    startFpsMonitor(setFps);
    return () => stopFpsMonitor();
  }, []);

  useEffect(() => {
    setLogLevelPref(level);
    void window.kanituDesktop?.setLogLevel?.(level);
  }, [level]);

  useEffect(() => {
    setPrefetchEnabled(prefetch);
  }, [prefetch]);

  useEffect(() => {
    const refresh = (): void => setLogs(getDebugLogs());
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, []);

  const copyLogs = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(getDebugLogs(), null, 2));
    } catch {
      // 忽略剪切板失败
    }
  };

  const refreshMainLogs = async (): Promise<void> => {
    const lines = (await window.kanituDesktop?.readLogs?.(300)) ?? [];
    setMainLogs(lines);
  };

  const fmtTime = (t: number): string => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-box border border-base-300 bg-base-200/50 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">帧率与滚动性能</h3>
          <button className="btn btn-ghost btn-xs shrink-0" onClick={resetFpsMonitor}>重置</button>
        </div>
        <p className="text-xs opacity-60 mb-2">
          rAF 帧间隔统计（最近 1s）：掉帧 &gt;33.3ms、卡顿帧 &gt;50ms。滚动回调耗时为 JS
          调度侧开销（窗口计算/状态更新）；渲染/绘画细账以 DevTools Performance 为准。
        </p>
        {fps && fps.totalFrames > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
            <div className="stat"><span className="stat-title">当前帧率</span><span className="stat-value text-lg text-primary">{fps.fps.toFixed(0)} fps</span></div>
            <div className="stat"><span className="stat-title">平均帧间隔</span><span className="stat-value text-lg">{fps.avgFrameMs.toFixed(1)} ms</span></div>
            <div className="stat"><span className="stat-title">p95 帧间隔</span><span className="stat-value text-lg">{fps.p95FrameMs.toFixed(1)} ms</span></div>
            <div className="stat"><span className="stat-title">最大帧间隔</span><span className="stat-value text-lg">{fps.maxFrameMs.toFixed(0)} ms</span></div>
            <div className="stat"><span className="stat-title">掉帧(1s)</span><span className={`stat-value text-lg ${fps.dropped > 0 ? 'text-error' : ''}`}>{fps.dropped}</span></div>
            <div className="stat"><span className="stat-title">卡顿帧(1s)</span><span className={`stat-value text-lg ${fps.jankFrames > 0 ? 'text-error' : ''}`}>{fps.jankFrames}</span></div>
            <div className="stat"><span className="stat-title">累计掉帧</span><span className="stat-value text-lg">{fps.totalDropped}</span></div>
            <div className="stat"><span className="stat-title">滚动回调</span><span className="stat-value text-lg">{fps.scrollSamples > 0 ? `${fps.scrollAvgMs.toFixed(1)} ms` : '—'}</span></div>
            <div className="stat"><span className="stat-title">滚动写入/秒</span><span className="stat-value text-lg">{fps.scrollWrites}</span></div>
            {fps.scrollSamples > 0 && (
              <>
                <div className="stat"><span className="stat-title">滚动回调 p95</span><span className="stat-value text-lg">{fps.scrollP95Ms.toFixed(1)} ms</span></div>
                <div className="stat"><span className="stat-title">滚动回调峰值</span><span className="stat-value text-lg">{fps.scrollMaxMs.toFixed(1)} ms</span></div>
                <div className="stat"><span className="stat-title">样本</span><span className="stat-value text-lg">{fps.scrollSamples}</span></div>
              </>
            )}
          </div>
        ) : (
          <div className="text-sm opacity-60">采集第一帧中…（滚动几下后查看）</div>
        )}
      </section>

      <section className="rounded-box border border-base-300 bg-base-200/50 p-5">
        <h2 className="text-base font-semibold mb-3">调试选项</h2>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span>
              日志等级
              <span className="block text-xs opacity-60">控制台与主进程日志的详细程度（含缩略图命中/未命中/队列状态）。</span>
            </span>
            <select
              className="select select-sm select-bordered shrink-0"
              value={level}
              onChange={(e) => setLevel(e.target.value as LogLevel)}
            >
              {LEVEL_LABELS.map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>
              后台预取
              <span className="block text-xs opacity-60">
                当前目录 / 子文件夹 / 全库缩略图预取（低优先级）。关闭可对照排查“滚动时加载”行为。
              </span>
            </span>
            <input
              type="checkbox"
              className="toggle toggle-sm shrink-0"
              checked={prefetch}
              onChange={(e) => setPrefetch(e.target.checked)}
            />
          </label>
        </div>
      </section>

      <section className="rounded-box border border-base-300 bg-base-200/50 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">主进程日志（UTF-8 文件，含时间/等级）</h3>
          <button className="btn btn-ghost btn-xs shrink-0" onClick={() => void refreshMainLogs()}>
            读取
          </button>
        </div>
        <p className="text-xs opacity-60 mb-2">位于 userData/logs/kanitu-日期.log；乱码时以此为准（控制台可能受系统代码页影响）。</p>
        <div className="max-h-48 overflow-y-auto">
          {mainLogs.length === 0 ? (
            <div className="text-sm opacity-60 py-2">暂无主进程日志。</div>
          ) : (
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-all leading-4">{mainLogs.join('\n')}</pre>
          )}
        </div>
      </section>

      <section className="rounded-box border border-base-300 bg-base-200/50 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">最近日志（渲染端，{logs.length}）</h3>
          <div className="flex gap-2 shrink-0">
            <button className="btn btn-ghost btn-xs" onClick={() => void copyLogs()}>复制</button>
            <button className="btn btn-ghost btn-xs" onClick={() => clearDebugLogs()}>
              清空
            </button>
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto">
          {logs.length === 0 ? (
            <div className="text-sm opacity-60 py-2">暂无日志；切换文件夹/打开大目录后会有目录切换与预取事件。</div>
          ) : (
            <table className="table table-sm">
              <tbody>
                {[...logs].slice(-100).map((entry, i) => (
                  <tr key={i} className="align-top">
                    <td className="text-[10px] opacity-50 whitespace-nowrap font-mono">{fmtTime(entry.time)}</td>
                    <td className="text-[10px] font-mono">
                      <span className={`badge badge-sm ${entry.level === 'error' ? 'badge-error' : entry.level === 'warn' ? 'badge-warning' : 'badge-ghost'}`}>
                        {entry.tag}
                      </span>
                    </td>
                    <td className="text-xs whitespace-pre-wrap break-all">{entry.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

/** 缓存面板：缓存统计（渲染端/主进程/磁盘）+ 清除缓存。 */
function CachePanel() {
  const [renderer, setRenderer] = useState<RendererThumbnailStats>(() => getRendererThumbnailStats());
  const [mainStats, setMainStats] = useState<ThumbnailDebugStats | null>(null);
  const [clearResult, setClearResult] = useState('');

  useEffect(() => {
    const refresh = (): void => {
      setRenderer(getRendererThumbnailStats());
      void window.kanituDesktop
        ?.getThumbnailDebugStats?.()
        .then((stats) => setMainStats(stats))
        .catch(() => setMainStats(null));
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleClearRendererCache = (): void => {
    const before = getRendererThumbnailStats();
    clearThumbnailCache();
    setClearResult(
      `渲染端内存缓存已清空（此前 ${before.entries} 条 / ${fmtBytes(before.bytes)}）；` +
        '重新浏览时将重新生成（磁盘缓存仍在则直接读盘）。',
    );
  };

  const handleClearMainCache = async (): Promise<void> => {
    const result: ClearCacheResult | null = await window.kanituDesktop?.clearCaches?.() ?? null;
    if (!result) {
      setClearResult('Web/演示模式无主进程缓存可清。');
      return;
    }
    setClearResult(
      `主进程缓存已清空：内存 ${result.memoryEntries} 条 / ${fmtBytes(result.memoryBytes)}；磁盘 ${result.diskFiles} 个文件 / ${fmtBytes(result.diskBytes)}。`,
    );
  };

  const hitRate =
    renderer.requests > 0 ? Math.round((renderer.cacheHits / renderer.requests) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-box border border-base-300 bg-base-200/50 p-5">
        <h3 className="text-sm font-semibold mb-3">渲染端缩略图缓存</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
          <div className="stat"><span className="stat-title">条目</span><span className="stat-value text-lg">{renderer.entries}</span></div>
          <div className="stat"><span className="stat-title">占用</span><span className="stat-value text-lg">{fmtBytes(renderer.bytes)}</span></div>
          <div className="stat"><span className="stat-title">容量上限</span><span className="stat-value text-lg">{fmtBytes(renderer.maxBytes)}</span></div>
          <div className="stat"><span className="stat-title">请求 / 命中</span><span className="stat-value text-lg">{renderer.requests} / {renderer.cacheHits}</span></div>
          <div className="stat"><span className="stat-title">命中率</span><span className="stat-value text-lg">{hitRate}%</span></div>
          <div className="stat"><span className="stat-title">未命中</span><span className="stat-value text-lg">{renderer.cacheMisses}</span></div>
          <div className="stat"><span className="stat-title">预取已排</span><span className="stat-value text-lg">{renderer.prefetchScheduled}</span></div>
          <div className="stat"><span className="stat-title">预取完成</span><span className="stat-value text-lg">{renderer.prefetchCompleted}</span></div>
          <div className="stat"><span className="stat-title">预取失败</span><span className="stat-value text-lg">{renderer.prefetchFailed}</span></div>
        </div>
      </section>

      <section className="rounded-box border border-base-300 bg-base-200/50 p-5">
        <h3 className="text-sm font-semibold mb-3">主进程缩略图表（Electron）</h3>
        {mainStats ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
            <div className="stat"><span className="stat-title">队列积压(按优先级)</span><span className="stat-value text-lg">{mainStats.queuedByPriority.join(' / ')}</span></div>
            <div className="stat"><span className="stat-title">解码中</span><span className="stat-value text-lg">{mainStats.inFlight}</span></div>
            <div className="stat"><span className="stat-title">worker 数</span><span className="stat-value text-lg">{mainStats.workers}</span></div>
            <div className="stat"><span className="stat-title">主进程缓存条目</span><span className="stat-value text-lg">{mainStats.thumbCacheEntries}</span></div>
            <div className="stat"><span className="stat-title">主进程缓存</span><span className="stat-value text-lg">{fmtBytes(mainStats.thumbCacheBytes)}</span></div>
            <div className="stat"><span className="stat-title">磁盘缓存文件</span><span className="stat-value text-lg">{mainStats.diskFiles}</span></div>
          </div>
        ) : (
          <div className="text-sm opacity-60">Web/演示模式无主进程数据；Electron 模式请确认应用已重启加载最新构建。</div>
        )}
      </section>

      <section className="rounded-box border border-base-300 bg-base-200/50 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">清除缓存（测试用）</h3>
          <div className="flex gap-2 shrink-0">
            <button className="btn btn-ghost btn-xs" onClick={handleClearRendererCache}>清除渲染端</button>
            <button className="btn btn-ghost btn-xs" onClick={() => void handleClearMainCache()}>清除主进程（内存+磁盘）</button>
          </div>
        </div>
        {clearResult && <p className="text-xs opacity-70 break-all">{clearResult}</p>}
      </section>
    </div>
  );
}