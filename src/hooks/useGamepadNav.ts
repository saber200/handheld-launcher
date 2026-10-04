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
   * 启动器用 `"double"`：独立前端浮层的 `Back+Start` 和弦里就有 Back 这一半，按下即触发就是
   * 「浮层出来的同时设置抽屉也被拉开」；而押后判定（按下后等几十毫秒看 Menu 是否也按下）会
   * 让设置键肉眼可见地变慢 —— 和弦是**按住两个键**，不会出现两次点按，双击既零延迟又天然
   * 分得开。双击模式下 Menu 也跟着守：第一次点按之后的一小段时间里 Menu 不算独立按下，
   * 第二次点按时若 Menu 还按着就整串吞掉（那正是和弦）。
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

/** Focused range input (the TDP slider) — steering adjusts it instead of leaving it. */
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
 * One step on a focused slider. Left / right used to walk the focus ring, so the
 * TDP slider could not be changed with a gamepad at all, and A clicked a range
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
 * 「每个焦点域里上次停在那一项」—— 只在**候选已经被筛过一层**之后用来二次挑选：
 * 从侧栏按右回内容区时，chip 行与卡片条都算「当前选中项」，几何上 chip 更近，
 * 但用户想回去的是刚才那张卡。见 nearestSideways。
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

/** 这个池子是不是「单列」（所有项横向基本重合，比如侧栏）。 */
function isSingleColumn(pool: HTMLElement[], current: DOMRect) {
  return pool.every((el) => {
    const r = el.getBoundingClientRect();
    return Math.abs(r.left - current.left) < Math.max(r.width, current.width) / 2;
  });
}

/**
 * 横向跨域用的候选挑选（侧栏 ←→ 内容区）。
 *
 * 只在 dx 那一侧找，逐级收窄：
 *   1. 先只留「当前选中项」（`.is-current` / `[aria-selected]`）—— 卡片条正在显示的那张卡、
 *      侧栏当前页那一行、当前的分组 chip；一个都没有就退回全部候选。
 *   2. 其中「本域里上次停过的那一项」优先 —— 从侧栏按右回内容区，落回刚才那张卡，
 *      而不是几何上更近的 chip 行（那样一按右，hero 与信息面板就换成了别的游戏）。
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

  // ① 候选里「上次停过的那一项」优先（用户在侧栏按右，想回去的是刚才那张卡，不是最近的 chip）
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

export function moveDirectionalFocus(dx: number, dy: number) {
  const nodes = visibleFocusables();
  if (nodes.length === 0) return;

  const active = document.activeElement as HTMLElement | null;
  const index = nodes.findIndex((node) => node === active);
  if (index < 0) {
    focusWithSfx(nodes[0]);
    return;
  }

  const trapped = document.querySelector(".focus-trap.open") !== null;
  const here = focusZone(nodes[index]);
  const pool = here ? nodes.filter((node) => focusZone(node) === here) : nodes;
  const local = pool.indexOf(nodes[index]);

  if (dx !== 0) {
    // 不在任何域里（焦点落在没包域的东西上）：保持老行为，按 DOM 顺序在池里走。
    if (!here) {
      const next = local + dx;
      if (next < 0 || next >= pool.length) {
        if (!trapped) focusWithSfx(pool[(next + pool.length) % pool.length]);
        return;
      }
      focusWithSfx(pool[next]);
      return;
    }

    const current = nodes[index].getBoundingClientRect();
    const inside = pool[local + dx];
    // ① 同域、同一行的邻居：卡片条、chip 行、工具栏、文件网格的同一行都走这条。
    //    为什么先看「同一行」而不是直接用池里的下一个：池按 DOM 顺序排，侧栏这种单列里
    //    「右」会往下跳一行（用户实测：在侧栏按右，焦点跑去下一行而不是进内容区）。
    if (inside && overlapsVertically(inside.getBoundingClientRect(), current)) {
      focusWithSfx(inside);
      return;
    }
    // ② 这一行到头了 → 跨域：侧栏 ←→ 内容区（左右方向的「出域」）。
    //    优先「当前选中项」，再优先「本域里上次停过的」，最后按几何（见 nearestSideways）。
    if (!trapped) {
      const sideways = nearestSideways(nodes, nodes[index], current, dx);
      if (sideways) {
        focusWithSfx(sideways);
        return;
      }
    }
    // ③ 兜底：多列域（文件网格）保住原来的池顺序行为；单列域（侧栏）按左右就什么都不做 ——
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
    // 跨域优先看「横向有没有压着」：只看上下距离的话，内容区底部的操作区往上一按会跳到
    // 左侧栏（栏里那一行的 top 离得更近）—— 用户的视线还在卡片条上，焦点却换页了。
    // 没有任何横向重叠时仍按原来的上下距离走，所以侧栏那种窄列的行为一个字没变。
    const others = nodes.filter((node) => focusZone(node) !== here);
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
    const next = index + dy;
    focusWithSfx(nodes[(next + nodes.length) % nodes.length]);
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

    // When this shell becomes active mid-hold (e.g. frontend shown while Start
    // is still down), treat current presses as already held so we don't fire
    // open+close on the same physical press.
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
          // 双击才触发：**单击什么都不做**，所以「按下那一下」不会被算成设置 ——
          // 独立前端浮层的 Back+Start 和弦里正好有 Back 这一半（见 Options.viewGesture）。
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
