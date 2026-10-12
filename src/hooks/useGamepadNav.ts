import { useEffect, useRef } from "react";
import { playSfx } from "../audio/sfx";
import { prefs } from "../settings/prefs";

type Options = {
  onBack?: () => void;
  onConfirm?: () => void;
  onBumperLeft?: () => void;
  onBumperRight?: () => void;
  /** Xbox View/Back，PS Share。标准映射里都是 8 号键。 */
  onView?: () => void;
  /** Xbox Menu/Start，PS Options。标准映射里都是 9 号键。 */
  onStart?: () => void;
  /**
   * View（8 号键）的动作怎么触发。默认 `"press"`：按下就触发；`"double"`：**双击**才触发，
   * 单击什么都不做。
   *
   * 启动器用 `"double"`：设置抽屉是重操作，掌机上 View / Share 很容易被误蹭到，按下就拉开
   * 太吵；而押后判定（按下后等几十毫秒看 Menu 是否也按下）会让设置键肉眼可见地变慢 ——
   * 双击零延迟，也不会把一次误触算成两次点按。双击模式下 Menu 也跟着守：第一次点按之后的
   * 一小段时间里 Menu 不算独立按下，第二次点按时若 Menu 还按着就整串吞掉（那是 Back+Start
   * 和弦，留给以后接的界面用）。
   *
   * 一次按键只有一个响应者，规则见仓库根 FRONTEND.md §10。
   */
  viewGesture?: "press" | "double";
  /** Xbox LT / PS L2。 */
  onTriggerLeft?: () => void;
  /** Xbox RT / PS R2。 */
  onTriggerRight?: () => void;
  /** Xbox Y / PS Triangle。 */
  onFaceTop?: () => void;
  /** Xbox X / PS Square。 */
  onFaceLeft?: () => void;
  enabled?: boolean;
};

let textEditing = false;
let suspendCaret = false;

type VirtualKeyboard = {
  overlaysContent: boolean;
  boundingRect: DOMRect;
  show: () => void;
  hide: () => void;
  addEventListener: (type: "geometrychange", listener: () => void) => void;
  removeEventListener: (type: "geometrychange", listener: () => void) => void;
};

function virtualKeyboard(): VirtualKeyboard | null {
  return (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard ?? null;
}

function typingTarget(): HTMLInputElement | HTMLTextAreaElement | null {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) return null;
    return el;
  }
  return null;
}

/** Focused range input — steering adjusts it instead of leaving it. */
function rangeTarget(): HTMLInputElement | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement)) return null;
  if (el.type !== "range" || el.disabled) return null;
  return el;
}

/** Pages listen for this on a slider: A asks for the value to be written now. */
export const GAMEPAD_COMMIT = "gamepad-commit";

/** 双击 View 的最大间隔：手柄点两下比鼠标双击慢，给足一点（见 Options.viewGesture）。 */
const VIEW_DOUBLE_MS = 450;

/**
 * One step on a focused slider. Left / right used to walk the focus ring, so a
 * slider could not be changed with a gamepad at all, and A clicked a range
 * (which does nothing).
 */
