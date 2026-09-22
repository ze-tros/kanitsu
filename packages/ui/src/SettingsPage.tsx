import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ArrowLeft, Bug, Database, MagicWand, MagnifyingGlass, Palette } from '@phosphor-icons/react';
import type { CustomOrganizeRule } from '../../organizer/src/index';
import type { ThumbnailDebugStats, ClearCacheResult, DesktopRawViewMode } from '../../fs-adapter/src/electron';
import { OrganizeRulesManager } from './OrganizeRulesModal';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import {
  chooseLibraryLocation,
  describeLocationChange,
  fetchLibraryLocation,
  resetLibraryLocation,
  supportsLibraryLocation,
  type LibraryLocationInfo,
} from './libraryLocation';
import {
  ACCENT_OPTIONS,
  DEFAULT_ACCENT,
  isAccentMode,
  type AccentMode,
} from './accents';
import {
  filterSettingsTabs,
  hasSettingsTabMatches,
  SETTINGS_TABS,
  type SettingsTabId,
} from './settingsTabs';
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

export type ThemeOption = 'light' | 'dark' | 'system';
export type AccentOption = AccentMode;

/** 标签页图标只属于视图层，留在组件里，纯数据模块保持无 React 依赖。 */
const TAB_ICONS: Record<SettingsTabId, typeof Palette> = {
  general: Palette,
  organize: MagicWand,
  debug: Bug,
  cache: Database,
};

function handleRadioNavigation<T extends string>(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  options: readonly T[],
  current: T,
  onChange: (value: T) => void,
): void {
  const currentIndex = Math.max(0, options.indexOf(current));
  let nextIndex: number | null = null;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextIndex = (currentIndex + 1) % options.length;
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (currentIndex - 1 + options.length) % options.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = options.length - 1;
  }
  if (nextIndex == null) return;

  event.preventDefault();
  const next = options[nextIndex];
  if (!next) return;
  onChange(next);
  const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  radios?.[nextIndex]?.focus();
}

type SettingsPageProps = {
  rules: CustomOrganizeRule[];
  onChange: (rules: CustomOrganizeRule[]) => void;
  onBack: () => void;
  runtimeLabel?: string;
  libraryBytes: number;
  libraryFileCount: number;
  sidebarWidth: number;
  onSidebarWidthChange: (width: number) => void;
  sidebarHidden?: boolean;
  theme: ThemeOption;
  accent: AccentOption;
  onThemeChange: (theme: ThemeOption) => void;
  onAccentChange: (accent: AccentOption) => void;
  /** RAW 查看模式(仅 Electron 有可切换项;Web/Android 平台固定不渲染)。 */
  rawViewMode: DesktopRawViewMode;
  onRawViewModeChange: (mode: DesktopRawViewMode) => void;
  /** 图包保存位置变更后回调：调用方需重扫图库（仅桌面端会触发）。 */
  onLibraryLocationChange?: () => void;
};

