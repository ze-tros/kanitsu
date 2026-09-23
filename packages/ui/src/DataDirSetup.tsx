import { useState, type CSSProperties } from 'react';
import { FolderOpen, X } from '@phosphor-icons/react';
import { DATA_DIR_NOTICE, chooseDataDir, confirmDataDir } from './dataDir';

/** 无边框窗口的拖拽区域（标题栏）与豁免（可交互控件）。 */
const DRAG_REGION = { WebkitAppRegion: 'drag' } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;

/**
 * 首次启动引导（独立引导窗口 ?setup=1 整窗渲染）：选定数据目录并确认后，
 * 主进程才创建主窗口——此后不再询问。不提供「跳过」：关闭窗口等于退出应用。
 * 引导窗口跑在不落盘的内存会话上，选定目录前不产生任何需要保留的状态。
 * 系统文件夹选择框只在用户点击按钮时打开，先进来看到的是说明。
 */
export function DataDirSetup() {
  const [candidate, setCandidate] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleChoose = async (): Promise<void> => {
    setBusy(true);
    const result = await chooseDataDir();
    if (result && result.path) {
      setCandidate(result.path);
      setError('');
    } else if (result?.error) {
      setError(result.error);
    }
    setBusy(false);
  };

  const handleConfirm = async (): Promise<void> => {
    if (!candidate) return;
    setBusy(true);
    const result = await confirmDataDir(candidate);
    if (result && !result.ok) {
      setError(result.error ?? '设置数据目录失败，请重试。');
      setBusy(false);
    }
    // 成功时主进程关闭本窗口并打开主界面，这里无需收尾。
  };

  return (
    <div className="h-screen w-full">
      <div className="h-full w-full rounded-2xl bg-base-100 shadow-2xl border border-base-300 flex flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3 shrink-0" style={DRAG_REGION}>
          <h3 className="font-bold text-lg">选择数据目录</h3>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-square -mt-1 -mr-1"
            style={NO_DRAG}
            aria-label="关闭"
            title="关闭（退出 Kanitsu）"
            onClick={() => void window.kanitsuDesktop?.closeWindow()}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 min-h-0 px-6 pb-3 text-sm">
          <p className="opacity-70 mb-3">Kanitsu 只管理自己复制出来的那份图包副本，导入、整理、删除都落在这个文件夹里：</p>
          <ul className="list-disc pl-5 space-y-1 opacity-80">
            {DATA_DIR_NOTICE.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <div className="mt-4">
            <span className="text-xs opacity-60">所选数据目录</span>
            {candidate ? (
              <p className="font-mono text-xs break-all mt-1 rounded-box border border-base-300 bg-base-200/60 px-2 py-2">
                {candidate}
              </p>
            ) : (
              <p className="text-xs opacity-60 mt-1">尚未选择文件夹，请点下方按钮选择。</p>
            )}
          </div>
          {error && <p className="text-xs text-error mt-2 break-all">{error}</p>}
        </div>
        <div className="px-6 pb-5 pt-1 shrink-0 flex justify-end gap-2">
          <button
            className={candidate ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm'}
            disabled={busy}
            onClick={() => void handleChoose()}
          >
            <FolderOpen size={15} aria-hidden="true" />
            {candidate ? '更改位置' : '选择文件夹'}
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || !candidate}
            onClick={() => void handleConfirm()}
          >
            使用此位置
          </button>
        </div>
      </div>
    </div>
  );
}
