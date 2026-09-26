export type LibraryActions = {
  cycleGroup?: (dir: -1 | 1) => void;
  closeDialog?: () => boolean;
  openCardMenu?: () => boolean;
};

let current: LibraryActions = {};

export function setLibraryActions(actions: LibraryActions) {
  current = actions;
}

export function libraryActions(): LibraryActions {
  return current;
}
