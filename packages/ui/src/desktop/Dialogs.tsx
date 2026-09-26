/**
 * 桌面对话框：输入（重命名 / 新建 / 合并）、删除确认、移动目标选择、快捷键表、封面选择。
 * 统一行为：打开时聚焦首个可交互元素，Tab 在对话框内循环，Esc 关闭，点遮罩关闭。
 */
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import {
  ArrowsLeftRight,
  CaretRight,
  FolderPlus,
  House,
  MagnifyingGlass,
  PencilSimple,
  ShieldCheck,
  Sparkle,
  Star,
  X,
} from '@phosphor-icons/react';
import type { FolderNode, ImageEntry, LibrarySnapshot } from '../../../core/src/index';
import { childrenOf, directImagesOf, imagesOf } from '../../../core/src/index';
import type { FileRef, LibraryStore } from '../../../fs-adapter/src/types';
import { pickCover } from '../../../cover-picker/src/index';
import { BlobImage } from '../BlobImage';
import { DESKTOP_SHORTCUTS } from '../desktopShortcuts';
import { COVER_THUMBNAIL_SIZE, preloadThumbnails, THUMB_PRIORITY_DIRECTIONAL, THUMB_PRIORITY_SUBFOLDER } from '../thumbnailCache';
import { FolderTree } from './Sidebar';
import { formatBytes, formatCount, imageFileRef } from './shared';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** 对话框键盘行为：Esc 关闭、Tab 焦点循环；卸载时把焦点还给打开前的元素。 */
export function useDialogKeys(ref: RefObject<HTMLElement | null>, onEscape: () => void, autoFocus = true): void {
  const escRef = useRef(onEscape);
  escRef.current = onEscape;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (autoFocus) {
      const node = ref.current;
      const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? node?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const node = ref.current;
      if (!node) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        escRef.current();
      } else if (event.key === 'Tab') {
        const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !node.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !node.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    // 捕获阶段：先于页面级快捷键处理，避免 Esc 同时关闭对话框和清空选择。
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [autoFocus, ref]);
}

