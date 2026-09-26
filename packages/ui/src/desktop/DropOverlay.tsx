import { UploadSimple } from '@phosphor-icons/react';

/** 拖入文件夹时的全窗口提示；松开后由主进程弹出原生确认框再导入。 */
export function DropOverlay({ count }: { count: number }) {
  return (
    <div className="dk-drop" aria-hidden="true">
      <div>
        <div>
          <div className="dk-big"><UploadSimple size={32} /></div>
          <h2>{count > 1 ? `松开以导入 ${count} 个文件夹` : '松开以导入文件夹'}</h2>
          <p>复制到图库后再整理，源文件夹保持原样。确认前不会读取任何文件。</p>
        </div>
      </div>
    </div>
  );
}
