import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { text } from "../i18n";
import {
  backspaceGamepadField,
  closeGamepadKeyboard,
  gamepadKeyboardOpen,
  subscribeGamepadKeyboard,
  typeIntoGamepadField,
} from "../hooks/useGamepadNav";

const ROWS = ["123", "456", "789"];

export function GamepadKeyboard() {
  const open = useSyncExternalStore(subscribeGamepadKeyboard, gamepadKeyboardOpen);
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>("[data-focusable]")?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div ref={rootRef} className="gamepad-keyboard" data-gamepad-keyboard role="group" aria-label={text().keyboard.label}>
      {ROWS.map((row) => (
        <div key={row} className="gamepad-keyboard-row">
          {row.split("").map((key) => (
            <button
              key={key}
              type="button"
              className="gamepad-key"
              data-focusable
              onClick={() => typeIntoGamepadField(key)}
            >
              {key}
            </button>
          ))}
        </div>
      ))}
      <div className="gamepad-keyboard-row">
        <button type="button" className="gamepad-key" data-focusable onClick={() => backspaceGamepadField()}>
          {text().keyboard.backspace}
        </button>
        <button type="button" className="gamepad-key" data-focusable onClick={() => typeIntoGamepadField("0")}>
          0
        </button>
        <button type="button" className="gamepad-key" data-focusable onClick={() => closeGamepadKeyboard()}>
          {text().keyboard.done}
        </button>
      </div>
    </div>
  );
}
