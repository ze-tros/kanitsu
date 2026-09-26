/**
 * 桌面端快捷键速查表（纯数据，不依赖 React）。
 *
 * 设置页「快捷键」标签页与主界面的快捷键对话框共用这一份清单，避免两处文案漂移。
 * keys 中每一项渲染为一个按键帽；同一行里的多个键按顺序排列（如 Alt ← →
 * 表示 Alt+← / Alt+→）。
 */
export interface DesktopShortcutItem {
  label: string;
  keys: readonly string[];
}

export interface DesktopShortcutGroup {
  title: string;
  items: readonly DesktopShortcutItem[];
}

export const DESKTOP_SHORTCUTS: ReadonlyArray<DesktopShortcutGroup> = [
  {
    title: '全局',
    items: [
      { label: '命令面板 / 搜索', keys: ['Ctrl', 'K'] },
      { label: '导入文件夹', keys: ['Ctrl', 'O'] },
      { label: '后退 / 前进（也可用鼠标侧键）', keys: ['Alt', '←', '→'] },
      { label: '打开设置', keys: ['Ctrl', ','] },
      { label: '显示 / 隐藏侧栏', keys: ['Ctrl', 'B'] },
      { label: '显示 / 隐藏检查器', keys: ['Ctrl', 'I'] },
      { label: '快捷键', keys: ['?'] },
    ],
  },
  {
    title: '浏览',
    items: [
      { label: '移动焦点', keys: ['方向键'] },
      { label: '打开', keys: ['Enter'] },
      { label: '勾选', keys: ['Space'] },
      { label: '全选', keys: ['Ctrl', 'A'] },
      { label: '重命名', keys: ['F2'] },
      { label: '删除', keys: ['Del'] },
      { label: '缩略图大小（也可用 Ctrl + 滚轮）', keys: ['Ctrl', '+', '−'] },
      { label: '取消选择', keys: ['Esc'] },
    ],
  },
  {
    title: '查看器',
    items: [
      { label: '上一张 / 下一张', keys: ['←', '→'] },
      { label: '同级上一个 / 下一个图包', keys: ['↑', '↓'] },
      { label: '首张 / 末张', keys: ['Home', 'End'] },
      { label: '适应窗口', keys: ['0'] },
      { label: '原始大小', keys: ['1'] },
      { label: '缩放', keys: ['+', '−'] },
      { label: '旋转', keys: ['R'] },
      { label: '图片信息', keys: ['I'] },
      { label: '胶片条', keys: ['F'] },
      { label: '删除', keys: ['Del'] },
      { label: '关闭', keys: ['Esc'] },
    ],
  },
];
