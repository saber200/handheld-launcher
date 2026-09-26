export type FileActions = {
  back?: () => boolean;
  openMenu?: () => boolean;
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
