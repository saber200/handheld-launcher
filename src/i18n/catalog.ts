export type Locale = "zh" | "en";

/** 底部提示条有内容的页面（首页 / 下载本版只有占位，但仍要给条上留开关抽屉那两条）。 */
export type Catalog = {
  productName: string;
  about: string;
  close: string;
  cancel: string;
  create: string;
  delete: string;
  save: string;
  edit: string;
  open: string;
  tabs: {
    menu: string;
    home: string;
    games: string;
    apps: string;
    downloads: string;
    files: string;
    toolbox: string;
    /** 模拟器页（六个平台：PS2 / PS3 / Switch / PS4 / 街机 / 全能）。 */
    emulators: string;
    store: string;
    community: string;
  };
  /** 外壳（顶栏 / 页签条 / 底部状态条）固定文案。 */
  shell: {
    storageTitle: string;
    /** 存储容量还没有数据源（要新的系统信息命令），如实说明，不摆假数字。 */
    storagePending: string;
    /**
     * 存储读数右边那行小字：列出**参与相加的盘符**（`mounts` 形如 `["C:", "D:"]`，
     * `label` 只在单块盘时非空）。多块盘时必须写明「合计」—— 数字是相加的、标签却像
     * 只有一块盘的话，用户会觉得这个数不对（2026-10-05 就是这么反馈的）。
     * 2026-10-11 起它不再画在界面上（存储卡改成状态条里的一行读数，只留 aria-label 与 title）。
     */
    storageVolumes: (mounts: string[], label: string) => string;
    /** 锁定项给读屏的播报：「商店，即将开放，不可用」。 */
    lockedAria: (name: string) => string;
  };
  /** 首页 / 下载：需要新数据源的页面，本版先占位并把话说清楚。 */
  /* ── 首页（画板 K5）与下载（画板 K6）：都是真数据，见 pages/HomePage.tsx / DownloadsPage.tsx ── */
  home: {
    resumeChip: string;
    lastLaunched: (when: string) => string;
    resume: string;
    details: string;
    recentTitle: string;
    recentSub: string;
    viewAll: string;
    appsTitle: string;
    installedOn: (date: string) => string;
    statusBattery: string;
    statusStorage: string;
    /** 这台机器上读不到那一格时显示的字（就是一个破折号）。 */
    statusNone: string;
    empty: string;
    emptyBody: string;
    /** 空态那颗按钮：去游戏库。 */
    openLibrary: string;
    today: string;
    yesterday: string;
    daysAgo: (count: number) => string;
    batteryLeft: (time: string) => string;
    charging: string;
    freeOf: (free: string, total: string) => string;
  };
  downloads: {
    title: string;
    sub: (running: number, done: number) => string;
    statRate: string;
    statEta: string;
    statBytes: string;
    modSection: string;
    modRow: (percent: string, right: string) => string;
    empty: string;
    emptyBody: string;
    note: string;
    noteBody: string;
  };

  hints: {
    filesNav: string;
    filesMulti: string;
    filesOpen: string;
    filesBack: string;
    filesCopy: string;
    filesTabs: string;
    tabs: string;
    keys: string;
    settings: string;
    groups: string;
    focusTools: string;
    cardMenu: string;
    confirm: string;
  };
  settings: {
    title: string;
    close: string;
    /** K3 抽屉标题行右边那句「双击 Back 呼出 · Esc 关闭」。 */
    panelSub: string;
    /** K3 抽屉底部那行按键提示。 */
    panelKeys: string;
    /** 「关于」那一行。 */
    aboutTitle: string;
    aboutStack: string;
    language: string;
    languageHint: string;
    autostart: string;
    autostartHint: string;
    /** 「登录自启时顺手把 Steam 静默拉到后台」那一行（默认关）。 */
    steamSilent: string;
    steamSilentHint: string;
    /** 开机自启关着时跟在提示后面的那句「这一项靠它才生效」。 */
    steamSilentNeedsAutostart: string;
    steamSilentOn: string;
    steamSilentOff: string;
    steamSilentReadFailed: string;
    steamSilentPreview: string;
    steamSilentFailed: (detail: string) => string;
    /* ── 功能 14 第 5 条补的两行 ── */
    scaleTitle: string;
    scaleHint: string;
    /** 自动档的读数：参数是算出来的倍率（「1.13」）。 */
    scaleAuto: (value: string) => string;
    /** 手动档：第一个参数是用户系数（「1.1」），第二个是最终倍率。 */
    scaleManual: (factor: string, value: string) => string;
    scaleSmall: string;
    scaleNormal: string;
    scaleBig: string;
    deadzoneTitle: string;
    deadzoneHint: string;
    /** 参数是百分比整数（「35」）。 */
    deadzoneValue: (percent: string) => string;
    deadzoneRaw: (value: string) => string;
    on: string;
    off: string;
    fullscreen: string;
    fullscreenHint: string;
    desktop: string;
    desktopHint: string;
    fse: string;
    fseHint: string;
    fseRegister: string;
    fseRegisterHint: string;
    fseOpenSettings: string;
    fseOpenSettingsHint: string;
    fsePreview: string;
    quit: string;
    quitHint: string;
    autostartReadFailed: string;
    autostartPreview: string;
    autostartOn: string;
    autostartOff: string;
    autostartFailed: (detail: string) => string;
    fullscreenPreview: string;
    fullscreenDone: string;
    fullscreenFailed: (detail: string) => string;
    desktopPreview: string;
    desktopDone: string;
    desktopFailed: (detail: string) => string;
    fseOpenFailed: (detail: string) => string;
    powerPreview: string;
    slept: string;
    powerFailed: (detail: string) => string;
  };
  power: { menu: string; sleep: string; restart: string; shutdown: string };
  // 工具箱（画板 K4）的文案。以前这一段叫 `frontend` —— 那套独立前端程序的文案
  // 已随程序一起删除，剩下的全是工具箱自己在用，名字跟着改成它实际服务的东西。
  toolbox: {
    toolboxPreview: string;
    toolboxFailed: (detail: string) => string;
    toolboxInstall: string;
    toolboxReinstall: string;
    toolboxWorking: string;
    toolboxInstalling: string;
    runtimesTitle: string;
    runtimesBody: string;
    runtimesEmpty: string;
    // 画板 K4（工具箱）：页面小标题、自检按钮、各卡的短文案。
    toolboxSubtitle: string;
    toolboxSelfCheck: string;
    toolboxModTitle: string;
    toolboxModBody: string;
    toolboxModAction: string;
    toolboxRuntimesSub: string;
    toolboxRuntimesAction: string;
    toolboxMaintenanceTitle: string;
    toolboxMaintenanceSub: string;
    toolboxMaintenancePending: string;
    /* ── 系统维护那三行（功能 14 第 2 条） ── */
    toolboxCacheRow: (size: string) => string;
    toolboxStartupRow: (count: number) => string;
    toolboxLogRow: (size: string) => string;
    toolboxCacheEmpty: string;
    toolboxStartupReadonly: string;
    toolboxClean: string;
    toolboxCleaning: string;
    toolboxCleanDone: (freed: string, caches: number, logs: number) => string;
    toolboxCleanNothing: string;
    /* ── 「查看列表」与驱动版本（功能 14 第 3、4 条） ── */
    toolboxModListAction: string;
    toolboxModListTitle: string;
    toolboxModListLoading: string;
    toolboxModListEmpty: string;
    toolboxModListBody: string;
    toolboxModListEntry: (game: string, version: string) => string;
    toolboxModListLegacy: string;
    toolboxModInstalled: (count: number, version: string) => string;
  };
  keyboard: { label: string; backspace: string; done: string };
  library: {
    all: string;
    groups: string;
    newGroup: string;
    addApps: string;
    deleteGroup: string;
    addGame: string;
    addApp: string;
    addFromScan: string;
    restoreHint: string;
    restoreEmpty: string;
    rescan: string;
    noCards: string;
    ungrouped: string;
    close: string;
    hideGameTitle: string;
    hideAppTitle: string;
    hideHeading: (library: string, name: string) => string;
    hideBody: string;
    deleteGroupTitle: string;
    deleteGroupHeading: (name: string) => string;
    deleteGroupBody: string;
    steamTitle: string;
    steamHeading: (name: string) => string;
    steamPlaceholder: string;
    steamBody: string;
    fetchCover: string;
    newGroupTitle: string;
    groupPlaceholder: string;
    setGroup: string;
    rename: string;
    changePath: string;
    steamMenu: string;
    installMods: string;
    installModsBusy: string;
    installModsPreview: string;
    installModsNoPath: string;
    installModsResult: (name: string, detail: string) => string;
    installModsFailed: (name: string, detail: string) => string;
    uninstallModsResult: (name: string, detail: string) => string;
    uninstallModsFailed: (name: string, detail: string) => string;
    modsTitle: (name: string) => string;
    modsLoading: string;
    modsDir: (dir: string) => string;
    modsExe: (name: string) => string;
    modsNoExe: string;
    modsCandidates: (names: string) => string;
    modsLoaded: string;
    modsNotLoaded: string;
    modsSwitchTo: (hook: string) => string;
    modsTried: (hooks: string) => string;
    modsNoDir: string;
    modsInstalled: (version: string, hook: string) => string;
    modsInstalledLegacy: string;
    modsHook: string;
    modsHookHint: string;
    modsLatest: string;
    /** 版本选择器里「自带版」那一片（随启动器发出去、带 FSR 4.1.1 放大器的那一份）。 */
    modsBundled: string;
    /** 已装的那一套**确实**带 FSR 4.1.1 放大器（判据是文件在不在，不是版本名）。 */
    modsFsr4: string;
    /** 已装的是官方包：放大器还是旧的 FSR 4，想要 4.1.1 就换自带版。 */
    modsFsr4Official: string;
    modsConflict: (name: string) => string;
    modsArch: (name: string) => string;
    modsRunning: string;
    modsWarn: string;
    modsInstall: string;
    modsReinstall: string;
    modsUninstall: string;
    modsProgress: (percent: number) => string;
    modsExtracting: string;
    modsWriting: string;
    modsCancel: string;
    modsClose: string;
    remove: string;
    leaveGroup: string;
    currentGroup: string;
    noGroups: string;
    addCards: string;
    addTo: (name: string) => string;
    pickerHint: string;
    currentLibrary: string;
    gamesPreview: string;
    gamesScanning: string;
    gamesEmpty: string;
    gamesReady: (count: number) => string;
    appsPreview: string;
    appsScanning: string;
    appsEmpty: string;
    appsReady: (count: number) => string;
    rescanning: string;
    scanFailed: (detail: string) => string;
    previewLaunch: string;
    launching: string;
    launched: (name: string) => string;
    switched: (name: string) => string;
    alreadyRunning: (name: string) => string;
    quitGame: string;
    quitGameDone: (name: string) => string;
    quitGameNotRunning: (name: string) => string;
    quitGameFailed: (name: string, detail: string) => string;
    launchFailed: (name: string, detail: string) => string;
    failed: string;
    added: (name: string) => string;
    pathUpdated: (name: string) => string;
    hidden: string;
    restored: string;
    allHidden: string;
    onlyAdded: (count: number) => string;
    alreadyInLibrary: string;
    steamDigits: string;
    steamMissing: string;
    steamApplied: (id: string) => string;
    previewNoScan: string;
    /* ── K1（画板）横向卡片条用的文案。画板上的「时长·体积 / 兼容性 / 收藏」这些格子
       本地没有数据源或能力，一律不摆（见 STATUS.md 的 M1 一节），所以这里只有真字段。 ── */
    focusLabel: string;
    focusLine: (name: string) => string;
    gameCount: (count: number) => string;
    startGame: string;
    cardMenu: string;
    platformSteam: string;
    platformEpic: string;
    platformManual: string;
    fieldSource: string;
    fieldState: string;
    fieldPath: string;
    fieldSize: string;
    fieldPlaytime: string;
    /** 时长/体积的写法（画板：42.6 小时 · 8.4 GB）—— 单位跟着语言走，数值由 format.ts 算。 */
    hours: (value: string) => string;
    minutes: (value: string) => string;
    stateRunning: string;
    stateIdle: string;
    /** K2（画板）软件库：页面副标题的计数 + 卡片包头行的状态字。 */
    appCount: (count: number) => string;
    stateInstalled: string;
    /* ── K2 的搜索框与底部操作条（FUTURE.md 功能 14 第 6、7 条） ── */
    searchPlaceholder: string;
    searchClear: string;
    noSearchHit: string;
    openFolder: string;
    /** K2 底部主按钮：启动一个已装的软件（画板上那颗写的是「安装」，那是**预置**软件的写法）。 */
    startApp: string;
    /** 底部操作条左边那行元信息（「v1.2.1 · 240 MB · 已安装」这类，空的部分不拼）。 */
    barMeta: (parts: string) => string;
  };
  files: {
    folder: string;
    sizeAtLeast: (size: string) => string;
    file: string;
    drives: string;
    back: string;
    viewMode: string;
    list: string;
    grid: string;
    newFolder: string;
    newFile: string;
    paste: string;
    selectAll: string;
    clearSelection: string;
    up: string;
    emptyFolder: string;
    emptyHint: string;
    /** 位置读不出来时的补一句（盘拔了 / 权限没了 —— 和「空文件夹」不是一回事）。 */
    emptyReadFailHint: string;
    unselect: (name: string) => string;
    select: (name: string) => string;
    dirMark: string;
    fileMark: string;
    selectedCount: (count: number) => string;
    pickedHint: (count: number) => string;
    previewHint: string;
    browseHint: string;
    editAction: string;
    copy: string;
    move: string;
    namePlaceholder: string;
    createHint: string;
    editorHint: string;
    saveFailed: string;
    deleteTitle: string;
    deleteOne: (name: string) => string;
    deleteMany: (count: number) => string;
    deleteBody: string;
    editTitle: (name: string) => string;
    cannotCreate: string;
    cannotEdit: string;
    cannotOpen: string;
    actionFailed: string;
    needName: string;
    badName: string;
    badChars: string;
    drivesTitle: string;
    previewRoot: string;
    root: string;
    choosePlace: string;
    missingPaste: string;
    alreadyHere: string;
    intoItself: string;
    pasteIntoFolder: string;
    nameTaken: string;
    pasted: (name: string) => string;
    moved: (name: string) => string;
    copiedClip: (label: string) => string;
    moveClip: (label: string) => string;
    itemCount: (count: number) => string;
    quoted: (name: string) => string;
    enterFolderFirst: string;
    partial: (done: number, error: string) => string;
    pastedMany: (count: string) => string;
    movedMany: (count: string) => string;
    folderCreated: (name: string) => string;
    fileCreated: (name: string) => string;
    notText: string;
    cannotSave: string;
    saved: (name: string) => string;
    cannotDeleteHere: string;
    deletedOne: (name: string) => string;
    deletedMany: (count: number) => string;
    recycledOne: (name: string) => string;
    recycledMany: (count: number) => string;
    deletePermanent: string;
    deleteRecycle: string;
    extract: string;
    extracting: (name: string) => string;
    extractDone: (files: number, dir: string) => string;
    extractFailed: (name: string, detail: string) => string;
    compress: string;
    compressing: (count: number) => string;
    compressDone: (items: number, archive: string) => string;
    compressFailed: (detail: string) => string;
    showHidden: string;
    hideHidden: string;
    keyboard: string;
    keyboardHint: string;
    transferRate: (rate: string, remaining: string) => string;
    previewOpen: string;
    opened: (name: string) => string;
    copyName: (stem: string, n: number, ext: string) => string;
    exeOnly: string;
    pickerPreview: string;
    pickerNative: string;
    // 功能 12：双栏 / 排序 / 面包屑 / 常用位置 / 搜索 / 属性 / 改名 / 传输进度
    pathHere: string;
    leftPane: string;
    rightPane: string;
    dual: string;
    dualHint: (pane: string) => string;
    sortBy: string;
    sortName: string;
    sortSize: string;
    sortTime: string;
    sortType: string;
    places: string;
    placesTitle: string;
    search: string;
    searchTitle: (pane: string) => string;
    searchPlaceholder: string;
    searchStart: string;
    searchKeyboard: string;
    searching: string;
    searchEmpty: (query: string) => string;
    searchCap: string;
    searchInsideFolder: string;
    selectModeHint: string;
    rename: string;
    renameTitle: (name: string) => string;
    renameHint: string;
    renamed: (name: string) => string;
    renamedMany: (count: number) => string;
    cannotRenameHere: string;
    batchRename: string;
    batchModeOriginal: string;
    batchModeNumber: string;
    batchModeReplace: string;
    batchBase: string;
    batchBaseHint: string;
    batchStart: string;
    batchFind: string;
    batchReplace: string;
    batchPreview: string;
    batchUnchanged: string;
    batchMore: (count: number) => string;
    batchKeyboard: string;
    batchRun: string;
    batchEmpty: string;
    properties: string;
    propsReading: string;
    propPath: string;
    propKind: string;
    propSize: string;
    propPartial: string;
    propModified: string;
    propCreated: string;
    propExtension: string;
    propAttrs: string;
    attrReadonly: string;
    attrHidden: string;
    propWritable: string;
    propYes: string;
    propNo: string;
    cannotReadProperties: string;
    unknown: string;
    hintDenied: string;
    hintBusy: string;
    hintSpace: string;
    hintToolong: string;
    hintProtected: string;
    startCopy: (label: string) => string;
    startMove: (label: string) => string;
    transferScan: string;
    transferMeta: (index: number, total: number, done: string, totalBytes: string) => string;
    transferCancel: string;
    transferDone: (items: number) => string;
    transferDoneSkipped: (items: number, skipped: number) => string;
    transferCancelled: (items: number) => string;
    reasonCancelled: string;
    copyToOther: (pane: string) => string;
    moveToOther: (pane: string) => string;
    conflictTitle: string;
    conflictBody: (count: number) => string;
    conflictReplace: string;
    conflictSkip: string;
    conflictKeep: string;
    previewCross: string;
  };
  /**
   * 文件管理增强（改造包 §2–§5）：任务入口 / 四步向导 / 预览面板 / 任务中心 /
   * 重命名对照 / 冲突应用到全部 / 总量摘要。
   *
   * 为什么单开一节而不是塞进 `files`：`files` 已经 160 多个字段（通用文件管理器的家底），
   * 再往里堆任务层会让「哪句话是哪一层的」彻底看不出来。
   */
  tasks: {
    /* ── 入口层 ── */
    tabBrowse: string;
    tabTasks: string;
    tabJobs: string;
    gridBody: string;
    runningCount: (count: number) => string;
    cardUnavailable: (reason: string) => string;
    cardOpen: (title: string) => string;
    cards: {
      importRom: { title: string; desc: string; meta: string };
      installMod: { title: string; desc: string; meta: string };
      backupSaves: { title: string; desc: string; meta: string };
      restoreSaves: { title: string; desc: string; meta: string };
      exportShots: { title: string; desc: string; meta: string };
      cleanup: { title: string; desc: string; meta: string };
      usb: { title: string; desc: string; meta: string };
      recentJobs: { title: string; desc: string; meta: string };
    };
    /* ── 四步向导 ── */
    stepNames: string[];
    scanning: string;
    next: string;
    back: string;
    close: string;
    start: string;
    again: string;
    sourceBody: string;
    sourceMissing: string;
    resultTitle: string;
    resultMeta: (count: number, size: string) => string;
    resultEmpty: string;
    resultTruncated: (count: number) => string;
    unknownBucket: string;
    unknownHint: string;
    targetTitle: string;
    targetMissing: string;
    targetPick: string;
    targetHave: (count: number) => string;
    targetNew: string;
    conflictTitle: string;
    conflictSkip: string;
    conflictReplace: string;
    conflictKeep: string;
    summaryTitle: string;
    sumCount: string;
    sumBytes: string;
    sumEta: string;
    sumConflict: string;
    sumNone: string;
    sumEstimate: string;
    etaSec: string;
    etaMin: string;
    etaHour: string;
    runTitle: string;
    runBody: string;
    runCancel: string;
    runCancelling: string;
    runProgress: (done: number, total: number) => string;
    doneTitle: (count: number) => string;
    doneSkipped: (count: number) => string;
    doneFailed: (count: number) => string;
    cancelledTitle: string;
    rollbackNone: string;
    rollbackOk: (count: number) => string;
    rollbackFail: (count: number) => string;
    failTitle: string;
    /* ── 各任务的字段与选项 ── */
    optAction: string;
    optTarget: string;
    optGame: string;
    optGameAuto: string;
    optStripped: string;
    optBackupName: string;
    optChecks: string;
    optRelease: (size: string) => string;
    optNothing: string;
    optEjectHint: string;
    optDevice: string;
    optPickDevice: string;
    optNoDevice: string;
    optDeleteWarning: string;
    optBakNote: string;
    /** 「替换」模式下被覆盖的旧文件回滚不了 —— 摘要在开始前就得说清楚。 */
    replaceNoRollback: string;
    optShotsNone: string;
    optSaveCount: (count: number) => string;
    /* ── 来源目录的名字（来源列表与「恢复存档」都用它） ── */
    srcDownloads: string;
    srcDesktop: string;
    srcDocuments: string;
    srcPictures: string;
    srcCaptures: string;
    srcRoms: string;
    srcBackups: string;
    srcShots: string;
    srcDevice: (name: string) => string;
    /* ── 处理截图的三种动作 ── */
    shotsExport: string;
    shotsArchive: string;
    shotsDelete: string;
    /* ── 清理空间的分类 ── */
    cleanInstallers: string;
    cleanInstallersHint: string;
    cleanDupShots: string;
    cleanDupShotsHint: string;
    cleanLogs: string;
    cleanLogsHint: string;
    cleanCaches: string;
    cleanCachesHint: string;
    cleanRecycle: string;
    cleanRecycleHint: string;
    /* ── U 盘 ── */
    usbToDevice: string;
    usbFromDevice: string;
    usbToDeviceHint: string;
    usbFromDeviceHint: string;
    usbEject: string;
    usbEjectAfter: string;
    usbEjectAfterHint: string;
    usbEjectDone: string;
    /* ── 光碟镜像的魔数判定 ── */
    discBucket: string;
    discBucketHint: string;
    discNote: (count: number) => string;
    /* ── 预览面板（F2） ── */
    previewTitle: string;
    previewAuto: string;
    previewToggle: string;
    previewOff: string;
    previewText: string;
    previewArchive: string;
    previewArchiveMore: (count: number) => string;
    previewRom: string;
    previewGame: string;
    previewDir: string;
    previewDirCount: (count: number, size: string) => string;
    previewDisc: (magic: string) => string;
    previewCover: string;
    previewLoading: string;
    previewTooBig: string;
    previewFailed: string;
    previewEmpty: string;
    previewOpen: string;
    previewDelete: string;
    previewKey: string;
    previewType: string;
    previewLocation: string;
    /* ── 任务中心（F3） ── */
    jobsTitle: string;
    jobsBody: (running: number, done: number) => string;
    jobsRunning: string;
    jobsRecent: string;
    jobsClear: string;
    jobsEmpty: string;
    jobsEmptyBody: string;
    /** 空态那颗按钮（下载页用）：去文件页起一个任务。 */
    jobsOpenFiles: string;
    jobsPause: string;
    jobsPauseHint: string;
    jobsPaused: string;
    jobsResume: string;
    jobsCancel: string;
    jobsCancelled: string;
    jobsFailed: string;
    jobsSkipped: (count: number) => string;
    jobsNote: string;
    jobsNoteBody: string;
    jobsSourceTo: (from: string, to: string) => string;
    jobsPercent: (percent: number, done: string, total: string, rate: string, eta: string) => string;
    /* ── 重命名对照与冲突（F4） ── */
    renamePreviewTitle: string;
    renamePreviewHint: string;
    renameColumnFrom: string;
    renameColumnTo: string;
    renameColumnState: string;
    renameConflictChip: string;
    renameUnchanged: string;
    renameOk: string;
    renameConflictCard: (name: string) => string;
    renameApplyAll: string;
    renameApplyAllHint: string;
    renameRun: string;
    renameCount: (changed: number, conflict: number) => string;
    confirmTitle: string;
    confirmDeleteBody: string;
    confirmDeleteMany: (count: number, size: string) => string;
  };
  /** 模拟器页（新页签）：一张卡一个平台，能自动装的直接下、装到非系统盘。 */
  emulators: {
    sub: string;
    refresh: string;
    /** 安装位置的标题行：「安装位置」+ 当前路径 + 改 / 恢复默认。 */
    rootTitle: string;
    rootChange: string;
    rootReset: string;
    rootCustom: string;
    rootDefault: string;
    rootHint: string;
    /** 只有装好的那几张卡才量体积，单独一颗按钮。 */
    measure: string;
    measuring: string;
    install: string;
    reinstall: string;
    cancel: string;
    launch: string;
    openFolder: string;
    uninstall: string;
    /** 二次确认（卸载会连存档一起删，所以必须问一次）。 */
    uninstallConfirm: string;
    uninstallYes: string;
    uninstallNo: string;
    /** 「游戏列表」面板（这一版只有列表，下载源还没接）。 */
    roms: string;
    romsTitle: (platform: string) => string;
    romsDir: (dir: string) => string;
    romsNoDrive: string;
    romsOpenDir: string;
    romsLoading: string;
    romsEmpty: string;
    /** 来源那一行：如实说还没接，别摆假按钮。 */
    romsSourcePending: string;
    /** 手动项（RPCS3 / Switch）：打不开官网时至少给个地址。 */
    openSite: string;
    manualTag: string;
    /** 一个平台的安装状态那行：「已安装 · 2.8.2 · 620 MB」。 */
    stateInstalled: (version: string, size: string) => string;
    stateInstalledNoVersion: (size: string) => string;
    sizeUnknown: string;
    stateMissing: string;
    /** 进度：「下载中 42%」+ 明细那行。 */
    phaseResolve: string;
    phaseDownload: string;
    phaseExtract: string;
    phaseCopy: string;
    phaseDone: string;
    progressBytes: (done: string, total: string) => string;
    progressUnknown: (done: string) => string;
    /** 解压那一步按**文件个数**报进度（sevenz 的逐条回调给不了字节数）。 */
    progressFiles: (done: number, total: number) => string;
    /** 还没拿到总量时那一行的字（按阶段分：解压 / 就位 都不是「已下载」）。 */
    progressWorking: string;
    /** 换过安装位置之后，已经装好的那几张卡要标出自己在哪儿。 */
    elsewhere: (dir: string) => string;
    /** 一次只能装一个：别的卡在装的时候，其他卡的按钮要说明为什么点不了。 */
    busyOther: string;
    /** 收尾提示。 */
    installedNote: (name: string) => string;
    launchedNote: (name: string) => string;
    removedNote: (name: string) => string;
    failed: (detail: string) => string;
    /** 非 Windows / 浏览器预览里那一页要说的话。 */
    unsupported: string;
    empty: string;
  };
};

