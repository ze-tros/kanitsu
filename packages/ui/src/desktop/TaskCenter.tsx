/**
 * 桌面任务中心：导入、整理、导出与批量移动 / 删除统一以任务呈现。
 * - 标题栏按钮：进行中显示进度环，有未查看的结束任务时显示红点；
 * - 弹出面板：进行中可取消；完成后可撤销整理（仅最近一次）、展开导入报告、打开图包。
 * 任务记录只在本次会话内保留，不落盘、不上传。
 */
import { useEffect, useRef, type RefObject } from 'react';
import {
  ArrowCounterClockwise,
  DownloadSimple,
  FileZip,
  FolderOpen,
  ListChecks,
  MagicWand,
  ShieldCheck,
  Trash,
  ArrowsLeftRight,
} from '@phosphor-icons/react';
import type { ImportTask, OrganizeConflict } from '../../../core/src/index';
import { formatRelativeTime } from '../browseHistory';
import { EmptyState } from './pageParts';

export type DesktopTaskKind = 'import' | 'organize' | 'export' | 'delete' | 'move';
export type DesktopTaskStatus = 'running' | 'done' | 'canceled' | 'failed';

export interface DesktopTask {
  id: string;
  kind: DesktopTaskKind;
  title: string;
  status: DesktopTaskStatus;
  done: number;
  /** 0 表示总数未知（导入扫描中、导出准备中）。 */
  total: number;
  /** 进行中的附加说明。 */
  detail?: string;
  /** 结束后的结果摘要。 */
  result?: string;
  startedAt: number;
  finishedAt?: number;
  cancelable?: boolean;
  /** 整理 / 移动：可撤销（仅最近一次且尚未撤销）。 */
  undoable?: boolean;
  /** 导入报告（跳过 / 失败明细）。 */
  report?: ImportTask;
  /** 整理冲突明细。 */
  conflicts?: OrganizeConflict[];
  /** 完成后可直接打开的图包。 */
  openFolderId?: string;
  /** 导出文件的保存位置（仅展示）。 */
  outputPath?: string;
}

const TASK_ICON = {
  import: DownloadSimple,
  organize: MagicWand,
  export: FileZip,
  delete: Trash,
  move: ArrowsLeftRight,
} as const;

/** 进行中任务的合计进度（0–1）；总数未知的任务不计入，全部未知时为 0。 */
export function runningProgress(tasks: readonly DesktopTask[]): number | null {
  const running = tasks.filter((t) => t.status === 'running');
  if (running.length === 0) return null;
  const known = running.filter((t) => t.total > 0);
  const total = known.reduce((s, t) => s + t.total, 0);
  return total > 0 ? known.reduce((s, t) => s + Math.min(t.done, t.total), 0) / total : 0;
}

const RING_C = 2 * Math.PI * 14;

export function TaskButton({
  tasks,
  unseen,
  open,
  onToggle,
  buttonRef,
}: {
  tasks: readonly DesktopTask[];
  unseen: boolean;
  open: boolean;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement>;
}) {
  const progress = runningProgress(tasks);
  const running = progress != null;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`dk-ib ${open ? 'on' : ''}`}
      title="任务中心"
      aria-label={running ? `任务中心，进行中 ${Math.round(progress * 100)}%` : '任务中心'}
      aria-expanded={open}
      onClick={onToggle}
    >
      {running && (
        <svg className="dk-ring" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="14" stroke="var(--desktop-surface-3)" />
          <circle
            cx="16"
            cy="16"
            r="14"
            stroke="var(--desktop-accent-fill)"
            strokeLinecap="round"
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - progress)}
            transform="rotate(-90 16 16)"
          />
        </svg>
      )}
      {running ? <DownloadSimple size={15} /> : <ListChecks size={18} />}
      {!running && unseen && <span className="dk-dot" />}
    </button>
  );
}

function progressText(task: DesktopTask): string {
  return task.total > 0 ? `${task.done}/${task.total}` : '准备中';
}

