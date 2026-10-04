import { useState, type Ref } from "react";
import { invoke } from "@tauri-apps/api/core";
import { displayAppMark, displayAppName } from "../data/previewApps";
import { currentLocale, text } from "../i18n";
import { LibraryShelf, type CardOptions } from "../components/LibraryShelf";
import { formatSize } from "../library/format";
import { type AppEntry } from "../data/previewApps";
import { launchLibraryItem, useLocalApps, useRunningGameIds } from "../library/useLocalLibrary";

export function AppsPage() {
  const library = useLocalApps();
  const [status, setStatus] = useState("");
  /**
   * 「运行中」是真的：`running_games` 按进程镜像路径判断（同一个命令游戏库在用），
   * 软件这边接进来之后，卡片包头行才敢写「运行中」（0.1.60 那版没有它就只写「已安装」）。
   */
  const runningIds = useRunningGameIds(library.items);

  /** 打开某个软件的安装目录（复用文件页的 `file_open` —— 系统默认程序打开这个文件夹）。 */
  const openFolder = (app: AppEntry) => {
    const path = (app.installPath || "").trim();
    if (!path) {
      setStatus(text().library.previewNoScan);
      return;
    }
    void invoke("file_open", { path }).catch((err) => setStatus(String(err)));
  };

  return (
    <LibraryShelf
      kind="apps"
      // 画板 K2：6 列卡片网格 + 底部操作条（头部与 K1 同构，样式在 styles/apps.css）
      skin="k2"
      heading={text().tabs.apps}
      // 画板：标题右边一句小结。只写数得出来的那一半（已装数量）；
      // 「预置可安装 / 可更新」没有数据源，不摆（见 FUTURE.md 功能 14 第 8、9 条）。
      headingNote={text().library.appCount(library.items.length)}
      searchPlaceholder={text().library.searchPlaceholder}
      runningIds={runningIds}
      items={library.items}
      label={text().tabs.apps}
      note={library.note}
      status={status}
      // K2 底部那条（画板：聚焦卡的名字 + 元信息 +「安装 A」+「打开目录」）。
      // 已装的软件没有「安装」这回事，所以主按钮是**启动**（同一个能力：launchLibraryItem）。
      renderBar={(item, ctx) => {
        // 手动添加的软件没有 version / sizeBytes（它们是注册表里扫出来的字段），
        // 所以这两个必须现判 —— 直接读会拿到 undefined 之外的类型错误。
        const version = item && "version" in item ? (item.version || "").trim() : "";
        const size = item && "sizeBytes" in item ? formatSize(item.sizeBytes) : "";
        return (
          <>
            <p className="k2-bar-note">
              {item ? (
                <>
                  <strong className="k2-bar-title">{ctx.name}</strong>
                  <span className="k2-bar-meta tnum">
                    {[
                      version,
                      size,
                      runningIds.has(item.id)
                        ? text().library.stateRunning
                        : text().library.stateInstalled,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </>
              ) : (
                ctx.status
              )}
            </p>
            <button
              type="button"
              className="k2-btn is-primary"
              data-focusable
              disabled={!item}
              onClick={() => {
                if (!item) return;
                setStatus("");
                void launchLibraryItem({
                  id: item.id,
                  name: item.name,
                  launchPath: item.launchPath,
                  installPath: item.installPath,
                  customPath: item.customPath,
                }).then(setStatus);
              }}
            >
              {text().library.startApp}
            </button>
            <button
              type="button"
              className="k2-btn"
              data-focusable
              disabled={!item?.installPath}
              onClick={() => {
                if (item) openFolder(item);
              }}
            >
              {text().library.openFolder}
            </button>
          </>
        );
      }}
      onUseFile={(target, file) => {
        setStatus("");
        return target.mode === "add" ? library.addFromFile(file) : library.setLaunchPath(target.id, file);
      }}
      onHide={(id) => {
        setStatus("");
        return library.hide(id);
      }}
      restorable={library.restorable}
      onRestore={(id) => {
        setStatus("");
        return library.restore(id);
      }}
      scanning={library.scanning}
      onScan={() => setStatus(library.rescan())}
      renderCard={(app, cardRef, options) => (
        <AppCard
          key={app.id}
          app={app}
          cardRef={cardRef}
          variant={options?.variant}
          picked={options?.picked}
          running={options?.running}
          onPick={options?.onPick}
          name={options?.name}
          onStatus={setStatus}
        />
      )}
    />
  );
}

function AppCard({
  app,
  cardRef,
  variant = "picker",
  picked,
  running,
  onPick,
  name,
  onStatus,
}: {
  app: AppEntry;
  cardRef?: Ref<HTMLButtonElement>;
  variant?: CardOptions["variant"];
  picked?: boolean;
  running?: boolean;
  onPick?: () => void;
  name?: string;
  onStatus: (message: string) => void;
}) {
  const title = name || displayAppName(app.id, app.name, currentLocale());
  const activate = () => {
    if (onPick) {
      onPick();
      return;
    }
    void launchLibraryItem({
      id: app.id,
      name: app.name,
      launchPath: app.launchPath,
      installPath: app.installPath,
      customPath: app.customPath,
    }).then(onStatus);
  };

  // ── 画板 K2 §4.1 的四段卡片：包头行 / 图标区 / 名称 / 底部行 ──
  if (variant === "grid") {
    // 底部行只写真字段（注册表的 DisplayVersion / EstimatedSize）：缺的那半边自己消失，
    // 两边都没有就整行不渲染（0 = 不知道，不是「0 字节」，见 library/format.ts）。
    const version = (app.version || "").trim();
    const size = formatSize(app.sizeBytes);
    return (
      <button
        ref={cardRef}
        type="button"
        className={picked ? "k2-card is-picked" : "k2-card"}
        data-focusable
        data-card-id={app.id}
        onClick={activate}
      >
        {/* 包头行：状态点 + 状态字。扫描出来的都算「已安装」；用户自己挑文件加进来的
            标「手动添加」——两者都是原样真实的事实。**「运行中」现在也是真的**：
            进程探测（`running_games`）接进来了，跑着就写「运行中」。 */}
        <span className="k2-card-head">
          <span className={running ? "k2-dot is-live" : "k2-dot"} aria-hidden />
          {running
            ? text().library.stateRunning
            : app.customPath
              ? text().library.platformManual
              : text().library.stateInstalled}
        </span>
        <span className="k2-icon">
          {app.icon ? (
            <img className="k2-icon-image" src={app.icon} alt="" />
          ) : (
            <span className="k2-icon-mark" style={{ background: app.color }} aria-hidden>
              {displayAppMark(app.id, app.mark, currentLocale())}
            </span>
          )}
        </span>
        <span className="k2-card-name">{title}</span>
        {(version || size) && (
          <span className="k2-card-foot">
            <span className="k2-card-facts tnum" title={version || undefined}>
              {version}
            </span>
            {size && <span className="k2-card-size tnum">{size}</span>}
          </span>
        )}
      </button>
    );
  }

  // 旧卡片：只用在「添加卡片 / 从扫描添加」这两个对话框里，别把它跟着页面卡一起改。
  return (
    <button
      ref={cardRef}
      type="button"
      className={picked ? "library-card is-picked" : "library-card"}
      data-focusable
      data-card-id={app.id}
      onClick={activate}
    >
      {picked && <span className="pick-mark">✓</span>}
      {app.icon ? (
        <img className="app-icon app-icon-image" src={app.icon} alt="" />
      ) : (
        <span className="app-icon" style={{ background: app.color }} aria-hidden>
          {displayAppMark(app.id, app.mark, currentLocale())}
        </span>
      )}
      <span className="library-name">{title}</span>
    </button>
  );
}

