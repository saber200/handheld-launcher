export type LibraryActions = {
  cycleGroup?: (dir: -1 | 1) => void;
  closeDialog?: () => boolean;
  /**
   * 打开卡片菜单。不传 id 时按**当前焦点所在的卡片**开（手柄 B 键就是这条路）；
   * 传 id 时按指定的那张开 —— 信息面板下面的「卡片菜单」按钮并不在卡片里，
   * 靠 `document.activeElement` 找不到目标（K1 的卡片条需要这条）。
   */
  openCardMenu?: (id?: string) => boolean;
};

let current: LibraryActions = {};

export function setLibraryActions(actions: LibraryActions) {
  current = actions;
}

export function libraryActions(): LibraryActions {
  return current;
}
