/**
 * 命令面板（Ctrl+K）：在本机索引里搜索图包与图片，并执行常用命令。
 * 不联网；输入只在内存里过滤，结果条数有上限，大库下也不会一次挂载大量节点。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react';
import type { FolderNode, ImageEntry, LibrarySnapshot } from '../../../core/src/index';
import type { LibraryStore } from '../../../fs-adapter/src/types';
import { BlobImage } from '../BlobImage';
import { useDialogKeys } from './Dialogs';
import { EmptyState } from './pageParts';
import { formatCount, imageFileRef } from './shared';

export interface PaletteCommand {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  run: () => void;
  /** 额外的检索词（英文 / 同义词）。 */
  keywords?: string;
}

type Item =
  | { kind: 'folder'; folder: FolderNode }
  | { kind: 'image'; image: ImageEntry }
  | { kind: 'command'; command: PaletteCommand };

const FOLDER_LIMIT = 6;
const IMAGE_LIMIT = 8;

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const i = text.toLowerCase().indexOf(query);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

export function CommandPalette({
  snapshot,
  store,
  scopeFolder,
  blurredImages,
  coverFor,
  commands,
  filterCommand,
  initialQuery = '',
  onOpenFolder,
  onOpenImage,
  onClose,
}: {
  snapshot: LibrarySnapshot | null;
  store: LibraryStore;
  /** 在图包页打开时：图片只在该图包（含子目录）内搜索。 */
  scopeFolder: FolderNode | null;
  blurredImages: ReadonlySet<string>;
  coverFor: (folderId: string) => ImageEntry | null;
  commands: readonly PaletteCommand[];
  /** 有输入时追加的「在网格中筛选」命令。 */
  filterCommand?: (query: string) => PaletteCommand | null;
  initialQuery?: string;
  onOpenFolder: (folder: FolderNode) => void;
  onOpenImage: (image: ImageEntry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useDialogKeys(ref, onClose, false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const folders = useMemo(
    () => (snapshot ? Object.values(snapshot.folders).filter((folder) => folder.relPath) : []),
    [snapshot],
  );
  const scopedImages = useMemo(() => {
    if (!snapshot) return [];
    if (!scopeFolder || scopeFolder.id === snapshot.rootId) return Object.values(snapshot.images);
    const prefix = `${scopeFolder.relPath}/`;
    return Object.values(snapshot.images).filter((image) => image.relPath.startsWith(prefix));
  }, [scopeFolder, snapshot]);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const out: { title: string; items: Item[] }[] = [];
    const matchedFolders: FolderNode[] = [];
    for (const folder of folders) {
      if (!q || folder.name.toLowerCase().includes(q)) {
        matchedFolders.push(folder);
        if (matchedFolders.length >= (q ? FOLDER_LIMIT : 4)) break;
      }
    }
    if (matchedFolders.length) out.push({ title: '图包', items: matchedFolders.map((folder) => ({ kind: 'folder', folder })) });
    if (q) {
      const matchedImages: ImageEntry[] = [];
      for (const image of scopedImages) {
        if (image.name.toLowerCase().includes(q)) {
          matchedImages.push(image);
          if (matchedImages.length >= IMAGE_LIMIT) break;
        }
      }
      if (matchedImages.length) {
        out.push({
          title: scopeFolder && scopeFolder.relPath ? `「${scopeFolder.name}」中的图片` : '图片',
          items: matchedImages.map((image) => ({ kind: 'image', image })),
        });
      }
    }
    const extra = q && filterCommand ? filterCommand(query.trim()) : null;
    const cmds = [...(extra ? [extra] : []), ...commands].filter(
      (command) => !q || command === extra || command.label.toLowerCase().includes(q) || command.keywords?.toLowerCase().includes(q),
    );
    if (cmds.length) out.push({ title: '命令', items: cmds.map((command) => ({ kind: 'command', command })) });
    return out;
  }, [commands, filterCommand, folders, q, query, scopeFolder, scopedImages]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  useEffect(() => setHighlight(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.dk-pal-i.hl')?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === 'folder') onOpenFolder(item.folder);
    else if (item.kind === 'image') onOpenImage(item.image);
    else item.command.run();
  };

  let index = -1;
  return (
    <>
      <div className="dk-scrim dk-scrim-clear" onMouseDown={onClose} />
      <div ref={ref} className="dk-pal" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="dk-pal-in">
          <MagnifyingGlass size={18} />
          <input
            ref={inputRef}
            value={query}
            placeholder={scopeFolder && scopeFolder.relPath ? '在当前图包中搜索图片，或搜索图包、命令' : '搜索图包、图片或命令'}
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="dk-pal-list"
            aria-activedescendant={flat.length ? `dk-pal-${highlight}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (flat.length) setHighlight((h) => (h + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                run(flat[highlight]);
              }
            }}
          />
          <kbd className="dk-kbd">Esc</kbd>
        </div>
        <div ref={listRef} id="dk-pal-list" className="dk-pal-b dk-scroll" role="listbox">
          {flat.length === 0 ? (
            <EmptyState compact title="没有匹配结果" text="试试图包名、文件名或命令。" />
          ) : (
            groups.map((group) => (
              <div key={group.title} role="group" aria-label={group.title}>
                <div className="dk-pal-g">{group.title}</div>
                {group.items.map((item) => {
                  index++;
                  const i = index;
                  const common = {
                    id: `dk-pal-${i}`,
                    role: 'option',
                    'aria-selected': i === highlight,
                    className: `dk-pal-i ${i === highlight ? 'hl' : ''}`,
                    onMouseMove: () => i !== highlight && setHighlight(i),
                    onClick: () => run(item),
                  } as const;
                  if (item.kind === 'folder') {
                    const cover = coverFor(item.folder.id);
                    const parent = item.folder.parentId ? snapshot?.folders[item.folder.parentId] : undefined;
                    return (
                      <button key={item.folder.id} type="button" {...common}>
                        <span className="dk-th">{cover && <BlobImage store={store} fileRef={imageFileRef(cover)} alt="" className="dk-art" thumbnail lazy blur={blurredImages.has(cover.relPath)} />}</span>
                        <span className="dk-t">
                          <Highlight text={item.folder.name} query={q} />
                          <small>{parent?.relPath ? parent.relPath : '图库'} · {formatCount(item.folder.imageCount)} 张</small>
                        </span>
                      </button>
                    );
                  }
                  if (item.kind === 'image') {
                    const blurred = blurredImages.has(item.image.relPath);
                    const folder = snapshot?.folders[item.image.folderId];
                    return (
                      <button key={item.image.id} type="button" {...common}>
                        <span className="dk-th"><BlobImage store={store} fileRef={imageFileRef(item.image)} alt="" className="dk-art" thumbnail lazy blur={blurred} /></span>
                        <span className="dk-t">
                          <Highlight text={item.image.name} query={q} />
                          <small>{folder?.name ?? ''}</small>
                        </span>
                      </button>
                    );
                  }
                  return (
                    <button key={item.command.id} type="button" {...common}>
                      <span className="dk-ico">{item.command.icon}</span>
                      <span className="dk-t"><Highlight text={item.command.label} query={q} /></span>
                      {item.command.shortcut && <kbd className="dk-kbd">{item.command.shortcut}</kbd>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="dk-pal-f">
          <span><kbd className="dk-kbd">↑</kbd><kbd className="dk-kbd">↓</kbd>选择</span>
          <span><kbd className="dk-kbd">Enter</kbd>打开</span>
          <span className="dk-push">只在本机索引中搜索</span>
        </div>
      </div>
    </>
  );
}
