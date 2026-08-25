/**
 * 共享 IntersectionObserver（性能优化 P1）。
 *
 * 旧实现里每张图片各自 `new IntersectionObserver`，几千张图 = 几千个观察器
 * 对象，内存与回调分发开销都很大。这里改成模块级单例：所有卡片 observe 同一
 * 个观察器，命中回调按 Element 分发到对应回调。
 */
const ROOT_MARGIN = '300px';

type VisibilityCallback = (isIntersecting: boolean) => void;

let shared: IntersectionObserver | null = null;
const callbacks = new Map<Element, VisibilityCallback>();

function sharedObserver(): IntersectionObserver {
  if (!shared) {
    shared = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const cb = callbacks.get(entry.target);
          // 回调可能已解除但仍出现在本轮 entries 中：忽略即可。
          cb?.(entry.isIntersecting);
        }
      },
      { rootMargin: ROOT_MARGIN },
    );
  }
  return shared;
}

/**
 * 观察元素进入/离开视口（含 300px 提前量），返回取消观察的函数。
 * observe 后浏览器会异步回调一次当前可见状态。
 */
export function observeVisibility(el: Element, onChange: VisibilityCallback): () => void {
  callbacks.set(el, onChange);
  sharedObserver().observe(el);
  return () => {
    callbacks.delete(el);
    sharedObserver().unobserve(el);
  };
}
