import { useState, type Ref } from "react";
import { displayAppMark, displayAppName } from "../data/previewApps";
import { currentLocale, text } from "../i18n";
import { LibraryShelf, type CardOptions } from "../components/LibraryShelf";
import { formatSize } from "../library/format";
import { type AppEntry } from "../data/previewApps";
import { launchLibraryItem, useLocalApps } from "../library/useLocalLibrary";

export function AppsPage() {
  const library = useLocalApps();
  const [status, setStatus] = useState("");
  return (
    <LibraryShelf
      kind="apps"
      // 画板 K2：6 列卡片网格 + 底部操作条（头部与 K1 同构，样式在 styles/apps.css）
      skin="k2"
      heading={text().tabs.apps}
      items={library.items}
      label={text().tabs.apps}
      note={library.note}
      status={status}
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
  onPick,
  name,
  onStatus,
}: {
  app: AppEntry;
  cardRef?: Ref<HTMLButtonElement>;
  variant?: CardOptions["variant"];
  picked?: boolean;
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
            标「手动添加」——两者都是原样真实的事实，不是猜的运行状态（软件这边没有
            进程探测，所以不写「运行中」）。 */}
        <span className="k2-card-head">
          <span className="k2-dot" aria-hidden />
          {app.customPath ? text().library.platformManual : text().library.stateInstalled}
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

