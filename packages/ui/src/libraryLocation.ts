/**
 * 桌面端「图包保存位置」的桥接与文案（仅 Electron 支持）。
 *
 * Web 演示与 Android 各有自己的应用目录，没有可切换的位置：这些环境下
 * `supportsLibraryLocation()` 为 false，相关调用返回 null/''，由调用方降级
 * （不渲染设置行、不弹首次运行引导）。判定条件与主进程 IPC 一一对应，
 * 便于后续单独测试文案分支。
 */
import type {
  LibraryLocationChangeResult,
  LibraryLocationInfo,
} from '../../fs-adapter/src/electron';

export type { LibraryLocationChangeResult, LibraryLocationInfo };

/** 首次运行引导里说明「本应用复制一份」的处理方式。 */
export const LIBRARY_COPY_NOTICE: readonly string[] = [
  '导入时 Kanitsu 会把图片复制一份到下面这个文件夹，你的原始文件夹和其中的文件不会被修改或删除。',
  '之后在图库里做的整理、重命名、删除都只作用于这份副本，导出 ZIP 也从副本读取。',
  '副本由本应用管理：清空或删除这个文件夹等于清空图库，原处不会自动补回。',
];

/** 当前环境是否支持自定义图包保存位置（桌面端）。 */
export function supportsLibraryLocation(): boolean {
  return typeof window.kanitsuDesktop?.getLibraryLocation === 'function';
}

/** 读取当前保存位置；不支持或读取失败时返回 null。 */
export async function fetchLibraryLocation(): Promise<LibraryLocationInfo | null> {
  const bridge = window.kanitsuDesktop;
  if (!bridge?.getLibraryLocation) return null;
  try {
    return await bridge.getLibraryLocation();
  } catch {
    return null;
  }
}

/** 打开系统文件夹选择框切换保存位置（可能弹出「是否搬移现有图包」询问）。 */
export async function chooseLibraryLocation(): Promise<LibraryLocationChangeResult | null> {
  const bridge = window.kanitsuDesktop;
  if (!bridge?.chooseLibraryLocation) return null;
  try {
    return await bridge.chooseLibraryLocation();
  } catch {
    return { canceled: false, error: '打开文件夹选择框失败，请重试。' };
  }
}

/** 切回默认保存位置。 */
export async function resetLibraryLocation(): Promise<LibraryLocationChangeResult | null> {
  const bridge = window.kanitsuDesktop;
  if (!bridge?.resetLibraryLocation) return null;
  try {
    return await bridge.resetLibraryLocation();
  } catch {
    return { canceled: false, error: '切换保存位置失败，请重试。' };
  }
}

/** 确认当前保存位置（首次运行引导的「使用此位置」），返回确认后的位置。 */
export async function acknowledgeLibraryLocation(): Promise<LibraryLocationInfo | null> {
  const bridge = window.kanitsuDesktop;
  if (!bridge?.acknowledgeLibraryLocation) return null;
  try {
    return await bridge.acknowledgeLibraryLocation();
  } catch {
    return null;
  }
}

/** 是否需要弹「首次运行确认保存位置」：桌面端且用户还没确认过。 */
export function shouldPromptLibraryLocation(info: LibraryLocationInfo | null): boolean {
  return info !== null && !info.confirmed;
}

/**
 * 位置变更后的提示文案。取消返回空串（调用方据此不打提示），
 * 其余分支都给出可读结果，失败时带上主进程给出的原因。
 */
export function describeLocationChange(result: LibraryLocationChangeResult | null): string {
  if (!result) return '当前环境不支持自定义图包保存位置。';
  if (result.canceled) return '';
  if (result.error) return `未更改保存位置：${result.error}`;
  const where = result.isDefault ? '默认位置' : result.path ?? '';
  if (result.moved) {
    const skipped = result.skippedCount
      ? `，另有 ${result.skippedCount} 项因目标已存在同名项留在原位置`
      : '';
    return `已切换保存位置到 ${where}，并搬移了 ${result.movedCount ?? 0} 项图包内容${skipped}。`;
  }
  return `已切换保存位置到 ${where}；原位置的内容保持不变。`;
}
