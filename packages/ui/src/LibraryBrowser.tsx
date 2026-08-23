import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyOrganize,
  childrenOf,
  directImagesOf,
  imagesOf,
  importFolder,
  scanLibrary,
  undoOrganize,
  type FolderNode,
  type ImageEntry,
  type ImportSkippedFile,
  type ImportTask,
  type LibrarySnapshot,
  type OrganizeBinding,
  type OrganizeManifest,
  type OrganizeResult,
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
}: {
  picker: ImportSourcePicker;
  store: LibraryStore;
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

  const refresh = useCallback(async () => {
    const next = await scanLibrary(store);
    setSnapshot(next);
    setSelectedFolderId((prev) => (prev && next.folders[prev] ? prev : next.rootId));
    return next;
  }, [store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') {
        const prev = images[(index - 1 + images.length) % images.length];
        onNavigate(prev.id);
      } else if (e.key === 'ArrowRight') {
        const next = images[(index + 1) % images.length];
        onNavigate(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images, index, onClose, onNavigate]);

  if (!image) return null;
  return (
    <div className="viewer">
      <div className="viewer-toolbar">
        <button onClick={onClose}>Close</button>
        <span>
          {index + 1} / {images.length}
        </span>
      </div>
      <BlobImage
        store={store}
        fileRef={{ id: image.fileRefId ?? image.id, name: image.name, kind: 'file' }}
        alt={image.name}
        className="viewer-image"
      />
      <div className="viewer-caption">{image.name}</div>
    </div>
  );
}
