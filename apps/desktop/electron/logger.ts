// 主进程日志：结构化（时间/等级/tag/消息），写 UTF-8 日志文件 + 同步控制台。
// 不引入第三方框架：本应用只需 分级过滤 + 落盘 + 尾部读取，几十行足够，
// 也避免给 Electron 打包引入额外依赖。日志文件在 userData/logs/kanitsu-日期.log。
import { app } from 'electron';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = 'info';
let logFilePath: string | null = null;

/** 是否为直连终端（非 npm/管道转发）。直连时输出中文（配合 chcp 65001）；
 *  经管道转发（如 npm → cmd）时输出 ASCII 安全版，避免 GBK 控制台乱码。 */
const consoleIsTTY = typeof process.stdout.isTTY === 'boolean' ? process.stdout.isTTY : false;

/** 控制台用词映射：常用中文词 → 英文。 */
const CONSOLE_DICT: Array<[RegExp, string]> = [
  [/缓存未命中/g, 'cache-miss'],
  [/磁盘命中/g, 'disk-hit'],
  [/队列状态/g, 'queue'],
  [/转生成/g, 'gen'],
  [/缩略图/g, 'thumb'],
  [/生成/g, 'gen'],
  [/失败/g, 'fail'],
  [/回退/g, 'fallback'],
  [/原样/g, 'passthrough'],
  [/动画/g, 'anim'],
  [/跳过/g, 'skip'],
  [/可用/g, 'ready'],
  [/留给可见请求处理/g, 'left-for-visible'],
  [/，/g, ','],
  [/。/g, '.'],
  [/：/g, ':'],
  [/“|”/g, '"'],
];

/** 非直连终端用：映射常见词后，其余非 ASCII 转 \uXXXX，输出 100% ASCII。 */
function asciiForConsole(text: string): string {
  let out = text;
  for (const [re, rep] of CONSOLE_DICT) out = out.replace(re, rep);
  return out.replace(/[^\x20-\x7E]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function todayFile(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return path.join(app.getPath('userData'), 'logs', `kanitsu-${stamp}.log`);
}

async function ensureFile(): Promise<string> {
  if (!logFilePath) {
    logFilePath = todayFile();
    await mkdir(path.dirname(logFilePath), { recursive: true }).catch(() => {});
  }
  return logFilePath;
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function log(level: LogLevel, tag: string, message: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const time = new Date().toISOString();
  const line = `[${time}] [${level.toUpperCase()}] [${tag}] ${message}`;
  // 控制台：直连终端输出完整中文（配合 chcp 65001）；管道转发场景输出 ASCII 安全版。
  // 文件：始终完整 UTF-8 中文（可读性最佳），设置页“主进程日志”面板同样可读。
  console.log(consoleIsTTY ? line : asciiForConsole(line));
  void ensureFile()
    .then((file) => appendFile(file, line + '\n', 'utf8'))
    .catch(() => {});
}

export const logger = {
  debug: (tag: string, message: string): void => log('debug', tag, message),
  info: (tag: string, message: string): void => log('info', tag, message),
  warn: (tag: string, message: string): void => log('warn', tag, message),
  error: (tag: string, message: string): void => log('error', tag, message),
};

/** 读取当日日志尾部（供设置页“调试→主进程日志”展示）。 */
export async function readLogTail(maxLines = 300): Promise<string[]> {
  try {
    const file = await ensureFile();
    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}