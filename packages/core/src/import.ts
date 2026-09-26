import type { FolderRef, ImportSourcePicker, LibraryStore } from '../../fs-adapter/src/types';
import type { ImportTask } from './types';
import { extOf, isSupportedImage, joinRelPath } from './path';
import { stableHash } from './hash';

export interface ImportOptions {
  onProgress?: (state: { status: string; scanned: number; copied: number; skipped: number; current?: string }) => void;
  /** 原生任务取消 token：传入后 UI 可通过 store.cancelTask(token) 取消（Android SAF 原生导入）。 */
  cancelToken?: string;
  /** 非原生回退路径的取消判定：返回 true 时停止复制并标记已取消（已复制文件保留）。 */
  shouldCancel?: () => boolean;
  /**
   * 已解析好的导入源（如桌面端拖入并经原生确认的文件夹，来自 picker.resolveDroppedFolder）。
   * 传入后不再调用 picker.pickFolder，其余流程（原生快速路径、回退复制、进度、取消、释放授权）不变。
   */
  source?: FolderRef;
}

/** 用户取消导入的哨兵错误：不清理已复制文件、不视为失败。 */
class ImportCancelledError extends Error {
  constructor() {
    super('已取消');
    this.name = 'ImportCancelledError';
  }
}

export async function importFolder(
  picker: ImportSourcePicker,
  store: LibraryStore,
  options: ImportOptions = {},
): Promise<ImportTask> {
  const task: ImportTask = {
    id: stableHash(`import-${Date.now()}-${Math.random()}`),
    sourceFolderName: '',
    targetTopFolder: '',
    status: 'picking',
    scannedFileCount: 0,
    copiedImageCount: 0,
    skippedCount: 0,
    skippedFiles: [],
    errors: [],
    createdAt: Date.now(),
  };

  let targetTop: FolderRef | null = null;
  try {
    const sourceRoot = options.source ?? await picker.pickFolder();
    task.sourceFolderName = sourceRoot.name || '未命名相册';
    options.onProgress?.({ status: 'scanning', scanned: 0, copied: 0, skipped: 0, current: sourceRoot.name });

    await store.ensureLibraryRoot();

    // Native fast path (Android SAF / Electron) copies the whole source tree without
    // round-tripping file bytes through the JS bridge. Platforms without it fall back
    // to picker.readBlob + store.writeBlob below.
    if (store.importSourceTree) {
      task.status = 'copying';
      const result = await store.importSourceTree(sourceRoot, task.sourceFolderName, (p) =>
        options.onProgress?.({
          status: 'copying',
          scanned: p.scanned,
          copied: p.copied,
          skipped: p.skipped,
          current: p.current,
        }),
        options.cancelToken,
      );
      task.targetTopFolder = result.targetTopFolder;
      task.scannedFileCount = result.scannedFileCount;
      task.copiedImageCount = result.copiedImageCount;
      task.skippedCount = result.skippedCount;
      task.skippedFiles = result.skippedFiles;
      task.errors = result.errors;
       task.status = result.canceled ? 'canceled' : 'done';
      task.finishedAt = Date.now();
      return task;
    }

    targetTop = await store.createTopFolder(task.sourceFolderName);
    task.targetTopFolder = targetTop.name;
    task.status = 'copying';

    async function copyFolder(srcFolder: FolderRef, dstFolder: FolderRef, relPath: string): Promise<void> {
      for await (const child of picker.listChildren(srcFolder)) {
        if (options.shouldCancel?.()) throw new ImportCancelledError();
        if (child.kind === 'folder') {
          const nextDst = await store.createFolder(dstFolder, child.name);
          await copyFolder(child, nextDst, joinRelPath(relPath, child.name));
        } else {
          task.scannedFileCount++;
          if (isSupportedImage(child.name)) {
            try {
              const blob = await picker.readBlob(child);
              await store.writeBlob(dstFolder, child.name, blob);
              task.copiedImageCount++;
            } catch (err) {
              task.errors.push(`${child.name}: ${String(err)}`);
            }
          } else {
            const ext = extOf(child.name);
            task.skippedCount++;
            task.skippedFiles.push({
              path: joinRelPath(relPath, child.name),
              reason: ext ? 'unsupported-format' : 'no-extension',
            });
          }
          options.onProgress?.({
            status: 'copying',
            scanned: task.scannedFileCount,
            copied: task.copiedImageCount,
            skipped: task.skippedCount,
            current: child.name,
          });
        }
      }
    }

    await copyFolder(sourceRoot, targetTop, '');
    task.status = 'done';
    task.finishedAt = Date.now();
    return task;
  } catch (err) {
    if (err instanceof ImportCancelledError) {
      // 取消：已复制的文件保留在目标目录，任务标记为 canceled，不视为失败。
      task.status = 'canceled';
      task.finishedAt = Date.now();
      return task;
    }
    task.status = 'failed';
    task.finishedAt = Date.now();
    if (targetTop) {
      try {
        await store.remove(targetTop);
      } catch (cleanupErr) {
        task.errors.push(`清理失败：${String(cleanupErr)}`);
      }
    }
    throw err;
  } finally {
    try {
      await picker.release?.();
    } catch {
      // Releasing the source grant is best-effort and must not mask the import result.
    }
  }
}
