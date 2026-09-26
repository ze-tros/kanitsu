/**
 * 任务中心：导入、整理、导出与批量操作统一以任务呈现。
 * - 顶栏任务按钮：进行中显示进度环，有未查看的完成任务时显示红点；
 * - 进度胶囊：浏览页底部显示当前任务，点按进入任务中心；
 * - 任务中心页：进行中（可取消）+ 最近完成（撤销整理、导入报告、打开图包）。
 * 任务记录只在本次会话内保留。
 */
import { useState } from 'react';
import type { ImportTask, OrganizeConflict } from '../../../core/src/index';
import { MobileIcon, type MobileIconName } from './mobileIcons';
import { conflictReasonLabel, skippedReasonLabel } from './mobileShared';
import { formatRelativeTime } from '../browseHistory';
import { Z_SETTINGS } from './zindex';

export type MobileTaskKind = 'import' | 'organize' | 'export' | 'delete' | 'move';
export type MobileTaskStatus = 'running' | 'done' | 'canceled' | 'failed';

export interface MobileTask {
  id: string;
  kind: MobileTaskKind;
  title: string;
  status: MobileTaskStatus;
  done: number;
  /** 0 表示总数未知（导入扫描中、导出准备中）。 */
  total: number;
  /** 进行中的附加说明（如导入的扫描/跳过计数）。 */
  detail?: string;
  /** 结束后的结果摘要。 */
  result?: string;
  startedAt: number;
  finishedAt?: number;
  /** 进行中可取消。 */
  cancelable?: boolean;
  /** 整理任务：可撤销（仅最近一次整理且尚未撤销）。 */
  undoable?: boolean;
  /** 导入任务：导入报告（跳过 / 失败明细）。 */
  report?: ImportTask;
  /** 整理任务：冲突明细。 */
  conflicts?: OrganizeConflict[];
  /** 完成后可直接打开的图包。 */
  openFolderId?: string;
}

const TASK_ICON: Record<MobileTaskKind, MobileIconName> = {
  import: 'download',
  organize: 'wand',
  export: 'zip',
  delete: 'trash',
  move: 'move',
};

function taskProgress(tasks: readonly MobileTask[]): number | null {
  const running = tasks.filter((t) => t.status === 'running');
  if (running.length === 0) return null;
  const known = running.filter((t) => t.total > 0);
  if (known.length === 0) return 0;
  const done = known.reduce((s, t) => s + Math.min(t.done, t.total), 0);
  const total = known.reduce((s, t) => s + t.total, 0);
  return total > 0 ? done / total : 0;
}

const RING_C = 2 * Math.PI * 15;

/** 顶栏任务按钮。 */
export function TaskButton({
  tasks,
  unseen,
  onOpen,
}: {
  tasks: readonly MobileTask[];
  unseen: boolean;
  onOpen: () => void;
}) {
  const progress = taskProgress(tasks);
  const running = progress != null;
  return (
    <button
      className="m2-icon-button"
      onClick={onOpen}
      aria-label={running ? `任务中心，进行中 ${Math.round(progress * 100)}%` : unseen ? '任务中心，有新完成的任务' : '任务中心'}
    >
      {running && (
        <svg className="m2-task-ring" viewBox="0 0 34 34" aria-hidden="true">
          <circle cx="17" cy="17" r="15" className="is-track" />
          <circle
            cx="17"
            cy="17"
            r="15"
            className="is-value"
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - Math.max(0.04, progress))}
            transform="rotate(-90 17 17)"
          />
        </svg>
      )}
      <MobileIcon name={running ? 'download' : 'tasks'} className={running ? 'w-[18px] h-[18px]' : 'w-[22px] h-[22px]'} />
      {!running && unseen && <span className="m2-dot" aria-hidden="true" />}
    </button>
  );
}

function progressText(task: MobileTask): string {
  if (task.total > 0) return `${Math.min(task.done, task.total)} / ${task.total} · ${Math.round((Math.min(task.done, task.total) / task.total) * 100)}%`;
  return task.detail ?? '准备中…';
}

/** 浏览页底部的进度胶囊。 */
export function ProgressPill({ tasks, onOpen, wide }: { tasks: readonly MobileTask[]; onOpen: () => void; wide: boolean }) {
  const running = tasks.filter((t) => t.status === 'running');
  const task = running[0];
  if (!task) return null;
  const pct = task.total > 0 ? (Math.min(task.done, task.total) / task.total) * 100 : 0;
  return (
    <button className={`m2-progress-pill ${wide ? 'is-wide' : ''}`} onClick={onOpen} aria-label={`${task.title}，${progressText(task)}，点按查看任务`}>
      <span className="m2-spinner" aria-hidden="true" />
      <span className="m2-progress-pill-copy">
        <span className="truncate">
          {task.title}
          {running.length > 1 ? ` 等 ${running.length} 项` : ''}
        </span>
        <small className="tabular-nums truncate">{task.total > 0 ? `${Math.min(task.done, task.total)} / ${task.total}` : task.detail ?? '准备中…'} · 点按查看</small>
        <span className="m2-progress-line" aria-hidden="true">
          <i className={task.total > 0 ? '' : 'is-indeterminate'} style={{ width: task.total > 0 ? `${pct}%` : undefined }} />
        </span>
      </span>
    </button>
  );
}