export function SettingsPage({
  rules,
  onChange,
  onBack,
  runtimeLabel,
  libraryBytes,
  libraryFileCount,
  sidebarWidth,
  onSidebarWidthChange,
  sidebarHidden = false,
  theme,
  accent,
  onThemeChange,
  onAccentChange,
  rawViewMode,
  onRawViewModeChange,
  onLibraryLocationChange,
}: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>('general');
  const [searchQuery, setSearchQuery] = useState('');
  const pageTitle = SETTINGS_TABS.find((tab) => tab.id === activeTab)?.title ?? '';
  // 当前标签页始终保留在导航里（见 filterSettingsTabs），避免正文与导航割裂。
  const navTabs = filterSettingsTabs(searchQuery, activeTab);
  const hasMatches = hasSettingsTabMatches(searchQuery);

  return (
    <div className={`desktop-settings-page titlebar-no-drag${sidebarHidden ? ' is-sidebar-hidden' : ''}`}>
      <div
        className="desktop-settings-body"
        style={{ '--desktop-settings-sidebar-width': `${Math.min(sidebarWidth, 360)}px` } as CSSProperties}
      >
        <aside className="desktop-settings-sidebar">
          <SidebarResizeHandle width={sidebarWidth} onResize={onSidebarWidthChange} max={360} />
          <button type="button" className="desktop-settings-back" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" />
            <span>返回图库</span>
          </button>
          <label className="desktop-settings-search">
            <MagnifyingGlass size={15} aria-hidden="true" />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="搜索设置…"
              aria-label="搜索设置"
            />
          </label>
          <div className="desktop-panel-label">设置项</div>
          <nav className="desktop-settings-nav" aria-label="设置项">
            {navTabs.map((tab) => {
              const Icon = TAB_ICONS[tab.id];
              const isActive = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={isActive ? 'is-active' : ''}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon size={17} /><span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
          {/* 空状态常驻挂载、用 role="status" 播报，避免只靠视觉提示。
              注意它仍在 .desktop-settings-sidebar 内，≤680px 该容器会变成横向标签条，
              此时提示文字位于标签条末尾（窄屏可能要横向滚动才看得到），屏幕阅读器不受影响。 */}
          <p className="desktop-settings-empty" role="status">
            {hasMatches ? '' : '没有匹配的设置项'}
          </p>
        </aside>

        <main className="desktop-settings-main">
          <div className="desktop-settings-content">
            <h1 className="desktop-settings-page-title">{pageTitle}</h1>
            {activeTab === 'general' && (
              <>
                <section className="desktop-settings-section">
                  <header className="desktop-settings-section-heading"><h2>外观</h2></header>
                  <div className="desktop-settings-row">
                    <div><strong>界面模式</strong><span>浅色、深色或跟随系统</span></div>
                    <div className="desktop-settings-mode-control" role="radiogroup" aria-label="界面模式">
                      {([['dark', '深色'], ['light', '浅色'], ['system', '跟随系统']] as const).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={theme === value}
                          tabIndex={theme === value ? 0 : -1}
                          className={theme === value ? 'is-active' : ''}
                          onClick={() => onThemeChange(value)}
                          onKeyDown={(event) => handleRadioNavigation(
                            event,
                            ['dark', 'light', 'system'],
                            theme,
                            onThemeChange,
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="desktop-settings-row">
                    <div><strong>主题色</strong><span>选中状态与关键操作</span></div>
                  </div>
                  <div className="desktop-settings-accent-grid" role="radiogroup" aria-label="主题色">
                    {ACCENT_OPTIONS.map((option) => {
                      const selected = accent === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          tabIndex={selected ? 0 : -1}
                          className={`desktop-settings-accent-option ${selected ? 'is-active' : ''}`}
                          onClick={() => onAccentChange(option.value)}
                          onKeyDown={(event) => handleRadioNavigation(
                            event,
                            ACCENT_OPTIONS.map((item) => item.value),
                            accent,
                            onAccentChange,
                          )}
                        >
                          <span className={`desktop-settings-swatch is-${option.value}`} aria-hidden="true" />
                          <span>{option.label}</span>
                          <span className="is-check" aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* RAW 查看模式:仅 Electron 桥存在时可切换(Web/Android 平台固定)。 */}
                {typeof window !== 'undefined' && window.kanitsuDesktop && (
                  <section className="desktop-settings-section">
                    <header className="desktop-settings-section-heading"><h2>RAW 显示</h2></header>
                    <div className="desktop-settings-row">
                      <div>
                        <strong>RAW 观感</strong>
                        <span>相机内嵌预览或完整解码渲染</span>
                      </div>
                      <div className="desktop-settings-mode-control" role="radiogroup" aria-label="RAW 观感">
                        {([['developed', '完整解码'], ['camera', '相机直出']] as const).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={rawViewMode === value}
                            tabIndex={rawViewMode === value ? 0 : -1}
                            className={rawViewMode === value ? 'is-active' : ''}
                            onClick={() => onRawViewModeChange(value)}
                            onKeyDown={(event) => handleRadioNavigation(
                              event,
                              ['developed', 'camera'],
                              rawViewMode,
                              onRawViewModeChange,
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </section>
                )}

                <section className="desktop-settings-section">
                  <header className="desktop-settings-section-heading"><h2>应用</h2></header>
                  <LibraryLocationRow onApplied={onLibraryLocationChange} />
                  <div className="desktop-settings-row"><div><strong>运行环境</strong></div><strong>{runtimeLabel ?? '—'}</strong></div>
                  <div className="desktop-settings-row"><div><strong>图库占用</strong><span>已索引的本地文件总量</span></div><strong>{fmtBytes(libraryBytes)} · {libraryFileCount.toLocaleString('zh-CN')} 个文件</strong></div>
                  <div className="desktop-settings-row"><div><strong>自定义整理规则</strong></div><strong>{rules.length} 条</strong></div>
                </section>
              </>
            )}
            {/* 整理规则面板自带三张卡片（内置规则 / 自定义规则 / 编辑器），
                所以这里不再套 .desktop-settings-section，避免卡片套卡片。 */}
            {activeTab === 'organize' && (
              <OrganizeRulesManager rules={rules} onChange={onChange} />
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

/**
 * 图包保存位置（仅桌面端）：展示当前路径，并提供切换/恢复默认。
 * 路径选择与「是否搬移现有图包」的询问都在主进程完成（含目录安全校验），
 * 这里只负责展示与重扫。
 */
function LibraryLocationRow({ onApplied }: { onApplied?: () => void }) {
  const supported = supportsLibraryLocation();
  const [info, setInfo] = useState<LibraryLocationInfo | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void fetchLibraryLocation().then((next) => {
      if (!cancelled) setInfo(next);
    });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  // Web 演示 / Android 的位置由平台固定，没有可切换的项，整行不渲染。
  if (!supported) return null;

  const apply = async (action: 'choose' | 'reset'): Promise<void> => {
    setBusy(true);
    const result = action === 'choose' ? await chooseLibraryLocation() : await resetLibraryLocation();
    setBusy(false);
    setStatus(describeLocationChange(result));
    if (result && !result.canceled && !result.error) {
      setInfo(await fetchLibraryLocation());
      onApplied?.();
    }
  };

  return (
    <div className="desktop-settings-row">
      <div>
        <strong>图包保存位置</strong>
        <span>导入的图片会复制一份到这里；整理、重命名、删除只作用于这份副本，原始文件夹不受影响。缩略图缓存也在该目录的 .kanitsu-cache 下。</span>
      </div>
      <div className="desktop-settings-location">
        <div className="desktop-settings-location-main">
          <code className="desktop-settings-path">{info?.path ?? '读取中…'}</code>
          <button type="button" className="desktop-settings-action" disabled={busy} onClick={() => void apply('choose')}>
            更改
          </button>
          {info && !info.isDefault && (
            <button
              type="button"
              className="desktop-settings-action is-quiet"
              disabled={busy}
              onClick={() => void apply('reset')}
            >
              恢复默认
            </button>
          )}
        </div>
        {status && <span className="desktop-settings-hint" role="status">{status}</span>}
      </div>
    </div>
  );
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
    void window.kanitsuDesktop?.setLogLevel?.(level);
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
    const lines = (await window.kanitsuDesktop?.readLogs?.(300)) ?? [];
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
                  空闲时生成全库缩略图，并预取下一屏与少量子图包；滚动期间自动暂停后台任务。
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
        <p className="text-xs opacity-60 mb-2">位于 userData/logs/kanitsu-日期.log；乱码时以此为准（控制台可能受系统代码页影响）。</p>
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
      void window.kanitsuDesktop
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
    const result: ClearCacheResult | null = await window.kanitsuDesktop?.clearCaches?.() ?? null;
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
