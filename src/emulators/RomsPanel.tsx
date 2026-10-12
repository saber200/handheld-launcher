import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { text } from "../i18n";
import { formatSize } from "../library/format";

/**
 * 「游戏列表」面板 —— **这一版只有列表，没有下载**。
 *
 * 用户 2026-10-12 的原话：「先不做 rom 这块的功能了吧，留下列表页面就可以，我到时候再告诉你
 * 在哪里下载，我先去找找可用的下载源」。所以这里就三件事：
 *   1. 把**这个平台的 ROM 目录**亮出来（路径写在标题下面，能直接打开）；
 *   2. 列出那个目录里**已经有的文件**（本机现状，不联网）；
 *   3. 如实说明「在线来源还没接」——**不摆一个按下去没反应的下载按钮**（仓库一贯规矩）。
 *
 * 为什么值得先留着：源一旦定了，下载只是往这个列表的每一行加一颗按钮 + 一条进度，
 * 目录约定（`<非系统盘>:\Emulation\ROMs\<平台>`）与「导入 ROM」那张表已经是同一套。
 */
type RomFile = {
  name: string;
  path: string;
  kind: string;
  bytes: number;
  hidden?: boolean;
};

export function RomsPanel({
  title,
  dir,
  onClose,
}: {
  /** 面板标题（平台名）。 */
  title: string;
  /** 这个平台的 ROM 目录（空串 = 这台机器上还没定位到盘）。 */
  dir: string;
  onClose: () => void;
}) {
  const t = text().emulators;
  const [rows, setRows] = useState<RomFile[] | null>(null);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!dir) {
        setRows([]);
        return;
      }
      try {
        const list = await invoke<RomFile[]>("file_list", { path: dir });
        if (!alive) return;
        setRows(list.filter((row) => row.kind === "file" && !row.hidden));
        setError("");
      } catch {
        // 目录还不存在是**正常情况**（还没往这个平台放过游戏）：不当错误报，列表空着。
        if (alive) {
          setRows([]);
          setError("");
        }
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [dir]);

  // 焦点落进来（面板是 focus-trap：进得来、方向键在里头走，B / 关闭回原处）。
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-focusable]")?.focus();
  }, [rows]);

  const openDir = () => {
    if (!dir) return;
    void invoke("file_open", { path: dir }).catch(() => {});
  };

  return (
    <div className="group-dialog focus-trap open">
      <button
        type="button"
        className="drawer-scrim"
        aria-label={text().close}
        tabIndex={-1}
        onClick={onClose}
      />
      <div className="group-dialog-panel roms-panel" role="dialog" aria-label={t.romsTitle(title)}>
        <h2>{t.romsTitle(title)}</h2>
        <p className="preview-note">{dir ? t.romsDir(dir) : t.romsNoDrive}</p>
        <div className="library-tools" data-focus-zone="roms-tools">
          <button
            type="button"
            className="library-tool"
            data-focusable
            disabled={!dir}
            onClick={openDir}
          >
            {t.romsOpenDir}
          </button>
          <button type="button" className="library-tool" data-focusable onClick={onClose}>
            {text().close}
          </button>
        </div>

        {rows === null ? (
          <p className="group-empty">{t.romsLoading}</p>
        ) : rows.length === 0 ? (
          <p className="group-empty">{t.romsEmpty}</p>
        ) : (
          // 只读列表：用的是工具箱那套 `.k4-rows / .k4-row-item`（同一个仓库里已经有
          // 三处只读清单这么写），行**不进焦点池** —— 现在点它们没有动作，做成能聚焦的按钮
          // 就是「按了没反应的假按钮」。
          <div className="k4-rows" ref={listRef}>
            {rows.map((row) => (
              <div key={row.path} className="k4-row-item">
                <strong className="roms-name">{row.name}</strong>
                <small className="tnum">{row.bytes > 0 ? formatSize(row.bytes) : ""}</small>
              </div>
            ))}
          </div>
        )}

        {/*
         * 来源那一行**必须说实话**：现在没有内置下载源（用户正在找）。
         * 这一行也是以后接上源的位置 —— 到时候换成「来源：<站名>」+ 每行的下载按钮。
         */}
        <p className="preview-note">{t.romsSourcePending}</p>
        {error ? <p className="preview-note">{error}</p> : null}
      </div>
    </div>
  );
}
