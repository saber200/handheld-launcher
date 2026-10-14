/*
 * 屏保：整屏一张游戏封面，铺满、然后一张张换。
 *
 * 需求（用户 2026-10-14 定的）：
 *   ① 一分钟没操作自动进；
 *   ② **一整张大图铺满整屏**，然后切换这张大图（轮播所有已安装游戏的封面）；
 *   ③ 封面比例不变形 —— 居中裁切，宁可裁掉四边也不拉伸；
 *   ④ 必须**慢速漂移**：掌机多是 OLED，静止不动的一屏高对比画面会烧屏（烙印）。
 *      这不是"好看"的讲究，是硬件损耗，所以漂移写在 CSS 动画里、`prefers-reduced-motion`
 *      也只压幅度不关掉（见 styles/screensaver.css）。
 *
 * ⚠️ 2026-10-14 改过一版：第一版做成了「中间一张大 + 两侧渐隐渐糊的卡片墙」，
 * 那是**理解错了需求**（用户原话：「你这中间放两个竖图是何意为？？？我意思是整个大图铺满
 * 然后切换这个大图」）。铺满 16:9 确实会把 600×900 的竖版封面裁掉上下两头（游戏名常常
 * 就在裁掉的那部分里），但这个取舍用户已经明确要了 —— **不要再自作主张改回卡片墙**。
 * 真想缓解，只能调 `object-position`（见下面那句），不要再动布局结构。
 *
 * 换图怎么做到不闪：所有已安装游戏的封面在**进来之后逐个解码进内存**（见 `preloadCover`）。
 * 掌机上最重的操作是"用户在库页翻卡片时现解码"，而屏保是闲下来的时刻，那点内存换
 * "换图零延迟"很划算；不解码的话每次换图都会先白一下再出图。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { markActivity } from "../idle/activity";
import { text } from "../i18n";
import { screensaverCoverCandidates, type ScreensaverCover } from "../library/shelf";

/** 一张图停多久。8 秒：够看清一张封面，又不至于让人等得不耐烦。 */
const STEP_MS = 8000;

/** 慢速漂移周期（秒）。CSS 里写的是同一个值，改这里要一起改。 */
const DRIFT_PERIOD_S = 40;

/** 同一个顺序放久了也腻，这么久之后重新洗一次牌。 */
const RESHUFFLE_MS = 5 * 60_000;

