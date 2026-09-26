import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  CheckCircle,
  Database,
  Gauge,
  HardDrives,
  Image as ImageIcon,
  Info,
  Keyboard,
  MagicWand,
  MagnifyingGlass,
  Palette,
} from '@phosphor-icons/react';
import type { CustomOrganizeRule } from '../../organizer/src/index';
import type { ThumbnailDebugStats, ClearCacheResult, DesktopRawViewMode } from '../../fs-adapter/src/electron';
import { formatLogTime } from '../../core/src/index';
import { handleRadioNavigation, Segmented, Switch } from './desktop/controls';
import { RulesPanel } from './desktop/RulesPanel';
import { formatBytes, formatCount } from './desktop/shared';
import {
  fetchDataDir,
  supportsDataDir,
} from './dataDir';
import {
  ACCENT_OPTIONS,
  type AccentMode,
} from './accents';
import {
  filterSettingsTabs,
  hasSettingsTabMatches,
  settingsTabMatches,
  SETTINGS_TABS,
  type SettingsTabId,
} from './settingsTabs';
import { DESKTOP_SHORTCUTS } from './desktopShortcuts';
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
  appearance: Palette,
  library: Database,
  viewer: ImageIcon,
  rules: MagicWand,
  cache: HardDrives,
  diagnostics: Gauge,
  shortcuts: Keyboard,
  about: Info,
};

/** 页标题下的一句说明；只写当前实现真实成立的事实。 */
const TAB_LEADS: Record<SettingsTabId, string> = {
  appearance: '界面模式与主题色，修改后立即生效并保存在本机。',
  library: '导入时图片会复制到数据目录里的图库副本；之后的整理、重命名、删除只作用于这份副本。',
  viewer: '原图与 RAW 文件在查看器里的显示方式。',
  rules: '内置规则按顺序匹配；自定义规则用正则表达式捕获目标目录，先于内置规则生效，保存在本机。',
  cache: '缓存可随时清理，重新浏览时会按需重新生成。',
  diagnostics: '只在本机记录，用于排查滚动卡顿与缩略图加载问题。',
  shortcuts: '桌面端常用的键盘操作速查。',
  about: '本地优先的图片管理与查看应用。',
};

export type SettingsPageProps = {
  rules: CustomOrganizeRule[];
  onChange: (rules: CustomOrganizeRule[]) => void;
  onBack: () => void;
  runtimeLabel?: string;
  libraryBytes: number;
  libraryFileCount: number;
  /** 标题栏「侧栏」开关：收起时设置页左栏一并隐藏。 */
  sidebarHidden?: boolean;
  theme: ThemeOption;
  accent: AccentOption;
  onThemeChange: (theme: ThemeOption) => void;
  onAccentChange: (accent: AccentOption) => void;
  /** RAW 查看模式(仅 Electron 有可切换项;Web/Android 平台固定)。 */
  rawViewMode: DesktopRawViewMode;
  onRawViewModeChange: (mode: DesktopRawViewMode) => void;
  /** 打开设置页时默认显示的标签页（变化时跟随切换）。 */
  initialTab?: SettingsTabId;
};

