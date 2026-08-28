import { useEffect, useState } from 'react';
import type { LibrarySnapshot } from '../../core/src/types';
import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';
import { childrenOf, directImagesOf, imagesOf } from '../../core/src/index';
import { pickCover } from '../../cover-picker/src/index';
import { BlobImage } from './BlobImage';
import { preloadThumbnails, THUMB_PRIORITY_DIRECTIONAL, THUMB_PRIORITY_SUBFOLDER } from './thumbnailCache';

const MAX_PREVIEW = 500;

/**
 * 图包封面选择弹窗：层次化浏览 —— 展示当前目录的直属图片与子文件夹，
 * 可进入子文件夹挑选其中图片，也可点卡片上的 ⭐ 直接用该子文件夹的封面。
 * 无论浏览到哪一层，最终设置的封面都属于发起设置的 folderId 目录。
 * onPick(null) 表示取消固定封面。
 */
export function CoverPickerModal({
  folderId,
  snapshot,
  store,
  pinnedCovers,
  currentCoverId,
  onPick,
  onCancel,
}: {
  folderId: string;
  snapshot: LibrarySnapshot;
  store: LibraryStore;
  /** 各目录已固定的封面 id，用于子文件夹卡片展示真实封面。 */
  pinnedCovers?: Record<string, string>;
  currentCoverId: string | null;
  onPick: (imageId: string | null) => void;
  onCancel: () => void;
}) {
  /** 从目标目录到当前浏览目录的路径（id 栈）。 */
  const [chain, setChain] = useState<string[]>([folderId]);
  const [selectedId, setSelectedId] = useState<string | null>(
    currentCoverId && snapshot.images[currentCoverId] ? currentCoverId : null,
  );

  const currentId = chain[chain.length - 1];
  const targetName = snapshot.folders[folderId]?.name ?? '';

  const childFolders = childrenOf(snapshot, currentId).sort((a, b) => a.name.localeCompare(b.name));
  const childCards = childFolders.map((child) => ({
    folder: child,
    cover: pickCover(imagesOf(snapshot, child.id), { preferredId: pinnedCovers?.[child.id] }),
  }));

  const directImages = directImagesOf(snapshot, currentId);
  const previewImages = directImages.slice(0, MAX_PREVIEW);
  const truncated = directImages.length > MAX_PREVIEW;
  const selectedImage = selectedId ? snapshot.images[selectedId] : undefined;

  const goTo = (index: number) => setChain((prev) => prev.slice(0, index + 1));
  const enterChild = (id: string) => setChain((prev) => [...prev, id]);

  // 与主视图同款低优先级预热：打开弹窗或切换浏览目录时，把当前目录的直属图片
  // （优先级 1＝滚动方向预取档，仅次于可见）与子文件夹封面（优先级 3）排入同一
  // 缓存/队列。外部已生成的缩略图（键一致）直接命中复用；未生成过的也提前后台
  // 生成，滚动/点选时即出图。
  useEffect(() => {
    const token = { cancelled: false };
    const direct: FileRef[] = [];
    const covers: FileRef[] = [];
    for (const img of directImagesOf(snapshot, currentId)) {
      direct.push({ id: img.fileRefId ?? img.id, name: img.name, kind: 'file', mtime: img.mtime, size: img.size });
    }
    for (const child of childrenOf(snapshot, currentId)) {
      const cover = pickCover(imagesOf(snapshot, child.id), { preferredId: pinnedCovers?.[child.id] });
      const coverImg = cover ? snapshot.images[cover.imageId] : undefined;
      if (coverImg) {
        covers.push({ id: coverImg.fileRefId ?? coverImg.id, name: coverImg.name, kind: 'file', mtime: coverImg.mtime, size: coverImg.size });
      }
    }
    if (direct.length > 0) preloadThumbnails(store, direct, { priority: THUMB_PRIORITY_DIRECTIONAL, shouldStop: () => token.cancelled });
    if (covers.length > 0) preloadThumbnails(store, covers, { priority: THUMB_PRIORITY_SUBFOLDER, shouldStop: () => token.cancelled });
    return () => {
      token.cancelled = true;
    };
  }, [snapshot, currentId, store, pinnedCovers]);

  return (
    <div className="modal modal-open z-[120]">
      <div className="modal-box max-w-3xl flex flex-col max-h-[80vh]">
        <h3 className="font-bold text-lg shrink-0">设置封面：{targetName}</h3>

        <nav className="breadcrumbs text-xs mt-1 opacity-80 shrink-0" aria-label="封面选择位置">
          <ul>
            {chain.map((id, i) => (
              <li key={id}>
                {i < chain.length - 1 ? (
                  <a className="link link-hover" onClick={() => goTo(i)}>
                    {snapshot.folders[id]?.name ?? '…'}
                  </a>
                ) : (
                  <span className="font-semibold">{snapshot.folders[id]?.name ?? '…'}</span>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <p className="text-xs opacity-70 mt-1 shrink-0">进入子文件夹挑选其中的图片，或点子文件夹卡片上的 ⭐ 直接用它的封面。</p>

        <div className="flex-1 min-h-0 overflow-y-auto mt-3">
        {childCards.length > 0 && (
          <section className="mt-3">
            <h4 className="text-xs font-semibold opacity-70 mb-2">子文件夹</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {childCards.map(({ folder, cover }) => (
                <div key={folder.id} className="card bg-base-100 border border-base-300 overflow-hidden">
                  <div
                    role="button"
                    tabIndex={0}
                    className="relative aspect-[4/3] w-full overflow-hidden cursor-pointer group"
                    title={`进入“${folder.name}”`}
                    onClick={() => enterChild(folder.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') enterChild(folder.id);
                    }}
                  >
                    {cover ? (
                      <BlobImage
                        store={store}
                        fileRef={{
                          id: snapshot.images[cover.imageId]?.fileRefId ?? cover.imageId,
                          name: snapshot.images[cover.imageId]?.name ?? '',
                          kind: 'file',
                          mtime: snapshot.images[cover.imageId]?.mtime,
                          size: snapshot.images[cover.imageId]?.size,
                        }}
                        alt={folder.name}
                        className="w-full h-full object-cover"
                        thumbnail
                        lazy
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center opacity-60 text-sm">无图片</div>
                    )}
                    <button
                      type="button"
                      className="btn btn-xs btn-circle btn-primary absolute top-1 right-1 shadow opacity-0 group-hover:opacity-100 focus:opacity-100 transition"
                      disabled={!cover}
                      title={cover ? `将“${folder.name}”的封面用作本图包封面` : '该子文件夹暂无图片'}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (cover) onPick(cover.imageId);
                      }}
                    >
                      ⭐
                    </button>
                  </div>
                  <figcaption className="p-2 text-xs truncate">{folder.name}</figcaption>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mt-3">
          <h4 className="text-xs font-semibold opacity-70 mb-2">
            图片（{directImages.length} 张{truncated ? `，仅显示前 ${MAX_PREVIEW} 张` : ''}）
          </h4>
          {previewImages.length > 0 ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {previewImages.map((img) => {
                const active = img.id === selectedId;
                return (
                  <button
                    key={img.id}
                    type="button"
                    title={img.name}
                    className={`relative rounded-lg overflow-hidden border-2 aspect-[4/3] ${
                      active ? 'border-primary ring-2 ring-primary/40' : 'border-transparent hover:border-base-content/30'
                    }`}
                    onClick={() => setSelectedId(active ? null : img.id)}
                  >
                    <BlobImage
                      store={store}
                      fileRef={{ id: img.fileRefId ?? img.id, name: img.name, kind: 'file', mtime: img.mtime, size: img.size }}
                      alt={img.name}
                      className="w-full h-full object-cover"
                      thumbnail
                      lazy
                    />
                    {active && <span className="absolute top-1 right-1 badge badge-primary badge-sm">✓</span>}
                    <span className="absolute bottom-0 inset-x-0 text-[10px] px-1 py-0.5 bg-black/50 text-white truncate">
                      {img.name}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-sm opacity-60 py-3 text-center">本目录暂无图片，可进入子文件夹挑选。</p>
          )}
        </section>

        </div>

        {selectedImage && <p className="mt-2 text-xs opacity-70 truncate shrink-0">已选择：{selectedImage.relPath}</p>}
        <div className="modal-action flex-wrap gap-2 shrink-0">
          {currentCoverId != null && (
            <button className="btn btn-ghost btn-sm mr-auto" onClick={() => onPick(null)}>
              取消固定封面
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            关闭
          </button>
          <button className="btn btn-primary btn-sm" disabled={!selectedId} onClick={() => selectedId && onPick(selectedId)}>
            设为封面
          </button>
        </div>
      </div>
    </div>
  );
}