/** 洗牌：Fisher-Yates。不用 `sort(() => Math.random() - 0.5)` —— 那样洗不均匀。 */
function shuffle<T>(input: T[]): T[] {
  const out = input.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 当前位置该显示哪个游戏。`offset` 一直往上涨，取模放在这里做。 */
function gameAt(covers: ScreensaverCover[], offset: number): ScreensaverCover | null {
  if (covers.length === 0) return null;
  return covers[((offset % covers.length) + covers.length) % covers.length];
}

/**
 * 把一张封面解码好放进浏览器缓存，返回"最终能用的那个地址"。
 *
 * 按 `screensaverCoverCandidates()` 给的顺序**从清楚到将就**试：先是 Steam 的宽幅大图
 * （1920×620，整屏铺满几乎不用放大 —— 用户 2026-10-14 反馈"为啥这么糊"的修法），
 * 再退到竖版 2x，最后才是本地缓存的那张。
 * 返回地址而不是只当预热是必要的：换图时要用**这里验过的**那个地址，本地缓存被删掉时
 * 无脑用 `asset://` 会换出一张破图。全都失败返回空串，那一张跳过、不让整屏卡在坏图上。
 */
async function preloadCover(cover: ScreensaverCover): Promise<string> {
  const tryLoad = (src: string) =>
    new Promise<boolean>((resolve) => {
      const image = new Image();
      image.decoding = "async";
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      image.onload = () => done(true);
      image.onerror = () => done(false);
      image.src = src;
      // 命中缓存时可能同步就 complete 了（onload 不会再触发）。
      if (image.complete) done(image.naturalWidth > 0);
    });

  for (const src of screensaverCoverCandidates(cover)) {
    if (await tryLoad(src)) return src;
  }
  return "";
}

export function GameScreensaver({ covers, closing }: { covers: ScreensaverCover[]; closing: boolean }) {
  const [offset, setOffset] = useState(0);
  const [generation, setGeneration] = useState(0);
  /** 当前这张图**验过的**地址（空串 = 这张加载不出来）。 */
  const [src, setSrc] = useState("");
  /** 已经验过的地址，按游戏 id 记着，绕回来时不用再验。 */
  const resolved = useRef(new Map<string, string>());
  const alive = useRef(true);

  // 每次进来重新洗牌（generation 变了就重洗）。
  const order = useMemo(() => shuffle(covers), [covers, generation]);
  const current = gameAt(order, offset);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * 进来之后把封面**逐个**解码进缓存。
   *
   * 为什么值得全解：换图那一刻才解码的话，画面上会先白一下再出图（600×900 解一次几十毫秒）。
   * 一个接一个（不是一把 Promise.all）是为了不和"当前这张"抢带宽 —— 第一张要立刻出来。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const cover of order) {
        if (cancelled || !alive.current) return;
        if (resolved.current.has(cover.id)) continue;
        const usable = await preloadCover(cover);
        if (cancelled || !alive.current) return;
        resolved.current.set(cover.id, usable);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [order]);

  /** 当前这张：先查验过的地址表，还没有就当场验一次（刚进屏保时会走这条）。 */
  useEffect(() => {
    if (!current) return;
    const known = resolved.current.get(current.id);
    if (known !== undefined) {
      setSrc(known);
      return;
    }
    let cancelled = false;
    void preloadCover(current).then((usable) => {
      if (cancelled || !alive.current) return;
      resolved.current.set(current.id, usable);
      setSrc(usable);
    });
    return () => {
      cancelled = true;
    };
  }, [current]);

  // 自动换图。
  useEffect(() => {
    if (order.length < 2) return;
    const timer = window.setInterval(() => setOffset((value) => value + 1), STEP_MS);
    return () => window.clearInterval(timer);
  }, [order.length]);

  // 隔一阵重新洗牌（generation 变化会重建 order）。
  useEffect(() => {
    if (order.length < 2) return;
    const timer = window.setInterval(() => setGeneration((value) => value + 1), RESHUFFLE_MS);
    return () => window.clearInterval(timer);
  }, [order.length]);

  if (order.length === 0) return null;

  return (
    <div
      className={closing ? "gs-root leaving" : "gs-root"}
      role="presentation"
      /*
       * 鼠标 / 触摸点一下也当唤醒。键盘和手柄的唤醒分别走 App 的 keydown 和
       * useGamepadNav 的 rAF —— 三条路最后都汇到 `markActivity()`。
       */
      onPointerDown={() => markActivity("screensaver")}
    >
      {/*
       * 整屏一张图，`object-fit: cover` = 等比放大到铺满、居中裁切，**永远不变形**。
       *
       * `object-position` 定在 center：竖版封面铺到 16:9 上，上下会被裁掉一大截，
       * 而 Steam 常把游戏名印在顶部。想让名字更容易留下来就把它改成 `center 30%`
       * （往上偏一点）—— 一行的事，但**要不要偏是用户的选择**，默认照他说的居中裁切。
       *
       * `key={src}`：换图时让这个 <img> 重新挂载，淡入动画跟着重跑一次，
       * 所以新图是在旧图上面淡进来的，看不见"啪"的一下。
       */}
      {src ? (
        <img
          key={src}
          className="gs-photo"
          src={src}
          alt=""
          draggable={false}
          // 这张实在加载不出来：就地跳到下一张，不留白、不卡住轮播。
          onError={() => setOffset((value) => value + 1)}
        />
      ) : (
        <div className="gs-photo gs-photo-empty" aria-hidden />
      )}

      <p className="gs-hint">
        {text().screensaver.exitHint}
        <span className="gs-count tnum">{text().screensaver.count(order.length)}</span>
      </p>
    </div>
  );
}

/** 每张图停留的毫秒数，导出给测试与调试用。 */
export const SCREENSAVER_STEP_MS = STEP_MS;
/** 慢速漂移周期（秒），导出给测试与调试用（真值在 screensaver.css 里）。 */
export const SCREENSAVER_DRIFT_SECONDS = DRIFT_PERIOD_S;