export function TaskPopover({
  tasks,
  anchorRef,
  reportOpen,
  onToggleReport,
  onCancel,
  onUndo,
  onOpenFolder,
  onClearFinished,
  onClose,
}: {
  tasks: readonly DesktopTask[];
  anchorRef: RefObject<HTMLButtonElement | null>;
  reportOpen: ReadonlySet<string>;
  onToggleReport: (id: string) => void;
  onCancel: (id: string) => void;
  onUndo: (id: string) => void;
  onOpenFolder: (folderId: string) => void;
  onClearFinished: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = anchorRef.current?.getBoundingClientRect();

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorRef, onClose]);

  const style = anchor
    ? { top: anchor.bottom + 6, right: Math.max(8, window.innerWidth - anchor.right - 4) }
    : { top: 52, right: 8 };

  return (
    <div ref={ref} className="dk-pop dk-task-pop" style={style} role="dialog" aria-label="任务中心">
      <div className="dk-pop-h">
        <b>任务中心</b>
        <button type="button" className="dk-btn sm ghost" disabled={!tasks.some((t) => t.status !== 'running')} onClick={onClearFinished}>
          清除已结束
        </button>
      </div>
      <div className="dk-scroll dk-task-list">
        {tasks.length === 0 ? (
          <EmptyState compact icon={<ListChecks size={24} />} title="没有任务" text="导入、整理和导出会出现在这里。" />
        ) : (
          tasks.map((task) => {
            const Icon = TASK_ICON[task.kind];
            const running = task.status === 'running';
            const report = task.report;
            const reportCount = report ? report.skippedFiles.length + report.errors.length : 0;
            const conflictCount = task.conflicts?.length ?? 0;
            const expandable = reportCount + conflictCount > 0;
            const expanded = reportOpen.has(task.id);
            return (
              <div key={task.id} className={`dk-task ${task.status}`}>
                <span className="dk-ti"><Icon size={17} /></span>
                <div className="dk-shrink">
                  <div className="dk-tt">
                    <b title={task.title}>{task.title}</b>
                    <small className="num">{running ? progressText(task) : formatRelativeTime(task.finishedAt ?? task.startedAt)}</small>
                  </div>
                  {running ? (
                    <>
                      <div className="dk-pb" role="progressbar" aria-valuemin={0} aria-valuemax={task.total || undefined} aria-valuenow={task.total ? task.done : undefined}>
                        <i style={{ width: task.total > 0 ? `${(Math.min(task.done, task.total) / task.total) * 100}%` : '6%' }} />
                      </div>
                      {task.detail && <p>{task.detail}</p>}
                    </>
                  ) : (
                    task.result && <p>{task.result}</p>
                  )}
                  {expanded && (
                    <div className="dk-rep">
                      {report?.skippedFiles.map((item, i) => (
                        <div key={`s-${i}`}><code>{item.path}</code> <span>· {skippedLabel(item.reason)}</span></div>
                      ))}
                      {report?.errors.map((error, i) => (
                        <div key={`e-${i}`}><code>{error}</code> <span>· 失败</span></div>
                      ))}
                      {task.conflicts?.map((c, i) => (
                        <div key={`c-${i}`}><code>{c.name}</code> <span>· {conflictLabel(c.reason)}</span></div>
                      ))}
                    </div>
                  )}
                  {(running && task.cancelable) || expandable || task.undoable || (!running && task.openFolderId) ? (
                    <div className="dk-acts">
                      {running && task.cancelable && (
                        <button type="button" className="dk-btn sm" onClick={() => onCancel(task.id)}>取消</button>
                      )}
                      {!running && expandable && (
                        <button type="button" className="dk-btn sm" onClick={() => onToggleReport(task.id)}>
                          {expanded ? '收起明细' : `查看明细（${reportCount + conflictCount}）`}
                        </button>
                      )}
                      {!running && task.undoable && (
                        <button type="button" className="dk-btn sm" onClick={() => onUndo(task.id)}>
                          <ArrowCounterClockwise size={13} />撤销
                        </button>
                      )}
                      {!running && task.openFolderId && (
                        <button type="button" className="dk-btn sm ghost" onClick={() => onOpenFolder(task.openFolderId!)}>
                          <FolderOpen size={14} />打开图包
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="dk-tip dk-task-foot">
        <ShieldCheck size={13} />任务记录只保存在本次会话；只能撤销最近一次整理或移动。
      </div>
    </div>
  );
}

function skippedLabel(reason: string): string {
  return reason === 'no-extension' ? '无扩展名' : reason === 'unsupported-format' ? '不支持的格式' : reason;
}

function conflictLabel(reason: string): string {
  return reason === 'source-missing' ? '源文件缺失' : reason === 'target-exists' ? '目标已存在' : reason === 'move-failed' ? '移动失败' : reason;
}
