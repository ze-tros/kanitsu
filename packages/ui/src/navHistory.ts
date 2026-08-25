/**
 * 前进/后退导航历史（浏览器/文件资源管理器风格）：栈 + 当前位置指针。
 *
 * 记录规则：每一次选中目录变化（进入、上一级退出、面包屑、目录树、查看器
 * 切换兄弟相册等）都作为一个独立历史节点记录——所以 a→b→退出b(到a)→c 的
 * 历史是 [a, b, a, c]，后退依次回到 a、b、a（与浏览器文件管理器一致）。
 *
 * 后退/前进按键本身不新增节点（浏览器语义）：反复按后退不会让历史无限增长；
 * 新导航会截断当前位置之后的分支（前进栈作废）。
 */

export interface NavHistory {
  /** 已访问目录 id 序列（含当前）。 */
  stack: string[];
  /** 当前位置在 stack 中的下标。 */
  pos: number;
}

export function createNavHistory(): NavHistory {
  return { stack: [], pos: -1 };
}

/**
 * 记录一次导航：截断当前位置之后的分支并把新位置追加进栈。
 * 新位置与栈顶相同时跳过（避免连点同一目录产生重复条目）。
 */
export function recordNav(prev: NavHistory, current: string): NavHistory {
  if (prev.stack[prev.pos] === current) return prev;
  const nextStack = [...prev.stack.slice(0, prev.pos + 1), current];
  return { stack: nextStack, pos: nextStack.length - 1 };
}

export function canGoBack(nav: NavHistory): boolean {
  return nav.pos > 0;
}

export function canGoForward(nav: NavHistory): boolean {
  return nav.pos >= 0 && nav.pos < nav.stack.length - 1;
}

/** 后退一步将要到达的位置；无历史时返回 undefined。 */
export function backTarget(nav: NavHistory): string | undefined {
  return canGoBack(nav) ? nav.stack[nav.pos - 1] : undefined;
}

/** 前进一步将要到达的位置；无前进历史时返回 undefined。 */
export function forwardTarget(nav: NavHistory): string | undefined {
  return canGoForward(nav) ? nav.stack[nav.pos + 1] : undefined;
}

export function moveBack(prev: NavHistory): NavHistory {
  return canGoBack(prev) ? { ...prev, pos: prev.pos - 1 } : prev;
}

export function moveForward(prev: NavHistory): NavHistory {
  return canGoForward(prev) ? { ...prev, pos: prev.pos + 1 } : prev;
}