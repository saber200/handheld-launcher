export type Locale = "zh" | "en";

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
  tabs: { menu: string; games: string; apps: string; files: string; toolbox: string };
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
    frontend: string;
  };
  settings: {
    title: string;
    close: string;
    language: string;
    languageHint: string;
    autostart: string;
    autostartHint: string;
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
    widgetRegister: string;
    widgetRegisterHint: string;
    widgetPreview: string;
    powerPreview: string;
    slept: string;
    powerFailed: (detail: string) => string;
  };
  power: { menu: string; sleep: string; restart: string; shutdown: string };
  frontend: {
    title: string;
    close: string;
    hint: string;
    tdpNoLauncher: string;
    tdpLoading: string;
    tdpReadFailed: (detail: string) => string;
    tdpDriverInLauncher: string;
    frontendTitle: string;
    frontendBody: string;
    frontendStatusInstalled: (version: string) => string;
    frontendStatusMissing: string;
    frontendAction: string;
    frontendNoPayload: string;
    powerTitle: string;
    powerBody: string;
    tdp: string;
    tdpValue: (watts: number) => string;
    tdpUnknown: string;
    tdpSlider: string;
    tdpPreview: string;
    tdpFailed: (detail: string) => string;
    fan: string;
    fanBody: string;
    toolboxPreview: string;
    toolboxFailed: (detail: string) => string;
    toolboxInstall: string;
    toolboxReinstall: string;
    toolboxWorking: string;
    toolboxInstalling: string;
    tdpDriverTitle: string;
    tdpDriverBody: string;
    tdpDriverInstall: string;
    tdpDriverStart: string;
    tdpDriverReinstall: string;
    tdpDriverReady: string;
    tdpDriverNeedAdmin: string;
    tdpDriverInstalling: string;
    tdpDriverStarting: string;
    runtimesTitle: string;
    runtimesBody: string;
    runtimesEmpty: string;
    quitGame: string;
    quitGameBody: (name: string) => string;
    quitGameRunning: string;
    later: string;
    soon: string;
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
  };
  files: {
    folder: string;
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
  tabs: { menu: "主菜单", games: "游戏库", apps: "软件库", files: "文件管理", toolbox: "工具箱" },
  hints: {
    filesNav: "方向键选择",
    filesMulti: "X 多选（进选择模式）",
    filesOpen: "A 打开",
    filesBack: "B 返回",
    filesCopy: "Y 菜单：复制 / 移动 / 改名 / 删除 / 属性",
    filesTabs: "LB / RB 切页；双栏时 LT / RT 换栏",
    tabs: "LB / RB 切换",
    keys: "键盘 Q / E",
    settings: "双击 Back / Share（Esc）设置",
    groups: "LT / RT 切换分组",
    focusTools: "方向键移到新建 / 添加",
    cardMenu: "B 卡片操作",
    confirm: "A / Enter 启动或确认",
    frontend: "前端是独立软件：装好后托盘常驻，Ctrl+H / 手柄 Back+Start 开关",
  },
  settings: {
    title: "设置",
    close: "关闭设置",
    language: "语言",
    languageHint: "中文显示幻想枢纽，英文显示 FantasyHub",
    autostart: "开机自启",
    autostartHint: "登录后打开启动器",
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
    widgetRegister: "装 Game Bar 小组件",
    widgetRegisterHint: "随启动器自动装；点这里重装一次",
    widgetPreview: "浏览器预览无法安装小组件",
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
  frontend: {
    title: "前端",
    close: "关闭前端",
    hint: "掌机常用调节和工具箱会放在这里。TDP 可先试 5–40W 档位。",
    tdpNoLauncher: "启动器没在运行 —— TDP 暂不可用，其它功能照常。",
    tdpLoading: "正在读取 TDP 驱动状态…",
    tdpReadFailed: (detail) => `无法读取 TDP 驱动状态：${detail}`,
    tdpDriverInLauncher: "安装 TDP 驱动需要管理员：请在启动器的「工具箱」里安装。",
    frontendTitle: "前端（独立程序）",
    frontendBody:
      "前端是独立软件：托盘常驻，Ctrl+H 或手柄 Back+Start 开关浮层。这里只负责安装 / 更新它，不控制它的开关。",
    frontendStatusInstalled: (version) => `已安装 ${version}`,
    frontendStatusMissing: "还没装过",
    frontendAction: "安装 / 更新",
    frontendNoPayload: "这个版本没内置前端安装包，请到 Release 页面下载",
    powerTitle: "性能",
    powerBody: "调节整机功耗上限。",
    tdp: "TDP",
    tdpValue: (watts) => `${watts}W`,
    tdpUnknown: "未读取",
    tdpSlider: "自定义瓦数",
    tdpPreview: "浏览器预览无法调节 TDP，请在 Windows 掌机上使用。",
    tdpFailed: (detail) => `TDP 调节失败：${detail}`,
    fan: "风扇",
    fanBody: "风扇协议较复杂，先不做，记在 FUTURE 里以后再接。",
    toolboxPreview: "浏览器预览无法安装运行库，请在 Windows 掌机上使用。",
    toolboxFailed: (detail) => `工具箱操作失败：${detail}`,
    toolboxInstall: "安装",
    toolboxReinstall: "重装",
    toolboxWorking: "…",
    toolboxInstalling: "正在下载并安装，请稍候…",
    tdpDriverTitle: "TDP 驱动 (WinRing0)",
    tdpDriverBody:
      "调节 TDP 需要内核驱动。可一键下载并安装；需管理员权限。若安全中心提示风险，属已知情况，允许后即可用。",
    tdpDriverInstall: "安装 TDP 驱动",
    tdpDriverStart: "启动 TDP 驱动",
    tdpDriverReinstall: "重新安装",
    tdpDriverReady: "驱动已就绪",
    tdpDriverNeedAdmin: "当前不是管理员，安装会失败；请确认启动时有 UAC。",
    tdpDriverInstalling: "正在下载并安装 TDP 驱动…",
    tdpDriverStarting: "正在启动已安装的 TDP 驱动…",
    runtimesTitle: "游戏运行库",
    runtimesBody: "从微软官方源下载常见运行库（参考 3DM 合集体验，组件会陆续加全）。",
    runtimesEmpty: "暂时没有可安装的运行库项。",
    quitGame: "退出游戏",
    quitGameBody: (name) => `立刻结束「${name}」；没保存的进度会丢`,
    quitGameRunning: "正在退出…",
    later: "展开",
    soon: "即将推出",
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
  },
  files: {
    folder: "文件夹",
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
    deleteBody: "会从磁盘删除，文件夹会连同里面的内容一起删除。",
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
  tabs: { menu: "Main menu", games: "Games", apps: "Apps", files: "Files", toolbox: "Toolbox" },
  hints: {
    filesNav: "D-pad to move",
    filesMulti: "X select mode",
    filesOpen: "A open",
    filesBack: "B back",
    filesCopy: "Y menu: copy / move / rename / delete / properties",
    filesTabs: "LB / RB tabs; LT / RT panes",
    tabs: "LB / RB switch",
    keys: "Q / E on keyboard",
    settings: "Double-tap Back / Share (Esc) for settings",
    groups: "LT / RT groups",
    focusTools: "D-pad to New / Add",
    cardMenu: "B card menu",
    confirm: "A / Enter launch or confirm",
    frontend: "The frontend is a separate app: tray-resident, toggle with Ctrl+H / Back+Start",
  },
  settings: {
    title: "Settings",
    close: "Close settings",
    language: "Language",
    languageHint: "Chinese shows 幻想枢纽. English shows FantasyHub",
    autostart: "Start with Windows",
    autostartHint: "Open the launcher after sign-in",
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
    widgetRegister: "Install Game Bar widget",
    widgetRegisterHint: "Ships with the launcher; this reinstalls it",
    widgetPreview: "Browser preview can't install the widget",
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
  frontend: {
    title: "Frontend",
    close: "Close frontend",
    hint: "Quick handheld controls live here. Try the 5–40W TDP presets first.",
    tdpNoLauncher: "The launcher isn't running — TDP is unavailable, everything else still works.",
    tdpLoading: "Reading TDP driver status…",
    tdpReadFailed: (detail) => `Couldn't read TDP driver status: ${detail}`,
    tdpDriverInLauncher: "Installing the TDP driver needs admin: use the launcher's toolbox.",
    frontendTitle: "Frontend (separate app)",
    frontendBody:
      "The frontend is its own app: tray-resident, toggle the overlay with Ctrl+H or Back+Start. This card only installs/updates it — it never opens or closes it.",
    frontendStatusInstalled: (version) => `Installed ${version}`,
    frontendStatusMissing: "Not installed yet",
    frontendAction: "Install / update",
    frontendNoPayload: "This build ships no frontend installer — grab it from Releases",
    powerTitle: "Performance",
    powerBody: "Adjust the package power limit.",
    tdp: "TDP",
    tdpValue: (watts) => `${watts}W`,
    tdpUnknown: "Unknown",
    tdpSlider: "Custom watts",
    tdpPreview: "Browser preview can't change TDP. Use it on a Windows handheld.",
    tdpFailed: (detail) => `Couldn't change TDP: ${detail}`,
    fan: "Fan",
    fanBody: "Fan control is deferred — protocols vary a lot by handheld.",
    toolboxPreview: "Browser preview can't install runtimes; use the Windows app.",
    toolboxFailed: (detail) => `Toolbox action failed: ${detail}`,
    toolboxInstall: "Install",
    toolboxReinstall: "Reinstall",
    toolboxWorking: "…",
    toolboxInstalling: "Downloading and installing…",
    tdpDriverTitle: "TDP driver (WinRing0)",
    tdpDriverBody:
      "TDP control needs a kernel driver. One-click download and install; admin required. Defender may warn — that's expected; allow it to continue.",
    tdpDriverInstall: "Install TDP driver",
    tdpDriverStart: "Start TDP driver",
    tdpDriverReinstall: "Reinstall",
    tdpDriverReady: "Driver ready",
    tdpDriverNeedAdmin: "Not elevated — install will fail. Confirm UAC on launch.",
    tdpDriverInstalling: "Downloading and installing TDP driver…",
    tdpDriverStarting: "Starting the installed TDP driver…",
    runtimesTitle: "Game runtimes",
    runtimesBody: "Official Microsoft redistributables first; more packages later.",
    runtimesEmpty: "No runtime packages available yet.",
    quitGame: "Quit game",
    quitGameBody: (name) => `Ends “${name}” right away; unsaved progress is lost`,
    quitGameRunning: "Quitting…",
    later: "Later",
    soon: "Soon",
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
  },
  files: {
    folder: "Folder",
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
    deleteBody: "This deletes it from disk. A folder takes its contents with it.",
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
};