export function DialogFrame({
  label,
  className,
  style,
  onClose,
  onEscape,
  children,
}: {
  label: string;
  className?: string;
  style?: CSSProperties;
  onClose: () => void;
  /** Esc 的处理；缺省同 onClose（例如对话框内有行内编辑时先退出编辑）。 */
  onEscape?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogKeys(ref, onEscape ?? onClose);
  return (
    <div className="dk-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={ref} className={`dk-dlg ${className ?? ''}`} style={style} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

// —— 输入对话框 ——

export interface PromptOptions {
  title: string;
  description?: string;
  initialValue: string;
  confirmLabel?: string;
  hint?: string;
  /** 返回错误文案；空串表示通过。 */
  validate: (value: string) => string;
  /** 重命名文件时只预选主文件名（不含扩展名）。 */
  selectStem?: boolean;
  onSubmit: (value: string) => void;
}

export function PromptDialog({ options, onClose }: { options: PromptOptions; onClose: () => void }) {
  const [value, setValue] = useState(options.initialValue);
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const error = touched ? options.validate(value) : '';

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = options.selectStem ? options.initialValue.lastIndexOf('.') : -1;
    input.setSelectionRange(0, dot > 0 ? dot : options.initialValue.length);
  }, [options.initialValue, options.selectStem]);

  const submit = () => {
    setTouched(true);
    const message = options.validate(value);
    if (message) return;
    onClose();
    options.onSubmit(value.trim());
  };

  return (
    <DialogFrame label={options.title} onClose={onClose}>
      <div className="dk-dlg-h">
        <h2>{options.title}</h2>
        {options.description && <p>{options.description}</p>}
      </div>
      <div className="dk-dlg-b">
        <div className={`dk-field ${error ? 'err' : ''}`}>
          <PencilSimple size={15} />
          <input
            ref={inputRef}
            value={value}
            spellCheck={false}
            aria-invalid={Boolean(error)}
            aria-describedby="dk-prompt-hint"
            onChange={(event) => {
              setValue(event.target.value);
              setTouched(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <div id="dk-prompt-hint" className={`dk-hint-t ${error ? 'err' : ''}`}>
          {error || options.hint || '不能包含 \\ / : * ? " < > |，也不能与同级重名。'}
        </div>
      </div>
      <div className="dk-dlg-f">
        <button type="button" className="dk-btn ghost" onClick={onClose}>取消</button>
        <button type="button" className="dk-btn primary" onClick={submit}>{options.confirmLabel ?? '保存'}</button>
      </div>
    </DialogFrame>
  );
}

// —— 删除确认 ——

export interface DeleteRequest {
  images: ImageEntry[];
  folders: FolderNode[];
}

export function DeleteDialog({
  request,
  snapshot,
  store,
  blurredImages,
  coverFor,
  onConfirm,
  onClose,
}: {
  request: DeleteRequest;
  snapshot: LibrarySnapshot;
  store: LibraryStore;
  blurredImages: ReadonlySet<string>;
  coverFor: (folderId: string) => ImageEntry | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { images, folders } = request;
  const stats = useMemo(() => {
    let count = images.length;
    let bytes = images.reduce((sum, image) => sum + image.size, 0);
    for (const folder of folders) {
      for (const image of imagesOf(snapshot, folder.id)) {
        count++;
        bytes += image.size;
      }
    }
    return { count, bytes };
  }, [folders, images, snapshot]);
  const what =
    folders.length === 1 && images.length === 0
      ? `图包「${folders[0]!.name}」`
      : images.length === 1 && folders.length === 0
        ? `「${images[0]!.name}」`
        : `${formatCount(images.length + folders.length)} 项`;
  const thumbs = [...images, ...folders.map((folder) => coverFor(folder.id)).filter((image): image is ImageEntry => Boolean(image))];
  return (
    <DialogFrame label={`删除${what}`} onClose={onClose}>
      <div className="dk-dlg-h">
        <h2>删除{what}？</h2>
        <p>
          将从 Kanitsu 图库删除 {formatCount(stats.count)} 张图片的副本（{formatBytes(stats.bytes)}）
          {folders.length > 0 ? '，包括全部子图包' : ''}。此操作无法撤销。
        </p>
      </div>
      <div className="dk-dlg-b">
        {thumbs.length > 0 && (
          <div className="dk-del-list" aria-hidden="true">
            {thumbs.slice(0, 6).map((image) => (
              <span key={image.id}>
                <BlobImage store={store} fileRef={imageFileRef(image)} alt="" className="dk-art" thumbnail lazy blur={blurredImages.has(image.relPath)} />
              </span>
            ))}
            {thumbs.length > 6 && <em>+{formatCount(thumbs.length - 6)}</em>}
          </div>
        )}
        <div className="dk-warnbox">
          <ShieldCheck size={16} />
          <span>只删除图库里的副本。导入时的源文件夹不受影响，需要时可以重新导入。</span>
        </div>
      </div>
      <div className="dk-dlg-f">
        <button type="button" className="dk-btn ghost" onClick={onClose}>取消</button>
        <button type="button" className="dk-btn danger" data-autofocus onClick={onConfirm}>删除</button>
      </div>
    </DialogFrame>
  );
}

// —— 移动到… ——

export function MoveDialog({
  count,
  snapshot,
  store,
  blurredImages,
  coverFor,
  isDisabled,
  initialExpanded,
  onCreateFolder,
  onConfirm,
  onClose,
}: {
  count: number;
  snapshot: LibrarySnapshot;
  store: LibraryStore;
  blurredImages: ReadonlySet<string>;
  coverFor: (folderId: string) => ImageEntry | null;
  /** 不可作为目标的目录（被移动的图包自身及其子树）。 */
  isDisabled: (folder: FolderNode) => boolean;
  initialExpanded: ReadonlySet<string>;
  onCreateFolder: (parent: FolderNode, onCreated: (folder: FolderNode) => void) => void;
  onConfirm: (target: FolderNode) => void;
  onClose: () => void;
}) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(initialExpanded);
  const scrollRef = useRef<HTMLDivElement>(null);
  const root = snapshot.folders[snapshot.rootId];
  const target = targetId ? snapshot.folders[targetId] ?? null : null;
  const rootDisabled = root ? isDisabled(root) : true;
  return (
    <DialogFrame label={`移动 ${count} 项`} className="dk-move-dlg" onClose={onClose}>
      <div className="dk-dlg-h">
        <h2>移动 {formatCount(count)} 项到…</h2>
        <p>只在图库内移动，不影响源文件夹。重名的图片会自动追加序号。</p>
      </div>
      <div className="dk-dlg-b">
        <div ref={scrollRef} className="dk-pick-tree dk-scroll">
          {root && (
            <div className={`dk-tree-row ${targetId === root.id ? 'on' : ''} ${rootDisabled ? 'disabled' : ''}`} style={{ paddingLeft: 4 }}>
              <span className="dk-car ph" />
              <button type="button" className="dk-go" disabled={rootDisabled} onClick={() => setTargetId(root.id)}>
                <span className="dk-mt dk-mt-icon"><House size={13} /></span>
                <span className="dk-nm">图库根目录</span>
              </button>
            </div>
          )}
          <FolderTree
            snapshot={snapshot}
            selectedFolderId=""
            onSelect={() => undefined}
            expandedFolders={expanded}
            onToggleFolder={(id) => setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })}
            scrollRootRef={scrollRef}
            store={store}
            coverFor={coverFor}
            blurredImages={blurredImages}
            pick={{ onPick: (folder) => setTargetId(folder.id), pickedId: targetId, isDisabled }}
          />
        </div>
      </div>
      <div className="dk-dlg-f">
        <button
          type="button"
          className="dk-btn ghost dk-lead"
          disabled={!target && !root}
          onClick={() => {
            const parent = target ?? root;
            if (!parent) return;
            onCreateFolder(parent, (created) => {
              setExpanded((prev) => new Set(prev).add(parent.id));
              setTargetId(created.id);
            });
          }}
        >
          <FolderPlus size={15} />新建图包
        </button>
        {/* 默认聚焦「取消」：聚焦目录行的描边容易被误看成已选中。 */}
        <button type="button" className="dk-btn ghost" data-autofocus onClick={onClose}>取消</button>
        <button type="button" className="dk-btn primary" disabled={!target} onClick={() => target && onConfirm(target)}>
          <ArrowsLeftRight size={15} />
          {target ? `移动到「${target.relPath ? target.name : '图库根目录'}」` : '选择目标'}
        </button>
      </div>
    </DialogFrame>
  );
}

// —— 快捷键 ——

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <DialogFrame label="键盘快捷键" className="dk-keys-dlg" onClose={onClose}>
      <div className="dk-dlg-h"><h2>键盘快捷键</h2></div>
      <div className="dk-dlg-b dk-scroll">
        <div className="dk-keys">
          {DESKTOP_SHORTCUTS.map((group) => (
            <Fragment key={group.title}>
              <h4>{group.title}</h4>
              {group.items.map((item) => (
                <div key={item.label}>
                  <span>{item.label}</span>
                  <span>{item.keys.map((key) => <kbd key={key} className="dk-kbd">{key}</kbd>)}</span>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
      <div className="dk-dlg-f"><button type="button" className="dk-btn primary" data-autofocus onClick={onClose}>知道了</button></div>
    </DialogFrame>
  );
}

// —— 封面选择 ——

const COVER_PAGE = 120;

/**
 * 图包封面选择：可逐层进入子图包挑图，也可直接用子图包的封面；
 * 最终固定的封面始终属于发起设置的图包。onPick(null) = 恢复智能封面。
 */
export function CoverDialog({
  folderId,
  snapshot,
  store,
  pinnedCovers,
  blurredImages,
  onPick,
  onClose,
}: {
  folderId: string;
  snapshot: LibrarySnapshot;
  store: LibraryStore;
  pinnedCovers: Record<string, string>;
  blurredImages: ReadonlySet<string>;
  onPick: (imageId: string | null) => void;
  onClose: () => void;
}) {
  const currentPinned = pinnedCovers[folderId] ?? null;
  const [chain, setChain] = useState<string[]>([folderId]);
  const [selectedId, setSelectedId] = useState<string | null>(currentPinned && snapshot.images[currentPinned] ? currentPinned : null);
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(COVER_PAGE);
  const currentId = chain[chain.length - 1]!;
  const target = snapshot.folders[folderId];
  const smart = useMemo(() => pickCover(imagesOf(snapshot, folderId), {}), [folderId, snapshot]);

  const childCards = useMemo(
    () => childrenOf(snapshot, currentId)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
      .map((child) => ({ folder: child, cover: pickCover(imagesOf(snapshot, child.id), { preferredId: pinnedCovers[child.id] }) })),
    [currentId, pinnedCovers, snapshot],
  );
  const direct = useMemo(() => directImagesOf(snapshot, currentId), [currentId, snapshot]);
  const q = query.trim().toLocaleLowerCase();
  const matching = q ? direct.filter((image) => image.name.toLocaleLowerCase().includes(q)) : direct;

  useEffect(() => {
    setQuery('');
    setVisible(COVER_PAGE);
  }, [currentId]);

  // 打开 / 切换目录时预热当前目录缩略图与子图包封面（与主视图同一缓存键）。
  useEffect(() => {
    const token = { cancelled: false };
    const files: FileRef[] = direct.slice(0, COVER_PAGE).map(imageFileRef);
    const covers: FileRef[] = childCards
      .map((card) => (card.cover ? snapshot.images[card.cover.imageId] : undefined))
      .filter((image): image is ImageEntry => Boolean(image))
      .map(imageFileRef);
    if (files.length) preloadThumbnails(store, files, { priority: THUMB_PRIORITY_DIRECTIONAL, shouldStop: () => token.cancelled });
    if (covers.length) preloadThumbnails(store, covers, { priority: THUMB_PRIORITY_SUBFOLDER, maxSize: COVER_THUMBNAIL_SIZE, shouldStop: () => token.cancelled });
    return () => {
      token.cancelled = true;
    };
  }, [childCards, direct, snapshot, store]);

  const tile = (image: ImageEntry, extra?: ReactNode) => {
    const blurred = blurredImages.has(image.relPath);
    return (
      <button
        key={image.id}
        type="button"
        className={selectedId === image.id ? 'on' : ''}
        aria-pressed={selectedId === image.id}
        title={image.name}
        onClick={() => setSelectedId(image.id)}
        onDoubleClick={() => {
          onClose();
          onPick(image.id);
        }}
      >
        <BlobImage store={store} fileRef={imageFileRef(image)} alt={image.name} className="dk-art" thumbnail lazy blur={blurred} />
        {extra}
      </button>
    );
  };

  return (
    <DialogFrame label={`设置「${target?.name ?? ''}」的封面`} className="dk-cover-dlg" onClose={onClose}>
      <div className="dk-dlg-h">
        <h2>设置「{target?.name}」的封面</h2>
        <p>固定的封面优先于智能选择；恢复后按命名、尺寸与比例自动挑选。双击直接设为封面。</p>
        {chain.length > 1 && (
          <nav className="dk-crumbs" aria-label="封面选择位置">
            {chain.map((id, i) => (
              <Fragment key={id}>
                {i > 0 && <CaretRight size={11} />}
                <button type="button" onClick={() => setChain((prev) => prev.slice(0, i + 1))}>{snapshot.folders[id]?.name ?? '…'}</button>
              </Fragment>
            ))}
          </nav>
        )}
      </div>
      <div className="dk-dlg-b dk-scroll grow">
        {childCards.length > 0 && (
          <>
            <h4 className="dk-h4">子图包 · 进入挑选，或点 ★ 直接用它的封面</h4>
            <div className="dk-cover-grid folders">
              {childCards.map(({ folder, cover }) => {
                const image = cover ? snapshot.images[cover.imageId] : undefined;
                const blurred = image ? blurredImages.has(image.relPath) : false;
                return (
                  <div key={folder.id} className="dk-cover-folder">
                    <button type="button" className="dk-cover-folder-open" onClick={() => setChain((prev) => [...prev, folder.id])} title={`进入${folder.name}`}>
                      {image && <BlobImage store={store} fileRef={imageFileRef(image)} alt="" className="dk-art" thumbnail lazy blur={blurred} />}
                      <small>{folder.name}</small>
                    </button>
                    {image && (
                      <button type="button" className="dk-cover-star" title="用这个子图包的封面" aria-label={`使用${folder.name}的封面`} onClick={() => setSelectedId(image.id)}>
                        <Star size={13} weight={selectedId === image.id ? 'fill' : 'regular'} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
        <div className="dk-cover-bar">
          <h4 className="dk-h4">图片 · {formatCount(matching.length)}</h4>
          {direct.length > 12 && (
            <div className="dk-field">
              <MagnifyingGlass size={13} />
              <input value={query} placeholder="按文件名筛选" onChange={(event) => setQuery(event.target.value)} />
              {query && <button type="button" aria-label="清除" onClick={() => setQuery('')}><X size={12} /></button>}
            </div>
          )}
        </div>
        {matching.length > 0 ? (
          <div className="dk-cover-grid">
            {matching.slice(0, visible).map((image) =>
              tile(image, smart?.imageId === image.id && !currentPinned ? <span className="dk-badge tl"><Sparkle size={11} weight="fill" />智能</span> : undefined),
            )}
          </div>
        ) : (
          <p className="dk-tip dk-cover-none">{q ? '没有匹配的图片。' : '这一层没有图片，可以进入子图包挑选。'}</p>
        )}
        {matching.length > visible && (
          <div className="dk-more-row">
            <button type="button" className="dk-btn ghost" onClick={() => setVisible((n) => n + COVER_PAGE)}>再显示 {formatCount(Math.min(COVER_PAGE, matching.length - visible))} 张</button>
          </div>
        )}
      </div>
      <div className="dk-dlg-f">
        <button
          type="button"
          className="dk-btn ghost dk-lead"
          disabled={!currentPinned}
          onClick={() => {
            onClose();
            onPick(null);
          }}
        >
          <Sparkle size={15} />恢复智能封面
        </button>
        <button type="button" className="dk-btn ghost" onClick={onClose}>取消</button>
        <button
          type="button"
          className="dk-btn primary"
          disabled={!selectedId || selectedId === currentPinned}
          onClick={() => {
            onClose();
            if (selectedId) onPick(selectedId);
          }}
        >
          设为封面
        </button>
      </div>
    </DialogFrame>
  );
}
