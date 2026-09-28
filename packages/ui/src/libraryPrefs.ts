/**
 * 两端共用的本机偏好与文案：固定封面、隐私预览标记（localStorage），导入跳过 / 整理冲突原因。
 * 桌面（LibraryBrowser）与移动（mobile/）都从这里取，避免移动端反向依赖桌面容器。
 */
import type { ImportSkippedFile, OrganizeAction } from '../../core/src/index';
import { joinRelPath } from '../../core/src/index';

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
    // 旧版按相册（文件夹）存储的键已废弃，读取前清除。
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

/**
 * 按「旧 relPath → 新 relPath」迁移隐私标记：remap 对每个旧路径返回新路径
 * （返回 null 或原路径表示不变）。重命名 / 移动 / 整理后调用，让标记跟着
 * 文件走——否则新路径不糊（隐私泄露）、旧路径残留死标记（后续同名新文件被误糊）。
 */
export function remapBlurredPaths(
  prev: ReadonlySet<string>,
  remap: (relPath: string) => string | null,
): ReadonlySet<string> {
  let changed = false;
  const next = new Set<string>();
  for (const p of prev) {
    const to = remap(p);
    if (to === null || to === p) {
      next.add(p);
    } else {
      next.add(to);
      changed = true;
    }
  }
  return changed ? next : prev;
}

/** 丢弃不再存在的路径标记（删除图片 / 图包后清理）。alive 返回 false 的标记被移除。 */
export function pruneBlurredPaths(
  prev: ReadonlySet<string>,
  alive: (relPath: string) => boolean,
): ReadonlySet<string> {
  let changed = false;
  const next = new Set<string>();
  for (const p of prev) {
    if (alive(p)) next.add(p);
    else changed = true;
  }
  return changed ? next : prev;
}

/** 构造「目录前缀重写」回调：图包重命名 / 整体移动后，子树内全部标记按前缀迁移。 */
export function folderPrefixRemap(
  prefixes: ReadonlyMap<string, string>,
): (relPath: string) => string | null {
  return (relPath) => {
    let best: { from: string; to: string } | null = null;
    for (const [from, to] of prefixes) {
      if ((relPath === from || relPath.startsWith(`${from}/`)) && (!best || from.length > best.from.length)) {
        best = { from, to };
      }
    }
    if (!best) return null;
    return relPath === best.from
      ? best.to
      : `${best.to}/${relPath.slice(best.from.length + 1)}`;
  };
}

/** 整合「精确路径改写」（图片重命名/移动）与「目录前缀改写」（图包移动）的统一回调。 */
export function blurredPathRemap(
  exact: ReadonlyMap<string, string>,
  prefixes?: ReadonlyMap<string, string>,
): (relPath: string) => string | null {
  const prefixRemap = prefixes && prefixes.size > 0 ? folderPrefixRemap(prefixes) : null;
  return (relPath) => exact.get(relPath) ?? (prefixRemap ? prefixRemap(relPath) : null);
}

/** 从整理 / 移动清单的 action 构造「旧图片 relPath → 新图片 relPath」精确映射。 */
export function relPathPairsFromActions(
  actions: readonly OrganizeAction[],
): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const a of actions) {
    const from = joinRelPath(a.fromRelPath, a.fromName);
    const to = joinRelPath(a.toRelPath, a.toName);
    if (from !== to) pairs.set(from, to);
  }
  return pairs;
}

const GIF_THUMB_ANIMATED_KEY = 'kanitsu-gif-thumb-animated';
let gifThumbAnimated: boolean | null = null;

/**
 * GIF 网格缩略图是否保持动画（动图 / 静态首帧）。默认开（动图）。
 * 影响生成路径（桌面 worker / Android 原生），经 readThumbnail 的选项逐请求
 * 传到生成端，两端缓存键都随模式区分，切换后不会命中旧图。
 */
export function loadGifThumbnailAnimated(): boolean {
  if (gifThumbAnimated === null) {
    try {
      const raw = localStorage.getItem(GIF_THUMB_ANIMATED_KEY);
      gifThumbAnimated = raw === null ? true : raw === '1';
    } catch {
      gifThumbAnimated = true;
    }
  }
  return gifThumbAnimated;
}

export function setGifThumbnailAnimated(value: boolean): void {
  gifThumbAnimated = value;
  try {
    localStorage.setItem(GIF_THUMB_ANIMATED_KEY, value ? '1' : '0');
  } catch {
    // ignore storage errors
  }
}