export const zh: Catalog = {
  productName: "幻想枢纽",
  about: "专为掌机玩家而生",
  close: "关闭",
  cancel: "取消",
  create: "创建",
  delete: "删除",
  save: "保存",
  edit: "编辑",
  open: "打开",
  tabs: {
    menu: "主菜单",
    home: "首页",
    games: "游戏库",
    apps: "软件库",
    downloads: "下载",
    files: "文件",
    toolbox: "工具箱",
    emulators: "模拟器",
    store: "商店",
    community: "社区",
  },
  hints: {
    filesNav: "方向键选择",
    filesMulti: "X 多选；选中之后 X 复制",
    filesOpen: "A 打开",
    filesBack: "B 返回",
    filesCopy: "Y 菜单；选中之后 Y 剪切（☰ 也是菜单）",
    filesTabs: "LB / RB 切页；双栏时 LT / RT 换栏",
    tabs: "LB / RB 切换",
    keys: "键盘 Q / E",
    settings: "双击 Back / Share（Esc）设置",
    groups: "LT / RT 切换分组",
    focusTools: "方向键移到新建 / 添加",
    cardMenu: "B 卡片操作",
    confirm: "A / Enter 启动或确认",
  },
  shell: {
    storageTitle: "存储空间",
    storagePending: "容量读取待接入",
    // 单块盘：还是「盘符 + 卷标」；多块盘：把盘符列出来再说一句「合计」——
    // 那个数字是几块盘相加的，标签必须让用户看得出来（否则会以为只有第一块盘）。
    storageVolumes: (mounts, label) => {
      if (mounts.length === 0) return "";
      if (mounts.length === 1) return `${mounts[0]} ${label}`.trim();
      const head = mounts.slice(0, 3).join(" + ");
      const more = mounts.length > 3 ? ` 等 ${mounts.length} 块` : "";
      return `${head}${more} · 合计`;
    },
    lockedAria: (name) => `${name}，即将开放，不可用`,
  },
  // 提示条只写**真的绑上了**的按键 —— 设计稿里的 X 收藏 / Y 打开目录 / 快速菜单还没做，
  home: {
    resumeChip: "继续游玩",
    lastLaunched: (when) => `上次启动：${when}`,
    resume: "继续游玩",
    details: "详情",
    recentTitle: "继续游玩",
    recentSub: "最近启动过的游戏",
    viewAll: "查看全部",
    appsTitle: "最近安装的软件",
    installedOn: (date) => `安装于 ${date}`,
    statusBattery: "续航预估",
    statusStorage: "存储空间",
    statusNone: "—",
    empty: "还没有启动记录",
    emptyBody:
      "从游戏库启动一个游戏，这里就会接着显示。首页只写这台机器上真的发生过的事，不摆示例数据。",
    openLibrary: "去游戏库",
    today: "今天",
    yesterday: "昨天",
    daysAgo: (count) => `${count} 天前`,
    batteryLeft: (time) => `约 ${time}`,
    charging: "充电中",
    freeOf: (free, total) => `可用 ${free} / ${total}`,
  },
  downloads: {
    title: "下载",
    sub: (running, done) => `${running} 个进行中 · ${done} 个已完成`,
    statRate: "总速度",
    statEta: "剩余时间",
    statBytes: "本次已传",
    modSection: "Mod / 工具安装",
    modRow: (percent, right) => `${percent}% · ${right}`,
    empty: "现在没有任务",
    emptyBody: "文件复制 / 移动、OptiScaler 安装都会出现在这里，切页也不丢。",
    note: "Steam 自己的下载不在这里",
    noteBody:
      "启动器看不到 Steam 的下载队列（那是 Steam 自己管的）。这一页只说启动器自己在做的事：文件传输与 Mod 安装。",
  },
  settings: {
    title: "设置",
    close: "关闭设置",
    panelSub: "双击 Back 呼出 · Esc 关闭",
    panelKeys: "A 确认 · B 关闭抽屉 · ↑↓ 移动焦点 · ←→ 调整数值",
    aboutTitle: "关于",
    aboutStack: "Tauri 2 · Rust + React",
    language: "语言",
    languageHint: "中文显示幻想枢纽，英文显示 FantasyHub",
    autostart: "开机自启",
    autostartHint: "登录后打开启动器",
    steamSilent: "开机时拉起 Steam",
    steamSilentHint:
      "自启时静默拉起 Steam；Steam 里要勾「记住密码」，否则拉起来的只是登录框",
    steamSilentNeedsAutostart: "先打开上面的「开机自启」才生效",
    steamSilentOn:
      "已开启。下次登录时启动器会把 Steam 拉到后台，之后点游戏直接进，不再弹 Steam 窗口。",
    steamSilentOff: "已关闭。点游戏时才启动 Steam（可能先弹出 Steam 窗口）。",
    steamSilentReadFailed: "无法读取这一项的状态（需在打包后的桌面端测试）",
    steamSilentPreview: "浏览器预览模式不支持这一项，请用 tauri:dev 或安装包验证",
    steamSilentFailed: (detail) => `Steam 设置失败：${detail}`,
    scaleTitle: "界面缩放",
    scaleHint: "按屏幕自动换算",
    scaleAuto: (value) => `自动 · ${value}×`,
    scaleManual: (factor, value) => `手动 ×${factor} · ${value}×`,
    scaleSmall: "小",
    scaleNormal: "标准",
    scaleBig: "大",
    deadzoneTitle: "手柄死区",
    deadzoneHint: "摇杆方向判定阈值",
    deadzoneValue: (percent) => `${percent}%`,
    deadzoneRaw: (value) => `阈值 ${value}`,
    on: "开",
    off: "关",
    fullscreen: "回到全屏",
    fullscreenHint: "启动器将重新铺满屏幕",
    desktop: "打开桌面",
    desktopHint: "打开 Windows 桌面",
    fse: "全屏体验状态",
    fseHint: "登记后可在系统设置里选成主页应用",
    fseRegister: "登记全屏体验",
    fseRegisterHint: "需要开发人员模式；管理员运行更稳",
    fseOpenSettings: "打开系统全屏体验设置",
    fseOpenSettingsHint: "把主页应用选成「幻想枢纽」",
    fsePreview: "浏览器预览无法登记全屏体验",
    quit: "退出启动器",
    quitHint: "退出并回到桌面",
    autostartReadFailed: "无法读取开机自启状态（需在打包后的桌面端测试）",
    autostartPreview: "浏览器预览模式不支持自启，请用 tauri:dev 或安装包验证",
    autostartOn: "已开启。下次登录进入启动器；这次被关掉也会再打开。",
    autostartOff: "已关闭。下次登录回到 Windows 桌面。",
    autostartFailed: (detail) => `自启设置失败：${detail}`,
    fullscreenPreview: "浏览器预览无法回到全屏",
    fullscreenDone: "已回到全屏。",
    fullscreenFailed: (detail) => `无法回到全屏：${detail}`,
    desktopPreview: "浏览器预览无法打开 Windows 桌面",
    desktopDone: "已打开 Windows 桌面，启动器还在。",
    desktopFailed: (detail) => `无法打开桌面：${detail}`,
    fseOpenFailed: (detail) => `无法打开设置：${detail}`,
    powerPreview: "浏览器预览无法休眠、重启或关机",
    slept: "已进入休眠。",
    powerFailed: (detail) => `电源操作失败：${detail}`,
  },
  power: { menu: "电源", sleep: "休眠", restart: "重启", shutdown: "关机" },
  // 工具箱（画板 K4）的文案：独立前端那套文案已随程序一起删除，只剩这一页在用。
  toolbox: {
    toolboxPreview: "浏览器预览无法安装运行库，请在 Windows 掌机上使用。",
    toolboxFailed: (detail) => `工具箱操作失败：${detail}`,
    toolboxInstall: "安装",
    toolboxReinstall: "重装",
    toolboxWorking: "…",
    toolboxInstalling: "正在下载并安装，请稍候…",
    runtimesTitle: "游戏运行库",
    runtimesBody: "从微软官方源下载常见运行库（参考 3DM 合集体验，组件会陆续加全）。",
    runtimesEmpty: "暂时没有可安装的运行库项。",
    toolboxSubtitle: "运行库 · Mod · 系统维护",
    toolboxSelfCheck: "自检",
    toolboxModTitle: "游戏 Mod / 工具",
    toolboxModBody: "在游戏卡片菜单里对单个游戏安装",
    toolboxModAction: "去游戏库",
    toolboxRuntimesSub: "VC++ / .NET / DirectX 一键补齐",
    toolboxRuntimesAction: "检查更新",
    toolboxMaintenanceTitle: "系统维护",
    toolboxMaintenanceSub: "缓存清理 · 启动项 · 日志导出",
    toolboxMaintenancePending:
      "这三项要新的系统信息与清理命令（着色器缓存、启动项、日志），这一版还没接 —— 不摆假数字。",
    toolboxCacheRow: (size) => `着色器缓存 ${size}`,
    toolboxStartupRow: (count) => `启动项 ${count} 个`,
    toolboxLogRow: (size) => `日志 ${size}`,
    toolboxCacheEmpty: "没有找到显卡着色器缓存（NVIDIA / AMD / Intel 都没有）",
    toolboxStartupReadonly: "只读：改别人的开机启动是另一回事，这里只报数",
    toolboxClean: "立即清理",
    toolboxCleaning: "正在清理…",
    toolboxCleanDone: (freed, caches, logs) =>
      `清出 ${freed}（${caches} 个缓存目录、${logs} 个日志文件）`,
    toolboxCleanNothing: "没有可清的东西（缓存目录本来就空）",
    toolboxModListAction: "查看列表",
    toolboxModListTitle: "装了 Mod 的游戏",
    toolboxModListLoading: "正在扫一遍游戏目录…",
    toolboxModListEmpty: "库里还没有游戏装过 OptiScaler",
    toolboxModListBody: "账本写在每个游戏的目录里，所以这里要现扫一遍才能列全。",
    toolboxModListEntry: (game, version) => `${game} · OptiScaler ${version}`,
    toolboxModListLegacy: "旧版标记（没记版本）",
    toolboxModInstalled: (count, version) => `已装 ${count} 个游戏${version ? ` · OptiScaler ${version}` : ""}`,
  },
  keyboard: { label: "数字键盘", backspace: "删除", done: "完成" },
  library: {
    all: "全部",
    groups: "分组",
    newGroup: "新建分组",
    addApps: "添加应用到分组",
    deleteGroup: "删除分组",
    addGame: "添加游戏",
    addApp: "添加软件",
    addFromScan: "从扫描添加",
    restoreHint: "方向键选择，A 加回库里，B 返回。这里列出已从库里拿掉的扫描结果。",
    restoreEmpty: "没有已移除的扫描项目。",
    rescan: "重新扫描",
    noCards: "暂无卡片",
    ungrouped: "未分组的卡片会显示在这里。已经分组的只出现在对应分组。",
    close: "关闭",
    hideGameTitle: "删除游戏",
    hideAppTitle: "删除软件",
    hideHeading: (library, name) => `从${library}拿掉「${name}」？`,
    hideBody: "只是不再显示在这个库里，不会删除磁盘上的文件。",
    deleteGroupTitle: "删除分组",
    deleteGroupHeading: (name) => `删除分组「${name}」？`,
    deleteGroupBody: "分组里的卡片会回到「全部」，不会从库里删掉。",
    steamTitle: "添加ID获取封面",
    steamHeading: (name) => `为「${name}」填写 Steam 编号`,
    steamPlaceholder: "例如 1245620",
    steamBody: "用这个编号去取 Steam 的竖版封面，重启后还会在。",
    fetchCover: "获取封面",
    newGroupTitle: "新建分组",
    groupPlaceholder: "分组名称",
    setGroup: "设置分组",
    rename: "修改名称",
    changePath: "修改路径",
    steamMenu: "添加ID获取封面",
    installMods: "安装 Mod / 工具",
    installModsBusy: "正在下载并安装 OptiScaler…",
    installModsPreview: "浏览器预览无法安装 OptiScaler，请在 Windows 掌机上使用。",
    installModsNoPath: "这个游戏还没有启动路径，先在卡片菜单里设置路径。",
    installModsResult: (name, detail) => `${name}：${detail}`,
    installModsFailed: (name, detail) => `为 ${name} 安装 OptiScaler 失败：${detail}`,
    uninstallModsResult: (name, detail) => `${name}：${detail}`,
    uninstallModsFailed: (name, detail) => `卸载 ${name} 的 OptiScaler 失败：${detail}`,
    modsTitle: (name) => `${name} · OptiScaler`,
    modsLoading: "正在检查游戏目录…",
    modsDir: (dir) => `安装到：${dir}`,
    modsExe: (name) => `主程序：${name}（官方要求装在它旁边）`,
    modsNoExe: "没认出主程序 exe，这次会装到游戏根目录；如果游戏不生效，把这些文件移到主程序旁边。",
    modsCandidates: (names) => `这个游戏会加载：${names} —— 只有这些名字才会生效（读游戏自己的导入表得出来的）。`,
    modsLoaded: "上次游戏运行：OptiScaler 已经加载成功了 ✓",
    modsNotLoaded: "还没看到加载记录。没进过游戏就先跑一次；跑过还是没菜单，就点下面换个注入名重装（不用等更新）。",
    modsSwitchTo: (hook) => `换成 ${hook} 重装（下一个该试的）`,
    modsTried: (hooks) => `已经试过：${hooks}`,
    modsNoDir: "找不到游戏目录。Steam 游戏请先在卡片菜单里用「修改路径」选中游戏的 exe。",
    modsInstalled: (version, hook) => `已安装 v${version}（${hook}）`,
    modsInstalledLegacy: "已安装（旧版装的，没有完整记录）",
    modsHook: "注入文件名",
    modsHookHint: "默认 dxgi；游戏自带 dxgi.dll 或已被别的 Mod 占用时改选 winmm.dll。",
    modsLatest: "最新",
    modsBundled: "自带版 · FSR 4.1.1",
    modsFsr4: "这一套带 FSR 4.1.1 放大器（amd_fidelityfx_upscaler_dx12.dll）。",
    modsFsr4Official:
      "官方版：放大器还是旧的 FSR 4 —— 想要 FSR 4.1.1 就换成上面的「自带版」重装。",
    modsConflict: (name) => `目录里已经有一个 ${name}（不是我们装的）：会被备份后覆盖，卸载时还原。`,
    modsArch: (name) => `${name} 是 32 位程序，OptiScaler 只有 64 位版，装进去游戏会起不来。`,
    modsRunning: "游戏正在运行，先退出再装。",
    modsWarn: "联机游戏（带反作弊）不要装：可能被判违规。装完如果游戏打不开，用「卸载并还原」退回。",
    modsInstall: "安装",
    modsReinstall: "重新安装 / 更新",
    modsUninstall: "卸载并还原",
    modsProgress: (percent) => `正在下载 ${percent}%`,
    modsExtracting: "正在解压…",
    modsWriting: "正在写入游戏目录…",
    modsCancel: "取消安装",
    modsClose: "关闭",
    remove: "从库中移除",
    quitGame: "退出游戏",
    leaveGroup: "移出分组",
    currentGroup: " · 当前",
    noGroups: "还没有分组，请先新建。",
    addCards: "添加卡片",
    addTo: (name) => `添加到「${name}」`,
    pickerHint: "方向键选择，A 添加或移除，B 返回",
    currentLibrary: "当前库",
    gamesPreview: "浏览器预览为示例封面。扫描本机游戏库需要 Windows 安装包。",
    gamesScanning: "正在扫描本机 Steam / Epic 游戏…",
    gamesEmpty: "没有扫到已安装的 Steam 或 Epic 游戏。",
    gamesReady: (count) => `已扫描本机游戏 ${count} 个。封面会保存在本机，之后离线也能看。`,
    appsPreview: "浏览器预览为示例应用。扫描本机已安装软件需要 Windows 安装包。",
    appsScanning: "正在扫描本机已安装软件…",
    appsEmpty: "没有扫到可显示的已安装软件。",
    appsReady: (count) => `已扫描本机已安装软件 ${count} 个。`,
    rescanning: "正在重新扫描…",
    scanFailed: (detail) => `扫描失败：${detail}`,
    previewLaunch: "浏览器预览不能启动。Windows 安装包里，在卡片上按 A 会打开程序。",
    launching: "正在启动…",
    launched: (name) => `已启动 ${name}`,
    switched: (name) => `已切换到 ${name}`,
    alreadyRunning: (name) => `${name} 已在运行`,
    quitGameDone: (name) => `已退出 ${name}`,
    quitGameNotRunning: (name) => `${name} 当前没有在运行`,
    quitGameFailed: (name, detail) => `退出 ${name} 失败：${detail}`,
    launchFailed: (name, detail) => `无法启动 ${name}：${detail}`,
    failed: "扫描失败",
    added: (name) => `已添加「${name}」。按 A 会直接启动这个程序。`,
    pathUpdated: (name) => `已改为直接启动「${name}」。`,
    hidden: "已从库里拿掉。磁盘上的文件还在。",
    restored: "已加回库里。",
    allHidden: "这些项目已从库里拿掉，磁盘上的文件还在。",
    onlyAdded: (count) => `没有新的扫描结果。手动添加的有 ${count} 个。`,
    alreadyInLibrary: "这个程序已经在库里。",
    steamDigits: "请输入 Steam 的数字编号。",
    steamMissing: "没有找到这个 Steam 编号的封面。",
    steamApplied: (id) => `已用 Steam ${id} 的封面。`,
    previewNoScan: "浏览器预览不会扫描本机。",
    focusLabel: "本次聚焦",
    focusLine: (name) => `当前聚焦：${name}`,
    gameCount: (count) => `${count} 个游戏`,
    startGame: "开始游戏",
    cardMenu: "卡片菜单",
    platformSteam: "Steam",
    platformEpic: "Epic",
    platformManual: "手动添加",
    fieldSource: "来源",
    fieldState: "状态",
    fieldPath: "安装位置",
    fieldSize: "占用空间",
    fieldPlaytime: "总时长",
    hours: (value) => `${value} 小时`,
    minutes: (value) => `${value} 分钟`,
    stateRunning: "运行中",
    stateIdle: "未运行",
    appCount: (count) => `${count} 个软件`,
    stateInstalled: "已安装",
    searchPlaceholder: "搜索软件 / 分类",
    searchClear: "清除关键词",
    noSearchHit: "没有找到软件 · 换个关键词",
    openFolder: "打开目录",
    startApp: "启动",
    barMeta: (parts) => parts,
  },
  files: {
    folder: "文件夹",
    sizeAtLeast: (size) => `≥ ${size}`,
    file: "文件",
    drives: "盘",
    back: "返回",
    viewMode: "显示方式",
    list: "列表",
    grid: "视图",
    newFolder: "新建文件夹",
    newFile: "新建文件",
    paste: "粘贴",
    selectAll: "全选",
    clearSelection: "取消全选",
    up: "返回上一级",
    emptyFolder: "这个文件夹是空的。",
    emptyHint: "这个文件夹是空的。用上方按钮新建，或先复制一项再粘贴。",
    emptyReadFailHint: "换个位置试试；如果是 U 盘 / SD 卡，检查它还在不在。",
    unselect: (name) => `取消选择 ${name}`,
    select: (name) => `选择 ${name}`,
    dirMark: "夹",
    fileMark: "文",
    selectedCount: (count) => `已选 ${count} 项`,
    pickedHint: (count) => `已选 ${count} 项。Y 可复制、移动或删除，再打开目标文件夹按粘贴。`,
    previewHint: "浏览器预览不会写入磁盘。A 用系统打开，文本请用 Y 里的编辑。",
    browseHint: "A 用系统打开。X 多选，Y 复制、移动或删除。",
    editAction: "编辑",
    copy: "复制",
    move: "移动",
    namePlaceholder: "名称",
    createHint: "A 创建。B 先回到创建，再按 B 取消。",
    editorHint: "方向键移动光标，A 换行。B 回到保存，再按 B 放弃修改。",
    saveFailed: "无法保存",
    deleteTitle: "删除",
    deleteOne: (name) => `删除「${name}」？`,
    deleteMany: (count) => `删除已选的 ${count} 项？`,
    deleteBody: "默认放进回收站（网络盘、超过回收站上限的会直接删除）；也可以选彻底删除，那就找不回来了。文件夹会连同里面的内容一起。",
    editTitle: (name) => `编辑 ${name}`,
    cannotCreate: "无法新建",
    cannotEdit: "无法编辑",
    cannotOpen: "无法打开",
    actionFailed: "操作失败",
    needName: "请输入名称",
    badName: "这个名称不能用",
    badChars: "名称里不能有 \\ / : * ? \" < > |",
    drivesTitle: "盘符",
    previewRoot: "本机预览",
    root: "根目录",
    choosePlace: "选择盘符或用户文件夹",
    missingPaste: "找不到要粘贴的项目。",
    alreadyHere: "已经在这个文件夹里。",
    intoItself: "不能粘贴到它自己里面。",
    pasteIntoFolder: "只能粘贴到文件夹里。",
    nameTaken: "目标里已经有同名项目。",
    pasted: (name) => `已粘贴「${name}」。`,
    moved: (name) => `已移动「${name}」。`,
    copiedClip: (label) => `已复制${label}。打开目标文件夹后按粘贴。`,
    moveClip: (label) => `已准备移动${label}。打开目标文件夹后按粘贴。`,
    itemCount: (count) => `${count} 项`,
    quoted: (name) => `「${name}」`,
    enterFolderFirst: "先进入一个文件夹，再粘贴。",
    partial: (done, error) => `已处理 ${done} 项。${error}`,
    pastedMany: (count) => `已粘贴 ${count}。`,
    movedMany: (count) => `已移动 ${count}。`,
    folderCreated: (name) => `已新建文件夹「${name}」。`,
    fileCreated: (name) => `已新建「${name}」。`,
    notText: "这个文件不是文本",
    cannotSave: "无法保存",
    saved: (name) => `已保存「${name}」。`,
    cannotDeleteHere: "不能删除这个位置。",
    deletedOne: (name) => `已删除「${name}」。`,
    deletedMany: (count) => `已删除 ${count} 项。`,
    recycledOne: (name) => `已把「${name}」放进回收站。`,
    recycledMany: (count) => `已把 ${count} 项放进回收站。`,
    deletePermanent: "彻底删除",
    deleteRecycle: "移到回收站",
    extract: "解压",
    extracting: (name) => `正在解压「${name}」…`,
    extractDone: (files, dir) => `解压完成：${files} 个文件 → ${dir}`,
    extractFailed: (name, detail) => `解压「${name}」失败：${detail}`,
    compress: "压缩成 zip",
    compressing: (count) => `正在压缩 ${count} 项…`,
    compressDone: (items, archive) => `已压缩 ${items} 项 → ${archive}`,
    compressFailed: (detail) => `压缩失败：${detail}`,
    showHidden: "显示隐藏",
    hideHidden: "不显示隐藏",
    keyboard: "软键盘",
    keyboardHint: "打开 Windows 触摸键盘（掌机上输入更顺手）",
    transferRate: (rate, remaining) => `${rate}/秒 · 还剩 ${remaining}`,
    previewOpen: "浏览器预览不能调用系统打开。文本文件请用编辑。",
    opened: (name) => `已打开「${name}」。`,
    copyName: (stem, n, ext) =>
      ext ? `${stem} 副本${n === 1 ? "" : ` ${n}`}${ext}` : `${stem} 副本${n === 1 ? "" : ` ${n}`}`,
    exeOnly: "请选择 .exe 程序。",
    pickerPreview: "浏览器预览可以选任意文件。A 进入文件夹或选中，B 返回。",
    pickerNative: "A 进入文件夹，或选中 .exe。B 返回，到盘符再按 B 关闭。",
    pathHere: "位置",
    leftPane: "左栏",
    rightPane: "右栏",
    dual: "双栏（左源右目标）",
    dualHint: (pane) => `当前是${pane}。LT / RT 换栏；Y 菜单里可以直接复制到另一栏。`,
    sortBy: "排序",
    sortName: "名称",
    sortSize: "大小",
    sortTime: "时间",
    sortType: "类型",
    places: "位置",
    placesTitle: "常用位置",
    search: "搜索",
    searchTitle: (pane) => `${pane}里搜索`,
    searchPlaceholder: "输入要搜索的名字",
    searchStart: "开始搜索",
    searchKeyboard: "用系统键盘输入（掌机上也可以接一个键盘）。",
    searching: "正在搜索…",
    searchEmpty: (query) => `没有找到「${query}」。`,
    searchCap: "只显示前 300 条、最深 6 层。名字说得再具体一点会更准。",
    searchInsideFolder: "先进入一个文件夹，再搜索。",
    selectModeHint: "选择模式：移动焦点就会选上；A 单独选或取消，B 退出。",
    rename: "重命名",
    renameTitle: (name) => `重命名「${name}」`,
    renameHint: "只改名字，位置不动。",
    renamed: (name) => `已改名为「${name}」。`,
    renamedMany: (count) => `已改名 ${count} 项。`,
    cannotRenameHere: "这个位置不能重命名。",
    batchRename: "批量重命名",
    batchModeOriginal: "原名 + 编号",
    batchModeNumber: "统一名称 + 编号",
    batchModeReplace: "查找替换",
    batchBase: "新名称",
    batchBaseHint: "留空就各自用原名",
    batchStart: "起始编号",
    batchFind: "查找",
    batchReplace: "替换为",
    batchPreview: "预览",
    batchUnchanged: "不变",
    batchMore: (count) => `…… 还有 ${count} 项`,
    batchKeyboard: "要输入名字时请用系统键盘（掌机上也可以接一个键盘）。",
    batchRun: "开始改名",
    batchEmpty: "照现在的规则没有一项会改名。",
    properties: "属性",
    propsReading: "正在读取…",
    propPath: "路径",
    propKind: "类型",
    propSize: "大小",
    propPartial: "（没算完，实际更大）",
    propModified: "修改时间",
    propCreated: "创建时间",
    propExtension: "扩展名",
    propAttrs: "属性",
    attrReadonly: "只读",
    attrHidden: "隐藏",
    propWritable: "现在能写入",
    propYes: "能",
    propNo: "不能",
    cannotReadProperties: "读不到这个项目的属性。",
    unknown: "未知",
    hintDenied: "权限不够：关掉占用它的程序，或者以管理员身份重新打开幻想枢纽再试。",
    hintBusy: "它正被别的程序用着：先关掉那个程序再试一次。",
    hintSpace: "目标盘空间不够了：清一点空间或换一个目标盘。",
    hintToolong: "路径太长了：把它移到更靠上层的文件夹再试。",
    hintProtected: "这是系统 / 程序目录，写入多半需要管理员，建议换一个位置。",
    startCopy: (label) => `正在复制${label}…`,
    startMove: (label) => `正在移动${label}…`,
    transferScan: "正在算大小…",
    transferMeta: (index, total, done, totalBytes) =>
      `第 ${index}/${total} 项 · ${done} / ${totalBytes}`,
    transferCancel: "取消",
    transferDone: (items) => `已完成 ${items} 项。`,
    transferDoneSkipped: (items, skipped) => `已完成 ${items} 项，跳过 ${skipped} 项（目标里已有同名）。`,
    transferCancelled: (items) => `已取消（已经完成 ${items} 项）。`,
    reasonCancelled: "已取消。",
    copyToOther: (pane) => `复制到${pane}`,
    moveToOther: (pane) => `移动到${pane}`,
    conflictTitle: "目标里已经有同名的",
    conflictBody: (count) => `有 ${count} 项和目标里的同名，你想怎么办？`,
    conflictReplace: "覆盖（用新的换掉旧的）",
    conflictSkip: "跳过（旧的留着，这些不搬）",
    conflictKeep: "保留两者（新的自动改名）",
    previewCross: "浏览器预览里左右两栏是两棵独立的树，跨栏复制请用打包后的程序试。",
  },
  tasks: {
    tabBrowse: "浏览",
    tabTasks: "任务",
    tabJobs: "任务中心",
    gridBody: "按目标选，不用先知道路径",
    runningCount: (count) => `${count} 个进行中`,
    cardUnavailable: (reason) => `暂时用不了：${reason}`,
    cardOpen: (title) => `开始「${title}」`,
    cards: {
      importRom: { title: "导入 ROM", desc: "自动识别平台并归位", meta: "switch · ps2 · psp · 3ds · 复古" },
      installMod: { title: "安装 Mod / 工具", desc: "解压到游戏目录，自动去掉多余的一层", meta: "zip · 7z" },
      backupSaves: { title: "备份游戏存档", desc: "打包到数据盘，换机 / 升级前先做一次", meta: "文档 · APPDATA · 模拟器" },
      restoreSaves: { title: "恢复存档", desc: "覆盖前自动留一份 .bak", meta: "来自备份目录" },
      exportShots: { title: "处理截图", desc: "导出到 U 盘 / 删除 / 压缩归档", meta: "图片 · Game Bar" },
      cleanup: { title: "清理空间", desc: "按体积列出能删的东西", meta: "缓存 · 旧安装包 · 日志" },
      usb: { title: "U 盘", desc: "往里传文件，或从里面导入", meta: "需要插着设备" },
      recentJobs: { title: "最近传输", desc: "看后台任务跑到哪了", meta: "任务中心" },
    },
    stepNames: ["选择来源", "识别平台", "确认目标", "执行"],
    scanning: "正在扫描…",
    next: "下一步",
    back: "上一步",
    close: "取消",
    start: "开始执行",
    again: "再做一次",
    sourceBody: "选一个要处理的文件夹",
    sourceMissing: "这个任务还没有可用的来源目录",
    resultTitle: "识别结果",
    resultMeta: (count, size) => `${count} 个文件 · ${size}`,
    resultEmpty: "这个文件夹里没有能处理的文件",
    resultTruncated: (count) => `只取前 ${count} 个`,
    unknownBucket: "无法识别",
    unknownHint: "需要你手动指定目标（不指定就不搬）",
    targetTitle: "目标位置",
    targetMissing: "还没指定",
    targetPick: "选择文件夹",
    targetHave: (count) => `已存在 ${count} 个文件`,
    targetNew: "不存在，执行时自动创建",
    conflictTitle: "同名文件",
    conflictSkip: "跳过",
    conflictReplace: "替换",
    conflictKeep: "保留两者",
    summaryTitle: "即将执行",
    sumCount: "文件总数",
    sumBytes: "总大小",
    sumEta: "预计耗时",
    sumConflict: "同名处理",
    sumNone: "不需要",
    sumEstimate: "耗时按 45 MB/s 估算，实际看存储卡速度",
    etaSec: "约 {n} 秒",
    etaMin: "约 {m} 分 {s} 秒",
    etaHour: "约 {n} 小时",
    runTitle: "执行中",
    runBody: "执行中可以随时取消",
    runCancel: "取消",
    runCancelling: "正在取消…",
    runProgress: (done, total) => `${done} / ${total}`,
    doneTitle: (count) => `已完成 · ${count} 项`,
    doneSkipped: (count) => `其中 ${count} 个因重名被跳过`,
    doneFailed: (count) => `${count} 项失败`,
    cancelledTitle: "已取消",
    rollbackNone: "还没有文件被移动，什么都没变",
    rollbackOk: (count) => `已把 ${count} 个文件搬回原处`,
    rollbackFail: (count) => `${count} 个文件没能搬回去，请手动确认一下`,
    failTitle: "没能完成",
    optAction: "要做的事",
    optTarget: "装到哪个游戏",
    optGame: "目标游戏目录",
    optGameAuto: "按压缩包名字自动挑",
    optStripped: "压缩包里只有一层目录，会自动去掉",
    optBackupName: "备份名字",
    optChecks: "要清理的项目",
    optRelease: (size) => `预计可释放 ${size}`,
    optNothing: "没有可清理的项目",
    optEjectHint: "勾上「搬完自动弹出」，传输结束就能直接安全弹出",
    optDevice: "设备",
    optPickDevice: "选择设备",
    optNoDevice: "没检测到设备",
    optDeleteWarning: "删除不进回收站，删了就没了",
    optBakNote: "覆盖前会把现有存档改名加 .bak",
    replaceNoRollback: "「替换」模式下被覆盖的旧文件恢复不了，取消也不会还回来",
    optShotsNone: "这个截图目录是空的",
    optSaveCount: (count) => `找到 ${count} 处存档`,
    srcDownloads: "下载文件夹",
    srcDesktop: "桌面",
    srcDocuments: "文档",
    srcPictures: "图片",
    srcCaptures: "Game Bar 录像",
    srcRoms: "模拟器 ROM 目录",
    srcBackups: "存档备份目录",
    srcShots: "截图目录",
    srcDevice: (name) => `设备 ${name}`,
    shotsExport: "导出到 U 盘",
    shotsArchive: "压缩归档",
    shotsDelete: "批量删除",
    cleanInstallers: "旧安装包",
    cleanInstallersHint: "下载夹里 30 天前的 exe / msi / zip",
    cleanDupShots: "疑似重复截图",
    cleanDupShotsHint: "同尺寸同格式，留下最早的那张",
    cleanLogs: "日志文件",
    cleanLogsHint: "启动器与游戏的日志",
    cleanCaches: "着色器缓存",
    cleanCachesHint: "Steam 与模拟器的 shader cache（删了会重新编译，不影响存档）",
    cleanRecycle: "回收站",
    cleanRecycleHint: "系统回收站里的东西（清空之后取不回来）",
    usbToDevice: "传到 U 盘",
    usbToDeviceHint: "复制过去，本机上的原样留着",
    usbFromDevice: "从 U 盘导入",
    usbFromDeviceHint: "复制到下载夹",
    usbEject: "安全弹出",
    usbEjectAfter: "搬完自动弹出",
    usbEjectAfterHint: "只在「传到 U 盘」时有效；弹不出来会告诉你真正的原因",
    usbEjectDone: "已弹出，可以拔了",
    discBucket: "光碟镜像（没认出来）",
    discBucketHint: "文件头既不是 PS2 也不是 PSP，这一组要你自己指定放哪儿",
    discNote: (count) => `另有 ${count} 个光碟镜像的文件头没认出来（不是 PS2，也不是 PSP）`,
    previewTitle: "预览",
    previewAuto: "随焦点自动更新",
    previewToggle: "预览",
    previewOff: "关",
    previewText: "文本前 20 行",
    previewArchive: "压缩包内容",
    previewArchiveMore: (count) => `还有 ${count} 项未列出`,
    previewRom: "ROM",
    previewGame: "游戏目录",
    previewDir: "文件夹",
    previewDirCount: (count, size) => `${count} 个子项 · ${size}`,
    previewDisc: (magic) => `光碟镜像 · 文件头 ${magic}`,
    previewCover: "游戏封面",
    previewLoading: "正在生成预览…",
    previewTooBig: "这张图太大，不生成预览",
    previewFailed: "这个文件预览不了",
    previewEmpty: "把焦点移到文件上就能看到预览",
    previewOpen: "打开",
    previewDelete: "删除",
    previewKey: "尺寸",
    previewType: "格式",
    previewLocation: "所在位置",
    jobsTitle: "任务",
    jobsBody: (running, done) => `${running} 个进行中 · ${done} 个已完成 · 后台继续`,
    jobsRunning: "进行中",
    jobsRecent: "最近完成",
    jobsClear: "清空记录",
    jobsEmpty: "现在没有任务",
    jobsEmptyBody: "从文件页的「任务」里挑一个开始吧",
    jobsOpenFiles: "去文件页",
    jobsPause: "暂停",
    jobsPauseHint: "暂停在当前文件传完之后生效",
    jobsPaused: "已暂停",
    jobsResume: "继续",
    jobsCancel: "取消",
    jobsCancelled: "已取消",
    jobsFailed: "失败",
    jobsSkipped: (count) => `跳过 ${count} 项`,
    jobsNote: "任务在后台继续",
    jobsNoteBody: "切换页面不会中断。侧栏「文件」入口会显示进度环；长任务建议保持接通电源。",
    jobsSourceTo: (from, to) => `${from} → ${to}`,
    jobsPercent: (percent, done, total, rate, eta) =>
      `${percent}% · ${done} / ${total}${rate ? ` · ${rate}` : ""}${eta ? ` · 剩余 ${eta}` : ""}`,
    renamePreviewTitle: "预览对照",
    renamePreviewHint: "确认前请检查冲突项",
    renameColumnFrom: "原文件名",
    renameColumnTo: "新文件名",
    renameColumnState: "状态",
    renameConflictChip: "重名",
    renameUnchanged: "未变化",
    renameOk: "可执行",
    renameConflictCard: (name) => `1 处重名：${name} 已经存在`,
    renameApplyAll: "对后续所有冲突使用此选择",
    renameApplyAllHint: "勾上之后后续重名不再逐条问",
    renameRun: "执行重命名",
    renameCount: (changed, conflict) =>
      `冲突 ${conflict} 处 · 其余 ${changed} 项可执行`,
    confirmTitle: "确认一下",
    confirmDeleteBody: "删除不进回收站，删了就没了",
    confirmDeleteMany: (count, size) => `要删除 ${count} 项 · ${size}`,
  },
  emulators: {
    sub: "装到非系统盘 · 配置留在自己目录里（便携模式）",
    refresh: "自检",
    rootTitle: "安装位置",
    rootChange: "改",
    rootReset: "恢复默认",
    rootCustom: "自定义",
    rootDefault: "默认（非系统盘）",
    rootHint: "只影响以后装的；已经装好的留在原地，不会自己搬家。",
    measure: "量体积",
    measuring: "正在量…",
    install: "安装",
    reinstall: "重装",
    cancel: "取消",
    launch: "启动",
    openFolder: "打开目录",
    uninstall: "卸载",
    uninstallConfirm: "卸载会连同这个模拟器目录里的存档一起删掉，确定？",
    uninstallYes: "确认卸载",
    uninstallNo: "再想想",
    roms: "游戏列表",
    romsTitle: (platform) => `${platform} · 游戏列表`,
    romsDir: (dir) => `ROM 目录：${dir}`,
    romsNoDrive: "这台机器上还没定位到放 ROM 的盘（要一块非系统盘）。",
    romsOpenDir: "打开 ROM 目录",
    romsLoading: "正在读目录…",
    romsEmpty: "这个目录里还没有文件。把 ROM 放进去，或者等在线来源接上。",
    romsSourcePending:
      "在线来源还没接（正在找可用的源）。这一版只列本机已有的文件 —— 接上之后这里每一行会多一颗下载按钮。",
    openSite: "打开官网",
    manualTag: "手动安装",
    stateInstalled: (version, size) => `已安装${version ? ` · ${version}` : ""}${size ? ` · ${size}` : ""}`,
    stateInstalledNoVersion: (size) => `已安装${size ? ` · ${size}` : ""}`,
    sizeUnknown: "体积待量",
    stateMissing: "未安装",
    phaseResolve: "正在查最新版本…",
    phaseDownload: "下载中",
    phaseExtract: "解压中",
    phaseCopy: "正在就位",
    phaseDone: "完成",
    progressBytes: (done, total) => `${done} / ${total}`,
    progressUnknown: (done) => `已下载 ${done}`,
    progressFiles: (done, total) => `${done} / ${total} 个文件`,
    progressWorking: "进行中…",
    elsewhere: (dir) => `装在别处：${dir}`,
    busyOther: "正在装另一个模拟器",
    installedNote: (name) => `${name} 装好了，在下面按 A 启动。`,
    launchedNote: (name) => `正在启动 ${name}…（第一次打开要初始化配置，会比平时慢一点）`,
    removedNote: (name) => `${name} 已卸载。`,
    failed: (detail) => `操作失败：${detail}`,
    unsupported: "安装模拟器只能在 Windows 掌机上做；这里只显示这张表。",
    empty: "这张表是空的 —— 要么是版本太旧，要么是构建时漏了目录。",
  },
};