function stepRange(el: HTMLInputElement, dir: number) {
  const step = Number(el.step) || 1;
  const min = el.min === "" ? Number.NEGATIVE_INFINITY : Number(el.min);
  const max = el.max === "" ? Number.POSITIVE_INFINITY : Number(el.max);
  const current = Number(el.value);
  if (!Number.isFinite(current)) return;
  const next = Math.min(max, Math.max(min, current + dir * step));
  if (next === current) return;
  // React tracks the DOM value: write through the native setter so the input
  // event carries the new value into onInput.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, String(next));
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function moveTextCaret(el: HTMLInputElement | HTMLTextAreaElement, dx: number, dy: number) {
  const value = el.value;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? start;
  const anchor = dx < 0 || dy < 0 ? Math.min(start, end) : Math.max(start, end);
  let next = anchor;
  if (dx !== 0) {
    next = Math.max(0, Math.min(value.length, anchor + dx));
  } else if (dy !== 0 && el instanceof HTMLTextAreaElement) {
    const lineStart = value.lastIndexOf("\n", Math.max(0, anchor - 1)) + 1;
    const col = anchor - lineStart;
    if (dy < 0) {
      if (lineStart === 0) next = 0;
      else {
        const prevStart = value.lastIndexOf("\n", lineStart - 2) + 1;
        next = Math.min(lineStart - 1, prevStart + col);
      }
    } else {
      const lineEnd = value.indexOf("\n", anchor);
      if (lineEnd < 0) next = value.length;
      else {
        const nextStart = lineEnd + 1;
        const nextBreak = value.indexOf("\n", nextStart);
        const nextEnd = nextBreak < 0 ? value.length : nextBreak;
        next = Math.min(nextEnd, nextStart + col);
      }
    }
  }
  el.setSelectionRange(next, next);
}

function insertNewline(el: HTMLTextAreaElement) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const next = `${el.value.slice(0, start)}\n${el.value.slice(end)}`;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, next);
  const pos = start + 1;
  el.setSelectionRange(pos, pos);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function focusZone(el: HTMLElement): string | null {
  return el.closest("[data-focus-zone]")?.getAttribute("data-focus-zone") ?? null;
}

/**
 * 外壳菜单（顶栏里的分区页签条）那一域的域名 —— 0.1.71 之前它是左侧栏。
 *
 * **2026-10-11 起菜单整个退出了焦点系统**（用户真机反馈：「直接把 menu 改成顶部的切换…
 * 直接使用 RB 和 LB 来切换，不允许聚焦就可以了」）：页签条里一个 `[data-focusable]` 都没有，
 * 换页只有手柄 LB/RB 与键盘 Q/E 两条路，所以下面这些「把菜单从候选里剔出去」的过滤
 * 现在**拦不到任何东西**。
 *
 * 留着它们是因为它们写的不是「侧栏」而是**规矩**：方向键永远不进出菜单。哪天有人给页签
 * 加了 `data-focusable`（比如为了 Tab 键），规矩照旧成立。探针逐页盯着「页签条里 0 个
 * 可聚焦元素」，这一条要是破了会先红在探针上。
 */
export const SHELL_NAV_ZONE = "shell-tabs";

function inShellNav(el: HTMLElement | null): boolean {
  return el !== null && focusZone(el) === SHELL_NAV_ZONE;
}

/** 「当前选中」的那一项：卡片条正在显示的那张卡、当前分组 chip、页签条当前那一项。 */
function currentMarked(nodes: HTMLElement[]): HTMLElement | null {
  const marked = (el: HTMLElement) =>
    el.matches('.is-current, [aria-current]:not([aria-current="false"]), [aria-selected="true"]') ||
    el.parentElement?.matches(".is-current") === true;
  return nodes.find(marked) ?? null;
}

let keyboardOpenFlag = false;
let keyboardTarget: HTMLInputElement | HTMLTextAreaElement | null = null;
let keyboardCaret = 0;
const keyboardListeners = new Set<() => void>();

function emitKeyboard() {
  keyboardListeners.forEach((listener) => listener());
}

export function gamepadKeyboardOpen() {
  return keyboardOpenFlag;
}

export function subscribeGamepadKeyboard(listener: () => void) {
  keyboardListeners.add(listener);
  return () => keyboardListeners.delete(listener);
}

export function openGamepadKeyboard(el: HTMLInputElement | HTMLTextAreaElement) {
  keyboardTarget = el;
  keyboardCaret = el.selectionStart ?? el.value.length;
  keyboardOpenFlag = true;
  textEditing = false;
  suspendCaret = true;
  emitKeyboard();
}

export function closeGamepadKeyboard() {
  if (!keyboardOpenFlag) return false;
  const field = keyboardTarget;
  const caret = keyboardCaret;
  keyboardOpenFlag = false;
  textEditing = false;
  suspendCaret = true;
  emitKeyboard();
  field?.focus();
  try {
    field?.setSelectionRange(caret, caret);
  } catch {
    /* 有的输入框不能设置光标 */
  }
  return true;
}

