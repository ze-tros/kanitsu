// 跨端日志契约：桌面（Electron）与未来移动端（Capacitor WebView）共用同一
// 日志格式与等级，保证日志面板/落盘/上报格式一致、解析无歧义。
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  time: number;
  level: LogLevel;
  tag: string;
  message: string;
}

/** 面板/控制台统一的时间展示格式（含时分秒）。 */
export function formatLogTime(time: number): string {
  return new Date(time).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 通用日志行文本（控制台/文件共用）。 */
export function formatLogLine(level: LogLevel, tag: string, message: string): string {
  const hh = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  return `[${hh}] [${level.toUpperCase()}] [${tag}] ${message}`;
}