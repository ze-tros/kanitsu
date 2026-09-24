/**
 * 移动端返回栈的纯逻辑（从 MobileApp 抽出，便于对幽灵栈项/多级返回做回归测试）。
 *
 * 栈模型：目录导航用 pushState 逐层入栈；浮层（抽屉/面板/对话框/查看器/搜索…）
 * 用 replaceState 原地写入快照，不制造浏览器历史项；硬件返回由 popstate 按快照
 * 对账。这里全部是无副作用函数。
 *
 * 不变式：UI 状态与栈必须同步增删。任何让浮层消失的路径（含"删除当前图后
 * 查看器自动关闭"这类派生状态变化）都要裁掉对应栈项，否则幽灵条目会吞掉
 * 下一次硬件返回（返回键"死按"）。
 */

export type OverlayLayer =
  /** 目录树底部面板（沿用 drawer 名，history.state 快照里的历史值保持兼容）。 */
  | 'drawer'
  | 'sheet'
  | 'viewer'
  | 'settings'
  | 'organize'
  | 'cover'
  | 'dialog'
  | 'search'
  | 'tasks'
  | 'display';

export type StackEntry = { type: 'folder'; folderId: string } | { type: 'overlay'; layer: OverlayLayer };

export function stackEntryEq(a: StackEntry, b: StackEntry): boolean {
  if (a.type === 'folder' && b.type === 'folder') return a.folderId === b.folderId;
  if (a.type === 'overlay' && b.type === 'overlay') return a.layer === b.layer;
  return false;
}

/**
 * 主动关闭某 overlay：裁掉该条目及其以上的一切，并返回需要同步关闭的 UI 层。
 * 条目不存在时栈原样返回（同一引用）、closed 仍含 layer——调用方无论如何都把
 * UI 关掉，"关闭一个已关闭的层"是幂等操作。
 */
export function closeOverlayEntries(
  stack: StackEntry[],
  layer: OverlayLayer,
): { stack: StackEntry[]; closed: OverlayLayer[] } {
  const idx = stack
    .map((e, i) => (e.type === 'overlay' && e.layer === layer ? i : -1))
    .filter((i) => i >= 0)
    .pop();
  if (idx == null) return { stack, closed: [layer] };
  const closed: OverlayLayer[] = [];
  for (let k = idx; k < stack.length; k++) {
    const e = stack[k]!;
    if (e.type === 'overlay') closed.push(e.layer);
  }
  return { stack: stack.slice(0, idx), closed };
}

/**
 * popstate 对账：目标栈与当前栈比对，返回要关闭的层与回退后的目录 id。
 * 两者一致时 changed=false（主动关闭触发的 back()，调用方直接忽略）；
 * 目标栈里没有目录条目时 folderId=null（调用方用根目录兜底）。
 */
export function reconcilePop(
  current: StackEntry[],
  target: StackEntry[],
): { changed: boolean; closed: OverlayLayer[]; folderId: string | null } {
  if (target.length === current.length && target.every((e, i) => stackEntryEq(e, current[i]!))) {
    return { changed: false, closed: [], folderId: null };
  }
  let i = 0;
  while (i < current.length && i < target.length && stackEntryEq(current[i]!, target[i]!)) i++;
  const closed: OverlayLayer[] = [];
  for (let k = i; k < current.length; k++) {
    const e = current[k]!;
    if (e.type === 'overlay') closed.push(e.layer);
  }
  const topFolder = [...target].reverse().find((e): e is { type: 'folder'; folderId: string } => e.type === 'folder');
  return { changed: true, closed, folderId: topFolder ? topFolder.folderId : null };
}
