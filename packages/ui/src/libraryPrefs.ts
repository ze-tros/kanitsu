/**
 * 两端共用的本机偏好与文案：固定封面、隐私预览标记（localStorage），导入跳过 / 整理冲突原因。
 * 桌面（LibraryBrowser）与移动（mobile/）都从这里取，避免移动端反向依赖桌面容器。
 */
import type { ImportSkippedFile } from '../../core/src/index';

export function skippedReasonLabel(reason: ImportSkippedFile['reason']): string {
  switch (reason) {
    case 'no-extension':
      return '无扩展名';
    case 'unsupported-format':
      return '不支持的格式';
    default:
      return reason;
  }
}

export function conflictReasonLabel(reason: string): string {
  switch (reason) {
    case 'source-missing':
      return '源文件缺失';
    case 'target-exists':
      return '目标已存在';
    case 'move-failed':
      return '移动失败';
    default:
      return reason;
  }
}

const BLUR_STORAGE_KEY = 'kanitsu-blurred-images';
const PINNED_COVERS_KEY = 'kanitsu-pinned-covers';

export function loadPinnedCovers(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PINNED_COVERS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function savePinnedCovers(covers: Record<string, string>): void {
  try {
    localStorage.setItem(PINNED_COVERS_KEY, JSON.stringify(covers));
  } catch {
    // ignore storage errors
  }
}

export function loadBlurredImages(): ReadonlySet<string> {
  try {
    // 旧版按相册（文件夹）存储，现改为逐图标记，作废旧键。
    localStorage.removeItem('kanitsu-blurred-albums');
    const raw = localStorage.getItem(BLUR_STORAGE_KEY);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

export function saveBlurredImages(paths: ReadonlySet<string>): void {
  try {
    localStorage.setItem(BLUR_STORAGE_KEY, JSON.stringify([...paths]));
  } catch {
    // ignore storage errors
  }
}

export function isImageBlurred(relPath: string | undefined, blurred: ReadonlySet<string>): boolean {
  return !!relPath && blurred.has(relPath);
}
