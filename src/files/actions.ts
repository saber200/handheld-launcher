export type FileActions = {
  back?: () => boolean;
  openMenu?: () => boolean;
  toggleSelect?: () => boolean;
  /** 双栏时 LT / RT 换栏（-1 左、+1 右）。返回 true 表示这次按键被接走了。 */
  switchPane?: (dir: -1 | 1) => boolean;
  blocksTabs?: () => boolean;
  dismiss?: () => void;
};

let current: FileActions = {};

export function setFileActions(actions: FileActions) {
  current = actions;
}

export function fileActions(): FileActions {
  return current;
}
