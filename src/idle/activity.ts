/*
 * 「用户最后一次动手」的时间戳 —— 屏保的判据。
 *
 * 为什么单独一个模块、而不是在 App 里挂个 setTimeout：这个时间戳有**三个**写入方，
 * 它们互不相识（手柄在 `useGamepadNav` 的 rAF 循环里、键鼠在 DOM 事件里、
 * 切标签页回来在 App 里）。谁都不能直接读写别人的 state，所以落在一个模块级的
 * 单例上，UI 通过 `useSyncExternalStore` 订阅 —— 和 `settings/prefs`、`files/useFileJobs`
 * 是同一个路子（这个仓库里已经是第三次这么干了，不新开一种模式）。
 *
 * 为什么计时用 ts + setTimeout 而不是「rAF 里比较时间差」：屏保触发的时刻要**准到秒**，
 * 而 rAF 在窗口不可见时会被浏览器停掉。真按下暂停的那一刻恰好是最不该卡住的
 * （用户把掌机放下就走，一分钟后回来看到的应该是封面墙，不是还停在库上）。
 * 所以 timer 用 setTimeout、每次事件重排；rAF 那条路径只负责**上报**活动。
 */

/** 多久没动静就进屏保。用户 2026-10-14 定的一分钟。 */
export const IDLE_TIMEOUT_MS = 60_000;

type Timer = ReturnType<typeof setTimeout>;

function defaultVisible(): boolean {
  // 非浏览器环境（单元测试跑在 Node 里）没有 document：当成可见，否则测不了。
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

export class IdleTracker {
  private last: number;
  private active = false;
  private timer: Timer | null = null;
  private readonly listeners = new Set<() => void>();
  private timeoutMs: number;
  /** 最近几次上报的来源（排查用，见 `markActivity`）。 */
  private readonly recent: string[] = [];

  constructor(
    timeoutMs: number = IDLE_TIMEOUT_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly visible: () => boolean = defaultVisible,
  ) {
    this.timeoutMs = timeoutMs;
    this.last = now();
  }

  /**
   * 改空闲阈值。**只给调试用**（浏览器预览的 `?idle=5`，见 App.tsx）：
   * 真机上验证一次屏保要坐着等一分钟，不改这个数就没法迭代。
   * 改完立刻重排定时器并同步一次状态 —— 调小阈值时屏保应该马上弹，而不是等旧定时器到点。
   */
  setTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0 || ms === this.timeoutMs) return;
    this.timeoutMs = ms;
    this.sync();
    this.schedule();
  }

  get timeout(): number {
    return this.timeoutMs;
  }

  /**
   * 窗口可见（标签页在前台）时才有「空闲」这回事。
   *
   * 不可见时一律算「不空闲」：启动器被最小化的时候用户多半正在**玩游戏**，
   * 这时候弹屏保毫无意义；而且 WebView2 在最小化时本来就会把 rAF 停掉，
   * 留着这个判断是为了**把话说死**，不依赖浏览器的节流行为。
   */
  get isIdle(): boolean {
    if (!this.visible()) return false;
    return this.now() - this.last >= this.timeoutMs;
  }

  /** 还能撑多久进屏保（毫秒）。已经空闲就是 0 —— 调用方拿它排定时器。 */
  get remainingMs(): number {
    return Math.max(0, this.timeoutMs - (this.now() - this.last));
  }

  get lastActivityAt(): number {
    return this.last;
  }

  /**
   * 上报一次用户操作。
   *
   * `source` 只是给排查用的标签（"谁把这颗计时器清零了"）：屏保"弹不出来"这类问题
   * 靠肉眼完全看不出原因，留下最近 24 次上报的来源就能一眼定位到是哪个输入在刷。
   *
   * 返回值是这个动作**有没有把屏保关掉**。屏保开着的时候按任意键就得立刻消失，
   * 不能等下一次 rAF 或定时器 —— 用户按下 A 到画面变化之间只要有半拍延迟，
   * 手感上就像「第一下没反应，得再按一下」。
   */
  markActivity(source = "?"): boolean {
    this.last = this.now();
    if (this.recent.length >= 24) this.recent.shift();
    this.recent.push(`${Math.round(this.now())} ${source}`);
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const was = this.active;
    this.active = false;
    if (was) this.emit();
    this.schedule();
    return was;
  }

  /** 最近若干次上报的来源（排查用，见 `markActivity` 的说明）。 */
  get recentActivity(): readonly string[] {
    return this.recent;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  };

  /**
   * `useSyncExternalStore` 的快照函数。
   *
   * 这里**顺手把 active 同步一次再返回**，不能直接返回缓存值：定时器到点与 React 读快照
   * 之间隔着一次事件循环，缓存值那一刻可能还是 false；React 拿到 false 就不会重渲染，
   * 屏保得等到下一个事件才弹（表现成「有时候要等两分钟」这种最难查的偶发）。
   */
  snapshot = (): boolean => {
    this.sync();
    return this.active;
  };

  /**
   * 窗口重新可见时调一次（App 挂在 `visibilitychange` 上）。
   *
   * 为什么不直接 `markActivity()`：用户可能是**切出去两小时**才切回来，这中间他一直在
   * 用别的窗口 —— 算「刚操作过」和算「空闲」都不对。这两种做法分别对应「回来立刻弹屏保」
   * 和「回来一小时不弹」，都不合理。所以：**从现在重新开始计时**，当作用户刚回来，
   * 一分钟内他不动手才弹。
   */
  visibilityChanged(): void {
    if (!this.visible()) {
      // 变不可见：取消待发的 timeout（也顺手把 active 压平，别让屏保挂在一个看不见的窗口上）。
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.active) {
        this.active = false;
        this.emit();
      }
      return;
    }
    this.markActivity();
  }

  /** 按当前时刻重算一次状态，翻转了就通知。返回是否翻转。 */
  private sync(): boolean {
    const next = this.isIdle;
    if (next === this.active) return false;
    this.active = next;
    this.emit();
    return true;
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.listeners.size === 0) return;
    if (!this.visible()) return;
    const timer = setTimeout(() => {
      this.timer = null;
      // 到点只说明「按时间算该空闲了」。真翻状态交给 sync —— 这中间可能有人上报过活动
      // （clearTimeout 漏了、系统时钟跳变），让当前时刻说话，别信定时器自己的判断。
      this.sync();
      this.schedule();
    }, this.remainingMs);
    /*
     * `unref()`：这一个待发的定时器**不该让事件循环活着**。
     *
     * 在浏览器里这句是无意义的（`setTimeout` 在 WebView 里本来就不持有进程），
     * 但单元测试跑在 Node 里：一分钟的定时器会把 `node --test` 的进程吊住，
     * 测试全过了也不退出 —— 本机实测就是 `npm test` 挂满三分钟被当成超时。
     * 有窗口的进程不靠这个定时器活着，所以 unref 掉是安全的。
     */
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

/** 全进程一个（见文件头）。 */
export const idle = new IdleTracker();

export function isIdle(): boolean {
  return idle.isIdle;
}

export function markActivity(source = "?"): void {
  idle.markActivity(source);
}

export function subscribeIdle(listener: () => void): () => void {
  return idle.subscribe(listener);
}

export function idleSnapshot(): boolean {
  return idle.snapshot();
}
