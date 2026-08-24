import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  applyOrganize,
  childrenOf,
  createSubfolder,
  deleteImage,
  deleteLibraryFolder,
  directImagesOf,
  imagesOf,
  importFolder,
  joinRelPath,
  loadOrScan,
  renameFolder,
  renameImage,
  rescanLibrary,
  undoOrganize,
  type FolderNode,
  type ImageEntry,
  type ImportSkippedFile,
  type ImportTask,
  type LibrarySnapshot,
  type OrganizeBinding,
  type OrganizeManifest,
  type OrganizeResult,
  type PersistentIndex,
} from '../../core/src/index';
import type { ImportSourcePicker, LibraryStore } from '../../fs-adapter/src/types';
import type { KanituDesktopBridge } from '../../fs-adapter/src/electron';
import { organizeByFolder, type CustomOrganizeRule } from '../../organizer/src/index';
import { pickCover } from '../../cover-picker/src/index';
import { BlobImage } from './BlobImage';
import { ContextMenu, type ContextMenuItem, type ContextMenuModel } from './ContextMenu';
import { loadCustomRules, saveCustomRules } from './OrganizeRulesModal';
import { OrganizePreview } from './OrganizePreview';
import { FolderUpIcon, HomeIcon, NavButton, NavIconButton, PanelLeftIcon, SettingsIcon } from './NavButton';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { SettingsPage } from './SettingsPage';

function skippedReasonLabel(reason: ImportSkippedFile['reason']): string {
  switch (reason) {
    case 'no-extension':
      return '无扩展名';
    case 'unsupported-format':
      return '不支持的格式';
    default:
      return reason;
  }
}