function writeField(next: string, caret: number) {
  const el = keyboardTarget;
  if (!el) return;
  const limit = el.maxLength;
  if (limit > 0 && next.length > limit) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, next);
  keyboardCaret = caret;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function typeIntoGamepadField(text: string) {
  const el = keyboardTarget;
  if (!el) return;
  const next = `${el.value.slice(0, keyboardCaret)}${text}${el.value.slice(keyboardCaret)}`;
  writeField(next, keyboardCaret + text.length);
}

export function backspaceGamepadField() {
  const el = keyboardTarget;
  if (!el || keyboardCaret <= 0) return;
  const next = `${el.value.slice(0, keyboardCaret - 1)}${el.value.slice(keyboardCaret)}`;
  writeField(next, keyboardCaret - 1);
}

/** Direction leaves a field that is not currently accepting text, and opens the keyboard with confirm. */
export function steerFocus(dx: number, dy: number) {
  // A slider is adjusted in place; up / down still leave it for the neighbours.
  const slider = rangeTarget();
  if (slider && dx !== 0) {
    stepRange(slider, dx);
    return;
  }
  const field = typingTarget();
  const editing = field instanceof HTMLTextAreaElement ? !suspendCaret : textEditing && !suspendCaret;
  if (field && editing) {
    if (field instanceof HTMLInputElement && dy !== 0) {
      textEditing = false;
      moveDirectionalFocus(dx, dy);
      return;
    }
    if (field instanceof HTMLTextAreaElement && dy !== 0) {
      const pos = field.selectionStart ?? 0;
      const leaving = (dy < 0 && pos === 0) || (dy > 0 && pos === field.value.length);
      if (leaving) {
        textEditing = false;
        moveDirectionalFocus(0, dy);
        return;
      }
    }
    moveTextCaret(field, dx, dy);
    return;
  }
  suspendCaret = false;
  moveDirectionalFocus(dx, dy);
}

export function confirmFocused() {
  const field = typingTarget();
  if (field instanceof HTMLTextAreaElement && textEditing && !suspendCaret) {
    insertNewline(field);
    return;
  }
  if (field instanceof HTMLInputElement && field.inputMode === "numeric" && visibleFocusables().includes(field)) {
    openGamepadKeyboard(field);
    return;
  }
  const slider = rangeTarget();
  if (slider) {
    // click() does nothing to a range input; the page commits the value instead.
    playSfx("click");
    slider.dispatchEvent(new Event(GAMEPAD_COMMIT));
    return;
  }
  const el = document.activeElement as HTMLElement | null;
  if (el && visibleFocusables().includes(el)) {
    playSfx("click");
    el.click();
  }
}

/** Leave the on-screen keyboard and return focus to a button. */
export function leaveTextEntry(): boolean {
  const field = typingTarget();
  if (!field || !textEditing) return false;
  textEditing = false;
  suspendCaret = false;
  const scope = field.closest(".focus-trap, .card-menu, .file-menu");
  scope?.querySelector<HTMLElement>("button[data-focusable]")?.focus();
  return true;
}

/**
 * 「每个焦点域里上次停在那一项」—— 只在**候选已经被筛过一层**之后用来二次挑选。
 *
 * 为什么需要它：内容区里好几个子域都算「当前选中」那一类（卡片条正在显示的那张卡、
 * 当前分组 chip、页签条当前那一项），跨子域横着走时几何上最近的往往不是用户想回的那个
 * —— 用户想回的是刚才停过的那一项。见 nearestSideways。
 *
 * 只记真在某个域里的元素。换页把页面卸载掉后这些节点还留在 Map 里，但它们已经不在
 * visibleFocusables() 里（offsetParent 为 null），选候选时根本不会出现；用前再查一次 isConnected。
 */
const lastInZone = new Map<string, HTMLElement>();