export const en: Catalog = {
  productName: "FantasyHub",
  about: "Made for handheld players",
  close: "Close",
  cancel: "Cancel",
  create: "Create",
  delete: "Delete",
  save: "Save",
  edit: "Edit",
  open: "Open",
  tabs: {
    menu: "Main menu",
    home: "Home",
    games: "Games",
    apps: "Apps",
    downloads: "Downloads",
    files: "Files",
    toolbox: "Toolbox",
    emulators: "Emulators",
    store: "Store",
    community: "Community",
  },
  hints: {
    filesNav: "D-pad to move",
    filesMulti: "X select mode; X copies once something is picked",
    filesOpen: "A open",
    filesBack: "B back",
    filesCopy: "Y menu; Y cuts once something is picked (≡ is the menu too)",
    filesTabs: "LB / RB tabs; LT / RT panes",
    tabs: "LB / RB switch",
    keys: "Q / E on keyboard",
    settings: "Double-tap Back / Share (Esc) for settings",
    groups: "LT / RT groups",
    focusTools: "D-pad to New / Add",
    cardMenu: "B card menu",
    confirm: "A / Enter launch or confirm",
  },
  shell: {
    storageTitle: "Storage",
    storagePending: "Capacity readout pending",
    // Single volume keeps the old "letter + label"; several volumes list the letters and say
    // "combined" — the number is a sum, and the caption has to say so.
    storageVolumes: (mounts, label) => {
      if (mounts.length === 0) return "";
      if (mounts.length === 1) return `${mounts[0]} ${label}`.trim();
      const head = mounts.slice(0, 3).join(" + ");
      const more = mounts.length > 3 ? ` +${mounts.length - 3} more` : "";
      return `${head}${more} · combined`;
    },
    lockedAria: (name) => `${name}, coming soon, unavailable`,
  },
  // Only bindings that actually work are listed: the design's X favourite / Y open folder /
  home: {
    resumeChip: "Continue",
    lastLaunched: (when) => `Last launched ${when}`,
    resume: "Continue",
    details: "Details",
    recentTitle: "Continue playing",
    recentSub: "Games launched recently",
    viewAll: "See all",
    appsTitle: "Recently installed apps",
    installedOn: (date) => `Installed ${date}`,
    statusBattery: "Battery estimate",
    statusStorage: "Storage",
    statusNone: "—",
    empty: "No launches recorded yet",
    emptyBody:
      "Launch a game from the library and it shows up here. The home page only shows what actually happened on this machine — no sample data.",
    openLibrary: "Open the library",
    today: "today",
    yesterday: "yesterday",
    daysAgo: (count) => `${count} days ago`,
    batteryLeft: (time) => `about ${time}`,
    charging: "charging",
    freeOf: (free, total) => `${free} free of ${total}`,
  },
  downloads: {
    title: "Downloads",
    sub: (running, done) => `${running} running · ${done} finished`,
    statRate: "Total speed",
    statEta: "Time left",
    statBytes: "Transferred",
    modSection: "Mods / tools",
    modRow: (percent, right) => `${percent}% · ${right}`,
    empty: "Nothing running right now",
    emptyBody: "File copies / moves and OptiScaler installs all show up here and survive a tab switch.",
    note: "Steam's own downloads are not here",
    noteBody:
      "The launcher can't see Steam's download queue (Steam manages that itself). This page only covers what the launcher does: file transfers and mod installs.",
  },
  settings: {
    title: "Settings",
    close: "Close settings",
    panelSub: "Double-press Back · Esc to close",
    panelKeys: "A confirm · B close · ↑↓ focus · ←→ adjust",
    aboutTitle: "About",
    aboutStack: "Tauri 2 · Rust + React",
    language: "Language",
    languageHint: "Chinese shows 幻想枢纽. English shows FantasyHub",
    autostart: "Start with Windows",
    autostartHint: "Open the launcher after sign-in",
    steamSilent: "Start Steam at sign-in",
    steamSilentHint:
      "Steam comes up in the background at sign-in. Tick \"Remember my password\" in Steam, or it only opens the sign-in box",
    steamSilentNeedsAutostart: "needs \"Start with Windows\" above",
    steamSilentOn:
      "On. At the next sign-in the launcher brings Steam up in the background; opening a game then skips the Steam window.",
    steamSilentOff: "Off. Steam starts when you open a game (its window may appear first).",
    steamSilentReadFailed: "Couldn't read this setting. Try the installed app.",
    steamSilentPreview: "Browser preview can't change this. Use the desktop app.",
    steamSilentFailed: (detail) => `Couldn't change the Steam setting: ${detail}`,
    scaleTitle: "UI scale",
    scaleHint: "Fitted to the screen",
    scaleAuto: (value) => `Auto · ${value}×`,
    scaleManual: (factor, value) => `Manual ×${factor} · ${value}×`,
    scaleSmall: "Small",
    scaleNormal: "Default",
    scaleBig: "Large",
    deadzoneTitle: "Stick deadzone",
    deadzoneHint: "Direction threshold for the analog stick",
    deadzoneValue: (percent) => `${percent}%`,
    deadzoneRaw: (value) => `threshold ${value}`,
    on: "On",
    off: "Off",
    fullscreen: "Fill the screen",
    fullscreenHint: "The launcher covers the screen again",
    desktop: "Show desktop",
    desktopHint: "Open the Windows desktop",
    fse: "Fullscreen experience status",
    fseHint: "After registering, pick FantasyHub as the home app in Windows Settings",
    fseRegister: "Register fullscreen experience",
    fseRegisterHint: "Needs Developer Mode; admin helps",
    fseOpenSettings: "Open Windows FSE settings",
    fseOpenSettingsHint: "Choose FantasyHub as the home app",
    fsePreview: "Browser preview can't register fullscreen experience",
    quit: "Quit",
    quitHint: "Leave and return to the desktop",
    autostartReadFailed: "Couldn't read the startup setting. Try the installed app.",
    autostartPreview: "Browser preview can't change startup. Use the desktop app.",
    autostartOn: "On. It opens at the next sign-in, and again if this window is closed.",
    autostartOff: "Off. The next sign-in stays on the Windows desktop.",
    autostartFailed: (detail) => `Couldn't change startup: ${detail}`,
    fullscreenPreview: "Browser preview can't fill the screen",
    fullscreenDone: "The launcher fills the screen.",
    fullscreenFailed: (detail) => `Couldn't fill the screen: ${detail}`,
    desktopPreview: "Browser preview can't open the Windows desktop",
    desktopDone: "The desktop is open. The launcher is still running.",
    desktopFailed: (detail) => `Couldn't open the desktop: ${detail}`,
    fseOpenFailed: (detail) => `Couldn't open settings: ${detail}`,
    powerPreview: "Browser preview can't sleep, restart, or shut down",
    slept: "Going to sleep.",
    powerFailed: (detail) => `Power action failed: ${detail}`,
  },
  power: { menu: "Power", sleep: "Sleep", restart: "Restart", shutdown: "Shut down" },
  // Toolbox page text. This block used to be called `frontend`; those strings went
  // away with the standalone frontend app, and the rest of the block is toolbox-only.
  toolbox: {
    toolboxPreview: "Browser preview can't install runtimes; use the Windows app.",
    toolboxFailed: (detail) => `Toolbox action failed: ${detail}`,
    toolboxInstall: "Install",
    toolboxReinstall: "Reinstall",
    toolboxWorking: "…",
    toolboxInstalling: "Downloading and installing…",
    runtimesTitle: "Game runtimes",
    runtimesBody: "Official Microsoft redistributables first; more packages later.",
    runtimesEmpty: "No runtime packages available yet.",
    toolboxSubtitle: "Runtimes · Mods · Maintenance",
    toolboxSelfCheck: "Self-check",
    toolboxModTitle: "Game mods / tools",
    toolboxModBody: "Install per game from its card menu",
    toolboxModAction: "Open library",
    toolboxRuntimesSub: "VC++ / .NET / DirectX in one pass",
    toolboxRuntimesAction: "Check again",
    toolboxMaintenanceTitle: "Maintenance",
    toolboxMaintenanceSub: "Shader cache · Startup · Logs",
    toolboxMaintenancePending:
      "These three need new system/cleanup commands (shader cache, startup items, logs); not wired up in this build — no fake numbers.",
    toolboxCacheRow: (size) => `Shader cache ${size}`,
    toolboxStartupRow: (count) => `${count} startup items`,
    toolboxLogRow: (size) => `Logs ${size}`,
    toolboxCacheEmpty: "No GPU shader cache found (neither NVIDIA, AMD nor Intel)",
    toolboxStartupReadonly: "Read-only: changing other apps' startup entries is a different matter",
    toolboxClean: "Clean now",
    toolboxCleaning: "Cleaning…",
    toolboxCleanDone: (freed, caches, logs) =>
      `Freed ${freed} (${caches} cache folders, ${logs} log files)`,
    toolboxCleanNothing: "Nothing to clean — the cache folders are already empty",
    toolboxModListAction: "View list",
    toolboxModListTitle: "Games with mods installed",
    toolboxModListLoading: "Scanning the game folders…",
    toolboxModListEmpty: "No game in the library has OptiScaler yet",
    toolboxModListBody: "The ledger lives inside each game folder, so this has to scan them to list them all.",
    toolboxModListEntry: (game, version) => `${game} · OptiScaler ${version}`,
    toolboxModListLegacy: "Legacy marker (version not recorded)",
    toolboxModInstalled: (count, version) => `${count} game(s) installed${version ? ` · OptiScaler ${version}` : ""}`,
  },
  keyboard: { label: "Number pad", backspace: "Delete", done: "Done" },
  library: {
    all: "All",
    groups: "Groups",
    newGroup: "New group",
    addApps: "Add apps to group",
    deleteGroup: "Delete group",
    addGame: "Add game",
    addApp: "Add app",
    addFromScan: "Add from scan",
    restoreHint: "D-pad to choose, A to restore, B to go back. Removed scan results show up here.",
    restoreEmpty: "No removed scan items.",
    rescan: "Scan again",
    noCards: "Nothing here",
    ungrouped: "Cards without a group show up here. Grouped cards stay in their group.",
    close: "Close",
    hideGameTitle: "Remove game",
    hideAppTitle: "Remove app",
    hideHeading: (_library, name) => `Remove “${name}” from this library?`,
    hideBody: "It only disappears from this library. The file on disk stays.",
    deleteGroupTitle: "Delete group",
    deleteGroupHeading: (name) => `Delete group “${name}”?`,
    deleteGroupBody: "Its cards go back to All. They stay in the library.",
    steamTitle: "Steam cover",
    steamHeading: (name) => `Steam app ID for “${name}”`,
    steamPlaceholder: "e.g. 1245620",
    steamBody: "This ID loads the Steam portrait cover. It stays after a restart.",
    fetchCover: "Get cover",
    newGroupTitle: "New group",
    groupPlaceholder: "Group name",
    setGroup: "Set group",
    rename: "Rename",
    changePath: "Change path",
    steamMenu: "Steam cover",
    installMods: "Install mods / tools",
    installModsBusy: "Downloading and installing OptiScaler…",
    installModsPreview: "Browser preview can't install OptiScaler; use the Windows app.",
    installModsNoPath: "This game has no executable path yet; set it from the card menu first.",
    installModsResult: (name, detail) => `${name}: ${detail}`,
    installModsFailed: (name, detail) => `Couldn't install OptiScaler for ${name}: ${detail}`,
    uninstallModsResult: (name, detail) => `${name}: ${detail}`,
    uninstallModsFailed: (name, detail) => `Couldn't uninstall OptiScaler for ${name}: ${detail}`,
    modsTitle: (name) => `${name} · OptiScaler`,
    modsLoading: "Checking the game folder…",
    modsDir: (dir) => `Installs into: ${dir}`,
    modsExe: (name) => `Main executable: ${name} (the mod goes next to it, as the docs require)`,
    modsNoExe: "Couldn't identify the main exe, so files go to the game root; if the mod doesn't load, move them next to the game exe.",
    modsCandidates: (names) => `This game loads: ${names} — only these names can take effect (read from the game's own import table).`,
    modsLoaded: "Last game run: OptiScaler loaded successfully ✓",
    modsNotLoaded: "No load record yet. Run the game once; if the menu still doesn't show, switch to the suggested hook name below — no app update needed.",
    modsSwitchTo: (hook) => `Switch to ${hook} and reinstall (next to try)`,
    modsTried: (hooks) => `Already tried: ${hooks}`,
    modsNoDir: "Couldn't find the game folder. For Steam games, pick the game exe via \"Change path\" first.",
    modsInstalled: (version, hook) => `Installed v${version} (${hook})`,
    modsInstalledLegacy: "Installed (legacy install, no full record)",
    modsHook: "Hook file name",
    modsHookHint: "dxgi by default; pick winmm.dll if the game ships its own dxgi.dll or another mod uses it.",
    modsLatest: "Latest",
    modsBundled: "Bundled · FSR 4.1.1",
    modsFsr4: "This set includes the FSR 4.1.1 upscaler (amd_fidelityfx_upscaler_dx12.dll).",
    modsFsr4Official:
      "Official build: the upscaler is the older FSR 4 — reinstall with the bundled build for FSR 4.1.1.",
    modsConflict: (name) => `This folder already has ${name} (not ours): it will be backed up, and restored on uninstall.`,
    modsArch: (name) => `${name} is 32-bit. OptiScaler is x64-only and would stop the game from starting.`,
    modsRunning: "The game is running. Quit it first.",
    modsWarn: "Don't install into online games with anti-cheat: you may be flagged. If the game stops launching, use \"Uninstall and restore\".",
    modsInstall: "Install",
    modsReinstall: "Reinstall / update",
    modsUninstall: "Uninstall and restore",
    modsProgress: (percent) => `Downloading ${percent}%`,
    modsExtracting: "Extracting…",
    modsWriting: "Writing into the game folder…",
    modsCancel: "Cancel install",
    modsClose: "Close",
    remove: "Remove from library",
    quitGame: "Quit game",
    leaveGroup: "Remove from group",
    currentGroup: " · current",
    noGroups: "No groups yet. Create one first.",
    addCards: "Add cards",
    addTo: (name) => `Add to “${name}”`,
    pickerHint: "D-pad to choose, A to add or remove, B to go back",
    currentLibrary: "This library",
    gamesPreview: "Browser preview uses sample covers. Scanning this PC needs the Windows app.",
    gamesScanning: "Scanning Steam / Epic games…",
    gamesEmpty: "No installed Steam or Epic games found.",
    gamesReady: (count) => `Found ${count} games. Covers are saved on this PC for offline use.`,
    appsPreview: "Browser preview uses sample apps. Scanning installed software needs the Windows app.",
    appsScanning: "Scanning installed software…",
    appsEmpty: "No installed software to show.",
    appsReady: (count) => `Found ${count} installed apps.`,
    rescanning: "Scanning again…",
    scanFailed: (detail) => `Scan failed: ${detail}`,
    previewLaunch: "Browser preview can't launch. In the Windows app, press A on a card.",
    launching: "Launching…",
    launched: (name) => `Launched ${name}`,
    switched: (name) => `Switched to ${name}`,
    alreadyRunning: (name) => `${name} is already running`,
    quitGameDone: (name) => `Quit ${name}`,
    quitGameNotRunning: (name) => `${name} is not running`,
    quitGameFailed: (name, detail) => `Couldn't quit ${name}: ${detail}`,
    launchFailed: (name, detail) => `Couldn't launch ${name}: ${detail}`,
    failed: "Scan failed",
    added: (name) => `Added “${name}”. Press A to launch it.`,
    pathUpdated: (name) => `“${name}” now launches this file.`,
    hidden: "Removed from the library. The file on disk is still there.",
    restored: "Restored to the library.",
    allHidden: "These items were removed from the library. The files on disk are still there.",
    onlyAdded: (count) => `No new scan results. ${count} added by hand.`,
    alreadyInLibrary: "That program is already in the library.",
    steamDigits: "Enter a numeric Steam app ID.",
    steamMissing: "No cover found for that Steam ID.",
    steamApplied: (id) => `Using the Steam ${id} cover.`,
    previewNoScan: "Browser preview doesn't scan this PC.",
    focusLabel: "In focus",
    focusLine: (name) => `In focus: ${name}`,
    gameCount: (count) => `${count} games`,
    startGame: "Start game",
    cardMenu: "Card menu",
    platformSteam: "Steam",
    platformEpic: "Epic",
    platformManual: "Added by hand",
    fieldSource: "Source",
    fieldState: "State",
    fieldPath: "Install path",
    fieldSize: "Size on disk",
    fieldPlaytime: "Playtime",
    hours: (value) => `${value} h`,
    minutes: (value) => `${value} min`,
    stateRunning: "Running",
    stateIdle: "Not running",
    appCount: (count) => `${count} apps`,
    stateInstalled: "Installed",
    searchPlaceholder: "Search apps / groups",
    searchClear: "Clear the keyword",
    noSearchHit: "No apps found · try another keyword",
    openFolder: "Open folder",
    startApp: "Launch",
    barMeta: (parts) => parts,
  },
  files: {
    folder: "Folder",
    sizeAtLeast: (size) => `≥ ${size}`,
    file: "File",
    drives: "Disk",
    back: "Back",
    viewMode: "Layout",
    list: "List",
    grid: "Grid",
    newFolder: "New folder",
    newFile: "New file",
    paste: "Paste",
    selectAll: "Select all",
    clearSelection: "Clear",
    up: "Up",
    emptyFolder: "This folder is empty.",
    emptyHint: "This folder is empty. Create something above, or copy an item and paste it here.",
    emptyReadFailHint: "Try another place; if this is a USB stick or SD card, check it's still connected.",
    unselect: (name) => `Deselect ${name}`,
    select: (name) => `Select ${name}`,
    dirMark: "D",
    fileMark: "F",
    selectedCount: (count) => `${count} selected`,
    pickedHint: (count) => `${count} selected. Y copies, moves, or deletes. Open the destination and paste.`,
    previewHint: "Browser preview doesn't write to disk. A opens with the system. Edit text from Y.",
    browseHint: "A opens with the system. X selects more. Y copies, moves, or deletes.",
    editAction: "Edit",
    copy: "Copy",
    move: "Move",
    namePlaceholder: "Name",
    createHint: "A creates. B returns to Create, then B cancels.",
    editorHint: "D-pad moves the cursor. A inserts a line. B returns to Save, then B discards.",
    saveFailed: "Couldn't save",
    deleteTitle: "Delete",
    deleteOne: (name) => `Delete “${name}”?`,
    deleteMany: (count) => `Delete ${count} selected items?`,
    deleteBody: "The default moves it to the recycle bin (network drives and oversized items are deleted outright). You can also delete permanently, which can't be undone. A folder takes its contents with it.",
    editTitle: (name) => `Edit ${name}`,
    cannotCreate: "Couldn't create",
    cannotEdit: "Couldn't edit",
    cannotOpen: "Couldn't open",
    actionFailed: "That didn't work",
    needName: "Enter a name",
    badName: "That name can't be used",
    badChars: "A name can't contain \\ / : * ? \" < > |",
    drivesTitle: "Drives",
    previewRoot: "Preview",
    root: "Root",
    choosePlace: "Choose a drive or your home folder",
    missingPaste: "Couldn't find the item to paste.",
    alreadyHere: "It's already in this folder.",
    intoItself: "Can't paste a folder into itself.",
    pasteIntoFolder: "Paste into a folder.",
    nameTaken: "That name is already here.",
    pasted: (name) => `Pasted “${name}”.`,
    moved: (name) => `Moved “${name}”.`,
    copiedClip: (label) => `Copied ${label}. Open the destination folder and paste.`,
    moveClip: (label) => `Ready to move ${label}. Open the destination folder and paste.`,
    itemCount: (count) => `${count} items`,
    quoted: (name) => `“${name}”`,
    enterFolderFirst: "Open a folder before pasting.",
    partial: (done, error) => `Finished ${done}. ${error}`,
    pastedMany: (count) => `Pasted ${count}.`,
    movedMany: (count) => `Moved ${count}.`,
    folderCreated: (name) => `Created folder “${name}”.`,
    fileCreated: (name) => `Created “${name}”.`,
    notText: "This file isn't text",
    cannotSave: "Couldn't save",
    saved: (name) => `Saved “${name}”.`,
    cannotDeleteHere: "This location can't be deleted.",
    deletedOne: (name) => `Deleted “${name}”.`,
    deletedMany: (count) => `Deleted ${count} items.`,
    recycledOne: (name) => `Moved “${name}” to the recycle bin.`,
    recycledMany: (count) => `Moved ${count} items to the recycle bin.`,
    deletePermanent: "Delete permanently",
    deleteRecycle: "Move to recycle bin",
    extract: "Extract",
    extracting: (name) => `Extracting “${name}”…`,
    extractDone: (files, dir) => `Extracted ${files} files → ${dir}`,
    extractFailed: (name, detail) => `Couldn't extract “${name}”: ${detail}`,
    compress: "Zip these",
    compressing: (count) => `Compressing ${count} items…`,
    compressDone: (items, archive) => `Zipped ${items} items → ${archive}`,
    compressFailed: (detail) => `Compress failed: ${detail}`,
    showHidden: "Show hidden",
    hideHidden: "Hide hidden",
    keyboard: "Keyboard",
    keyboardHint: "Open the Windows touch keyboard (easier typing on a handheld)",
    transferRate: (rate, remaining) => `${rate}/s · ${remaining} left`,
    previewOpen: "Browser preview can't open files with the system. Edit text files instead.",
    opened: (name) => `Opened “${name}”.`,
    copyName: (stem, n, ext) =>
      ext ? `${stem} copy${n === 1 ? "" : ` ${n}`}${ext}` : `${stem} copy${n === 1 ? "" : ` ${n}`}`,
    exeOnly: "Choose an .exe program.",
    pickerPreview: "Browser preview can pick any file. A opens a folder or selects, B goes back.",
    pickerNative: "A opens a folder or selects an .exe. B goes back. B again on the drive list closes.",
    pathHere: "Location",
    leftPane: "Left pane",
    rightPane: "Right pane",
    dual: "Two panes (source left, target right)",
    dualHint: (pane) => `${pane} is active. LT / RT switches panes; the Y menu can copy straight to the other pane.`,
    sortBy: "Sort",
    sortName: "Name",
    sortSize: "Size",
    sortTime: "Date",
    sortType: "Type",
    places: "Places",
    placesTitle: "Common places",
    search: "Search",
    searchTitle: (pane) => `Search in ${pane}`,
    searchPlaceholder: "Type a name to look for",
    searchStart: "Search",
    searchKeyboard: "Type with the system keyboard (or plug one in).",
    searching: "Searching…",
    searchEmpty: (query) => `Nothing named “${query}”.`,
    searchCap: "First 300 hits, 6 levels deep. A more specific name searches better.",
    searchInsideFolder: "Open a folder before searching.",
    selectModeHint: "Select mode: moving the focus selects; A toggles one, B leaves.",
    rename: "Rename",
    renameTitle: (name) => `Rename “${name}”`,
    renameHint: "Only the name changes; it stays where it is.",
    renamed: (name) => `Renamed to “${name}”.`,
    renamedMany: (count) => `Renamed ${count} items.`,
    cannotRenameHere: "This location can't be renamed.",
    batchRename: "Batch rename",
    batchModeOriginal: "Name + number",
    batchModeNumber: "Same name + number",
    batchModeReplace: "Find and replace",
    batchBase: "New name",
    batchBaseHint: "Leave empty to keep each original name",
    batchStart: "Start number",
    batchFind: "Find",
    batchReplace: "Replace with",
    batchPreview: "Preview",
    batchUnchanged: "unchanged",
    batchMore: (count) => `… and ${count} more`,
    batchKeyboard: "Names are typed with the system keyboard (or a plugged-in one).",
    batchRun: "Rename now",
    batchEmpty: "Nothing would change with these settings.",
    properties: "Properties",
    propsReading: "Reading…",
    propPath: "Path",
    propKind: "Kind",
    propSize: "Size",
    propPartial: "(still counting, it's bigger)",
    propModified: "Modified",
    propCreated: "Created",
    propExtension: "Extension",
    propAttrs: "Attributes",
    attrReadonly: "Read-only",
    attrHidden: "Hidden",
    propWritable: "Writable now",
    propYes: "Yes",
    propNo: "No",
    cannotReadProperties: "Couldn't read this item's properties.",
    unknown: "Unknown",
    hintDenied: "Not enough permission: close whatever is using it, or reopen FantasyHub as administrator and try again.",
    hintBusy: "Another program is using it: close that program and try again.",
    hintSpace: "The target drive is full: free some space or pick another drive.",
    hintToolong: "The path is too long: move it to a folder closer to the root.",
    hintProtected: "This is a system / program folder; writing usually needs admin, so pick another location.",
    startCopy: (label) => `Copying ${label}…`,
    startMove: (label) => `Moving ${label}…`,
    transferScan: "Counting the size…",
    transferMeta: (index, total, done, totalBytes) => `Item ${index}/${total} · ${done} / ${totalBytes}`,
    transferCancel: "Cancel",
    transferDone: (items) => `Finished ${items} items.`,
    transferDoneSkipped: (items, skipped) => `Finished ${items}, skipped ${skipped} (already there).`,
    transferCancelled: (items) => `Cancelled (finished ${items}).`,
    reasonCancelled: "Cancelled.",
    copyToOther: (pane) => `Copy to ${pane}`,
    moveToOther: (pane) => `Move to ${pane}`,
    conflictTitle: "Those names are already there",
    conflictBody: (count) => `${count} items have the same name in the target. What should happen?`,
    conflictReplace: "Replace (swap the old one out)",
    conflictSkip: "Skip (keep the old one, don't move these)",
    conflictKeep: "Keep both (rename the new ones)",
    previewCross: "In the browser preview the two panes have separate trees; try cross-pane copy in the packaged app.",
  },
  tasks: {
    tabBrowse: "Browse",
    tabTasks: "Tasks",
    tabJobs: "Transfers",
    gridBody: "Pick a goal — no need to know the path first",
    runningCount: (count) => `${count} running`,
    cardUnavailable: (reason) => `Not available: ${reason}`,
    cardOpen: (title) => `Start “${title}”`,
    cards: {
      importRom: { title: "Import ROMs", desc: "Detects the platform and files them away", meta: "switch · ps2 · psp · 3ds · retro" },
      installMod: { title: "Install a mod / tool", desc: "Unpacks into the game folder, drops the extra level", meta: "zip · 7z" },
      backupSaves: { title: "Back up saves", desc: "Packs them onto the data drive before an upgrade", meta: "Documents · APPDATA · emulators" },
      restoreSaves: { title: "Restore saves", desc: "Keeps a .bak copy of what it replaces", meta: "from the backup folder" },
      exportShots: { title: "Handle screenshots", desc: "Send to USB / delete / archive", meta: "Pictures · Game Bar" },
      cleanup: { title: "Free up space", desc: "Lists what can go, biggest first", meta: "caches · old installers · logs" },
      usb: { title: "USB drive", desc: "Move files onto it, or import from it", meta: "needs a device plugged in" },
      recentJobs: { title: "Recent transfers", desc: "See how the background jobs are doing", meta: "Transfers" },
    },
    stepNames: ["Pick a source", "Detect", "Confirm", "Run"],
    scanning: "Scanning…",
    next: "Next",
    back: "Back",
    close: "Cancel",
    start: "Start",
    again: "Do it again",
    sourceBody: "Pick the folder to work on",
    sourceMissing: "This task has no source folder available",
    resultTitle: "Scan result",
    resultMeta: (count, size) => `${count} files · ${size}`,
    resultEmpty: "Nothing in this folder can be handled",
    resultTruncated: (count) => `only the first ${count}`,
    unknownBucket: "Unrecognised",
    unknownHint: "Pick a target yourself (unset means it won't be moved)",
    targetTitle: "Destination",
    targetMissing: "not set",
    targetPick: "Choose folder",
    targetHave: (count) => `${count} files already there`,
    targetNew: "Doesn't exist yet — created when you run it",
    conflictTitle: "Same-name files",
    conflictSkip: "Skip",
    conflictReplace: "Replace",
    conflictKeep: "Keep both",
    summaryTitle: "About to run",
    sumCount: "Files",
    sumBytes: "Total size",
    sumEta: "Estimated time",
    sumConflict: "Same-name handling",
    sumNone: "Not needed",
    sumEstimate: "Time assumes 45 MB/s — real speed depends on the card",
    etaSec: "about {n}s",
    etaMin: "about {m}m {s}s",
    etaHour: "about {n}h",
    runTitle: "Running",
    runBody: "You can cancel at any time",
    runCancel: "Cancel",
    runCancelling: "Cancelling…",
    runProgress: (done, total) => `${done} / ${total}`,
    doneTitle: (count) => `Done · ${count} items`,
    doneSkipped: (count) => `${count} skipped because of name clashes`,
    doneFailed: (count) => `${count} failed`,
    cancelledTitle: "Cancelled",
    rollbackNone: "Nothing had been moved yet, so nothing changed",
    rollbackOk: (count) => `Moved ${count} files back where they were`,
    rollbackFail: (count) => `${count} files couldn't be moved back — please check`,
    failTitle: "Couldn't finish",
    optAction: "What to do",
    optTarget: "Which game",
    optGame: "Target game folder",
    optGameAuto: "Chosen from the archive name",
    optStripped: "The archive has a single top folder, so it's dropped",
    optBackupName: "Backup name",
    optChecks: "Items to clean",
    optRelease: (size) => `${size} would be freed`,
    optNothing: "Nothing to clean up",
    optEjectHint: "Tick “Eject when done” to eject the drive safely right after the copy",
    optDevice: "Device",
    optPickDevice: "Choose device",
    optNoDevice: "No device detected",
    optDeleteWarning: "Deleting skips the Recycle Bin — it's gone for good",
    optBakNote: "Existing saves are renamed with a .bak suffix first",
    replaceNoRollback: "In Replace mode the old files are gone for good — cancelling won't bring them back",
    optShotsNone: "This screenshot folder is empty",
    optSaveCount: (count) => `${count} save folders found`,
    srcDownloads: "Downloads",
    srcDesktop: "Desktop",
    srcDocuments: "Documents",
    srcPictures: "Pictures",
    srcCaptures: "Game Bar captures",
    srcRoms: "Emulator ROMs",
    srcBackups: "Save backups",
    srcShots: "Screenshots",
    srcDevice: (name) => `Device ${name}`,
    shotsExport: "Send to USB",
    shotsArchive: "Zip them up",
    shotsDelete: "Delete them",
    cleanInstallers: "Old installers",
    cleanInstallersHint: "exe / msi / zip older than 30 days in Downloads",
    cleanDupShots: "Likely duplicate shots",
    cleanDupShotsHint: "Same size and format; the oldest one is kept",
    cleanLogs: "Log files",
    cleanLogsHint: "Launcher and game logs",
    cleanCaches: "Shader caches",
    cleanCachesHint: "Steam and emulator shader caches (they get rebuilt; saves untouched)",
    cleanRecycle: "Recycle Bin",
    cleanRecycleHint: "Whatever is in the system Recycle Bin (gone for good once emptied)",
    usbToDevice: "Copy to USB",
    usbToDeviceHint: "Copies over, the originals stay put",
    usbFromDevice: "Import from USB",
    usbFromDeviceHint: "Copies into Downloads",
    usbEject: "Eject safely",
    usbEjectAfter: "Eject when done",
    usbEjectAfterHint: "Only applies to “Copy to USB”; if it can't eject you'll get the real reason",
    usbEjectDone: "Ejected — safe to unplug",
    discBucket: "Disc images (unrecognised)",
    discBucketHint: "The header is neither PS2 nor PSP, so pick the folder yourself",
    discNote: (count) => `${count} disc images have an unrecognised header (neither PS2 nor PSP)`,
    previewTitle: "Preview",
    previewAuto: "Follows the focus",
    previewToggle: "Preview",
    previewOff: "off",
    previewText: "First 20 lines",
    previewArchive: "Archive contents",
    previewArchiveMore: (count) => `${count} more not listed`,
    previewRom: "ROM",
    previewGame: "Game folder",
    previewDir: "Folder",
    previewDirCount: (count, size) => `${count} items · ${size}`,
    previewDisc: (magic) => `Disc image · header ${magic}`,
    previewCover: "Game cover",
    previewLoading: "Building preview…",
    previewTooBig: "This image is too large to preview",
    previewFailed: "Can't preview this file",
    previewEmpty: "Move the focus onto a file to preview it",
    previewOpen: "Open",
    previewDelete: "Delete",
    previewKey: "Size",
    previewType: "Format",
    previewLocation: "Location",
    jobsTitle: "Transfers",
    jobsBody: (running, done) => `${running} running · ${done} finished · keeps going in the background`,
    jobsRunning: "Running",
    jobsRecent: "Recently finished",
    jobsClear: "Clear history",
    jobsEmpty: "No transfers right now",
    jobsEmptyBody: "Start one from the Tasks tab on the Files page",
    jobsOpenFiles: "Go to Files",
    jobsPause: "Pause",
    jobsPauseHint: "Takes effect when the current file finishes",
    jobsPaused: "Paused",
    jobsResume: "Resume",
    jobsCancel: "Cancel",
    jobsCancelled: "Cancelled",
    jobsFailed: "Failed",
    jobsSkipped: (count) => `${count} skipped`,
    jobsNote: "Transfers keep running in the background",
    jobsNoteBody: "Switching pages doesn't stop them. The Files entry in the sidebar shows a progress ring; keep the handheld plugged in for long ones.",
    jobsSourceTo: (from, to) => `${from} → ${to}`,
    jobsPercent: (percent, done, total, rate, eta) =>
      `${percent}% · ${done} / ${total}${rate ? ` · ${rate}` : ""}${eta ? ` · ${eta} left` : ""}`,
    renamePreviewTitle: "Preview",
    renamePreviewHint: "Check the clashes before confirming",
    renameColumnFrom: "Current name",
    renameColumnTo: "New name",
    renameColumnState: "State",
    renameConflictChip: "clash",
    renameUnchanged: "unchanged",
    renameOk: "ready",
    renameConflictCard: (name) => `1 clash: ${name} already exists`,
    renameApplyAll: "Use this choice for all clashes",
    renameApplyAllHint: "Stops asking once ticked",
    renameRun: "Rename",
    renameCount: (changed, conflict) => `${conflict} clashes · ${changed} ready`,
    confirmTitle: "Please confirm",
    confirmDeleteBody: "Deleting skips the Recycle Bin — it's gone for good",
    confirmDeleteMany: (count, size) => `${count} items · ${size} to delete`,
  },
  emulators: {
    sub: "Installs to a non-system drive · settings stay in its own folder (portable mode)",
    refresh: "Check",
    rootTitle: "Install location",
    rootChange: "Change",
    rootReset: "Use default",
    rootCustom: "custom",
    rootDefault: "default (non-system drive)",
    rootHint: "Only affects future installs; what's already installed stays put.",
    measure: "Measure",
    measuring: "Measuring…",
    install: "Install",
    reinstall: "Reinstall",
    cancel: "Cancel",
    launch: "Launch",
    openFolder: "Open folder",
    uninstall: "Uninstall",
    uninstallConfirm: "Uninstalling deletes the saves inside that emulator folder too. Sure?",
    uninstallYes: "Uninstall",
    uninstallNo: "Keep it",
    roms: "Game list",
    romsTitle: (platform) => `${platform} · game list`,
    romsDir: (dir) => `ROM folder: ${dir}`,
    romsNoDrive: "No non-system drive to hold ROMs was found on this machine.",
    romsOpenDir: "Open ROM folder",
    romsLoading: "Reading the folder…",
    romsEmpty: "Nothing in this folder yet — drop ROMs in, or wait for an online source.",
    romsSourcePending:
      "No online source yet (still hunting for a usable one). This build only lists what's already on disk — once a source is wired up, every row gets a download button.",
    openSite: "Open website",
    manualTag: "Manual install",
    stateInstalled: (version, size) => `Installed${version ? ` · ${version}` : ""}${size ? ` · ${size}` : ""}`,
    stateInstalledNoVersion: (size) => `Installed${size ? ` · ${size}` : ""}`,
    sizeUnknown: "Size not measured",
    stateMissing: "Not installed",
    phaseResolve: "Checking for the latest version…",
    phaseDownload: "Downloading",
    phaseExtract: "Extracting",
    phaseCopy: "Putting it in place",
    phaseDone: "Done",
    progressBytes: (done, total) => `${done} / ${total}`,
    progressUnknown: (done) => `${done} downloaded`,
    progressFiles: (done, total) => `${done} / ${total} files`,
    progressWorking: "Working…",
    elsewhere: (dir) => `Installed elsewhere: ${dir}`,
    busyOther: "Another emulator is installing",
    installedNote: (name) => `${name} is ready — press A below to launch it.`,
    launchedNote: (name) => `Starting ${name}… (the first run sets up its config, so it takes a moment)`,
    removedNote: (name) => `${name} was removed.`,
    failed: (detail) => `Action failed: ${detail}`,
    unsupported: "Installing emulators only works on a Windows handheld; this is a preview of the list.",
    empty: "This list is empty — either the build is stale or the catalog didn't ship.",
  },
};
