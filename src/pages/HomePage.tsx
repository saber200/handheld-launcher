/*
 * 首页（画板 K5）。
 *
 * 画板上那三块内容各自都要数据源，0.1.60 时一个都没有，所以那一版这里是「排期中」占位；
 * 这一版把三个源接上（FUTURE.md 功能 14 第 10 条）：
 *   1. 「继续游玩」= 启动器自己记的最近启动（`library/recent.ts`，只有真的从这儿启动过
 *      的游戏才会出现）；
 *   2. 「最近安装的软件」= 扫描缓存里按注册表 `InstallDate` 倒序的前几个（缓存里没有就
 *      不显示这一段，绝不触发一次全盘扫描 —— 首页要秒开）；
 *   3. 底部状态条四格 = `tdp_status` / `system_power_status` / `system_storage` /
 *      `toolbox_driver_version`，读不到就写「—」。
 *
 * 画板上还有「详情」「查看全部」「正在更新」那几处：详情 / 查看全部是跳去游戏库（那边才有
 * 卡片菜单与完整信息），「正在更新」要 Steam 的下载进度 —— 启动器看不到，所以不画。
 */
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderIcon } from "../components/NavIcons";
import { text } from "../i18n";
import { formatSize } from "../library/format";
import { cachedApps, gameCoverFor, launchLibraryItem } from "../library/useLocalLibrary";
import { useRecentLaunches, type RecentLaunch } from "../library/recent";

type TdpInfo = { watts: number | null; supported: boolean };
type PowerStatus = {
  hasBattery: boolean;
  percent: number;
  charging: boolean;
  minutesLeft: number;
  supported: boolean;
};
type DriveSpace = { mount: string; label: string; totalBytes: number; freeBytes: number; kind: string };

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 「今天 / 昨天 / N 天前」：按**日历天**算，不是按 24 小时（用户说的是「昨天玩的」）。 */
function dayLabel(at: number): string {
  const m = text().home;
  const then = new Date(at);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThat = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const days = Math.round((startOfToday - startOfThat) / (24 * 60 * 60 * 1000));
  if (days <= 0) return m.today;
  if (days === 1) return m.yesterday;
  return m.daysAgo(days);
}