function TaskCard({
  task,
  onCancel,
  onUndo,
  onOpenFolder,
}: {
  task: MobileTask;
  onCancel: (task: MobileTask) => void;
  onUndo: (task: MobileTask) => void;
  onOpenFolder: (folderId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = task.status === 'running';
  const report = task.report;
  const reportRows = report ? report.skippedFiles.length + report.errors.length : 0;
  const conflicts = task.conflicts ?? [];
  const icon: MobileIconName = running ? TASK_ICON[task.kind] : task.status === 'done' ? 'check' : task.status === 'canceled' ? 'close' : 'info';
  const pct = task.total > 0 ? (Math.min(task.done, task.total) / task.total) * 100 : 0;
  return (
    <article className="m2-task" aria-busy={running}>
      <div className="m2-task-top">
        <span className={`m2-task-icon is-${running ? 'running' : task.status}`}>
          <MobileIcon name={icon} className="w-[18px] h-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <strong>{task.title}</strong>
          <small className="tabular-nums">
            {running
              ? progressText(task)
              : `${task.result ?? ''}${task.finishedAt ? ` · ${formatRelativeTime(task.finishedAt)}` : ''}`}
          </small>
          {running && task.detail && task.total > 0 && <small className="tabular-nums">{task.detail}</small>}
        </div>
      </div>
      {running && (
        <>
          <div
            className="m2-task-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={task.total || undefined}
            aria-valuenow={task.total ? Math.min(task.done, task.total) : undefined}
            aria-label={task.title}
          >
            <i className={task.total > 0 ? '' : 'is-indeterminate'} style={{ width: task.total > 0 ? `${pct}%` : undefined }} />
          </div>
          {task.cancelable && (
            <div className="m2-task-actions">
              <button className="m2-chip-button" onClick={() => onCancel(task)}>
                取消
              </button>
              {(task.kind === 'import' || task.kind === 'export') && <span className="m2-task-hint">已完成的部分会保留</span>}
            </div>
          )}
        </>
      )}
      {!running && (task.undoable || reportRows > 0 || conflicts.length > 0 || task.openFolderId) && (
        <div className="m2-task-actions">
          {task.undoable && (
            <button className="m2-chip-button is-accent" onClick={() => onUndo(task)}>
              <MobileIcon name="undo" className="w-4 h-4" />
              撤销整理
            </button>
          )}
          {(reportRows > 0 || conflicts.length > 0) && (
            <button className="m2-chip-button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? '收起详情' : report ? '查看报告' : '查看冲突'}
            </button>
          )}
          {task.openFolderId && (
            <button className="m2-chip-button" onClick={() => onOpenFolder(task.openFolderId!)}>
              打开图包
            </button>
          )}
        </div>
      )}
      {expanded && (
        <div className="m2-task-report">
          {report?.skippedFiles.map((f, i) => (
            <div key={`s-${i}`}>
              <span className="is-warning">跳过</span>
              <code>{f.path}</code>
              <small>{skippedReasonLabel(f.reason)}</small>
            </div>
          ))}
          {report?.errors.map((e, i) => (
            <div key={`e-${i}`}>
              <span className="is-error">失败</span>
              <code>{e}</code>
            </div>
          ))}
          {conflicts.map((c, i) => (
            <div key={`c-${i}`}>
              <span className="is-warning">冲突</span>
              <code>
                {c.name} → {c.targetRelPath}
              </code>
              <small>{conflictReasonLabel(c.reason)}</small>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

/** 任务中心页（全屏）。 */
export function TasksScreen({
  tasks,
  exiting,
  onBack,
  onCancel,
  onUndo,
  onOpenFolder,
  onClear,
}: {
  tasks: readonly MobileTask[];
  exiting: boolean;
  onBack: () => void;
  onCancel: (task: MobileTask) => void;
  onUndo: (task: MobileTask) => void;
  onOpenFolder: (folderId: string) => void;
  onClear: () => void;
}) {
  const running = tasks.filter((t) => t.status === 'running');
  const finished = tasks.filter((t) => t.status !== 'running');
  return (
    <div className={`m2-page fixed inset-0 flex flex-col ${exiting ? 'm-page-exit-right' : 'm-subpage-enter'}`} style={{ zIndex: Z_SETTINGS }}>
      <header className="m2-appbar is-solid" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="m2-appbar-row">
          <button className="m2-icon-button" onClick={onBack} aria-label="返回">
            <MobileIcon name="back" className="w-[22px] h-[22px]" />
          </button>
          <div className="m2-appbar-title is-visible">任务中心</div>
        </div>
      </header>
      <main className="m2-scroll flex-1 overflow-y-auto overscroll-contain">
        {running.length > 0 && (
          <>
            <div className="m2-section-head">
              <h2>
                进行中<span>{running.length}</span>
              </h2>
            </div>
            {running.map((t) => (
              <TaskCard key={t.id} task={t} onCancel={onCancel} onUndo={onUndo} onOpenFolder={onOpenFolder} />
            ))}
          </>
        )}
        <div className="m2-section-head">
          <h2>最近完成</h2>
          {finished.length > 0 && (
            <button className="m2-text-button" onClick={onClear}>
              清除
            </button>
          )}
        </div>
        {finished.length === 0 ? (
          <p className="m2-empty-line">本次使用中还没有完成的任务。</p>
        ) : (
          finished.map((t) => <TaskCard key={t.id} task={t} onCancel={onCancel} onUndo={onUndo} onOpenFolder={onOpenFolder} />)
        )}
        <div className="m2-privacy-note">
          <MobileIcon name="cloud-off" className="w-[18px] h-[18px] shrink-0" />
          <span>导入、整理、导出都在本机执行，图片不会上传。删除只作用于图库副本，源文件夹不受影响。</span>
        </div>
      </main>
    </div>
  );
}