function conflictReasonLabel(reason: string): string {
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

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const BLUR_STORAGE_KEY = 'kanitu-blurred-albums';
const PINNED_COVERS_KEY = 'kanitu-pinned-covers';

function loadPinnedCovers(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PINNED_COVERS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function savePinnedCovers(covers: Record<string, string>): void {
  try {
    localStorage.setItem(PINNED_COVERS_KEY, JSON.stringify(covers));
  } catch {
    // ignore storage errors
  }
}

function loadBlurredPaths(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(BLUR_STORAGE_KEY);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

function saveBlurredPaths(paths: ReadonlySet<string>): void {
  try {
    localStorage.setItem(BLUR_STORAGE_KEY, JSON.stringify([...paths]));
  } catch {
    // ignore storage errors
  }
}

function isPathBlurred(relPath: string | undefined, blurred: ReadonlySet<string>): boolean {
  if (!relPath) return false;
  let p = relPath;
  while (p) {
    if (blurred.has(p)) return true;
    const idx = p.lastIndexOf('/');
    if (idx < 0) break;
    p = p.slice(0, idx);
  }
  return false;
}

export function LibraryBrowser({
  picker,
  store,
  index,
}: {
  picker: ImportSourcePicker;
  store: LibraryStore;
  index: PersistentIndex;
}) {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string>('');
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageKind, setMessageKind] = useState<'info' | 'success' | 'error'>('info');
  const [organizePreview, setOrganizePreview] = useState<OrganizeBinding[] | null>(null);
  const [organizeResult, setOrganizeResult] = useState<OrganizeResult | null>(null);
  const [lastManifest, setLastManifest] = useState<OrganizeManifest | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [organizeProgress, setOrganizeProgress] = useState<{ done: number; total: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);
  const [importReport, setImportReport] = useState<ImportTask | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'folder'; folder: FolderNode } | { kind: 'image'; image: ImageEntry } | null>(null);
  const [promptState, setPromptState] = useState<{
    kind: 'rename-image' | 'rename-folder' | 'create-folder';
    title: string;
    label: string;
    initialValue: string;
    image?: ImageEntry;
    folder?: FolderNode;
  } | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [blurredPaths, setBlurredPaths] = useState<ReadonlySet<string>>(() => loadBlurredPaths());
  const [searchQuery, setSearchQuery] = useState('');
  const [sidebarHidden, setSidebarHidden] = useState(() => localStorage.getItem('kanitu-sidebar-hidden') === '1');
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const value = Number(localStorage.getItem('kanitu-sidebar-width'));
    return Number.isFinite(value) && value >= 200 && value <= 480 ? value : 288;
  });
  const [customRules, setCustomRules] = useState<CustomOrganizeRule[]>(() => loadCustomRules());
  const [showSettings, setShowSettings] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuModel | null>(null);
  const [pinnedCovers, setPinnedCovers] = useState<Record<string, string>>(() => loadPinnedCovers());

  const applySnapshot = useCallback((next: LibrarySnapshot) => {
    setSnapshot(next);
    setSelectedFolderId((prev) => (prev && next.folders[prev] ? prev : next.rootId));
  }, []);

  const notify = useCallback((text: string, kind?: 'info' | 'success' | 'error') => {
    const detected = kind ?? (/失败|错误/.test(text) ? 'error' : (/完成|成功|^已/.test(text) ? 'success' : 'info'));
    setMessage(text);
    setMessageKind(detected);
  }, []);

  // Persist sidebar appearance across sessions.
  useEffect(() => {
    try {
      localStorage.setItem('kanitu-sidebar-hidden', sidebarHidden ? '1' : '0');
    } catch {
      // Ignore storage errors.
    }
  }, [sidebarHidden]);

  useEffect(() => {
    try {
      localStorage.setItem('kanitu-sidebar-width', String(sidebarWidth));
    } catch {
      // Ignore storage errors.
    }
  }, [sidebarWidth]);

  // Startup: load the cached index (no full re-scan). Fallback scans + persists.
  useEffect(() => {
    void (async () => {
      applySnapshot(await loadOrScan(store, index));
    })();
  }, [store, index, applySnapshot]);

  // Mutation / explicit refresh: re-scan from disk and persist the fresh index.
  const refresh = useCallback(async () => {
    const next = await rescanLibrary(store, index);
    applySnapshot(next);
    return next;
  }, [store, index, applySnapshot]);

  // Auto-dismiss the toast message after a short delay (like the demo).
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => notify(''), 3500);
    return () => clearTimeout(t);
  }, [message]);

  const searchTerm = searchQuery.trim().toLowerCase();
  const folderImages = useMemo(() => {
    if (!snapshot) return [];
    const id = selectedFolderId || snapshot.rootId;
    const images = directImagesOf(snapshot, id);
    return searchTerm ? images.filter((img) => img.name.toLowerCase().includes(searchTerm)) : images;
  }, [snapshot, selectedFolderId, searchTerm]);

  const childFolders = useMemo(() => {
    if (!snapshot) return [];
    const id = selectedFolderId || snapshot.rootId;
    const folders = childrenOf(snapshot, id).sort((a, b) => a.name.localeCompare(b.name));
    return searchTerm ? folders.filter((f) => f.name.toLowerCase().includes(searchTerm)) : folders;
  }, [snapshot, selectedFolderId, searchTerm]);

  const childFolderCards = useMemo(() => {
    if (!snapshot) return [];
    return childFolders.map((child) => ({
      folder: child,
      cover: pickCover(imagesOf(snapshot, child.id), { preferredId: pinnedCovers[child.id] }),
    }));
  }, [snapshot, childFolders, pinnedCovers]);

  const selectedFolder = snapshot?.folders[selectedFolderId || snapshot?.rootId || ''] ?? null;
  const rootFolder = snapshot?.folders[snapshot.rootId] ?? null;
  const selectedParentFolder = selectedFolder?.parentId ? snapshot?.folders[selectedFolder.parentId] ?? null : null;
  const runtimeLabel =
    (window as { kanituDesktop?: { platform?: string } }).kanituDesktop?.platform === 'electron'
      ? 'Electron 模式 v0.5 · daisyUI 5'
      : 'Web 模式 v0.5 · daisyUI 5';
  const isRootSelected = !selectedFolderId || selectedFolderId === snapshot?.rootId;
  const effectiveBlur = useMemo(
    () => (selectedFolder ? isPathBlurred(selectedFolder.relPath, blurredPaths) : false),
    [selectedFolder, blurredPaths],
  );

  // Breadcrumb path from the library root to the selected folder.
  const crumbs = useMemo(() => {
    if (!snapshot || !selectedFolder) return [];
    const chain: FolderNode[] = [];
    let node: FolderNode | undefined = selectedFolder;
    while (node) {
      chain.unshift(node);
      node = node.parentId ? snapshot.folders[node.parentId] : undefined;
    }
    return chain;
  }, [snapshot, selectedFolder]);

  const cover = useMemo(() => {
    if (!selectedFolder || !snapshot) return null;
    const images = directImagesOf(snapshot, selectedFolder.id);
    return pickCover(images, { preferredId: pinnedCovers[selectedFolder.id] });
  }, [snapshot, selectedFolder, pinnedCovers]);

  const toggleFolder = useCallback((id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectFolder = useCallback(
    (folder: FolderNode) => {
      setSelectedFolderId(folder.id);
      if (folder.childCount > 0) {
        setExpandedFolders((prev) => {
          if (prev.has(folder.id)) return prev;
          const next = new Set(prev);
          next.add(folder.id);
          return next;
        });
      }
    },
    [],
  );

  const handleGoUp = useCallback(() => {
    if (!snapshot || !selectedFolder?.parentId) return;
    const parent = snapshot.folders[selectedFolder.parentId];
    if (parent) handleSelectFolder(parent);
  }, [snapshot, selectedFolder, handleSelectFolder]);

  const handleGoRoot = useCallback(() => {
    if (rootFolder) handleSelectFolder(rootFolder);
  }, [rootFolder, handleSelectFolder]);

  // In the viewer: switch to a sibling folder (same level) and show its first image.
  const handleViewerSwitchSibling = useCallback(
    (dir: number) => {
      if (!snapshot) return;
      const currentId = selectedFolderId || snapshot.rootId;
      if (currentId === snapshot.rootId) return;
      const parentId = snapshot.folders[currentId]?.parentId ?? snapshot.rootId;
      const siblings = childrenOf(snapshot, parentId).sort((a, b) => a.name.localeCompare(b.name));
      if (siblings.length === 0) return;
      const index = siblings.findIndex((f) => f.id === currentId);
      const next = siblings[(index + dir + siblings.length) % siblings.length]!;
      handleSelectFolder(next);
      const first = directImagesOf(snapshot, next.id)[0];
      if (first) setViewerImageId(first.id);
    },
    [snapshot, selectedFolderId, handleSelectFolder],
  );

  const handleAdd = async () => {
    setBusy(true);
    notify('正在导入…');
    try {
      const task = await importFolder(picker, store, {
        onProgress: (p) =>
          notify(`导入中：已扫描 ${p.scanned}，已复制 ${p.copied}，已跳过 ${p.skipped}`),
      });
      setImportReport(task);
      const next = await refresh();
      const importedTopFolder = Object.values(next.folders).find(
        (folder) => folder.parentId === next.rootId && folder.name === task.targetTopFolder,
      );
      if (importedTopFolder) {
        setSelectedFolderId(importedTopFolder.id);
        setExpandedFolders((prev) => {
          const nextSet = new Set(prev);
          nextSet.add(importedTopFolder.id);
          return nextSet;
        });
      }
      notify(
        task.skippedCount > 0
          ? `导入完成：复制 ${task.copiedImageCount} 张，跳过 ${task.skippedCount} 张。`
          : `导入完成：复制 ${task.copiedImageCount} 张。`,
      );
    } catch (err) {
      notify(`导入失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const openOrganizePreviewFor = (folder: FolderNode) => {
    if (!snapshot || !folder) return;
    setSelectedFolderId(folder.id);
    setOrganizePreview(organizeByFolder(imagesOf(snapshot, folder.id), { customRules }));
    setOrganizeResult(null);
    setOrganizeProgress(null);
  };

  const openOrganizePreview = () => {
    if (selectedFolder) openOrganizePreviewFor(selectedFolder);
  };

  const handleCustomRulesChange = useCallback((rules: CustomOrganizeRule[]) => {
    setCustomRules(rules);
    saveCustomRules(rules);
  }, []);

  const handleApplyOrganize = async () => {
    if (!snapshot || !selectedFolder || !organizePreview) return;
    setOrganizing(true);
    setOrganizeProgress({ done: 0, total: organizePreview.length });
    try {
      const result = await applyOrganize(store, snapshot, selectedFolder.relPath, organizePreview, {
        onProgress: (done, total) => setOrganizeProgress({ done, total }),
      });
      setOrganizePreview(null);
      setOrganizeResult(result);
      setLastManifest(result.manifest);
      await refresh();
      notify(
        result.conflicts.length > 0
          ? `已整理 ${result.appliedCount} 个文件，${result.conflicts.length} 个冲突。`
          : `已整理 ${result.appliedCount} 个文件。`,
      );
    } catch (err) {
      notify(`整理失败：${String(err)}`);
    } finally {
      setOrganizing(false);
      setOrganizeProgress(null);
    }
  };

  const handleUndoOrganize = async () => {
    if (!lastManifest) return;
    setBusy(true);
    notify('正在撤销整理…');
    try {
      const result = await undoOrganize(store, lastManifest);
      setLastManifest(null);
      setOrganizeResult(null);
      await refresh();
      notify(
        result.errors.length > 0
          ? `撤销：已还原 ${result.undone} 个，${result.errors.length} 个错误。`
          : `撤销：已还原 ${result.undone} 个文件。`,
      );
    } catch (err) {
      notify(`撤销失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const exportFolder = async (folder: FolderNode) => {
    if (!folder) return;
    setExporting(true);
    setExportProgress({ done: 0, total: 0 });
    notify('正在导出 ZIP…');
    try {
      const result = await store.zipLibrary(folder.relPath, (done, total) => {
        setExportProgress({ done, total });
      });
      setExportProgress(null);
      if (result.kind === 'blob' && result.blob) {
        const base = folder.relPath ? folder.relPath.split('/').pop() : '相册';
        downloadBlob(result.blob, `${base}.zip`);
        notify(`已导出 ${result.exportedCount} 张图片为 ZIP。`);
      } else if (result.outputPath) {
        notify(`已导出 ${result.exportedCount} 张图片到 ${result.outputPath}。`);
      } else {
        notify(`已导出 ${result.exportedCount} 张图片。`);
      }
    } catch (err) {
      setExportProgress(null);
      notify(`导出失败：${String(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const handleExport = async () => {
    if (selectedFolder) await exportFolder(selectedFolder);
  };

  const performDelete = async (folder: FolderNode = selectedFolder!) => {
    if (!folder || !folder.relPath) return;
    const name = folder.name;
    setBusy(true);
    notify(`正在删除“${name}”…`);
    const parentId = folder.parentId;
    try {
      await deleteLibraryFolder(store, folder.relPath);
      await refresh();
      if (parentId) setSelectedFolderId(parentId);
      notify(`已删除“${name}”。`);
    } catch (err) {
      notify(`删除失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const requestDelete = () => {
    if (selectedFolder && selectedFolder.relPath) setDeleteTarget({ kind: 'folder', folder: selectedFolder });
  };
  const requestDeleteImage = (image: ImageEntry) => setDeleteTarget({ kind: 'image', image });
  const requestDeleteFolder = (folder: FolderNode) => setDeleteTarget({ kind: 'folder', folder });

  const toggleBlur = useCallback(() => {
    if (!selectedFolder || !selectedFolder.relPath) return;
    const path = selectedFolder.relPath;
    setBlurredPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      saveBlurredPaths(next);
      return next;
    });
  }, [selectedFolder]);

  const copyPath = useCallback(async (text: string, label = '路径') => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`已复制${label}。`);
    } catch {
      notify(`无法复制，请手动复制：${text}`);
    }
  }, [notify]);

  const pinCover = useCallback((folderId: string, imageId: string | null) => {
    setPinnedCovers((prev) => {
      const next = { ...prev };
      if (imageId) next[folderId] = imageId;
      else delete next[folderId];
      savePinnedCovers(next);
      return next;
    });
    notify(imageId ? '已设为相册封面。' : '已取消固定封面。');
  }, [notify]);

  const handleRenameImage = (image: ImageEntry) => {
    setPromptState({ kind: 'rename-image', title: '重命名图片', label: '新名称', initialValue: image.name, image });
    setPromptValue(image.name);
  };

  const executeRenameImage = async (image: ImageEntry, nextName: string) => {
    const name = nextName.trim();
    if (!name || name === image.name) return;
    setBusy(true);
    try {
      const renamed = await renameImage(store, image, name);
      await refresh();
      notify(`已重命名为“${renamed.name}”。`);
    } catch (err) {
      notify(`重命名失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const executeDeleteImage = async (image: ImageEntry) => {
    if (!image) return;
    setBusy(true);
    try {
      await deleteImage(store, image);
      await refresh();
      notify(`已删除图片“${image.name}”。`);
    } catch (err) {
      notify(`删除失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteTarget = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target.kind === 'image') await executeDeleteImage(target.image);
    else await performDelete(target.folder);
  };

  const handleCreateSubfolder = (folder: FolderNode) => {
    setPromptState({
      kind: 'create-folder',
      title: `在“${folder.name}”中新建子文件夹`,
      label: '文件夹名称',
      initialValue: '新建文件夹',
      folder,
    });
    setPromptValue('新建文件夹');
  };

  const executeCreateSubfolder = async (folder: FolderNode, name: string) => {
    const clean = name.trim();
    if (!clean) return;
    setBusy(true);
    try {
      const createdRel = joinRelPath(folder.relPath, clean);
      await createSubfolder(store, folder.relPath, clean);
      const next = await refresh();
      const created = Object.values(next.folders).find((item) => item.relPath === createdRel);
      if (created) {
        setSelectedFolderId(created.id);
        setExpandedFolders((prev) => {
          const nextSet = new Set(prev);
          nextSet.add(folder.id);
          return nextSet;
        });
      }
      notify(`已创建“${clean}”。`);
    } catch (err) {
      notify(`新建失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRenameFolder = (folder: FolderNode) => {
    if (!folder.relPath) return;
    setPromptState({ kind: 'rename-folder', title: '重命名图包', label: '新名称', initialValue: folder.name, folder });
    setPromptValue(folder.name);
  };

  const executeRenameFolder = async (folder: FolderNode, nextName: string) => {
    const name = nextName.trim();
    if (!name || name === folder.name) return;
    setBusy(true);
    try {
      await renameFolder(store, folder, name);
      await refresh();
      notify(`已重命名为“${name}”。`);
    } catch (err) {
      notify(`重命名失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const submitPrompt = async () => {
    if (!promptState) return;
    const state = promptState;
    const value = promptValue.trim();
    if (!value) return;
    setPromptState(null);
    if (state.kind === 'rename-image' && state.image) await executeRenameImage(state.image, value);
    else if (state.kind === 'rename-folder' && state.folder) await executeRenameFolder(state.folder, value);
    else if (state.kind === 'create-folder' && state.folder) await executeCreateSubfolder(state.folder, value);
  };

  const openContextMenu = useCallback((event: ReactMouseEvent, items: ContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  }, []);

  const buildImageMenu = (image: ImageEntry): ContextMenuItem[] => [
    { label: '查看图片', icon: '🔍', onSelect: () => setViewerImageId(image.id) },
    {
      label: pinnedCovers[image.folderId] === image.id ? '取消固定封面' : '设为封面',
      icon: '⭐',
      onSelect: () => pinCover(image.folderId, pinnedCovers[image.folderId] === image.id ? null : image.id),
    },
    { label: '重命名…', icon: '✏️', onSelect: () => void handleRenameImage(image) },
    { label: '复制路径', icon: '📋', onSelect: () => void copyPath(image.relPath) },
    { label: '删除', icon: '🗑️', danger: true, separator: true, onSelect: () => requestDeleteImage(image) },
  ];

  const buildFolderMenu = (folder: FolderNode): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { label: '打开', icon: '📂', onSelect: () => handleSelectFolder(folder) },
      { label: '新建子文件夹…', icon: '➕', onSelect: () => void handleCreateSubfolder(folder) },
    ];
    if (folder.relPath && folder.childCount > 0) {
      items.push({
        label: expandedFolders.has(folder.id) ? '收起子目录' : '展开子目录',
        icon: expandedFolders.has(folder.id) ? '▾' : '▸',
        onSelect: () => toggleFolder(folder.id),
      });
    }
    if (folder.relPath) {
      items.push({ label: '重命名…', icon: '✏️', onSelect: () => void handleRenameFolder(folder) });
    }
    items.push(
      { label: '整理…', icon: '🧹', onSelect: () => openOrganizePreviewFor(folder) },
      { label: '导出 ZIP…', icon: '📦', onSelect: () => void exportFolder(folder) },
      { label: '复制路径', icon: '📋', onSelect: () => void copyPath(folder.relPath || '根目录') },
    );
    if (folder.relPath) {
      items.push({ label: '删除', icon: '🗑️', danger: true, separator: true, onSelect: () => requestDeleteFolder(folder) });
    }
    return items;
  };

  const viewerImages = folderImages;
  const viewerIndex = viewerImages.findIndex((img) => img.id === viewerImageId);

  return (
    <div className="app-shell flex h-screen flex-col">
      <TitleBar />
      <div className={'drawer flex-1 min-h-0' + (sidebarHidden ? '' : ' lg:drawer-open')}>
        <input id="app-drawer" type="checkbox" className="drawer-toggle" checked={!sidebarHidden} onChange={(event) => setSidebarHidden(!event.target.checked)} />

      <div className="drawer-content flex flex-col min-h-0">
        <div className="navbar bg-base-200 border-b border-base-300 px-4 gap-2 sticky top-0 z-10">
          <div className="flex-none lg:hidden">
            <label htmlFor="app-drawer" className="btn btn-square btn-ghost" aria-label="打开侧边栏">☰</label>
          </div>
          <div className="flex-none flex items-center gap-1">
            <NavIconButton
              onClick={() => setSidebarHidden((value) => !value)}
              className="hidden lg:inline-flex"
              title={sidebarHidden ? '显示侧边栏' : '隐藏侧边栏'}
            >
              <PanelLeftIcon />
            </NavIconButton>
            <NavIconButton onClick={handleGoUp} disabled={!selectedParentFolder} title="上一级目录">
              <FolderUpIcon />
            </NavIconButton>
            <NavIconButton onClick={handleGoRoot} disabled={isRootSelected} active={isRootSelected} title="全部相册">
              <HomeIcon />
            </NavIconButton>
          </div>
          <div className="flex-1 min-w-0">
            <nav className="breadcrumbs text-sm" aria-label="面包屑">
              <ul>
                {crumbs.map((crumb, i) => (
                  <li key={crumb.id} className={i === crumbs.length - 1 ? 'font-semibold' : ''}>
                    {i < crumbs.length - 1 ? (
                      <a className="link link-hover" onClick={() => handleSelectFolder(crumb)}>{crumb.name}</a>
                    ) : (
                      <span>{crumb.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          </div>
          <div className="flex-none">
            <ThemeToggle />
          </div>
        </div>

        <div className="bg-base-100 px-5 lg:px-8 py-3 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="min-w-0">
              <h2 className="text-2xl font-bold min-w-0">{selectedFolder?.name ?? '全部相册'}</h2>
              {(selectedFolder || cover) && (
                <div className="mt-1 text-sm opacity-70 flex flex-wrap gap-x-4 gap-y-1">
                  {selectedFolder && (
                    <span>{selectedFolder.imageCount} 图片 / {selectedFolder.childCount} 子目录</span>
                  )}
                  {cover && (
                    <span>封面：{snapshot?.images[cover.imageId]?.name ?? cover.imageId}</span>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-none shrink-0 flex-wrap justify-end gap-2">
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={handleAdd}>导入相册</button>
            <button className="btn btn-ghost btn-sm" disabled={!selectedFolder} onClick={() => void refresh()}>刷新</button>
            <button className="btn btn-ghost btn-sm" disabled={!selectedFolder} onClick={openOrganizePreview}>整理</button>
            <button className="btn btn-ghost btn-sm" disabled={!lastManifest || busy} onClick={handleUndoOrganize}>撤销</button>
            <button className="btn btn-ghost btn-sm" disabled={!selectedFolder || busy || exporting} onClick={handleExport}>
              {exporting ? '导出中…' : '导出 ZIP'}
            </button>
            <button
              className={`btn btn-sm ${effectiveBlur ? 'btn-active' : 'btn-ghost'}`}
              disabled={!selectedFolder || !selectedFolder.relPath}
              onClick={toggleBlur}
              title={effectiveBlur ? '关闭模糊预览（当前相册及子文件夹）' : '开启模糊预览（当前相册及子文件夹）'}
            >
              {effectiveBlur ? '已模糊' : '模糊预览'}
            </button>
            <button className="btn btn-error btn-sm btn-outline" disabled={!selectedFolder || !selectedFolder.relPath || busy || exporting} onClick={requestDelete}>删除</button>
            {importReport && <button className="btn btn-ghost btn-sm" onClick={() => setImportReport(importReport)}>报告</button>}
          </div>
        </div>

        <main className="flex-1 overflow-y-auto p-5 lg:p-8">
          {childFolderCards.length > 0 && (
            <section className="mb-8">
              <h3 className="text-sm font-semibold opacity-70 mb-3">子文件夹</h3>
              <div className="folder-grid">
                {childFolderCards.map(({ folder, cover }) => (
                  <div
                    key={folder.id}
                    className="card bg-base-200 border border-base-300 shadow hover:shadow-lg transition cursor-pointer overflow-hidden"
                    onClick={() => handleSelectFolder(folder)}
                    onContextMenu={(event) => openContextMenu(event, buildFolderMenu(folder))}
                  >
                    <figure className="aspect-[4/3] overflow-hidden relative">
                      {cover ? (
                        <BlobImage
                          store={store}
                          fileRef={{
                            id: snapshot?.images[cover.imageId]?.fileRefId ?? cover.imageId,
                            name: snapshot?.images[cover.imageId]?.name ?? '',
                            kind: 'file',
                          }}
                          alt={folder.name}
                          className="w-full h-full object-cover"
                          thumbnail
                          lazy
                          blur={isPathBlurred(folder.relPath, blurredPaths)}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center opacity-60 text-sm">无图片</div>
                      )}
                    </figure>
                    <figcaption className="p-3 flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{folder.name}</span>
                      <span className="text-[11px] opacity-60 whitespace-nowrap">{folder.imageCount} 图 / {folder.childCount} 子</span>
                    </figcaption>
                  </div>
                ))}
              </div>
            </section>
          )}

          {folderImages.length > 0 && (
            <section className="mb-8">
              <h3 className="text-sm font-semibold opacity-70 mb-3">图片</h3>
              <div className="gallery-grid">
                {folderImages.map((image) => (
                  <div
                    key={image.id}
                    className="card bg-base-200 border border-base-300 shadow hover:shadow-lg transition cursor-pointer overflow-hidden"
                    onClick={() => setViewerImageId(image.id)}
                    onContextMenu={(event) => openContextMenu(event, buildImageMenu(image))}
                  >
                    <figure className="aspect-[4/3] overflow-hidden relative">
                      <BlobImage
                        store={store}
                        fileRef={{ id: image.fileRefId ?? image.id, name: image.name, kind: 'file' }}
                        alt={image.name}
                        className="w-full h-full object-cover"
                        thumbnail
                        lazy
                        blur={effectiveBlur}
                      />
                    </figure>
                    <figcaption className="p-3">
                      <span className="text-xs truncate block">{image.name}</span>
                    </figcaption>
                  </div>
                ))}
              </div>
            </section>
          )}

          {childFolderCards.length === 0 && folderImages.length === 0 && (
            <div className="border-2 border-dashed border-base-300 rounded-2xl p-12 text-center">
              <p className="text-4xl mb-3">{searchTerm ? '⍰' : '◻'}</p>
              <div className="text-lg font-medium mb-1">{searchTerm ? '未找到匹配结果' : '该目录暂无图片'}</div>
              <p className="text-sm opacity-70 mb-4">{searchTerm ? `没有与“${searchQuery}”匹配的相册或图片` : '导入照片，开始整理你的图库'}</p>
              {!searchTerm && <button className="btn btn-primary" disabled={busy} onClick={handleAdd}>导入图片</button>}
            </div>
          )}
        </main>

      </div>

      <div className="drawer-side">
        <label htmlFor="app-drawer" className="drawer-overlay"></label>
        <aside className="bg-base-200 h-full flex flex-col relative shrink-0" style={{ width: sidebarWidth }}>
          <SidebarResizeHandle width={sidebarWidth} onResize={setSidebarWidth} />
          <div className="p-4 pb-0 flex-1 min-h-0 overflow-y-auto flex flex-col gap-4">
            <div className="px-1">
            <label className="input input-sm w-full flex items-center gap-2 bg-base-100 border-base-300">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 opacity-60"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
              <input
                type="text"
                className="grow"
                placeholder="搜索相册 / 图片…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button className="btn btn-ghost btn-xs btn-square" title="清除搜索" onClick={() => setSearchQuery('')}>✕</button>
              )}
            </label>
          </div>

          {rootFolder && (
            <div>
              <div className="menu-title text-xs opacity-60 px-1 mt-1">快捷</div>
              <div
                className={`flex items-center gap-2 rounded-lg py-1.5 pl-1 pr-2 cursor-pointer ${isRootSelected ? 'bg-primary/15 text-primary' : 'hover:bg-base-300/60'}`}
                onClick={() => handleSelectFolder(rootFolder)}
                onContextMenu={(event) => openContextMenu(event, buildFolderMenu(rootFolder))}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0"><path d="M3 10.5L12 3l9 7.5V21H3z"/></svg>
                <span className="truncate">全部相册</span>
                {rootFolder.imageCount > 0 && <span className={`badge badge-sm ml-auto ${isRootSelected ? 'badge-primary' : 'badge-ghost'}`}>{rootFolder.imageCount}</span>}
              </div>
            </div>
          )}

          <div className="menu-title text-xs opacity-60 px-1 mt-1">目录树</div>
          {snapshot && (
            <FolderTree
              snapshot={snapshot}
              folderId={snapshot.rootId}
              selectedFolderId={selectedFolderId || snapshot.rootId}
              onSelect={handleSelectFolder}
              expandedFolders={expandedFolders}
              onToggleFolder={toggleFolder}
              onFolderContextMenu={(event, folder) => openContextMenu(event, buildFolderMenu(folder))}
              depth={0}
            />
          )}

          </div>
          <div className="p-4 pt-3 border-t border-base-300 shrink-0 flex flex-col gap-2 text-sm bg-base-200">
            {importReport && (
              <NavButton onClick={() => setImportReport(importReport)} className="w-full">
                <span>导入报告</span>
              </NavButton>
            )}
            <NavButton onClick={() => setShowSettings(true)} className="w-full" title="设置">
              <SettingsIcon />
              <span>设置</span>
            </NavButton>
            <div className="text-xs opacity-60 px-1">{runtimeLabel}</div>
          </div>
        </aside>
      </div>

      {showSettings && (
        <SettingsPage
          rules={customRules}
          onChange={handleCustomRulesChange}
          onBack={() => setShowSettings(false)}
          runtimeLabel={runtimeLabel}
          sidebarWidth={sidebarWidth}
          onSidebarWidthChange={setSidebarWidth}
        />
      )}

      {organizePreview && (
        <OrganizePreview
          bindings={organizePreview}
          organizing={organizing}
          progress={organizeProgress}
          onChange={(next) => setOrganizePreview(next)}
          onApply={handleApplyOrganize}
          onClose={() => setOrganizePreview(null)}
        />
      )}

      {organizeResult && (
        <div className="modal modal-open">
          <div className="modal-box max-w-3xl">
            <h3 className="font-bold text-lg">整理结果</h3>
            <div className="flex flex-wrap gap-4 text-sm mb-3">
              <span>已应用：{organizeResult.appliedCount}</span>
              <span>低置信跳过：{organizeResult.skippedLowConfidenceCount}</span>
              <span>冲突：{organizeResult.conflicts.length}</span>
            </div>
            {organizeResult.conflicts.length > 0 && (
              <div className="overflow-x-auto">
                <table className="table table-sm">
                  <thead>
                    <tr><th>文件</th><th>目标</th><th>原因</th></tr>
                  </thead>
                  <tbody>
                    {organizeResult.conflicts.map((c, i) => (
                      <tr key={`${c.imageId}-${i}`}>
                        <td>{c.name}</td>
                        <td>{c.targetRelPath}</td>
                        <td>{conflictReasonLabel(c.reason)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="modal-action"><button className="btn btn-ghost" onClick={() => setOrganizeResult(null)}>关闭</button></div>
          </div>
        </div>
      )}

      {importReport && (
        <div className="modal modal-open">
          <div className="modal-box max-w-3xl">
            <h3 className="font-bold text-lg">导入报告</h3>
            <div className="flex flex-wrap gap-4 text-sm mb-3">
              <span>来源：{importReport.sourceFolderName}</span>
              <span>扫描：{importReport.scannedFileCount}</span>
              <span>复制：{importReport.copiedImageCount}</span>
              <span>跳过：{importReport.skippedCount}</span>
            </div>
            {importReport.skippedFiles.length > 0 && (
              <div className="overflow-x-auto">
                <table className="table table-sm">
                  <thead><tr><th>跳过的文件</th><th>原因</th></tr></thead>
                  <tbody>
                    {importReport.skippedFiles.map((item, idx) => (
                      <tr key={`${item.path}-${idx}`}>
                        <td className="font-mono text-xs">{item.path}</td>
                        <td>{skippedReasonLabel(item.reason)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {importReport.errors.length > 0 && (
              <div className="mt-4">
                <h4 className="text-sm font-semibold mb-2">失败项</h4>
                <div className="overflow-x-auto">
                  <table className="table table-sm">
                    <thead><tr><th>错误</th></tr></thead>
                    <tbody>
                      {importReport.errors.map((error, idx) => (
                        <tr key={`error-${idx}`}>
                          <td className="font-mono text-xs text-error">{error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="modal-action"><button className="btn btn-ghost" onClick={() => setImportReport(null)}>关闭</button></div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">确认删除</h3>
            <p className="py-4 text-sm opacity-80">
              {deleteTarget.kind === 'image'
                ? `确定要删除图片“${deleteTarget.image.name}”吗？此操作不可撤销。`
                : `确定要删除图包“${deleteTarget.folder.name}”及其全部子目录吗？此操作不可撤销。`}
            </p>
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => setDeleteTarget(null)}>取消</button>
              <button className="btn btn-error" onClick={() => void confirmDeleteTarget()}>删除</button>
            </div>
          </div>
        </div>
      )}

      {promptState && (
        <div className="modal modal-open z-[130]">
          <div className="modal-box max-w-md">
            <h3 className="font-bold text-lg">{promptState.title}</h3>
            <div className="form-control w-full mt-3">
              <span className="label-text text-xs">{promptState.label}</span>
              <input
                className="input input-bordered input-sm mt-1 font-mono"
                value={promptValue}
                onChange={(event) => setPromptValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitPrompt();
                  if (event.key === 'Escape') setPromptState(null);
                }}
                autoFocus
              />
            </div>
            <div className="modal-action">
              <button className="btn btn-ghost btn-sm" onClick={() => setPromptState(null)}>取消</button>
              <button className="btn btn-primary btn-sm" onClick={() => void submitPrompt()}>保存</button>
            </div>
          </div>
        </div>
      )}
      </div>

      {viewerImageId && viewerIndex >= 0 ? (
        <Viewer
          images={viewerImages}
          index={viewerIndex}
          store={store}
          onClose={() => setViewerImageId(null)}
          onNavigate={(id) => setViewerImageId(id)}
          onSwitchSibling={handleViewerSwitchSibling}
          onImageContextMenu={(event, image) => openContextMenu(event, buildImageMenu(image))}
        />
      ) : (
        <div className="toast toast-end">
          {message && <div className={`alert alert-${messageKind} shadow-lg`}><span>{message}</span></div>}
          {exporting && exportProgress && (
            <div className="alert alert-info shadow-lg">
              <span>打包中… {exportProgress.done}/{exportProgress.total}</span>
              <progress className="progress progress-info w-24" value={exportProgress.done} max={exportProgress.total || 1} />
            </div>
          )}
        </div>
      )}

      <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />
    </div>
  );
}

function FolderTree({
  snapshot,
  folderId,
  selectedFolderId,
  onSelect,
  expandedFolders,
  onToggleFolder,
  onFolderContextMenu,
  depth,
}: {
  snapshot: LibrarySnapshot;
  folderId: string;
  selectedFolderId: string;
  onSelect: (folder: FolderNode) => void;
  expandedFolders: ReadonlySet<string>;
  onToggleFolder: (id: string) => void;
  onFolderContextMenu: (event: ReactMouseEvent, folder: FolderNode) => void;
  depth: number;
}) {
  const children = childrenOf(snapshot, folderId).sort((a, b) => a.name.localeCompare(b.name));
  if (children.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5" style={{ marginLeft: depth === 0 ? 0 : 12 }}>
      {children.map((folder) => {
        const childFolders = childrenOf(snapshot, folder.id);
        const hasChildren = childFolders.length > 0;
        const expanded = expandedFolders.has(folder.id);
        const active = folder.id === selectedFolderId;
        return (
          <li key={folder.id}>
            <div
              className={`flex items-center rounded-lg ${active ? 'bg-primary/15 text-primary' : 'hover:bg-base-300/60'}`}
              onContextMenu={(event) => onFolderContextMenu(event, folder)}
            >
              <button
                className={`chevron-btn ${hasChildren ? '' : 'invisible'} ${expanded ? 'expanded' : ''}`}
                disabled={!hasChildren}
                aria-label={hasChildren ? (expanded ? '收起' : '展开') : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasChildren) onToggleFolder(folder.id);
                }}
              >
                <svg className="chevron-icon" viewBox="0 0 12 12" width="12" height="12" xmlns="http://www.w3.org/2000/svg">
                  <path d="M3.5 2.2L8.5 6l-5 3.8z" fill="currentColor" />
                </svg>
              </button>
              <button className="flex-1 min-w-0 text-left flex items-center justify-between gap-2 py-1.5 pr-2" onClick={() => onSelect(folder)}>
                <span className="truncate">{folder.name}</span>
                <span className={`badge badge-sm ${active ? 'badge-primary' : 'badge-ghost'}`}>{folder.imageCount}</span>
              </button>
            </div>
            {hasChildren && expanded && (
              <FolderTree
                snapshot={snapshot}
                folderId={folder.id}
                selectedFolderId={selectedFolderId}
                onSelect={onSelect}
                expandedFolders={expandedFolders}
                onToggleFolder={onToggleFolder}
                onFolderContextMenu={onFolderContextMenu}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TitleBar() {
  const bridge = (window as { kanituDesktop?: KanituDesktopBridge }).kanituDesktop;
  const isElectron = bridge?.platform === 'electron';
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isElectron) return;
    let alive = true;
    void bridge?.isWindowMaximized?.().then((m) => {
      if (alive) setMaximized(m);
    });
    const off = bridge?.onWindowMaximizedChanged?.((m) => setMaximized(m));
    return () => {
      alive = false;
      off?.();
    };
  }, [isElectron, bridge]);

  const toggleMaximize = () => {
    if (!isElectron) return;
    void bridge?.maximizeWindowToggle?.().then((m) => setMaximized(m));
  };

  if (!isElectron) return null;

  return (
    <div
      className={`app-titlebar flex items-center justify-between h-12 px-3 shrink-0 select-none bg-base-200 border-b border-base-300 ${isElectron ? 'titlebar-drag' : ''}`}
    >
      <div className="flex items-center gap-2.5 min-w-0 pl-1">
        <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-sky-500 to-violet-500 flex items-center justify-center text-white text-base">◉</span>
        <span className="text-base font-semibold truncate">全能看图王</span>
      </div>
      {isElectron && (
        <div className="titlebar-no-drag flex items-center gap-0.5">
          <button className="btn btn-ghost btn-square btn-sm" title="最小化" onClick={() => void bridge?.minimizeWindow?.()}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" className="w-3.5 h-3.5" fill="currentColor"><rect x="1" y="4.5" width="8" height="1"/></svg>
          </button>
          <button className="btn btn-ghost btn-square btn-sm" title={maximized ? '还原' : '最大化'} onClick={toggleMaximize}>
            {maximized ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.5" y="3" width="5.5" height="5.5"/><path d="M3 1.5h5.5V7"/></svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.5" y="1.5" width="7" height="7"/></svg>
            )}
          </button>
          <button className="btn btn-ghost btn-square btn-sm hover:bg-red-500 hover:text-white" title="关闭" onClick={() => void bridge?.closeWindow?.()}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>
          </button>
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('kanitu-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('kanitu-theme', theme);
  }, [theme]);
  return (
    <label className="swap swap-rotate btn btn-ghost btn-square btn-sm" title="切换主题">
      <input type="checkbox" checked={theme === 'light'} onChange={(e) => setTheme(e.target.checked ? 'light' : 'dark')} />
      <svg className="swap-off fill-current w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4L7 17M17 7l1.4-1.4M12 7a5 5 0 010 10z"/></svg>
      <svg className="swap-on fill-current w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/></svg>
    </label>
  );
}

function Viewer({
  images,
  index,
  store,
  onClose,
  onNavigate,
  onSwitchSibling,
  onImageContextMenu,
}: {
  images: ImageEntry[];
  index: number;
  store: LibraryStore;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onSwitchSibling: (dir: number) => void;
  onImageContextMenu: (event: ReactMouseEvent, image: ImageEntry) => void;
}) {
  const image = images[index];
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const viewerUrlRef = useRef<string | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; startPan: { x: number; y: number } } | null>(null);

  const fileRefFor = (img: ImageEntry) => ({ id: img.fileRefId ?? img.id, name: img.name, kind: 'file' as const });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    store.getViewerUrl(fileRefFor(image)).then((url) => {
      if (cancelled) {
        store.releaseViewerUrl(url);
        return;
      }
      if (viewerUrlRef.current) store.releaseViewerUrl(viewerUrlRef.current);
      viewerUrlRef.current = url;
      setViewerUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [image, store]);

  useEffect(() => {
    return () => {
      if (viewerUrlRef.current) store.releaseViewerUrl(viewerUrlRef.current);
    };
  }, [store]);

  useEffect(() => {
    setZoom(1);
    setRotate(0);
    setPan({ x: 0, y: 0 });
    setNatural(null);
  }, [image?.id]);

  useEffect(() => {
    if (!images.length) return;
    for (const offset of [-1, 1]) {
      const i = index + offset;
      if (i < 0 || i >= images.length) continue;
      const img = images[i]!;
      store.getViewerUrl(fileRefFor(img)).then((url) => {
        const pre = new Image();
        pre.onload = () => store.releaseViewerUrl(url);
        pre.onerror = () => store.releaseViewerUrl(url);
        pre.src = url;
      });
    }
  }, [image?.id, images, index, store]);

  const baseFit = useMemo(() => {
    if (!natural || !containerSize.w || !containerSize.h) return 1;
    const s = Math.min(containerSize.w / natural.w, containerSize.h / natural.h);
    return Math.max(0.05, Math.min(1, s));
  }, [natural, containerSize]);

  const displayed = useMemo(() => {
    const w = (natural?.w ?? 1) * baseFit * zoom;
    const h = (natural?.h ?? 1) * baseFit * zoom;
    return { w, h };
  }, [natural, baseFit, zoom]);

  // The transform below uses scale(zoom). Keep the img's layout box at the
  // fit-to-window size so the browser's max-width:100% (Tailwind preflight)
  // does NOT shrink it a second time on top of the transform scale.
  const fitSize = useMemo(() => {
    const w = (natural?.w ?? 1) * baseFit;
    const h = (natural?.h ?? 1) * baseFit;
    return { w, h };
  }, [natural, baseFit]);

  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  const maxX = Math.max(0, (displayed.w - containerSize.w) / 2);
  const maxY = Math.max(0, (displayed.h - containerSize.h) / 2);
  const panX = clamp(pan.x, maxX);
  const panY = clamp(pan.y, maxY);

  const zoomBy = useCallback((factor: number) => {
    setZoom((z) => Math.max(0.5, Math.min(8, z * factor)));
  }, []);
  const fit = useCallback(() => setZoom(1), []);
  const percent = useCallback(() => {
    setZoom((z) => (baseFit > 0 ? 1 / baseFit : 1));
  }, [baseFit]);
  const toggleFit100 = useCallback(() => {
    setZoom((z) => (Math.abs(z - 1) < 0.01 ? (baseFit > 0 ? 1 / baseFit : 1) : 1));
  }, [baseFit]);
  const rotateCW = useCallback(() => setRotate((r) => (r + 90) % 360), []);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft') {
        onNavigate(images[(index - 1 + images.length) % images.length]!.id);
      } else if (e.key === 'ArrowRight') {
        onNavigate(images[(index + 1) % images.length]!.id);
      } else if (e.key === 'ArrowUp') {
        onSwitchSibling(-1);
      } else if (e.key === 'ArrowDown') {
        onSwitchSibling(1);
      } else if (e.key === '+' || e.key === '=') {
        zoomBy(1.25);
      } else if (e.key === '-') {
        zoomBy(0.8);
      } else if (e.key === '0') {
        fit();
      } else if (e.key === '1') {
        percent();
      } else if (e.key === 'r' || e.key === 'R') {
        rotateCW();
      }
    },
    [images, index, onClose, onNavigate, onSwitchSibling, zoomBy, fit, percent, rotateCW],
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  if (!image) return null;

  return (
    <div className="viewer-overlay fixed inset-0 z-[100] bg-black flex flex-col">
      <div className="flex items-center justify-between gap-3 p-4 text-white">
        <button className="btn btn-ghost btn-square text-white" onClick={onClose} aria-label="关闭">✕</button>
        <div className="flex items-center gap-3">
          <button className="btn btn-ghost text-white" onClick={() => onNavigate(images[(index - 1 + images.length) % images.length]!.id)}>‹</button>
          <span className="text-sm opacity-80">{index + 1} / {images.length}</span>
          <button className="btn btn-ghost text-white" onClick={() => onNavigate(images[(index + 1) % images.length]!.id)}>›</button>
        </div>
        <div className="flex items-center gap-1">
          <button className="btn btn-ghost btn-sm text-white" onClick={fit}>适应</button>
          <button className="btn btn-ghost btn-sm text-white" onClick={percent}>100%</button>
          <button className="btn btn-ghost btn-sm text-white" onClick={rotateCW}>↻</button>
        </div>
      </div>
      <div
        className="flex-1 flex items-center justify-center overflow-hidden cursor-grab active:cursor-grabbing"
        ref={containerRef}
        onContextMenu={(event) => onImageContextMenu(event, image)}
        onWheel={(e) => {
          e.preventDefault();
          zoomBy(e.deltaY > 0 ? 0.8 : 1.25);
        }}
        onDoubleClick={toggleFit100}
        onMouseDown={(e) => {
          dragRef.current = { startX: e.clientX, startY: e.clientY, startPan: pan };
        }}
        onMouseMove={(e) => {
          const drag = dragRef.current;
          if (drag) setPan({ x: drag.startPan.x + (e.clientX - drag.startX), y: drag.startPan.y + (e.clientY - drag.startY) });
        }}
        onMouseUp={() => {
          dragRef.current = null;
        }}
        onMouseLeave={() => {
          dragRef.current = null;
        }}
      >
        {viewerUrl && (
          <img
            className="select-none pointer-events-none"
            src={viewerUrl}
            alt={image.name}
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              setNatural({ w: el.naturalWidth, h: el.naturalHeight });
            }}
            style={{
              width: fitSize.w,
              height: fitSize.h,
              transform: `translate(${panX}px, ${panY}px) rotate(${rotate}deg) scale(${zoom})`,
            }}
          />
        )}
      </div>
      <div className="flex gap-2 px-4 pb-4 pt-2 bg-black/40 overflow-x-auto flex-shrink-0">
        {images.map((img, i) => (
          <button key={img.id} className={`filmstrip-thumb ${i === index ? 'active' : ''}`} onClick={() => onNavigate(img.id)}>
            <BlobImage store={store} fileRef={fileRefFor(img)} alt={img.name} className="w-full h-full object-cover" thumbnail lazy />
          </button>
        ))}
      </div>
      <div className="absolute bottom-20 right-5 text-xs text-white/80 bg-black/50 rounded-lg px-3 py-2">
        {image.name} · {natural ? `${natural.w}×${natural.h}` : '—'} · {Math.round(baseFit * zoom * 100)}%
      </div>
    </div>
  );
}