function rememberZone(el: HTMLElement | null | undefined) {
  if (!el || !el.isConnected) return;
  const zone = focusZone(el);
  if (zone) lastInZone.set(zone, el);
}

function focusWithSfx(el: HTMLElement | null | undefined) {
  if (!el) return;
  const before = document.activeElement as HTMLElement | null;
  rememberZone(before); // 离开的那一项属于它的域
  el.focus();
  rememberZone(el);
  if (document.activeElement === el && document.activeElement !== before) {
    playSfx("click");
  }
}

/** 两个盒子在纵向有重叠 = 视觉上算「同一行」。留 1px 容差，免得亚像素舍入把同一行判成两行。 */
function overlapsVertically(a: DOMRect, b: DOMRect) {
  return a.bottom > b.top + 1 && a.top < b.bottom - 1;
}

/** 这个池子是不是「单列」（所有项横向基本重合，比如文件页左边那栏「位置」）。 */
function isSingleColumn(pool: HTMLElement[], current: DOMRect) {
  return pool.every((el) => {
    const r = el.getBoundingClientRect();
    return Math.abs(r.left - current.left) < Math.max(r.width, current.width) / 2;
  });
}

/**
 * 横向跨域用的候选挑选（内容区的各个子域之间：卡片条 ⇄ 分组 chip ⇄ 工具栏 ⇄ 操作条）。
 *
 * 0.1.71 时它还是「侧栏 ←→ 内容区」的通道；菜单搬进顶栏并退出焦点系统之后，跨的只剩
 * 内容区内部的子域，但这套挑法原样有用。
 *
 * 只在 dx 那一侧找，逐级收窄：
 *   1. 先只留「当前选中项」（`.is-current` / `[aria-selected]`）—— 卡片条正在显示的那张卡、
 *      当前的分组 chip；一个都没有就退回全部候选。
 *   2. 其中「本域里上次停过的那一项」优先 —— 用户在卡片条上按上到了 chip 行、再按下来时，
 *      想回的是刚才那张卡，而不是几何上更近的另一张（那样一按，hero 与信息面板就换成了别的游戏）。
 *   3. 再按几何：同一行（垂直有重叠）取横向最近的；一行都没有就取垂直中心最近的。
 */
function nearestSideways(
  nodes: HTMLElement[],
  from: HTMLElement,
  current: DOMRect,
  dir: number,
): HTMLElement | null {
  const side = nodes.filter((el) => {
    if (el === from) return false;
    const r = el.getBoundingClientRect();
    // 8px 容差：跟上下跨域的 nearest() 保持一致，边框/内边距不至于把邻居挡在外面
    return dir < 0 ? r.right <= current.left + 8 : r.left >= current.right - 8;
  });
  if (side.length === 0) return null;

  // 卡片条的 .is-current 挂在外层 .k1-item 上（按钮是它里面的 .k1-card），
  // 所以父元素也要认；往上再爬就太宽了（页面级容器也可能是 is-current）。
  const marked = (el: HTMLElement) =>
    el.matches('.is-current, [aria-current]:not([aria-current="false"]), [aria-selected="true"]') ||
    el.parentElement?.matches(".is-current") === true;
  const chosen = side.filter(marked);
  const candidates = chosen.length > 0 ? chosen : side;

  // ① 候选里「上次停过的那一项」优先（用户想回去的是刚才那张卡，不是几何上最近的那个 chip）
  const back = candidates.find((el) => {
    const zone = focusZone(el);
    return zone ? lastInZone.get(zone) === el : false;
  });
  if (back) return back;

  // ② 否则按几何：同一行（垂直有重叠）先看横向距离，没有同一行就看垂直中心距离
  const sameRow = candidates.filter((el) => overlapsVertically(el.getBoundingClientRect(), current));
  const ranked = sameRow.length > 0 ? sameRow : candidates;

  const gap = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return dir < 0 ? current.left - r.right : r.left - current.right;
  };
  const center = current.top + current.height / 2;
  return (
    ranked
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .sort((a, b) => {
        const g = gap(a.el) - gap(b.el);
        // 同一行：横向谁近谁赢；跨行：先看垂直中心距离（视线方向最近的），再看横向。
        if (sameRow.length > 0 && g !== 0) return g;
        const va = Math.abs(a.r.top + a.r.height / 2 - center);
        const vb = Math.abs(b.r.top + b.r.height / 2 - center);
        if (va !== vb) return va - vb;
        return g;
      })[0]?.el ?? null
  );
}

