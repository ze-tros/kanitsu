import { useEffect, useState } from 'react';
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
import { applyThemeMode, formatBytes, loadThemeMode, type ThemeMode } from './mobileShared';
import { Z_SETTINGS } from './zindex';

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

function SettingsGlyph({ name }: { name: 'appearance' | 'performance' | 'cache' | 'rules' | 'debug' | 'about' }) {
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

  if (name === 'appearance') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (name === 'performance') {
    return (
      <svg {...common}>
        <path d="M13 2L5 14h7l-1 8 8-12h-7z" />
      </svg>
    );
  }
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
  if (name === 'debug') {
    return (
      <svg {...common}>
        <path d="M8 9h8M8 13h8M9 3l1.2 2h3.6L15 3M6 7h12v11a3 3 0 01-3 3H9a3 3 0 01-3-3z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

/** 移动端设置页：保留设置逻辑，只切换为与桌面新版一致的紧凑工作台视觉。 */
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
    <div className="m-settings-screen fixed inset-0 flex flex-col" style={{ zIndex: Z_SETTINGS }}>
      <header className="m-settings-header m-context-header shrink-0" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="m-context-bar">
          <button className="m-icon-button" onClick={onBack} aria-label="返回">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <div className="m-context-title">
            <strong>设置</strong>
            <span>Android 工作区</span>
          </div>
          <span className="w-11 h-11 shrink-0" aria-hidden="true" />
        </div>
      </header>

      <main className="m-settings-content flex-1 overflow-y-auto overscroll-contain">
        <section className="m-settings-hero">
          <span className="m-eyebrow">设备偏好</span>
          <h1>偏好与运行状态</h1>
          <p>管理移动端主题、预取、缓存、整理规则与诊断信息。</p>
        </section>

        <section className="m-settings-group">
          <h2 className="m-settings-group-title">外观</h2>
          <div className="m-settings-card">
            <div className="m-settings-row is-stacked">
              <span className="m-settings-row-icon"><SettingsGlyph name="appearance" /></span>
              <span className="m-settings-row-copy">
                <strong>界面主题</strong>
                <span>移动端使用固定钴蓝强调色，明暗模式仅切换表面与文字。</span>
              </span>
            </div>
            <div className="m-theme-segment" role="group" aria-label="界面主题">
              {(
                [
                  ['system', '跟随系统'],
                  ['light', '浅色'],
                  ['dark', '深色'],
                ] as [ThemeMode, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={theme === value ? 'is-active' : ''}
                  aria-pressed={theme === value}
                  onClick={() => setTheme(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <MobilePerformanceSection />
        <MobileCacheSection />

        <section className="m-settings-group">
          <h2 className="m-settings-group-title">整理规则</h2>
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
        </section>

        <MobileLogSection />

        <section className="m-settings-group">
          <h2 className="m-settings-group-title">关于</h2>
          <div className="m-about-card">
            <span className="m-settings-row-icon"><SettingsGlyph name="about" /></span>
            <span>
              <strong>Kanitsu</strong>
              <small>Android 模式 · v{androidBridge()?.version ?? '0.1.0'}</small>
            </span>
            <em>Local first</em>
          </div>
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
    <section className="m-settings-group">
      <h2 className="m-settings-group-title">性能</h2>
      <div className="m-settings-card">
        <label className="m-settings-row">
          <span className="m-settings-row-icon"><SettingsGlyph name="performance" /></span>
          <span className="m-settings-row-copy">
            <strong>后台预取</strong>
            <span>预生成当前目录、子文件夹与全库缩略图，让连续滚动更流畅。</span>
          </span>
          <input
            type="checkbox"
            className="m-switch"
            checked={prefetch}
            onChange={(e) => setPrefetch(e.target.checked)}
            aria-label="后台预取"
          />
        </label>
      </div>
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
    <section className="m-settings-group">
      <h2 className="m-settings-group-title">缓存</h2>
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
          <button className="m-button" onClick={handleClearRenderer}>清除内存缓存</button>
          <button className="m-button" onClick={() => void handleClearNative()}>清除磁盘缓存</button>
        </div>
        {clearResult && <p className="m-settings-result">{clearResult}</p>}
      </div>
    </section>
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
    <section className="m-settings-group">
      <h2 className="m-settings-group-title">诊断</h2>
      <div className="m-settings-card">
        <label className="m-settings-row">
          <span className="m-settings-row-icon"><SettingsGlyph name="debug" /></span>
          <span className="m-settings-row-copy">
            <strong>日志等级</strong>
            <span>控制渲染端与 Android 原生桥记录的详细程度。</span>
          </span>
          <span className="m-select-wrap m-log-level-wrap">
            <select className="m-select m-log-level-select" value={level} onChange={(e) => setLevel(e.target.value as LogLevel)}>
              {LEVEL_LABELS.map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
          </span>
        </label>
        <div className="m-settings-actions is-three">
          <button className="m-button" onClick={() => setShowLogs((v) => !v)}>{showLogs ? '收起日志' : '查看日志'}</button>
          <button className="m-button" onClick={() => void refreshNativeLogs()}>读取原生</button>
          <button
            className="m-button is-ghost"
            onClick={() => {
              clearDebugLogs();
              setLogs([]);
            }}
          >
            清空
          </button>
        </div>
        {showLogs && (
          <div className="m-log-panel">
            {nativeLogs.length > 0 && <pre>{nativeLogs.join('\n')}</pre>}
            {logs.length === 0 && nativeLogs.length === 0 ? (
              <div className="m-log-empty">暂无日志。</div>
            ) : (
              logs.slice(-80).map((entry, i) => (
                <div key={i} className={`m-log-line is-${entry.level}`}>
                  <span>{fmtTime(entry.time)} </span>
                  <b>[{entry.tag}]</b>{' '}
                  {entry.message}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  );
}