export function SettingsPage({
  rules,
  onChange,
  onBack,
  runtimeLabel,
  libraryBytes,
  libraryFileCount,
  sidebarHidden = false,
  theme,
  accent,
  onThemeChange,
  onAccentChange,
  rawViewMode,
  onRawViewModeChange,
  initialTab,
}: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab ?? 'appearance');
  const [searchQuery, setSearchQuery] = useState('');
  const scrollRef = useRef<HTMLElement>(null);
  const pageTitle = SETTINGS_TABS.find((tab) => tab.id === activeTab)?.title ?? '';
  // 当前标签页始终保留在导航里（见 filterSettingsTabs），避免正文与导航割裂。
  const navTabs = filterSettingsTabs(searchQuery, activeTab);
  const hasMatches = hasSettingsTabMatches(searchQuery);

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  // 切换标签页时正文回到顶部，不沿用上一页的滚动位置。
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [activeTab]);

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      // 回车跳到第一个命中的标签页（当前页也命中时保持不动）。
      if (!searchQuery.trim()) return;
      const matched = SETTINGS_TABS.filter((tab) => settingsTabMatches(tab, searchQuery));
      const target = matched.find((tab) => tab.id === activeTab) ?? matched[0];
      if (target) {
        event.preventDefault();
        setActiveTab(target.id);
      }
    } else if (event.key === 'Escape' && searchQuery) {
      event.preventDefault();
      event.stopPropagation();
      setSearchQuery('');
    }
  };

  return (
    <div className={`dk-set-page titlebar-no-drag${sidebarHidden ? ' is-nav-hidden' : ''}`}>
      <aside className="dk-set-nav" aria-label="设置导航">
        <button type="button" className="dk-set-nav-item" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          <span>返回图库</span>
        </button>
        <label className="dk-set-search">
          <MagnifyingGlass size={14} aria-hidden="true" />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索设置"
            aria-label="搜索设置"
          />
        </label>
        <nav className="dk-set-tabs" aria-label="设置项">
          {navTabs.map((tab) => {
            const Icon = TAB_ICONS[tab.id];
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                className={`dk-set-nav-item${isActive ? ' is-active' : ''}`}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={16} aria-hidden="true" /><span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
        {/* 空状态常驻挂载、用 role="status" 播报，避免只靠视觉提示。 */}
        <p className="dk-set-empty" role="status">
          {hasMatches ? '' : '没有匹配的设置项'}
        </p>
      </aside>

      <main className="dk-set-scroll" ref={scrollRef}>
        <div className="dk-set-main">
          <h1 className="dk-set-title">{pageTitle}</h1>
          <p className="dk-set-lead">{TAB_LEADS[activeTab]}</p>

          {activeTab === 'appearance' && (
            <AppearancePanel
              theme={theme}
              accent={accent}
              onThemeChange={onThemeChange}
              onAccentChange={onAccentChange}
            />
          )}
          {activeTab === 'library' && (
            <LibraryPanel
              runtimeLabel={runtimeLabel}
              libraryBytes={libraryBytes}
              libraryFileCount={libraryFileCount}
              ruleCount={rules.length}
              onOpenRules={() => setActiveTab('rules')}
            />
          )}
          {activeTab === 'viewer' && (
            <ViewerPanel rawViewMode={rawViewMode} onRawViewModeChange={onRawViewModeChange} />
          )}
          {activeTab === 'rules' && <RulesPanel rules={rules} onChange={onChange} />}
          {activeTab === 'cache' && <CachePanel />}
          {activeTab === 'diagnostics' && <DebugPanel />}
          {activeTab === 'shortcuts' && <ShortcutsPanel />}
          {activeTab === 'about' && <AboutPanel runtimeLabel={runtimeLabel} />}
        </div>
      </main>
    </div>
  );
}

/** 设置行：左侧标题 + 说明，右侧控件。 */
function SettingRow({
  label,
  description,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="dk-set-row">
      <div className="dk-set-row-label">
        <b>{label}</b>
        {description != null && description !== '' && <small>{description}</small>}
      </div>
      {children != null && <div className="dk-set-row-control">{children}</div>}
    </div>
  );
}

/* ===== 外观 ===== */

const THEME_CHOICES: ReadonlyArray<readonly [ThemeOption, string]> = [
  ['dark', '深色'],
  ['light', '浅色'],
  ['system', '跟随系统'],
];

function AppearancePanel({
  theme,
  accent,
  onThemeChange,
  onAccentChange,
}: {
  theme: ThemeOption;
  accent: AccentOption;
  onThemeChange: (theme: ThemeOption) => void;
  onAccentChange: (accent: AccentOption) => void;
}) {
  const accentLabel = ACCENT_OPTIONS.find((option) => option.value === accent)?.label ?? '';
  return (
    <section className="dk-set-card">
      <h3 className="dk-set-card-title">界面模式</h3>
      <div className="dk-set-theme-cards" role="radiogroup" aria-label="界面模式">
        {THEME_CHOICES.map(([value, label]) => {
          const selected = theme === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              className={`dk-set-theme-card${selected ? ' is-active' : ''}`}
              onClick={() => onThemeChange(value)}
              onKeyDown={(event) => handleRadioNavigation(
                event,
                THEME_CHOICES.map(([v]) => v),
                theme,
                onThemeChange,
              )}
            >
              <span className={`dk-set-theme-preview is-${value}`} aria-hidden="true">
                <span />
                <span />
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      <SettingRow label="主题色" description={`选中状态与关键操作 · 当前：${accentLabel}`}>
        <div className="dk-set-swatches" role="radiogroup" aria-label="主题色">
          {ACCENT_OPTIONS.map((option) => {
            const selected = accent === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={option.label}
                title={option.label}
                tabIndex={selected ? 0 : -1}
                className={`dk-set-swatch is-${option.value}${selected ? ' is-active' : ''}`}
                onClick={() => onAccentChange(option.value)}
                onKeyDown={(event) => handleRadioNavigation(
                  event,
                  ACCENT_OPTIONS.map((item) => item.value),
                  accent,
                  onAccentChange,
                )}
              />
            );
          })}
        </div>
      </SettingRow>
    </section>
  );
}

/* ===== 图库与数据 ===== */

function LibraryPanel({
  runtimeLabel,
  libraryBytes,
  libraryFileCount,
  ruleCount,
  onOpenRules,
}: {
  runtimeLabel?: string;
  libraryBytes: number;
  libraryFileCount: number;
  ruleCount: number;
  onOpenRules: () => void;
}) {
  return (
    <>
      <section className="dk-set-card">
        <DataDirRow />
        <div className="dk-set-usage">
          <div className="dk-set-usage-head">
            <b>图库占用 {formatBytes(libraryBytes)}</b>
            <span>{formatCount(libraryFileCount)} 个文件</span>
          </div>
          <small>已索引的本地文件总量</small>
        </div>
      </section>
      <section className="dk-set-card">
        <SettingRow label="运行环境">
          <code className="dk-set-code">{runtimeLabel ?? '—'}</code>
        </SettingRow>
        <SettingRow label="自定义整理规则" description="用于智能整理的本机规则">
          <span className="dk-set-value">{ruleCount} 条</span>
          <button type="button" className="dk-btn sm" onClick={onOpenRules}>管理</button>
        </SettingRow>
      </section>
    </>
  );
}

/**
 * 数据目录（仅桌面端）：只读展示。数据目录在首次启动引导里确定；更改需要
 * 整体搬移图库与缓存，本期不提供入口。
 */
function DataDirRow() {
  const supported = supportsDataDir();
  const [dir, setDir] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void fetchDataDir().then((next) => {
      if (!cancelled) setDir(next);
    });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  // Web 演示 / Android 的数据目录由平台固定，整行不渲染。
  if (!supported) return null;

  return (
    <SettingRow
      label="数据目录"
      description={<code className="dk-set-code is-path" title={dir ?? undefined}>{dir ?? '读取中…'}</code>}
    />
  );
}

/* ===== 查看器 ===== */

function ViewerPanel({
  rawViewMode,
  onRawViewModeChange,
}: {
  rawViewMode: DesktopRawViewMode;
  onRawViewModeChange: (mode: DesktopRawViewMode) => void;
}) {
  // RAW 查看模式:仅 Electron 桥存在时可切换(Web/Android 平台固定)。
  const canSwitchRaw = typeof window !== 'undefined' && Boolean(window.kanitsuDesktop);
  return (
    <section className="dk-set-card">
      <h3 className="dk-set-card-title">RAW 显示</h3>
      {canSwitchRaw ? (
        <SettingRow label="RAW 观感" description="显影 = 完整解码渲染；直出 = 相机内嵌预览">
          <Segmented<DesktopRawViewMode>
            label="RAW 观感"
            options={[{ value: 'developed', content: '显影' }, { value: 'camera', content: '直出' }]}
            value={rawViewMode}
            onChange={onRawViewModeChange}
          />
        </SettingRow>
      ) : (
        <SettingRow label="RAW 观感" description="仅桌面端可切换；当前平台使用固定的显示方式。" />
      )}
    </section>
  );
}

/* ===== 快捷键 ===== */

function ShortcutsPanel() {
  return (
    <>
      {DESKTOP_SHORTCUTS.map((group) => (
        <section key={group.title} className="dk-set-card">
          <h3 className="dk-set-card-title">{group.title}</h3>
          <dl className="dk-set-keys">
            {group.items.map((item) => (
              <div key={item.label} className="dk-set-keys-row">
                <dt>{item.label}</dt>
                <dd>
                  {item.keys.map((key) => (
                    <kbd key={key} className="dk-kbd">{key}</kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </>
  );
}

/* ===== 关于 ===== */

function AboutPanel({ runtimeLabel }: { runtimeLabel?: string }) {
  const version = window.kanitsuDesktop?.version;
  return (
    <section className="dk-set-card">
      <SettingRow label="Kanitsu" description={runtimeLabel === 'Electron' ? '本地图片管理与查看 · Windows 版' : '本地图片管理与查看'} />
      <SettingRow label="版本">
        <code className="dk-set-code">{version ? `v${version}` : '—'}</code>
      </SettingRow>
      <SettingRow label="运行环境">
        <code className="dk-set-code">{runtimeLabel ?? '—'}</code>
      </SettingRow>
      <SettingRow label="离线" description="默认不联网、不上传、不遥测图片内容">
        <CheckCircle size={18} weight="fill" className="dk-set-ok" role="img" aria-label="已启用" />
      </SettingRow>
      <SettingRow label="副本隔离" description="导入后不修改源文件夹">
        <CheckCircle size={18} weight="fill" className="dk-set-ok" role="img" aria-label="已启用" />
      </SettingRow>
    </section>
  );
}

/* ===== 诊断 ===== */

const LEVEL_LABELS: ReadonlyArray<readonly [LogLevel, string]> = [
  ['debug', '调试'],
  ['info', '信息'],
  ['warn', '警告'],
  ['error', '仅错误'],
];

/** 主进程多级队列的档位名，与 thumbnailCache.ts 的 THUMB_PRIORITY_* 一一对应。 */
const QUEUE_PRIORITY_LABELS = ['可见', '滚动方向', '当前目录', '子文件夹', '预热'];

/** 帧率折线保留的样本数：监测器约 500ms 回调一次，60 个 ≈ 最近 30 秒。 */
const FPS_HISTORY = 60;

/** 主进程缩略图统计（仅 Electron）：打开期间每秒刷新，面板卸载即停止。 */
function useMainThumbnailStats(): ThumbnailDebugStats | null {
  const [mainStats, setMainStats] = useState<ThumbnailDebugStats | null>(null);
  useEffect(() => {
    const refresh = (): void => {
      void window.kanitsuDesktop
        ?.getThumbnailDebugStats?.()
        .then((stats) => setMainStats(stats))
        .catch(() => setMainStats(null));
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, []);
  return mainStats;
}

/** 诊断面板：帧率 + 缩略图队列 + 调试选项（日志等级 / 预取开关）+ 主进程日志 + 渲染端日志。 */
function DebugPanel() {
  const [level, setLevel] = useState<LogLevel>(() => getLogLevelPref());
  const [prefetch, setPrefetch] = useState<boolean>(() => isPrefetchEnabled());
  const [logs, setLogs] = useState<readonly LogEntry[]>(() => getDebugLogs());
  const [mainLogs, setMainLogs] = useState<string[]>([]);
  const [fps, setFps] = useState<FpsStats | null>(null);
  const [fpsHistory, setFpsHistory] = useState<number[]>([]);
  const mainStats = useMainThumbnailStats();

  // 诊断面板打开期间运行帧率监测（关闭自动停止，避免常驻开销）。
  useEffect(() => {
    startFpsMonitor((stats) => {
      setFps(stats);
      if (stats.totalFrames > 0) {
        setFpsHistory((prev) => [...prev.slice(-(FPS_HISTORY - 1)), stats.fps]);
      }
    });
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

  const handleResetFps = (): void => {
    resetFpsMonitor();
    setFpsHistory([]);
  };

  // 折线高度以 60fps 为基准，高刷屏按实测最大值放大，避免柱子顶格。
  const sparkMax = Math.max(60, ...fpsHistory);

  return (
    <>
      <section className="dk-set-card">
        <div className="dk-set-card-head">
          <h3 className="dk-set-card-title">帧率与滚动性能</h3>
          <button type="button" className="dk-btn sm ghost" onClick={handleResetFps}>重置</button>
        </div>
        <div className="dk-set-usage">
          <div className="dk-set-usage-head">
            <b>帧率 · 最近 30 秒</b>
            <span>
              {fps && fps.totalFrames > 0
                ? `当前 ${fps.fps.toFixed(0)} fps · 累计掉帧 ${fps.totalDropped}`
                : '采集第一帧中…（滚动几下后查看）'}
            </span>
          </div>
          <div className="dk-set-spark" aria-hidden="true">
            {fpsHistory.map((value, i) => (
              <i
                key={i}
                className={value < 30 ? 'is-low' : undefined}
                style={{ height: `${Math.max(2, Math.min(100, (value / sparkMax) * 100))}%` }}
              />
            ))}
          </div>
        </div>
        {fps && fps.totalFrames > 0 && (
          <div className="dk-set-stats">
            <Stat label="当前帧率" value={`${fps.fps.toFixed(0)} fps`} accent />
            <Stat label="平均帧间隔" value={`${fps.avgFrameMs.toFixed(1)} ms`} />
            <Stat label="p95 帧间隔" value={`${fps.p95FrameMs.toFixed(1)} ms`} />
            <Stat label="最大帧间隔" value={`${fps.maxFrameMs.toFixed(0)} ms`} />
            <Stat label="掉帧(1s)" value={fps.dropped} danger={fps.dropped > 0} />
            <Stat label="卡顿帧(1s)" value={fps.jankFrames} danger={fps.jankFrames > 0} />
            <Stat label="累计掉帧" value={fps.totalDropped} />
            <Stat label="滚动回调" value={fps.scrollSamples > 0 ? `${fps.scrollAvgMs.toFixed(1)} ms` : '—'} />
            {fps.scrollSamples > 0 && (
              <>
                <Stat label="滚动回调 p95" value={`${fps.scrollP95Ms.toFixed(1)} ms`} />
                <Stat label="滚动回调峰值" value={`${fps.scrollMaxMs.toFixed(1)} ms`} />
                <Stat label="样本" value={fps.scrollSamples} />
              </>
            )}
          </div>
        )}
        <p className="dk-set-note">
          rAF 帧间隔统计（最近 1s）：掉帧 &gt;33.3ms、卡顿帧 &gt;50ms。滚动回调耗时为 JS
          调度侧开销（窗口计算/状态更新）；渲染/绘画细账以 DevTools Performance 为准。
        </p>
      </section>

      <section className="dk-set-card">
        <SettingRow
          label="缩略图队列"
          description={mainStats
            ? `队列积压（按优先级）：${mainStats.queuedByPriority
              .map((count, i) => `${QUEUE_PRIORITY_LABELS[i] ?? `P${i}`} ${count}`)
              .join(' · ')}`
            : 'Web/演示模式无主进程数据；Electron 模式请确认应用已重启加载最新构建。'}
        >
          {mainStats && (
            <code className="dk-set-code">解码中 {mainStats.inFlight} · worker {mainStats.workers}</code>
          )}
        </SettingRow>
      </section>

      <section className="dk-set-card">
        <h3 className="dk-set-card-title">调试选项</h3>
        <SettingRow
          label="日志等级"
          description="控制台与主进程日志的详细程度（调试最详细，含缩略图命中/未命中/队列状态）。"
        >
          <Segmented<LogLevel> label="日志等级" options={LEVEL_LABELS.map(([value, content]) => ({ value, content }))} value={level} onChange={setLevel} />
        </SettingRow>
        <SettingRow
          label="后台预取"
          description="空闲时生成全库缩略图，并预取下一屏与少量子图包；滚动期间自动暂停后台任务。"
        >
          <Switch checked={prefetch} onChange={setPrefetch} label="后台预取" />
        </SettingRow>
      </section>

      <section className="dk-set-card">
        <div className="dk-set-card-head">
          <h3 className="dk-set-card-title">主进程日志（UTF-8 文件，含时间/等级）</h3>
          <button type="button" className="dk-btn sm" onClick={() => void refreshMainLogs()}>读取</button>
        </div>
        <p className="dk-set-note">位于 userData/logs/kanitsu-日期.log；乱码时以此为准（控制台可能受系统代码页影响）。</p>
        <div className="dk-set-log-box is-short">
          {mainLogs.length === 0 ? (
            <div className="dk-set-log-empty">暂无主进程日志。</div>
          ) : (
            <pre className="dk-set-log-pre">{mainLogs.join('\n')}</pre>
          )}
        </div>
      </section>

      <section className="dk-set-card">
        <div className="dk-set-card-head">
          <h3 className="dk-set-card-title">最近日志（渲染端，{logs.length}）</h3>
          <div className="dk-set-actions">
            <button type="button" className="dk-btn sm" onClick={() => void copyLogs()}>复制</button>
            <button type="button" className="dk-btn sm" onClick={() => clearDebugLogs()}>清空</button>
          </div>
        </div>
        <div className="dk-set-log-box">
          {logs.length === 0 ? (
            <div className="dk-set-log-empty">暂无日志；切换文件夹/打开大目录后会有目录切换与预取事件。</div>
          ) : (
            <table className="dk-set-log-table">
              <tbody>
                {[...logs].slice(-100).map((entry, i) => (
                  <tr key={i}>
                    <td className="is-time">{formatLogTime(entry.time)}</td>
                    <td>
                      <span className={`dk-set-tag is-${entry.level}`}>{entry.tag}</span>
                    </td>
                    <td className="is-message">{entry.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

function Stat({
  label,
  value,
  accent = false,
  danger = false,
}: {
  label: string;
  value: ReactNode;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div className={`dk-set-stat${accent ? ' is-accent' : ''}${danger ? ' is-danger' : ''}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

/* ===== 缓存 ===== */

/** 缓存面板：渲染端内存缓存 + 主进程内存/磁盘缓存 + 清除缓存。 */
function CachePanel() {
  const [renderer, setRenderer] = useState<RendererThumbnailStats>(() => getRendererThumbnailStats());
  const mainStats = useMainThumbnailStats();
  const [clearResult, setClearResult] = useState('');

  useEffect(() => {
    const refresh = (): void => setRenderer(getRendererThumbnailStats());
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleClearRendererCache = (): void => {
    const before = getRendererThumbnailStats();
    clearThumbnailCache();
    setRenderer(getRendererThumbnailStats());
    setClearResult(
      `渲染端内存缓存已清空（此前 ${before.entries} 条 / ${formatBytes(before.bytes)}）；` +
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
      `主进程缓存已清空：内存 ${result.memoryEntries} 条 / ${formatBytes(result.memoryBytes)}；磁盘 ${result.diskFiles} 个文件 / ${formatBytes(result.diskBytes)}。`,
    );
  };

  const hitRate =
    renderer.requests > 0 ? Math.round((renderer.cacheHits / renderer.requests) * 100) : 0;

  return (
    <>
      <section className="dk-set-card">
        <h3 className="dk-set-card-title">渲染端缩略图缓存</h3>
        <SettingRow
          label="内存缓存"
          description={`会话级 LRU · 上限 ${formatBytes(renderer.maxBytes)} · 命中率 ${hitRate}%`}
        >
          <code className="dk-set-code">{formatBytes(renderer.bytes)}</code>
          <button type="button" className="dk-btn sm" onClick={handleClearRendererCache}>清除渲染端</button>
        </SettingRow>
        <div className="dk-set-stats">
          <Stat label="条目" value={renderer.entries} />
          <Stat label="占用" value={formatBytes(renderer.bytes)} />
          <Stat label="容量上限" value={formatBytes(renderer.maxBytes)} />
          <Stat label="请求 / 命中" value={`${renderer.requests} / ${renderer.cacheHits}`} />
          <Stat label="命中率" value={`${hitRate}%`} />
          <Stat label="未命中" value={renderer.cacheMisses} />
          <Stat label="预取已排" value={renderer.prefetchScheduled} />
          <Stat label="预取完成" value={renderer.prefetchCompleted} />
          <Stat label="预取失败" value={renderer.prefetchFailed} />
        </div>
      </section>

      <section className="dk-set-card">
        <h3 className="dk-set-card-title">主进程缩略图缓存（Electron）</h3>
        {mainStats ? (
          <>
            <SettingRow label="主进程内存缓存" description={`${mainStats.thumbCacheEntries} 个缓存条目`}>
              <code className="dk-set-code">{formatBytes(mainStats.thumbCacheBytes)}</code>
            </SettingRow>
            <SettingRow label="磁盘缓存" description="缩略图磁盘缓存文件数">
              <code className="dk-set-code">{mainStats.diskFiles} 个文件</code>
            </SettingRow>
          </>
        ) : (
          <SettingRow
            label="主进程缓存"
            description="Web/演示模式无主进程数据；Electron 模式请确认应用已重启加载最新构建。"
          />
        )}
        <SettingRow label="清除主进程缓存" description="内存 + 磁盘；重新浏览时会重新生成（测试用）">
          <button type="button" className="dk-btn sm" onClick={() => void handleClearMainCache()}>
            清除主进程（内存+磁盘）
          </button>
        </SettingRow>
      </section>

      {clearResult && <p className="dk-set-result" role="status">{clearResult}</p>}
    </>
  );
}
