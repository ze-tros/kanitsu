import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyOrganize,
  childrenOf,
  deleteLibraryFolder,
  directImagesOf,
  imagesOf,
  importFolder,
  loadOrScan,
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
import { organizeByFolder } from '../../organizer/src/index';
import { pickCover } from '../../cover-picker/src/index';
import { BlobImage } from './BlobImage';

function skippedReasonLabel(reason: ImportSkippedFile['reason']): string {
  switch (reason) {
    case 'no-extension':
      return 'No extension';
    case 'unsupported-format':
      return 'Unsupported format';
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
  const [organizePreview, setOrganizePreview] = useState<OrganizeBinding[] | null>(null);
  const [organizeResult, setOrganizeResult] = useState<OrganizeResult | null>(null);
  const [lastManifest, setLastManifest] = useState<OrganizeManifest | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);
  const [importReport, setImportReport] = useState<ImportTask | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(new Set());

  const applySnapshot = useCallback((next: LibrarySnapshot) => {
    setSnapshot(next);
    setSelectedFolderId((prev) => (prev && next.folders[prev] ? prev : next.rootId));
  }, []);

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

  const folderImages = useMemo(() => {
    if (!snapshot) return [];
    const id = selectedFolderId || snapshot.rootId;
    return directImagesOf(snapshot, id);
  }, [snapshot, selectedFolderId]);

  const childFolders = useMemo(() => {
    if (!snapshot) return [];
    const id = selectedFolderId || snapshot.rootId;
    return childrenOf(snapshot, id).sort((a, b) => a.name.localeCompare(b.name));
  }, [snapshot, selectedFolderId]);

  const childFolderCards = useMemo(() => {
    if (!snapshot) return [];
    return childFolders.map((child) => ({
      folder: child,
      cover: pickCover(imagesOf(snapshot, child.id)),
    }));
  }, [snapshot, childFolders]);

  const selectedFolder = snapshot?.folders[selectedFolderId || snapshot?.rootId || ''] ?? null;

  const cover = useMemo(() => {
    if (!selectedFolder || !snapshot) return null;
    const images = directImagesOf(snapshot, selectedFolder.id);
    return pickCover(images);
  }, [snapshot, selectedFolder]);

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

  const handleAdd = async () => {
    setBusy(true);
    setMessage('Importing...');
    try {
      const task = await importFolder(picker, store, {
        onProgress: (p) =>
          setMessage(`Importing: scanned ${p.scanned}, copied ${p.copied}, skipped ${p.skipped}`),
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
      setMessage(
        task.skippedCount > 0
          ? `Import completed: ${task.copiedImageCount} copied, ${task.skippedCount} skipped. See report.`
          : `Import completed: ${task.copiedImageCount} copied.`,
      );
    } catch (err) {
      setMessage(`Import failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const openOrganizePreview = () => {
    if (!snapshot || !selectedFolder) return;
    setOrganizePreview(organizeByFolder(imagesOf(snapshot, selectedFolder.id)));
    setOrganizeResult(null);
  };

  const handleApplyOrganize = async () => {
    if (!snapshot || !selectedFolder || !organizePreview) return;
    setOrganizing(true);
    try {
      const result = await applyOrganize(store, snapshot, selectedFolder.relPath, organizePreview);
      setOrganizePreview(null);
      setOrganizeResult(result);
      setLastManifest(result.manifest);
      await refresh();
      setMessage(
        result.conflicts.length > 0
          ? `Organized ${result.appliedCount} file(s), ${result.conflicts.length} conflict(s) — see report.`
          : `Organized ${result.appliedCount} file(s).`,
      );
    } catch (err) {
      setMessage(`Organize failed: ${String(err)}`);
    } finally {
      setOrganizing(false);
    }
  };

  const handleUndoOrganize = async () => {
    if (!lastManifest) return;
    setBusy(true);
    setMessage('Undoing organize…');
    try {
      const result = await undoOrganize(store, lastManifest);
      setLastManifest(null);
      setOrganizeResult(null);
      await refresh();
      setMessage(
        result.errors.length > 0
          ? `Undo: ${result.undone} restored, ${result.errors.length} error(s).`
          : `Undo: ${result.undone} file(s) restored.`,
      );
    } catch (err) {
      setMessage(`Undo failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    if (!selectedFolder) return;
    setExporting(true);
    setExportProgress({ done: 0, total: 0 });
    setMessage('Exporting ZIP…');
    try {
      const result = await store.zipLibrary(selectedFolder.relPath, (done, total) => {
        setExportProgress({ done, total });
      });
      setExportProgress(null);
      if (result.kind === 'blob' && result.blob) {
        const base = selectedFolder.relPath ? selectedFolder.relPath.split('/').pop() : 'albums';
        downloadBlob(result.blob, `${base}.zip`);
        setMessage(`Exported ${result.exportedCount} image(s) as ZIP (download).`);
      } else if (result.outputPath) {
        setMessage(`Exported ${result.exportedCount} image(s) to ${result.outputPath}.`);
      } else {
        setMessage(`Exported ${result.exportedCount} image(s).`);
      }
    } catch (err) {
      setExportProgress(null);
      setMessage(`Export failed: ${String(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedFolder || !selectedFolder.relPath) return;
    const name = selectedFolder.name;
    if (!window.confirm(`Delete "${name}" and all of its subfolders? This cannot be undone.`)) return;
    setBusy(true);
    setMessage(`Deleting "${name}"…`);
    const parentId = selectedFolder.parentId;
    try {
      await deleteLibraryFolder(store, selectedFolder.relPath);
      await refresh();
      if (parentId) setSelectedFolderId(parentId);
      setMessage(`Deleted "${name}".`);
    } catch (err) {
      setMessage(`Delete failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const viewerImages = folderImages;
  const viewerIndex = viewerImages.findIndex((img) => img.id === viewerImageId);

  return (
    <div className="library-browser">
      <aside className="sidebar">
        <div className="toolbar">
          <button disabled={busy} onClick={handleAdd}>
            Add Album
          </button>
          <button
            disabled={!selectedFolder}
            onClick={() => {
              void refresh();
            }}
          >
            Refresh
          </button>
          <button disabled={!selectedFolder} onClick={openOrganizePreview}>
            Organize Preview
          </button>
          <button disabled={!lastManifest || busy} onClick={handleUndoOrganize}>
            Undo Last Organize
          </button>
          <button disabled={!selectedFolder || busy || exporting} onClick={handleExport}>
            {exporting ? 'Exporting…' : 'Export ZIP'}
          </button>
          <button
            disabled={!selectedFolder || !selectedFolder.relPath || busy || exporting}
            onClick={handleDelete}
          >
            Delete Album
          </button>
          {importReport && (
            <button onClick={() => setImportReport(importReport)}>Import Report</button>
          )}
        </div>
          <div className="tree-version">Tree v0.4 (subfolder covers)</div>
        {snapshot && (
          <FolderTree
            snapshot={snapshot}
            folderId={snapshot.rootId}
            selectedFolderId={selectedFolderId || snapshot.rootId}
            onSelect={handleSelectFolder}
            expandedFolders={expandedFolders}
            onToggleFolder={toggleFolder}
            depth={0}
          />
        )}
        {message && <div className="message">{message}</div>}
        {exporting && exportProgress && (
          <div className="message export-progress">
            {exportProgress.total > 0
              ? `Packaging ZIP… ${exportProgress.done}/${exportProgress.total}`
              : 'Packaging ZIP…'}
          </div>
        )}
      </aside>

      <main className="content">
        <header className="content-header">
          <h2>{selectedFolder?.name ?? 'Albums'}</h2>
          <div className="meta">
            {selectedFolder && (
              <>
                <span>
                  {selectedFolder.imageCount} images / {selectedFolder.childCount} folders
                </span>
                {cover && (
                  <span>
                    Cover: {snapshot?.images[cover.imageId]?.name ?? cover.imageId}
                  </span>
                )}
              </>
            )}
          </div>
        </header>

        {viewerImageId && viewerIndex >= 0 ? (
          <Viewer
            images={viewerImages}
            index={viewerIndex}
            store={store}
            onClose={() => setViewerImageId(null)}
            onNavigate={(id) => setViewerImageId(id)}
          />
        ) : (
          <div className="album-content">
              {childFolderCards.length > 0 && (
                <section className="folder-section">
                  <h3>Subfolders</h3>
                  <div className="folder-grid">
                    {childFolderCards.map(({ folder, cover }) => (
                      <figure
                        key={folder.id}
                        className="folder-card"
                        onClick={() => handleSelectFolder(folder)}
                      >
                        {cover ? (
                          <BlobImage
                            store={store}
                            fileRef={{
                              id: snapshot?.images[cover.imageId]?.fileRefId ?? cover.imageId,
                              name: snapshot?.images[cover.imageId]?.name ?? '',
                              kind: 'file',
                            }}
                            alt={folder.name}
                            className="folder-cover"
                            thumbnail
                          />
                        ) : (
                          <div className="folder-cover empty-folder-cover">No images</div>
                        )}
                        <figcaption>
                          <span>{folder.name}</span>
                          <span className="count">
                            {folder.imageCount} img / {folder.childCount} sub
                          </span>
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                </section>
              )}

              {folderImages.length > 0 && (
                <section className="image-section">
                  <h3>Images</h3>
                  <div className="grid">
                    {folderImages.map((image) => (
                      <figure key={image.id} className="card" onClick={() => setViewerImageId(image.id)}>
                        <BlobImage
                          store={store}
                          fileRef={{ id: image.fileRefId ?? image.id, name: image.name, kind: 'file' }}
                          alt={image.name}
                          className="thumb"
                          thumbnail
                        />
                        <figcaption>{image.name}</figcaption>
                      </figure>
                    ))}
                  </div>
                </section>
              )}

              {childFolderCards.length === 0 && folderImages.length === 0 && (
                <div className="empty">No images in this folder</div>
              )}
            </div>
        )}
      </main>

      {organizePreview && (
        <div className="organize-preview">
          <h3>Organize preview (virtual only, no files are moved)</h3>
          <table>
            <thead>
              <tr>
                <th>Original name</th>
                <th>Target path</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {organizePreview.map((b) => {
                const img = snapshot?.images[b.imageId];
                const keep = b.confidence < 0.5;
                return (
                  <tr key={b.imageId}>
                    <td>{img?.name ?? b.imageId}</td>
                    <td>{keep ? `${b.virtualPath} (left in place)` : b.virtualPath}</td>
                    <td>{b.confidence.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="organize-actions">
            <button disabled={organizing} onClick={handleApplyOrganize}>
              {organizing ? 'Applying…' : `Apply (${organizePreview.length} files)`}
            </button>
            <button onClick={() => setOrganizePreview(null)}>Close</button>
          </div>
          <p className="organize-hint">
            Files with confidence below 0.50 are left in place. Targets are created under the current folder.
          </p>
        </div>
      )}

      {organizeResult && (
        <div className="organize-preview organize-result">
          <h3>Organize result</h3>
          <div className="report-summary">
            <span>Applied: {organizeResult.appliedCount}</span>
            <span>Skipped (low confidence): {organizeResult.skippedLowConfidenceCount}</span>
            <span>Conflicts: {organizeResult.conflicts.length}</span>
          </div>
          {organizeResult.conflicts.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Target</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {organizeResult.conflicts.map((c, i) => (
                  <tr key={`${c.imageId}-${i}`}>
                    <td>{c.name}</td>
                    <td>{c.targetRelPath}</td>
                    <td>{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button onClick={() => setOrganizeResult(null)}>Close</button>
        </div>
      )}

      {importReport && (
        <div className="organize-preview import-report">
          <h3>Import report</h3>
          <div className="report-summary">
            <span>Source: {importReport.sourceFolderName}</span>
            <span>Scanned: {importReport.scannedFileCount}</span>
            <span>Copied: {importReport.copiedImageCount}</span>
            <span>Skipped: {importReport.skippedCount}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Skipped file</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {importReport.skippedFiles.map((item, index) => (
                <tr key={`${item.path}-${index}`}>
                  <td>{item.path}</td>
                  <td>{skippedReasonLabel(item.reason)}</td>
                </tr>
              ))}
              {importReport.skippedFiles.length === 0 && (
                <tr>
                  <td colSpan={2}>No skipped files</td>
                </tr>
              )}
            </tbody>
          </table>
          <button onClick={() => setImportReport(null)}>Close</button>
        </div>
      )}
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
  depth,
}: {
  snapshot: LibrarySnapshot;
  folderId: string;
  selectedFolderId: string;
  onSelect: (folder: FolderNode) => void;
  expandedFolders: ReadonlySet<string>;
  onToggleFolder: (id: string) => void;
  depth: number;
}) {
  const children = childrenOf(snapshot, folderId).sort((a, b) => a.name.localeCompare(b.name));
  if (children.length === 0) return null;
  return (
    <ul className="folder-tree" style={{ paddingLeft: depth === 0 ? 0 : 12 }}>
      {children.map((folder) => {
        // Use the actual snapshot children so the arrow is always in sync with reality.
        const childFolders = childrenOf(snapshot, folder.id);
        const hasChildren = childFolders.length > 0;
        const expanded = expandedFolders.has(folder.id);
        const active = folder.id === selectedFolderId;
        return (
          <li key={folder.id}>
            <div className={`folder-row${active ? ' active' : ''}`}>
              <button
                className="chevron"
                disabled={!hasChildren}
                aria-label={hasChildren ? (expanded ? 'Collapse' : 'Expand') : undefined}
                title={hasChildren ? (expanded ? 'Collapse' : 'Expand') : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasChildren) onToggleFolder(folder.id);
                }}
              >
                {hasChildren ? (
                  <span className={expanded ? 'chevron-icon expanded' : 'chevron-icon'} />
                ) : null}
              </button>
              <button className="folder-name" onClick={() => onSelect(folder)}>
                <span>{folder.name}</span>
                <span className="count">
                  {folder.imageCount} img / {childFolders.length} sub
                </span>
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
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Viewer({
  images,
  index,
  store,
  onClose,
  onNavigate,
}: {
  images: ImageEntry[];
  index: number;
  store: LibraryStore;
  onClose: () => void;
  onNavigate: (id: string) => void;
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

  // Track the container size so "fit" can be computed correctly.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load the ORIGINAL-resolution URL for the current image, releasing the previous one.
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

  // Release the URL when the viewer unmounts.
  useEffect(() => {
    return () => {
      if (viewerUrlRef.current) store.releaseViewerUrl(viewerUrlRef.current);
    };
  }, [store]);

  // Reset transforms when switching images.
  useEffect(() => {
    setZoom(1);
    setRotate(0);
    setPan({ x: 0, y: 0 });
    setNatural(null);
  }, [image?.id]);

  // Preload adjacent images for smoother navigation.
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
    [images, index, onClose, onNavigate, zoomBy, fit, percent, rotateCW],
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  if (!image) return null;

  return (
    <div className="viewer">
      <div className="viewer-toolbar">
        <button onClick={onClose}>✕ Close</button>
        <button onClick={() => onNavigate(images[(index - 1 + images.length) % images.length]!.id)}>‹ Prev</button>
        <span>
          {index + 1} / {images.length}
        </span>
        <button onClick={() => onNavigate(images[(index + 1) % images.length]!.id)}>Next ›</button>
        <span className="viewer-divider" />
        <button onClick={() => zoomBy(1.25)}>＋</button>
        <button onClick={() => zoomBy(0.8)}>－</button>
        <button onClick={fit}>Fit</button>
        <button onClick={percent}>100%</button>
        <button onClick={rotateCW}>↻</button>
      </div>
      <div
        className="viewer-canvas"
        ref={containerRef}
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
            className="viewer-image"
            src={viewerUrl}
            alt={image.name}
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              setNatural({ w: el.naturalWidth, h: el.naturalHeight });
            }}
            style={{ transform: `translate(${panX}px, ${panY}px) rotate(${rotate}deg) scale(${baseFit * zoom})` }}
          />
        )}
      </div>
      <div className="viewer-caption">{image.name}</div>
    </div>
  );
}
