import { useEffect, useRef } from "react";
import { playSfx } from "../audio/sfx";

type Options = {
  onBack?: () => void;
  onConfirm?: () => void;
  onBumperLeft?: () => void;
  onBumperRight?: () => void;
  /** Xbox View/Back，PS Share。标准映射里都是 8 号键。 */
  onView?: () => void;
  /** Xbox Menu/Start，PS Options。标准映射里都是 9 号键。 */
  onStart?: () => void;
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

function focusWithSfx(el: HTMLElement | null | undefined) {
  if (!el) return;
  const before = document.activeElement;
  el.focus();
  if (document.activeElement === el && document.activeElement !== before) {
    playSfx("click");
  }
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
    const next = local + dx;
    if (next < 0 || next >= pool.length) {
      if (!trapped && !here) focusWithSfx(pool[(next + pool.length) % pool.length]);
      return;
    }
    focusWithSfx(pool[next]);
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
    const other = nearest(nodes.filter((node) => focusZone(node) !== here));
    focusWithSfx(other);
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
  enabled = true,
}: Options) {
  const lastAxis = useRef({ x: 0, y: 0 });
  const repeatAt = useRef(0);
  const bumpers = useRef({ l: false, r: false });
  const triggers = useRef({ l: false, r: false });
  const viewHeld = useRef(false);
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
      if (view && !viewHeld.current) onView?.();
      viewHeld.current = view;
      const start = !!pad.buttons[9]?.pressed;
      if (start && !startHeld.current) onStart?.();
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
      const dead = 0.45;

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
  }, [enabled, onBack, onConfirm, onBumperLeft, onBumperRight, onView, onStart, onTriggerLeft, onTriggerRight, onFaceTop, onFaceLeft]);
}
