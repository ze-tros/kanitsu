// 渲染端调试日志：轻量环形缓冲 + 控制台输出（按日志等级过滤） + 可插拔 sink。
// 契约（LogLevel/LogEntry/时间格式）来自 packages/core/log，桌面与未来移动端
// 共用同一格式；sink 可用于移动端落盘/上报。
import type { LogEntry, LogLevel } from '../../core/src/index';
import { formatLogLine } from '../../core/src/index';

const MAX_LOGS = 300;
const LEVEL_KEY = 'kanitu-log-level';
const PREFETCH_KEY = 'kanitu-prefetch-enabled';
const logs: LogEntry[] = [];
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function isLevel(v: string | null): v is LogLevel {
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error';
}

/** 当前渲染端日志等级（控制台过滤、可持久化）。 */
export function getLogLevelPref(): LogLevel {
  try {
    const v = localStorage.getItem(LEVEL_KEY);
    return isLevel(v) ? v : 'info';
  } catch {
    return 'info';
  }
}

export function setLogLevelPref(level: LogLevel): void {
  try {
    localStorage.setItem(LEVEL_KEY, level);
  } catch {
    // 忽略存储错误
  }
}

/** 预取主开关（当前目录/子文件夹/全库后台预热；用于调试“开-关”对照）。 */
export function isPrefetchEnabled(): boolean {
  try {
    return localStorage.getItem(PREFETCH_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setPrefetchEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(PREFETCH_KEY, enabled ? '1' : '0');
  } catch {
    // 忽略存储错误
  }
}

/** 可插拔外部 sink（移动端落盘/上报用）；有则每条日志同步投递。 */
let externalSink: ((entry: LogEntry) => void) | null = null;

export function setDebugLogSink(fn: ((entry: LogEntry) => void) | null): void {
  externalSink = fn;
}

export function logDebug(tag: string, message: string, level: LogLevel = 'info'): void {
  const entry: LogEntry = { time: Date.now(), level, tag, message };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  // 控制台按配置的日志等级过滤（环形缓冲始终全量记录，面板可看）
  if (LEVEL_ORDER[level] >= LEVEL_ORDER[getLogLevelPref()]) {
    // eslint-disable-next-line no-console
    console.debug(formatLogLine(level, tag, message));
  }
  externalSink?.(entry);
}

export function getDebugLogs(): readonly LogEntry[] {
  return logs;
}

export function clearDebugLogs(): void {
  logs.length = 0;
}

export type { LogEntry, LogLevel };
export { formatLogLine };