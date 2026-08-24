import type { FolderRef, ImportSourcePicker, LibraryStore } from '../../fs-adapter/src/types';
import type { ImportTask } from './types';
import { extOf, isSupportedImage, joinRelPath } from './path';
import { stableHash } from './hash';

export interface ImportOptions {
  onProgress?: (state: { status: string; scanned: number; copied: number; skipped: number; current?: string }) => void;
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

  const sourceRoot = await picker.pickFolder();
  task.sourceFolderName = sourceRoot.name || '未命名相册';
  options.onProgress?.({ status: 'scanning', scanned: 0, copied: 0, skipped: 0, current: sourceRoot.name });

  await store.ensureLibraryRoot();
  const targetTop = await store.createTopFolder(task.sourceFolderName);
  task.targetTopFolder = targetTop.name;
  task.status = 'copying';

  async function copyFolder(srcFolder: FolderRef, dstFolder: FolderRef, relPath: string): Promise<void> {
    for await (const child of picker.listChildren(srcFolder)) {
      task.scannedFileCount++;
      if (child.kind === 'folder') {
        const nextDst = await store.createFolder(dstFolder, child.name);
        await copyFolder(child, nextDst, joinRelPath(relPath, child.name));
      } else if (isSupportedImage(child.name)) {
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

  await copyFolder(sourceRoot, targetTop, '');
  task.status = 'done';
  task.finishedAt = Date.now();
  return task;
}