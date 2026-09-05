import { useMemo, useRef, useState } from 'react';
import type { OrganizeBinding } from '../../core/src/index';

interface PreviewFile {
  name: string;
  binding: OrganizeBinding;
}

interface PreviewDir {
  name: string;
  path: string;
  children: PreviewDir[];
  files: PreviewFile[];
  total: number;
}

interface PromptState {
  kind: 'rename-folder' | 'edit-file';
  title: string;
  label: string;
  initialValue: string;
  folderPath?: string;
  imageId?: string;
}

function insertPath(root: PreviewDir, binding: OrganizeBinding): void {
  const segments = binding.virtualPath.split('/').filter(Boolean);
  if (segments.length === 0) return;
  const fileName = segments.pop()!;
  let node = root;
  for (const segment of segments) {
    let child = node.children.find((item) => item.name === segment);
    if (!child) {
      child = {
        name: segment,
        path: node.path ? node.path + '/' + segment : segment,
        children: [],
        files: [],
        total: 0,
      };
      node.children.push(child);
    }
    node = child;
  }
  node.files.push({ name: fileName, binding });
}

function computeTotals(node: PreviewDir): void {
  for (const child of node.children) computeTotals(child);
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  node.files.sort((a, b) => a.name.localeCompare(b.name));
  node.total = node.files.length + node.children.reduce((sum, child) => sum + child.total, 0);
}

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.')
    .join('/');
}

function FileList({ files, onEditFile, showAll = false }: { files: PreviewFile[]; onEditFile: (file: PreviewFile) => void; showAll?: boolean }) {
  const visible = showAll ? files : files.slice(0, 8);
  const remaining = showAll ? 0 : files.length - visible.length;
  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {visible.map((file) => (
        <div key={file.binding.imageId} className="flex items-center gap-1.5 text-xs opacity-75 group/file">
          <span className="w-1 h-1 rounded-full bg-current opacity-40" />
          <span className="truncate flex-1 min-w-0">{file.name}</span>
          <button
            className="btn btn-ghost btn-xs opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100"
            title="调整该文件的目标位置"
            onClick={() => onEditFile(file)}
          >
            ✎
          </button>
        </div>
      ))}
      {remaining > 0 && <div className="text-xs opacity-50 pl-2.5">… 还有 {remaining} 个文件</div>}
    </div>
  );
}

function FolderTreeNode({
  node,
  depth,
  onRenameFolder,
  onEditFile,
}: {
  node: PreviewDir;
  depth: number;
  onRenameFolder: (node: PreviewDir) => void;
  onEditFile: (file: PreviewFile) => void;
}) {
  return (
    <details open className="group">
      <summary className="flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer hover:bg-base-300/50">
        <span className="opacity-60 text-xs">▸</span>
        <span className="text-sm font-medium truncate flex-1 min-w-0">{node.name}</span>
        <button
          className="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          title="重命名该分组"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRenameFolder(node);
          }}
        >
          ✎
        </button>
        <span className="badge badge-sm">{node.total}</span>
      </summary>
      <div className="pl-4 border-l border-base-300 ml-2 mt-1 flex flex-col gap-1">
        {node.children.map((child) => (
          <FolderTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            onRenameFolder={onRenameFolder}
            onEditFile={onEditFile}
          />
        ))}
        {node.files.length > 0 && <FileList files={node.files} onEditFile={onEditFile} />}
      </div>
    </details>
  );
}

