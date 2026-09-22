import { useState } from 'react';
import { FolderOpen } from '@phosphor-icons/react';
import {
  LIBRARY_COPY_NOTICE,
  acknowledgeLibraryLocation,
  chooseLibraryLocation,
  fetchLibraryLocation,
  type LibraryLocationInfo,
} from './libraryLocation';

/**
 * 首次运行引导：确认图包保存位置，并说明本应用「复制一份」的处理方式
 * （仅桌面端渲染，见 LibraryBrowser 里的能力判定）。不提供「跳过」：
 * 用户点「使用此位置」即完成确认，主进程据此不再弹窗。
 */
export function LibraryLocationModal({
  info,
  onConfirm,
}: {
  info: LibraryLocationInfo;
  onConfirm: () => void;
}) {
  const [current, setCurrent] = useState(info);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleChoose = async (): Promise<void> => {
    setBusy(true);
    const result = await chooseLibraryLocation();
    if (result && !result.canceled && !result.error) {
      setError('');
      const next = await fetchLibraryLocation();
      if (next) setCurrent(next);
    } else if (result?.error) {
      setError(result.error);
    }
    setBusy(false);
  };

  const handleConfirm = async (): Promise<void> => {
    setBusy(true);
    const next = await acknowledgeLibraryLocation();
    setBusy(false);
    if (next) setCurrent(next);
    onConfirm();
  };

  return (
    <div className="modal modal-open z-[130]">
      <div className="modal-box max-w-lg flex flex-col max-h-[80vh]">
        <h3 className="font-bold text-lg shrink-0">选择图包的保存位置</h3>
        <div className="overflow-y-auto flex-1 min-h-0 py-3 text-sm">
          <p className="opacity-70 mb-3">
            Kanitsu 只管理自己复制出来的那份图包副本，导入、整理、删除都落在这个文件夹里：
          </p>
          <ul className="list-disc pl-5 space-y-1 opacity-80">
            {LIBRARY_COPY_NOTICE.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <div className="mt-4">
            <span className="text-xs opacity-60">当前保存位置{current.isDefault ? '（默认）' : ''}</span>
            <p className="font-mono text-xs break-all mt-1 rounded-box border border-base-300 bg-base-200/60 px-2 py-2">
              {current.path}
            </p>
            {!current.exists && (
              <span className="text-xs opacity-60">该文件夹尚未创建，确认后会自动创建。</span>
            )}
          </div>
          {error && <p className="text-xs text-error mt-2 break-all">{error}</p>}
        </div>
        <div className="modal-action shrink-0">
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void handleChoose()}>
            <FolderOpen size={15} aria-hidden="true" />
            更改位置
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void handleConfirm()}>
            使用此位置
          </button>
        </div>
        <p className="text-[11px] opacity-55 shrink-0 mt-1">之后可随时在「设置 → 通用 → 图包保存位置」修改。</p>
      </div>
    </div>
  );
}
