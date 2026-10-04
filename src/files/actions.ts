export type FileActions = {
  back?: () => boolean;
  openMenu?: () => boolean;
  toggleSelect?: () => boolean;
  /**
   * X 复制 / Y 剪切（规格书 §13.2 那张表里「文件」页的两格）。
   *
   * 为什么返回 boolean、而且**没有选中项时返回 false**：这两个动作是有前提的（得先选中
   * 东西）。App.tsx 那边据此决定要不要落到老绑定上（X 进选择模式 / Y 开菜单）——
   * 于是「X 复制」这条新快捷键不会把「怎么多选」「怎么开菜单」这两条老路堵死。
   * 见 FRONTEND.md「K7 按键角标」。
   */
  copy?: () => boolean;
  cut?: () => boolean;
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