/**
 * 把焦点落进内容区 —— 换页（LB/RB、点页签）、开场动画结束、以及「焦点掉出池子」时的落点。
 *
 * 优先「当前那张卡」（游戏库切回来要落在正显示的那张卡上，而不是工具栏第一颗按钮），
 * 再退到「当前选中项」，最后才是内容区第一个可聚焦项。菜单自己永远不是候选。
 */
export function focusContentLanding(): boolean {
  const nodes = visibleFocusables().filter((el) => !inShellNav(el));
  if (nodes.length === 0) return false;
  const card = nodes.find(
    (el) => el.closest("[data-card-id]") !== null && el.closest(".is-current") !== null,
  );
  focusWithSfx(card ?? currentMarked(nodes) ?? nodes[0]);
  return true;
}

export function moveDirectionalFocus(dx: number, dy: number) {
  const nodes = visibleFocusables();
  if (nodes.length === 0) return;

  const active = document.activeElement as HTMLElement | null;
  const index = nodes.findIndex((node) => node === active);
  if (index < 0) {
    /*
     * 焦点不在池子里 —— 它掉了：按下去就把自己变灰的按钮（工具箱的自检、模拟器的安装）、
     * 点一下会整块重挂载的控件（文件页的「位置」栏）、手指点了空白处（掌机有触摸屏）…
     * 都会让 `document.activeElement` 回到 body。
     *
     * 这里**绝不能用 `nodes[0]`**：池子按 DOM 排序，0.1.71 那版里第一项永远是侧栏第一行，
     * 于是「从落地页按一下方向键」等于「回菜单」（用户 2026-10-11 真机反馈的原话）。
     * 现在菜单移出焦点系统之后 `nodes[0]` 是内容区第一个元素 —— 但仍然不是用户想回的地方，
     * 所以统一走**同一套落地规矩**（当前那张卡 → 当前选中项 → 第一项），和换页落点一致。
     */
    focusContentLanding();
    return;
  }

  const trapped = document.querySelector(".focus-trap.open") !== null;
  const here = focusZone(nodes[index]);
  /*
   * 候选池：焦点在某个域里就只留同域的那些；不在域里（首页 / 下载 / 工具箱 / 模拟器那几颗
   * 没包 data-focus-zone 的按钮）就用整个内容区 —— 但**菜单那一域永远不在候选里**。
   *
   * 2026-10-11 之前这里是 `here ? … : nodes`，`nodes` 里含着侧栏：页面元素没包域时，上下键
   * 在「同一列」的候选里就能挑中侧栏某一行（宽按钮和侧栏算得成同一列），于是上下键会把焦点
   * 送进菜单 —— 用户原话「尤其是有的时候可以通过上下方向键移动过去」说的就是它（实测调用栈
   * 落在 sameZone 那条分支上）。
   */
  const pool = here
    ? nodes.filter((node) => focusZone(node) === here)
    : nodes.filter((node) => !inShellNav(node));
  const local = pool.indexOf(nodes[index]);

  if (dx !== 0) {
    // 不在任何域里（焦点落在没包域的东西上，比如首页那几颗按钮、工具箱的自检）：
    // 保持「按 DOM 顺序在池里走」。
    if (!here) {
      const loose = pool;
      if (loose.length === 0) return;
      const at = loose.indexOf(nodes[index]);
      const next = at + dx;
      if (next < 0 || next >= loose.length) {
        if (!trapped) focusWithSfx(loose[(next + loose.length) % loose.length]);
        return;
      }
      focusWithSfx(loose[next]);
      return;
    }

    // 菜单那一域：**左右什么都不做**（它现在整个不可聚焦，这一条是给「哪天又有人把它变成
    // 焦点域」留的闸）。进内容区只有一条路 —— 在当前那一项上按 A 落进去（见 `focusContentLanding`）。
    if (here === SHELL_NAV_ZONE) return;

    const current = nodes[index].getBoundingClientRect();
    const inside = pool[local + dx];
    // ① 同域、同一行的邻居：卡片条、chip 行、工具栏、文件网格的同一行都走这条。
    //    为什么先看「同一行」而不是直接用池里的下一个：池按 DOM 顺序排，单列里
    //    「右」会往下跳一行。
    if (inside && overlapsVertically(inside.getBoundingClientRect(), current)) {
      focusWithSfx(inside);
      return;
    }
    // ② 这一行到头了 → 跨域：内容区的各个子域之间（卡片条 ⇄ chip 行 ⇄ 操作条）照样能横向走，
    //    候选里照旧排除菜单。
    if (!trapped) {
      const sideways = nearestSideways(
        nodes.filter((node) => focusZone(node) !== SHELL_NAV_ZONE),
        nodes[index],
        current,
        dx,
      );
      if (sideways) {
        focusWithSfx(sideways);
        return;
      }
    }
    // ③ 兜底：多列域（文件网格）保住原来的池顺序行为；单列域按左右就什么都不做 ——
    //    宁可不动，也不要「按右往下跳一行」。
    if (inside && !isSingleColumn(pool, current)) {
      focusWithSfx(inside);
    }
    return;
  }

  if (dy === 0) return;

  const current = nodes[index].getBoundingClientRect();
  const nearest = (list: HTMLElement[]) =>
    list
      .filter((el) => el !== nodes[index])
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => {
        if (dy < 0) return r.bottom <= current.top + 8;
        return r.top >= current.bottom - 8;
      })
      .sort((a, b) => {
        const vertical = Math.abs(a.r.top - current.top) - Math.abs(b.r.top - current.top);
        if (vertical !== 0) return vertical;
        const ax = a.r.left + a.r.width / 2;
        const bx = b.r.left + b.r.width / 2;
        const cx = current.left + current.width / 2;
        return Math.abs(ax - cx) - Math.abs(bx - cx);
      })[0]?.el;

  const sameZone = nearest(
    pool.filter((el) => {
      const r = el.getBoundingClientRect();
      const sameCol =
        Math.abs(r.left + r.width / 2 - (current.left + current.width / 2)) <
        Math.max(current.width, r.width);
      return sameCol;
    }),
  );
  if (sameZone) {
    focusWithSfx(sameZone);
    return;
  }

  if (here) {
    // 菜单那一域到自己那一行的头/尾就**停住**（同 dx：给「又变成焦点域」留的闸）。
    if (here === SHELL_NAV_ZONE) return;
    // 内容区的子域之间照旧能上下走（卡片条 → 操作条 → 网格…），跨域候选里排除菜单。
    const others = nodes.filter(
      (node) => focusZone(node) !== here && focusZone(node) !== SHELL_NAV_ZONE,
    );
    if (others.length === 0) return;
    // 跨域优先看「横向有没有压着」：只看上下距离的话，内容区底部的操作区往上一按会跳到
    // 离得最近的那一行去 —— 用户的视线还在卡片条上，焦点却换地方了。
    const overlapping = nearest(
      others.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < current.right && r.right > current.left;
      }),
    );
    focusWithSfx(overlapping ?? nearest(others));
    return;
  }

  if (!trapped) {
    // 同上：没包域时上下也在内容区里绕，不进菜单。
    const loose = pool;
    if (loose.length === 0) return;
    const at = loose.indexOf(nodes[index]);
    const next = at + dy;
    focusWithSfx(loose[(next + loose.length) % loose.length]);
  }
}