export function OrganizePreview({
  bindings,
  organizing,
  progress,
  onChange,
  onApply,
  onClose,
}: {
  bindings: OrganizeBinding[];
  organizing: boolean;
  progress?: { done: number; total: number } | null;
  onChange: (bindings: OrganizeBinding[]) => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const initialBindingsRef = useRef<OrganizeBinding[]>(bindings);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState('');

  const tree = useMemo(() => {
    const root: PreviewDir = { name: '', path: '', children: [], files: [], total: 0 };
    for (const binding of bindings) {
      if (binding.confidence < 0.5) continue;
      insertPath(root, binding);
    }
    computeTotals(root);
    return root;
  }, [bindings]);

  const keptBindings = bindings.filter((binding) => binding.confidence < 0.5);
  const keptCount = keptBindings.length;
  const moveCount = bindings.length - keptCount;
  const keptFiles = keptBindings.map((binding) => ({
    name: binding.virtualPath.includes('/')
      ? binding.virtualPath.slice(binding.virtualPath.lastIndexOf('/') + 1)
      : binding.virtualPath,
    binding,
  }));

  const openRenameFolder = (node: PreviewDir) => {
    setPrompt({
      kind: 'rename-folder',
      title: '重命名分组',
      label: '新分组名称',
      initialValue: node.name,
      folderPath: node.path,
    });
    setPromptValue(node.name);
  };

  const openEditFile = (file: PreviewFile) => {
    setPrompt({
      kind: 'edit-file',
      title: '调整文件位置',
      label: '目标路径（相对当前目录）',
      initialValue: file.binding.virtualPath,
      imageId: file.binding.imageId,
    });
    setPromptValue(file.binding.virtualPath);
  };

  const submitPrompt = () => {
    if (!prompt) return;

    if (prompt.kind === 'rename-folder' && prompt.folderPath) {
      const newName = promptValue.trim().replace(/[\\/]/g, '');
      if (!newName || newName === '..') return;
      const oldPath = prompt.folderPath;
      const parentPath = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
      const newPath = parentPath ? parentPath + '/' + newName : newName;
      if (newPath !== oldPath) {
        onChange(
          bindings.map((binding) => {
            if (binding.virtualPath === oldPath || binding.virtualPath.startsWith(oldPath + '/')) {
              const rest = binding.virtualPath.slice(oldPath.length);
              return { ...binding, virtualPath: newPath + rest, confidence: 1 };
            }
            return binding;
          }),
        );
      }
    }

    if (prompt.kind === 'edit-file' && prompt.imageId) {
      const newPath = normalizePath(promptValue);
      if (!newPath) return;
      onChange(
        bindings.map((binding) =>
          binding.imageId === prompt.imageId
            ? { ...binding, virtualPath: newPath, confidence: 1 }
            : binding,
        ),
      );
    }

    setPrompt(null);
  };

  const resetToAuto = () => {
    onChange(initialBindingsRef.current.map((binding) => ({ ...binding })));
  };

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-3xl flex flex-col max-h-[80vh]">
        <h3 className="font-bold text-lg">整理预测</h3>
        <p className="text-sm opacity-70 mt-1">
          将移动 {moveCount} 个文件，保留原位 {keptCount} 个。悬停目录可重命名，悬停文件可调整位置。
        </p>

        <div className="flex items-center justify-end gap-2 mt-2">
          <button className="btn btn-ghost btn-xs" onClick={resetToAuto}>重置为自动结果</button>
        </div>

        <div className="overflow-y-auto flex-1 min-h-0 rounded-box border border-base-300 bg-base-100 p-3 mt-2">
          {moveCount === 0 ? (
            <div className="text-sm opacity-70 p-4 text-center">没有高置信度文件，全部保留原位。</div>
          ) : (
            <div className="flex flex-col gap-1">
              {tree.children.map((child) => (
                <FolderTreeNode
                  key={child.path}
                  node={child}
                  depth={0}
                  onRenameFolder={openRenameFolder}
                  onEditFile={openEditFile}
                />
              ))}
              {tree.files.length > 0 && (
                <div className="mt-2">
                  <div className="text-xs font-semibold opacity-60 px-2">当前目录下</div>
                  <FileList files={tree.files} onEditFile={openEditFile} />
                </div>
              )}
            </div>
          )}

          {keptFiles.length > 0 && (
            <div className="mt-4">
              <div className="text-xs font-semibold opacity-60 px-2">保留原位的文件（点击 ✎ 可手动加入分组）</div>
              <div className="max-h-48 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 mt-1">
                <FileList files={keptFiles} onEditFile={openEditFile} showAll />
              </div>
            </div>
          )}
        </div>

        <div className="modal-action shrink-0">
          {organizing && progress && (
            <div className="flex items-center gap-3 text-sm opacity-80">
              <span>正在整理… {progress.done}/{progress.total}</span>
              <progress className="progress progress-primary w-40" value={progress.done} max={progress.total || 1} />
            </div>
          )}
          <button className="btn btn-primary" disabled={organizing || moveCount === 0} onClick={onApply}>
            {organizing ? '应用…' : '应用（' + moveCount + ' 个文件）'}
          </button>
          <button className="btn btn-ghost" disabled={organizing} onClick={onClose}>关闭</button>
        </div>
      </div>

      {prompt && (
        <div className="modal modal-open z-[130]">
          <div className="modal-box max-w-md flex flex-col max-h-[80vh]">
            <h3 className="font-bold text-lg shrink-0">{prompt.title}</h3>
            <div className="overflow-y-auto flex-1 min-h-0">
              <div className="form-control w-full mt-3">
                <span className="label-text text-xs">{prompt.label}</span>
                <input
                  className="input input-bordered input-sm mt-1 font-mono"
                  value={promptValue}
                  onChange={(event) => setPromptValue(event.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className="modal-action shrink-0">
              <button className="btn btn-ghost btn-sm" onClick={() => setPrompt(null)}>取消</button>
              <button className="btn btn-primary btn-sm" onClick={submitPrompt}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
