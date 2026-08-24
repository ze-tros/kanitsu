import { useState } from 'react';
import type { CustomOrganizeRule } from '../../organizer/src/index';
import { ArrowLeftIcon, NavButton } from './NavButton';
import { OrganizeRulesManager } from './OrganizeRulesModal';
import { SidebarResizeHandle } from './SidebarResizeHandle';

export function SettingsPage({
  rules,
  onChange,
  onBack,
  runtimeLabel,
  sidebarWidth,
  onSidebarWidthChange,
}: {
  rules: CustomOrganizeRule[];
  onChange: (rules: CustomOrganizeRule[]) => void;
  onBack: () => void;
  runtimeLabel?: string;
  sidebarWidth: number;
  onSidebarWidthChange: (width: number) => void;
}) {
  const [activeTab, setActiveTab] = useState<'general' | 'organize'>('general');

  return (
    <div className="fixed inset-0 z-[120] bg-base-100 flex flex-col titlebar-no-drag">
      <header className="navbar bg-base-200 border-b border-base-300 px-4 shrink-0 min-h-12">
        <h1 className="text-lg font-semibold">设置</h1>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside
          className="relative shrink-0 border-r border-base-300 bg-base-200 p-3 flex flex-col gap-1"
          style={{ width: sidebarWidth }}
        >
          <SidebarResizeHandle width={sidebarWidth} onResize={onSidebarWidthChange} />
          <NavButton onClick={onBack} className="w-full" title="返回图库">
            <ArrowLeftIcon />
            <span>返回</span>
          </NavButton>
          <div className="menu-title text-xs opacity-60 px-1 mt-2">设置项</div>
          <NavButton
            onClick={() => setActiveTab('general')}
            active={activeTab === 'general'}
            className="w-full"
          >
            <span>通用</span>
          </NavButton>
          <NavButton
            onClick={() => setActiveTab('organize')}
            active={activeTab === 'organize'}
            className="w-full"
          >
            <span>整理规则</span>
          </NavButton>
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto p-5 lg:p-8">
          <div className="max-w-4xl">
            {activeTab === 'general' ? (
              <section className="rounded-box border border-base-300 bg-base-200/50 p-5">
                <h2 className="text-base font-semibold">通用设置</h2>
                <div className="mt-3 flex flex-col gap-2 text-sm opacity-80">
                  <div>运行模式：{runtimeLabel ?? '—'}</div>
                  <div>主题切换：使用图库右上角按钮。</div>
                  <div>自定义整理规则：请在左侧选择“整理规则”。</div>
                </div>
              </section>
            ) : (
              <section className="rounded-box border border-base-300 bg-base-200/50 p-5">
                <OrganizeRulesManager rules={rules} onChange={onChange} />
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
