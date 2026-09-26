import { useEffect, useRef, useState } from 'react';
import type { CustomOrganizeRule } from '../../../organizer/src/index';
import type { KanitsuAndroidBridge } from '../../../fs-adapter/src/android';
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
import { ACCENT_OPTIONS, type AccentMode } from '../accents';
import {
  applyAccentMode,
  applyThemeMode,
  formatBytes,
  isRawFullDecodeEnabled,
  loadAccentMode,
  loadThemeMode,
  setRawFullDecodeEnabled,
  type ThemeMode,
} from './mobileShared';
import { MobileIcon, type MobileIconName } from './mobileIcons';
import { Switch } from './MobileDisplaySheets';
import { Z_SETTINGS } from './zindex';
import { useExitPresence } from './useExitPresence';
import { MobileConfirmDialog } from './MobileSheets';
import { formatLogTime } from '../../../core/src/index';

const LEVEL_LABELS: ReadonlyArray<[LogLevel, string]> = [
  ['debug', '调试'],
  ['info', '信息'],
  ['warn', '警告'],
  ['error', '仅错误'],
];

/** ui 包不直接依赖 fs-adapter/android 的全局声明，这里做类型化读取。 */
function androidBridge(): KanitsuAndroidBridge | undefined {
  return (window as unknown as { kanitsuAndroid?: KanitsuAndroidBridge }).kanitsuAndroid;
}

