/**
 * 桌面端「数据目录」的桥接与文案（仅 Electron 支持）。
 *
 * Web 演示与 Android 各有自己的应用目录，没有可选的数据目录：这些环境下
 * `supportsDataDir()` 为 false，相关调用返回 null/''，由调用方降级（不渲染设置行）。
 * 首次启动引导（DataDirSetup，独立引导窗口 ?setup=1）只在数据目录未设置时出现，
 * 选定并确认后主进程直接创建主窗口——之后不再询问。
 */
import type {
  DataDirChoice,
  DataDirConfirmResult,
} from '../../fs-adapter/src/electron';

export type { DataDirChoice, DataDirConfirmResult };

/** 首次启动引导里说明「数据目录放什么、怎么管理」的要点。 */
export const DATA_DIR_NOTICE: readonly string[] = [
  '导入时 Kanitsu 会把图片复制一份到这个文件夹，你的原始文件夹和其中的文件不会被修改或删除。',
  '图库副本、缩略图缓存、RAW 预览缓存、日志与索引数据都存放在这里（图库在其 albums 子目录）。',
  '之后在图库里做的整理、重命名、删除都只作用于这份副本，导出 ZIP 也从副本读取。',
  '只有少量配置文件会留在系统应用数据目录。',
];

/** 当前环境是否支持自定义数据目录（桌面端）。 */
export function supportsDataDir(): boolean {
  return typeof window !== 'undefined' && typeof window.kanitsuDesktop?.getDataDir === 'function';
}

/** 读取当前数据目录（空串=尚未设置）；不支持或读取失败时返回 null。 */
export async function fetchDataDir(): Promise<string | null> {
  const bridge = typeof window !== 'undefined' ? window.kanitsuDesktop : undefined;
  if (!bridge?.getDataDir) return null;
  try {
    return (await bridge.getDataDir()) || null;
  } catch {
    return null;
  }
}

/** 打开系统文件夹选择框挑选数据目录（只回显候选、不落盘；确认走 confirmDataDir）。 */
export async function chooseDataDir(): Promise<DataDirChoice | null> {
  const bridge = typeof window !== 'undefined' ? window.kanitsuDesktop : undefined;
  if (!bridge?.chooseDataDir) return null;
  try {
    return await bridge.chooseDataDir();
  } catch {
    return { canceled: false, error: '打开文件夹选择框失败，请重试。' };
  }
}

/** 确认候选路径为数据目录：主进程校验并落盘设置，成功后直接打开主界面。 */
export async function confirmDataDir(path: string): Promise<DataDirConfirmResult | null> {
  const bridge = typeof window !== 'undefined' ? window.kanitsuDesktop : undefined;
  if (!bridge?.confirmDataDir) return null;
  try {
    return await bridge.confirmDataDir(path);
  } catch {
    return { ok: false, error: '设置数据目录失败，请重试。' };
  }
}