/** 「1 h 20 min」这种写法（续航那一格）。 */
function hoursText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${rest} min`;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

export function HomePage({
  onOpenGames,
  onOpenApps,
}: {
  onOpenGames: () => void;
  onOpenApps: () => void;
}) {
  const m = text().home;
  const recent = useRecentLaunches();
  const games = useMemo(() => recent.filter((row) => row.kind === "game"), [recent]);
  const hero = games[0] ?? null;
  const [status, setStatus] = useState("");
  const [tdp, setTdp] = useState<TdpInfo | null>(null);
  const [power, setPower] = useState<PowerStatus | null>(null);
  const [drives, setDrives] = useState<DriveSpace[]>([]);
  const [driverVersion, setDriverVersion] = useState("");

  // 缓存里的软件列表：读一次就够（它只是为了首页那一行，不进依赖）。
  const apps = useMemo(() => (inTauri() ? cachedApps().slice(0, 4) : []), []);

  useEffect(() => {
    if (!inTauri()) return;
    void invoke<TdpInfo>("tdp_status")
      .then(setTdp)
      .catch(() => setTdp(null));
    void invoke<PowerStatus>("system_power_status")
      .then(setPower)
      .catch(() => setPower(null));
    void invoke<DriveSpace[]>("system_storage")
      .then(setDrives)
      .catch(() => setDrives([]));
    void invoke<string>("toolbox_driver_version")
      .then((value) => setDriverVersion(value || ""))
      .catch(() => setDriverVersion(""));
  }, []);

  const cover = hero ? (gameCoverFor(hero.installPath ?? "")?.cover ?? null) : null;
  const primary = drives.find((drive) => drive.kind === "fixed") ?? drives[0] ?? null;

  const launch = (row: RecentLaunch) => {
    setStatus("");
    void launchLibraryItem({
      id: row.id,
      name: row.name,
      launchPath: row.launchPath,
      installPath: row.installPath,
      kind: "game",
    }).then(setStatus);
  };

  return (
    <main className="page k5-page">
      <section className="k5-hero">
        {cover ? (
          <span className="k5-hero-cover" style={{ backgroundImage: `url(${cover})` }} aria-hidden />
        ) : null}
        <div className="k5-hero-text">
          {hero ? (
            <>
              <span className="k5-chip">{m.resumeChip}</span>
              <p className="k5-hero-when">{m.lastLaunched(dayLabel(hero.at))}</p>
              <h2 className="k5-hero-name">{hero.name}</h2>
              <p className="k5-hero-path">{hero.installPath || hero.launchPath || ""}</p>
              <div className="k5-hero-actions">
                <button
                  type="button"
                  className="k5-btn is-primary"
                  data-focusable
                  onClick={() => launch(hero)}
                >
                  ▶ {m.resume}
                </button>
                <button type="button" className="k5-btn" data-focusable onClick={onOpenGames}>
                  {m.details}
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className="k5-hero-name">{m.empty}</h2>
              <p className="k5-hero-path">{m.emptyBody}</p>
              {/* 空态也要留一个能聚焦的入口：手柄上「一条可聚焦的都没有」等于走进死胡同
                  （探针那条「侧栏按右出得来」也是这么要求的）。 */}
              <div className="k5-hero-actions">
                <button type="button" className="k5-btn is-primary" data-focusable onClick={onOpenGames}>
                  {m.openLibrary}
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      {games.length > 0 && (
        <section className="k5-shelf" aria-label={m.recentTitle}>
          <header className="k5-shelf-head">
            <h3>{m.recentTitle}</h3>
            <span className="k5-shelf-sub">{m.recentSub}</span>
            <button type="button" className="k5-link" data-focusable onClick={onOpenGames}>
              {m.viewAll} →
            </button>
          </header>
          <div className="k5-cards">
            {games.slice(0, 4).map((row) => {
              const art = gameCoverFor(row.installPath ?? "")?.cover ?? null;
              return (
                <button
                  key={row.id}
                  type="button"
                  className="k5-card"
                  data-focusable
                  onClick={() => launch(row)}
                >
                  <span className="k5-card-art" aria-hidden>
                    {art ? <img src={art} alt="" /> : <FolderIcon />}
                  </span>
                  <span className="k5-card-name">{row.name}</span>
                  <span className="k5-card-meta">{dayLabel(row.at)}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {apps.length > 0 && (
        <section className="k5-shelf" aria-label={m.appsTitle}>
          <header className="k5-shelf-head">
            <h3>{m.appsTitle}</h3>
            <button type="button" className="k5-link" data-focusable onClick={onOpenApps}>
              {m.viewAll} →
            </button>
          </header>
          <div className="k5-apps">
            {apps.map((app) => (
              <div key={app.id} className="k5-app">
                <span className="k5-app-name">{app.name}</span>
                <span className="k5-app-meta tnum">
                  {[
                    app.version,
                    formatSize(app.sizeBytes),
                    app.installDate
                      ? m.installedOn(
                          `${app.installDate.slice(0, 4)}-${app.installDate.slice(4, 6)}-${app.installDate.slice(6, 8)}`,
                        )
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 底部状态条（画板 K5 最下面那四格）。四格都是真读数，读不到写「—」。 */}
      <section className="k5-status" aria-label={m.statusStorage}>
        <div className="k5-status-cell">
          <span className="k5-status-label">{m.statusTdp}</span>
          <strong className="k5-status-value tnum">
            {tdp?.supported && tdp.watts != null ? m.tdpValue(String(tdp.watts)) : m.statusNone}
          </strong>
        </div>
        <div className="k5-status-cell">
          <span className="k5-status-label">{m.statusBattery}</span>
          <strong className="k5-status-value tnum">
            {power?.supported && power.hasBattery
              ? power.minutesLeft > 0
                ? m.batteryLeft(hoursText(power.minutesLeft))
                : power.charging
                  ? m.charging
                  : `${power.percent}%`
              : m.statusNone}
          </strong>
        </div>
        <div className="k5-status-cell">
          <span className="k5-status-label">{m.statusStorage}</span>
          <strong className="k5-status-value tnum">
            {primary
              ? m.freeOf(formatSize(primary.freeBytes), formatSize(primary.totalBytes))
              : m.statusNone}
          </strong>
        </div>
        <div className="k5-status-cell">
          <span className="k5-status-label">{m.statusDriver}</span>
          <strong className="k5-status-value tnum">
            {driverVersion ? m.driverInstalled(driverVersion) : m.driverMissing}
          </strong>
        </div>
      </section>

      {status ? <p className="k5-note">{status}</p> : null}
    </main>
  );
}