function SettingsGlyph({ name }: { name: SettingsSectionId }) {
  const common = {
    viewBox: '0 0 24 24',
    className: 'w-[18px] h-[18px]',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  if (name === 'cache') {
    return (
      <svg {...common}>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </svg>
    );
  }
  if (name === 'rules') {
    return (
      <svg {...common}>
        <path d="M4 6h10M4 12h16M4 18h8" />
        <circle cx="17" cy="6" r="2" />
        <circle cx="15" cy="18" r="2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M8 9h8M8 13h8M9 3l1.2 2h3.6L15 3M6 7h12v11a3 3 0 01-3 3H9a3 3 0 01-3-3z" />
    </svg>
  );
}

/** 设置二级详情页 id（设置首页 → 分类详情）。外观与浏览选项直接在首页设置。 */
export type SettingsSectionId = 'cache' | 'rules' | 'debug';

const SECTION_META: ReadonlyArray<{
  id: SettingsSectionId;
  title: string;
  subtitle: string;
}> = [
  { id: 'cache', title: '缓存', subtitle: '缩略图缓存统计与清除' },
  { id: 'rules', title: '整理规则', subtitle: '文件名匹配与自定义规则' },
  { id: 'debug', title: '诊断', subtitle: '日志等级与查看' },
];

function SettingsHeaderBar({ title, subtitle, onBack }: { title: string; subtitle: string; onBack: () => void }) {
  return (
    <header className="m2-appbar is-solid is-static" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
      <div className="m2-appbar-row">
        <button className="m2-icon-button" onClick={onBack} aria-label="返回">
          <MobileIcon name="back" className="w-[22px] h-[22px]" />
        </button>
        <div className="m2-appbar-title is-visible">
          {title}
          <small>{subtitle}</small>
        </div>
      </div>
    </header>
  );
}

const ACCENT_SWATCH: Record<AccentMode, string> = {
  coral: '#ff785e',
  cobalt: '#8aa4e8',
  amber: '#e2ad55',
  graphite: '#c2c9d0',
};

function SettingsItem({
  icon,
  title,
  subtitle,
  value,
  onClick,
  trailing,
}: {
  icon: MobileIconName;
  title: string;
  subtitle: string;
  value?: string;
  onClick?: () => void;
  trailing?: React.ReactNode;
}) {
  const body = (
    <>
      <span className="m2-set-icon">
        <MobileIcon name={icon} className="w-[18px] h-[18px]" />
      </span>
      <span className="m2-set-copy">
        <strong>{title}</strong>
        <small>{subtitle}</small>
      </span>
      {value && <span className="m2-set-value tabular-nums">{value}</span>}
      {trailing ?? (onClick ? <MobileIcon name="chevron-right" className="w-4 h-4 m2-muted shrink-0" /> : null)}
    </>
  );
  return onClick ? (
    <button className="m2-set-item" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="m2-set-item">{body}</div>
  );
}

/** 外观（首页内联）：明暗模式 + 主题色。 */
function AppearanceInline() {
  const [theme, setTheme] = useState<ThemeMode>(() => loadThemeMode());
  const [accent, setAccent] = useState<AccentMode>(() => loadAccentMode());
  useEffect(() => applyThemeMode(theme), [theme]);
  useEffect(() => applyAccentMode(accent), [accent]);
  return (
    <>
      <div className="m2-set-pad">
        <div className="m2-segmented" role="radiogroup" aria-label="界面主题">
          {(
            [
              ['dark', '深色'],
              ['light', '浅色'],
              ['system', '跟随系统'],
            ] as [ThemeMode, string][]
          ).map(([value, label]) => (
            <button key={value} role="radio" aria-checked={theme === value} className={theme === value ? 'is-on' : ''} onClick={() => setTheme(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="m2-swatches" role="radiogroup" aria-label="主题色">
        {ACCENT_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            role="radio"
            aria-checked={accent === value}
            aria-label={label}
            className={accent === value ? 'is-on' : ''}
            style={{ background: ACCENT_SWATCH[value] }}
            onClick={() => setAccent(value)}
          />
        ))}
        <span className="m2-swatch-label">{ACCENT_OPTIONS.find((o) => o.value === accent)?.label}</span>
      </div>
    </>
  );
}

/** 存储概览：缩略图内存缓存 + Android 磁盘缓存（缩略图与 RAW/HEIC 派生图）。 */
function StorageInline({ onOpenDetail }: { onOpenDetail: () => void }) {
  const [renderer, setRenderer] = useState<RendererThumbnailStats>(() => getRendererThumbnailStats());
  const [native, setNative] = useState<{ diskFiles: number; diskBytes: number } | null>(null);
  useEffect(() => {
    const refresh = (): void => {
      setRenderer(getRendererThumbnailStats());
      void androidBridge()
        ?.getThumbnailStats?.()
        .then((st) => setNative(st))
        .catch(() => setNative(null));
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, []);
  const total = renderer.bytes + (native?.diskBytes ?? 0);
  const memPct = total > 0 ? (renderer.bytes / total) * 100 : 0;
  return (
    <>
      <div className="m2-set-pad m2-cache-summary">
        <span>缓存占用</span>
        <b className="tabular-nums">{formatBytes(total)}</b>
      </div>
      <div className="m2-cache-bar" aria-hidden="true">
        <i style={{ width: `${memPct}%` }} />
        <i className="is-disk" style={{ width: `${100 - memPct}%` }} />
      </div>
      <div className="m2-cache-legend tabular-nums">
        <span className="is-mem">内存 {formatBytes(renderer.bytes)}</span>
        {native && <span className="is-disk">磁盘 {formatBytes(native.diskBytes)} · {native.diskFiles} 个文件</span>}
      </div>
      <SettingsItem icon="database" title="缓存详情与清理" subtitle="命中率、解码队列；清理不影响图库" onClick={onOpenDetail} />
    </>
  );
}

function BrowseInline() {
  const [prefetch, setPrefetch] = useState<boolean>(() => isPrefetchEnabled());
  const [rawFull, setRawFull] = useState<boolean>(() => isRawFullDecodeEnabled());
  return (
    <>
      <SettingsItem
        icon="gauge"
        title="后台预取"
        subtitle="空闲时预热当前目录、子目录与全库缩略图，滚动更顺"
        trailing={
          <Switch
            checked={prefetch}
            label="后台预取"
            onChange={(v) => {
              setPrefetch(v);
              setPrefetchEnabled(v);
            }}
          />
        }
      />
      <SettingsItem
        icon="aperture"
        title="RAW 完整解码"
        subtitle="先显示相机内嵌预览，当前页再后台完整解码；关闭可省电"
        trailing={
          <Switch
            checked={rawFull}
            label="RAW 完整解码"
            onChange={(v) => {
              setRawFull(v);
              setRawFullDecodeEnabled(v);
            }}
          />
        }
      />
    </>
  );
}

/**
 * 移动端设置页：首页直接调整外观与浏览选项，缓存 / 整理规则 / 诊断进入二级详情。
 * section 由 MobileApp 持有，硬件返回可逐级退回（详情 → 设置 → 图库）。
 * exiting：整页关闭时由父层置 true，播放滑出动画后再卸载。
 */
export function MobileSettingsScreen({
  rules,
  onChange,
  onBack,
  section,
  onSectionChange,
  exiting = false,
}: {
  rules: CustomOrganizeRule[];
  onChange: (rules: CustomOrganizeRule[]) => void;
  onBack: () => void;
  section: SettingsSectionId | null;
  onSectionChange: (section: SettingsSectionId | null) => void;
  exiting?: boolean;
}) {
  // 详情作为覆盖层：打开时从右滑入盖在首页上，返回时向右滑出露出首页。
  // 退场期间 section 已复位，用 ref 记住最后一个分类用于渲染。
  const detailOpen = section != null && !!SECTION_META.find((s) => s.id === section);
  const detailPresence = useExitPresence(detailOpen, 240);
  const lastSectionRef = useRef<SettingsSectionId | null>(null);
  if (section != null) lastSectionRef.current = section;
  const shownSection = detailPresence.present ? lastSectionRef.current : null;
  const shownMeta = shownSection != null ? SECTION_META.find((s) => s.id === shownSection) : undefined;
  const [solid, setSolid] = useState(false);
  const enabledRules = rules.filter((r) => r.enabled).length;

  return (
    <>
      <div
        className={`m-settings-screen m2-page fixed inset-0 flex flex-col ${exiting ? 'm-page-exit-right' : 'm-subpage-enter'}`}
        style={{ zIndex: Z_SETTINGS }}
      >
        <header className={`m2-appbar ${solid ? 'is-solid' : ''}`} style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
          <div className="m2-appbar-row">
            <button className="m2-icon-button" onClick={onBack} aria-label="返回">
              <MobileIcon name="back" className="w-[22px] h-[22px]" />
            </button>
            <div className={`m2-appbar-title ${solid ? 'is-visible' : ''}`}>设置</div>
          </div>
        </header>
        <main
          className="m-settings-content m2-scroll flex-1 overflow-y-auto overscroll-contain"
          onScroll={(e) => {
            const next = e.currentTarget.scrollTop > 40;
            if (next !== solid) setSolid(next);
          }}
        >
          <div className="m2-set-head">
            <h1>设置</h1>
          </div>

          <section className="m2-set-card" aria-label="外观">
            <h4>外观</h4>
            <AppearanceInline />
          </section>

          <section className="m2-set-card" aria-label="浏览">
            <h4>浏览</h4>
            <BrowseInline />
          </section>

          <section className="m2-set-card" aria-label="存储">
            <h4>存储</h4>
            <StorageInline onOpenDetail={() => onSectionChange('cache')} />
            <SettingsItem icon="folder" title="图库位置" subtitle="应用私有目录（Android/data/…/files/albums），无需存储权限" />
          </section>

          <section className="m2-set-card" aria-label="整理与诊断">
            <h4>整理与诊断</h4>
            <SettingsItem
              icon="braces"
              title="整理规则"
              subtitle={`6 条内置 · ${rules.length} 条自定义${rules.length ? `（启用 ${enabledRules}）` : ''}`}
              onClick={() => onSectionChange('rules')}
            />
            <SettingsItem icon="bug" title="诊断" subtitle="日志等级、查看渲染端与原生日志" value={getLogLevelPref()} onClick={() => onSectionChange('debug')} />
          </section>

          <section className="m2-set-card" aria-label="关于">
            <h4>关于</h4>
            <SettingsItem icon="shield" title="隐私" subtitle="不联网、不上传；只访问你授权的文件夹，导入后不修改源文件夹" />
            <SettingsItem icon="info" title="Kanitsu" subtitle={`Android 版 · v${androidBridge()?.version ?? '0.1.0'}`} />
          </section>
        </main>
      </div>

      {/* 二级分类详情覆盖层 */}
      {detailPresence.present && shownMeta && (
        <div
          key={shownMeta.id}
          className={`m-settings-screen m2-page fixed inset-0 flex flex-col ${
            detailPresence.exiting || exiting ? 'm-page-exit-right' : 'm-subpage-enter'
          }`}
          style={{ zIndex: Z_SETTINGS }}
        >
          <SettingsHeaderBar title={shownMeta.title} subtitle={shownMeta.subtitle} onBack={() => onSectionChange(null)} />
          <main className="m-settings-content flex-1 overflow-y-auto overscroll-contain">
            <section className="m-settings-group">
              {shownSection === 'cache' && <CacheCard />}
              {shownSection === 'rules' && <RulesCard rules={rules} onChange={onChange} />}
              {shownSection === 'debug' && <LogCard />}
            </section>
          </main>
        </div>
      )}
    </>
  );
}

/** 缓存：渲染端 + Android 原生统计与清除。 */
function CacheCard() {
  const [renderer, setRenderer] = useState<RendererThumbnailStats>(() => getRendererThumbnailStats());
  const [nativeStats, setNativeStats] = useState<{ diskFiles: number; diskBytes: number; inFlight: number } | null>(null);
  const [clearResult, setClearResult] = useState('');
  const [confirmClear, setConfirmClear] = useState<'renderer' | 'native' | null>(null);

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
    <div className="m-settings-card">
      <div className="m-settings-row is-stacked">
        <span className="m-settings-row-icon"><SettingsGlyph name="cache" /></span>
        <span className="m-settings-row-copy">
          <strong>缩略图缓存</strong>
          <span>渲染端内存与 Android 磁盘缓存会在浏览时持续更新。</span>
        </span>
      </div>
      <div className="m-cache-grid">
        <CacheStat value={String(renderer.entries)} label="内存条目" />
        <CacheStat value={formatBytes(renderer.bytes)} label="内存占用" />
        <CacheStat value={`${hitRate}%`} label="命中率" />
        {nativeStats && (
          <>
            <CacheStat value={String(nativeStats.diskFiles)} label="磁盘文件" />
            <CacheStat value={formatBytes(nativeStats.diskBytes)} label="磁盘占用" />
            <CacheStat value={String(nativeStats.inFlight)} label="解码中" />
          </>
        )}
      </div>
      <div className="m-settings-actions">
        <button className="m-button" onClick={() => setConfirmClear('renderer')}>清除内存缓存</button>
        <button className="m-button" onClick={() => setConfirmClear('native')}>清除磁盘缓存</button>
      </div>
      {clearResult && <p className="m-settings-result">{clearResult}</p>}
      {confirmClear && (
        <MobileConfirmDialog
          title="确认清除"
          body={
            confirmClear === 'renderer'
              ? '确定要清除内存中的缩略图缓存吗？下次浏览会重新解码生成。'
              : '确定要清除磁盘缩略图缓存吗？重新浏览时将重新生成全部缩略图。'
          }
          confirmLabel="清除"
          onConfirm={() => {
            if (confirmClear === 'renderer') handleClearRenderer();
            else void handleClearNative();
            setConfirmClear(null);
          }}
          onCancel={() => setConfirmClear(null)}
        />
      )}
    </div>
  );
}

function CacheStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="m-cache-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/** 整理规则：文件名匹配。 */
function RulesCard({ rules, onChange }: { rules: CustomOrganizeRule[]; onChange: (rules: CustomOrganizeRule[]) => void }) {
  return (
    <div className="m-settings-card m-settings-rules-card">
      <div className="m-settings-row is-stacked">
        <span className="m-settings-row-icon"><SettingsGlyph name="rules" /></span>
        <span className="m-settings-row-copy">
          <strong>文件名匹配</strong>
          <span>内置规则固定生效；自定义规则优先匹配并自动保存到本机。</span>
        </span>
      </div>
      <OrganizeRulesManager
        rules={rules}
        onChange={onChange}
        showIntro={false}
        className="m-settings-rules"
      />
    </div>
  );
}

/** 诊断：日志等级 + 渲染端 / 原生日志。 */
function LogCard() {
  const [level, setLevel] = useState<LogLevel>(() => getLogLevelPref());
  const [logs, setLogs] = useState<readonly LogEntry[]>(() => getDebugLogs());
  const [nativeLogs, setNativeLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [confirmClearLogs, setConfirmClearLogs] = useState(false);

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


  return (
    <div className="m-settings-card">
      <div className="m-settings-row is-stacked">
        <span className="m-settings-row-icon"><SettingsGlyph name="debug" /></span>
        <span className="m-settings-row-copy">
          <strong>日志等级</strong>
          <span>控制渲染端与 Android 原生桥记录的详细程度。</span>
        </span>
      </div>
      <div className="m-theme-segment" role="group" aria-label="日志等级">
        {LEVEL_LABELS.map(([v, label]) => (
          <button
            key={v}
            className={level === v ? 'is-active' : ''}
            aria-pressed={level === v}
            onClick={() => setLevel(v)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="m-settings-actions is-three">
        <button className="m-button" onClick={() => setShowLogs((v) => !v)}>{showLogs ? '收起日志' : '查看日志'}</button>
        <button className="m-button" onClick={() => void refreshNativeLogs()}>读取原生</button>
        <button
          className="m-button is-ghost"
          onClick={() => setConfirmClearLogs(true)}
        >
          清空
        </button>
      </div>
      {confirmClearLogs && (
        <MobileConfirmDialog
          title="确认清空"
          body="确定要清空本机调试日志吗？此操作不可撤销。"
          confirmLabel="清空"
          onConfirm={() => {
            clearDebugLogs();
            setLogs([]);
            setConfirmClearLogs(false);
          }}
          onCancel={() => setConfirmClearLogs(false)}
        />
      )}
      {showLogs && (
        <div className="m-log-panel">
          {nativeLogs.length > 0 && <pre>{nativeLogs.join('\n')}</pre>}
          {logs.length === 0 && nativeLogs.length === 0 ? (
            <div className="m-log-empty">暂无日志。</div>
          ) : (
            logs.slice(-80).map((entry, i) => (
              <div key={i} className={`m-log-line is-${entry.level}`}>
                <span>{formatLogTime(entry.time)} </span>
                <b>[{entry.tag}]</b>{' '}
                {entry.message}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