export function visibleFocusables(): HTMLElement[] {
  const keyboard = document.querySelector("[data-gamepad-keyboard]");
  const trap = document.querySelector(".focus-trap.open");
  const scope: ParentNode = keyboard ?? trap ?? document;
  return Array.from(scope.querySelectorAll<HTMLElement>("[data-focusable]")).filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      el.offsetParent !== null &&
      (keyboard !== null || trap !== null || !el.closest(".focus-trap")),
  );
}

/**
 * Lightweight gamepad polling for D-pad / stick navigation.
 * Moves document focus among [data-focusable] elements.
 */
export function useGamepadNav({
  onBack,
  onConfirm,
  onBumperLeft,
  onBumperRight,
  onView,
  onStart,
  onTriggerLeft,
  onTriggerRight,
  onFaceTop,
  onFaceLeft,
  viewGesture = "press",
  enabled = true,
}: Options) {
  const lastAxis = useRef({ x: 0, y: 0 });
  const repeatAt = useRef(0);
  const bumpers = useRef({ l: false, r: false });
  const triggers = useRef({ l: false, r: false });
  const viewHeld = useRef(false);
  const viewTappedAt = useRef(0);
  const startHeld = useRef(false);
  const faceTopHeld = useRef(false);
  const faceLeftHeld = useRef(false);
  const confirmHeld = useRef(false);
  const backHeld = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    // When navigation turns on mid-hold (the intro finishes while a button is
    // still down), treat current presses as already held so one physical press
    // never fires twice.
    const seedHeld = () => {
      const pads = navigator.getGamepads?.() ?? [];
      const pad = pads.find(Boolean);
      if (!pad) {
        bumpers.current = { l: false, r: false };
        triggers.current = { l: false, r: false };
        viewHeld.current = false;
        startHeld.current = false;
        faceTopHeld.current = false;
        faceLeftHeld.current = false;
        confirmHeld.current = false;
        backHeld.current = false;
        return;
      }
      bumpers.current = { l: !!pad.buttons[4]?.pressed, r: !!pad.buttons[5]?.pressed };
      triggers.current = { l: !!pad.buttons[6]?.pressed, r: !!pad.buttons[7]?.pressed };
      viewHeld.current = !!pad.buttons[8]?.pressed;
      startHeld.current = !!pad.buttons[9]?.pressed;
      faceTopHeld.current = !!pad.buttons[3]?.pressed;
      faceLeftHeld.current = !!pad.buttons[2]?.pressed;
      confirmHeld.current = !!pad.buttons[0]?.pressed;
      backHeld.current = !!pad.buttons[1]?.pressed;
    };
    seedHeld();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      if (target.disabled || target.readOnly) return;
      textEditing = true;
      suspendCaret = false;
    };
    document.addEventListener("pointerdown", onPointerDown);
    const keyboard = virtualKeyboard();
    const onKeyboard = () => {
      if ((keyboard?.boundingRect.height ?? 0) < 1) {
        textEditing = false;
        suspendCaret = true;
      }
    };
    keyboard?.addEventListener("geometrychange", onKeyboard);
    const viewport = window.visualViewport;
    let viewportHeight = viewport?.height ?? window.innerHeight;
    const onViewport = () => {
      const height = viewport?.height ?? window.innerHeight;
      if (textEditing && height > viewportHeight + 80) {
        textEditing = false;
        suspendCaret = true;
      }
      viewportHeight = height;
    };
    viewport?.addEventListener("resize", onViewport);

    const tick = () => {
      const pads = navigator.getGamepads?.() ?? [];
      const pad = pads.find(Boolean);
      if (!pad) return;

      const now = performance.now();

      // LB / RB switch tabs on the rising edge, independent of D-pad focus.
      const lb = !!pad.buttons[4]?.pressed;
      const rb = !!pad.buttons[5]?.pressed;
      if (lb && !bumpers.current.l) onBumperLeft?.();
      if (rb && !bumpers.current.r) onBumperRight?.();
      bumpers.current = { l: lb, r: rb };

      // Standard Gamepad button 8: the left utility key.
      // Xbox View/Back, PlayStation Share. Menu/Start is button 9.
      const view = !!pad.buttons[8]?.pressed;
      const start = !!pad.buttons[9]?.pressed;
      if (view && !viewHeld.current) {
        if (viewGesture === "double") {
          // 双击才触发：**单击什么都不做** —— 设置抽屉是重操作，掌机上误蹭到 View 不该拉开它
          // （见 Options.viewGesture）。
          if (now - viewTappedAt.current <= VIEW_DOUBLE_MS) {
            viewTappedAt.current = 0;
            // 第二次按下时 Menu 还按着 = 和弦（不是双击），整串吞掉。
            if (!start) onView?.();
          } else {
            viewTappedAt.current = now;
          }
        } else {
          onView?.();
        }
      }
      viewHeld.current = view;
      // 刚点过 View 的那一小会儿里，Menu 不算独立按下：它多半是和弦的另一半。
      const chord =
        viewGesture === "double" && now - viewTappedAt.current <= VIEW_DOUBLE_MS;
      if (start && !startHeld.current && !chord) onStart?.();
      startHeld.current = start;

      const lt = !!pad.buttons[6]?.pressed;
      const rt = !!pad.buttons[7]?.pressed;
      if (lt && !triggers.current.l) onTriggerLeft?.();
      if (rt && !triggers.current.r) onTriggerRight?.();
      triggers.current = { l: lt, r: rt };

      const field = textEditing ? typingTarget() : null;
      const faceTop = !!pad.buttons[3]?.pressed;
      if (faceTop && !faceTopHeld.current && !field) onFaceTop?.();
      faceTopHeld.current = faceTop;

      const faceLeft = !!pad.buttons[2]?.pressed;
      if (faceLeft && !faceLeftHeld.current && !field) onFaceLeft?.();
      faceLeftHeld.current = faceLeft;

      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      // 死区可调（设置抽屉「手柄死区」，FUTURE.md 功能 14 第 5 条）：老摇杆会飘，
      // 新摇杆在 0.25 上更跟手。默认 0.45 = 0.1.60 的行为。
      const dead = prefs().deadzone;

      const bx =
        pad.buttons[14]?.pressed ? -1 : pad.buttons[15]?.pressed ? 1 : 0;
      const by =
        pad.buttons[12]?.pressed ? -1 : pad.buttons[13]?.pressed ? 1 : 0;

      const dx = bx || (Math.abs(ax) > dead ? (ax > 0 ? 1 : -1) : 0);
      const dy = by || (Math.abs(ay) > dead ? (ay > 0 ? 1 : -1) : 0);

      const prev = lastAxis.current;
      const roseX = dx !== 0 && dx !== prev.x;
      const roseY = dy !== 0 && dy !== prev.y;
      const steer = (sx: number, sy: number) => {
        steerFocus(sx, sy);
      };
      if (roseX || roseY) {
        steer(roseX ? dx : 0, roseX ? 0 : dy);
        repeatAt.current = now + 320;
      } else if ((dx !== 0 || dy !== 0) && now >= repeatAt.current) {
        steer(dx !== 0 ? dx : 0, dx !== 0 ? 0 : dy);
        repeatAt.current = now + 140;
      }
      lastAxis.current = { x: dx, y: dy };

      const confirm = !!pad.buttons[0]?.pressed;
      if (confirm && !confirmHeld.current) {
        confirmFocused();
        onConfirm?.();
      }
      confirmHeld.current = confirm;

      const back = !!pad.buttons[1]?.pressed;
      if (back && !backHeld.current && !closeGamepadKeyboard() && !leaveTextEntry()) onBack?.();
      backHeld.current = back;
    };

    let frame = 0;
    const loop = () => {
      tick();
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
      keyboard?.removeEventListener("geometrychange", onKeyboard);
      viewport?.removeEventListener("resize", onViewport);
    };
  }, [enabled, viewGesture, onBack, onConfirm, onBumperLeft, onBumperRight, onView, onStart, onTriggerLeft, onTriggerRight, onFaceTop, onFaceLeft]);
}
