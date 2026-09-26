import { useState } from 'react';
import { CheckCircle, FolderOpen, WarningCircle, X } from '@phosphor-icons/react';
import { DATA_DIR_NOTICE, chooseDataDir, confirmDataDir } from './dataDir';
import { KanitsuLogo } from './KanitsuLogo';

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
    <div className="dk-setup-win">
      <div className="dk-setup-card">
        <div className="dk-setup-drag titlebar-drag">
          <KanitsuLogo className="dk-setup-logo" alt="" aria-hidden="true" />
          <button
            type="button"
            className="dk-ib titlebar-no-drag"
            aria-label="关闭"
            title="关闭（退出 Kanitsu）"
            onClick={() => void window.kanitsuDesktop?.closeWindow()}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="dk-setup-body dk-scroll">
          <h1>欢迎使用 Kanitsu</h1>
          <p>先选一个数据目录。Kanitsu 只管理自己复制出来的那份图包副本，导入、整理、删除都落在这个文件夹里。</p>
          <ul className="dk-setup-notes">
            {DATA_DIR_NOTICE.map((line) => (
              <li key={line}><CheckCircle size={15} weight="fill" aria-hidden="true" />{line}</li>
            ))}
          </ul>
          <div className="dk-setup-label">数据目录</div>
          <div className={`dk-field dk-setup-path ${error ? 'err' : ''}`}>
            <FolderOpen size={16} aria-hidden="true" />
            <b title={candidate ?? undefined}>{candidate ?? '尚未选择文件夹'}</b>
          </div>
          {error && (
            <p className="dk-setup-error" role="alert"><WarningCircle size={14} weight="fill" aria-hidden="true" />{error}</p>
          )}
        </div>
        <div className="dk-setup-foot">
          <button type="button" className={`dk-btn ${candidate ? 'ghost' : 'primary'}`} disabled={busy} onClick={() => void handleChoose()}>
            <FolderOpen size={15} aria-hidden="true" />
            {candidate ? '更改位置' : '选择文件夹…'}
          </button>
          <button type="button" className="dk-btn primary" disabled={busy || !candidate} onClick={() => void handleConfirm()}>
            使用此位置
          </button>
        </div>
      </div>
    </div>
  );
}
