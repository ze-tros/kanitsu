import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, MagnifyingGlass, SidebarSimple, UploadSimple } from '@phosphor-icons/react';
import { KanitsuLogo } from '../KanitsuLogo';
import { DesktopWindowControls } from '../DesktopWindowControls';
import { isElectron } from './shared';

/**
 * 桌面标题栏：导航（侧栏 / 后退 / 前进）、居中的搜索入口（打开命令面板）、
 * 任务中心与导入。Electron 下整条是窗口拖拽区，按钮单独声明为非拖拽。
 */
export function TitleBar({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onToggleSidebar,
  searchPlaceholder,
  onOpenPalette,
  showSearch,
  taskButton,
  importing,
  onImport,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onToggleSidebar: () => void;
  searchPlaceholder: string;
  onOpenPalette: () => void;
  showSearch: boolean;
  taskButton: ReactNode;
  importing: boolean;
  onImport: () => void;
}) {
  return (
    <header className={`dk-tb ${isElectron() ? 'titlebar-drag' : ''}`}>
      <div className="dk-brand">
        <KanitsuLogo className="dk-brand-mark" alt="" aria-hidden="true" />
        Kanitsu
      </div>
      <div className="dk-tb-nav titlebar-no-drag">
        <button type="button" className="dk-ib" title="侧栏 (Ctrl+B)" aria-label="显示或隐藏侧栏" onClick={onToggleSidebar}>
          <SidebarSimple size={18} />
        </button>
        <button type="button" className="dk-ib" title="后退 (Alt+←)" aria-label="后退" disabled={!canGoBack} onClick={onBack}>
          <ArrowLeft size={17} />
        </button>
        <button type="button" className="dk-ib" title="前进 (Alt+→)" aria-label="前进" disabled={!canGoForward} onClick={onForward}>
          <ArrowRight size={17} />
        </button>
      </div>
      <div className="dk-spacer" />
      {showSearch && (
        <button type="button" className="dk-tb-search titlebar-no-drag" onClick={onOpenPalette} aria-keyshortcuts="Control+K">
          <MagnifyingGlass size={15} />
          <span>{searchPlaceholder}</span>
          <kbd className="dk-kbd">Ctrl K</kbd>
        </button>
      )}
      <div className="dk-spacer" />
      <div className="dk-tb-actions titlebar-no-drag">
        {taskButton}
        <button type="button" className="dk-btn primary" disabled={importing} onClick={onImport} title="导入文件夹 (Ctrl+O)">
          <UploadSimple size={16} />
          {importing ? '正在导入' : '导入'}
        </button>
      </div>
      <DesktopWindowControls />
    </header>
  );
}
