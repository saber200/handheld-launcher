import { useEffect, useRef } from "react";

type Options = {
  onBack?: () => void;
  onConfirm?: () => void;
  enabled?: boolean;
};

/**
 * Lightweight gamepad polling for D-pad / stick navigation.
 * Moves document focus among [data-focusable] elements.
 */
export function useGamepadNav({ onBack, onConfirm, enabled = true }: Options) {
  const lastAxis = useRef({ x: 0, y: 0 });
  const coolUntil = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const moveFocus = (dx: number, dy: number) => {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("[data-focusable]"),
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);

      if (nodes.length === 0) return;

      const active = document.activeElement as HTMLElement | null;
      let index = nodes.findIndex((n) => n === active);
      if (index < 0) {
        nodes[0]?.focus();
        return;
      }

      if (dx !== 0) {
        index = (index + dx + nodes.length) % nodes.length;
      } else if (dy !== 0) {
        // Prefer vertical neighbors by comparing geometry
        const current = nodes[index].getBoundingClientRect();
        const candidates = nodes
          .map((el, i) => ({ el, i, r: el.getBoundingClientRect() }))
          .filter(({ i, r }) => {
            if (i === index) return false;
            const sameCol =
              Math.abs(r.left + r.width / 2 - (current.left + current.width / 2)) <
              Math.max(current.width, r.width);
            if (dy < 0) return sameCol && r.bottom <= current.top + 4;
            return sameCol && r.top >= current.bottom - 4;
          })
          .sort((a, b) => {
            const da = Math.abs(a.r.top - current.top);
            const db = Math.abs(b.r.top - current.top);
            return da - db;
          });

        if (candidates.length > 0) {
          index = candidates[0].i;
        } else {
          index = (index + dy + nodes.length) % nodes.length;
        }
      }

      nodes[index]?.focus();
    };

    const tick = () => {
      const pads = navigator.getGamepads?.() ?? [];
      const pad = pads.find(Boolean);
      if (!pad) return;

      const now = performance.now();
      if (now < coolUntil.current) return;

      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      const dead = 0.45;

      const bx =
        pad.buttons[14]?.pressed ? -1 : pad.buttons[15]?.pressed ? 1 : 0;
      const by =
        pad.buttons[12]?.pressed ? -1 : pad.buttons[13]?.pressed ? 1 : 0;

      const dx = bx || (Math.abs(ax) > dead ? (ax > 0 ? 1 : -1) : 0);
      const dy = by || (Math.abs(ay) > dead ? (ay > 0 ? 1 : -1) : 0);

      const moved =
        (dx !== 0 && dx !== lastAxis.current.x) ||
        (dy !== 0 && dy !== lastAxis.current.y);

      if (moved && (dx !== 0 || dy !== 0)) {
        moveFocus(dx, dy);
        coolUntil.current = now + 180;
      }

      lastAxis.current = { x: dx, y: dy };

      // A / Cross
      if (pad.buttons[0]?.pressed) {
        const el = document.activeElement as HTMLElement | null;
        el?.click();
        onConfirm?.();
        coolUntil.current = now + 250;
      }

      // B / Circle
      if (pad.buttons[1]?.pressed) {
        onBack?.();
        coolUntil.current = now + 250;
      }
    };

    const id = window.setInterval(tick, 50);
    return () => window.clearInterval(id);
  }, [enabled, onBack, onConfirm]);
}
