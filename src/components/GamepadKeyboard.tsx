import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { text } from "../i18n";
import { playSfx } from "../audio/sfx";
import {
  backspaceField,
  bindKeyboardClosedHook,
  closeGamepadKeyboard,
  fieldIsMultiline,
  gamepadKeyboardOpen,
  insertIntoField,
  moveDirectionalFocus,
  subscribeGamepadKeyboard,
} from "../hooks/useGamepadNav";
import {
  bindKeyboardCloseRequest,
  bindKeyboardField,
  cancelComposition,
  commitCandidate,
  displayComposing,
  ensureWordIndex,
  pressBackspace,
  pressEnter,
  pressKey,
  pressSpace,
  resetKeyboardInput,
  toggleCaps,
  toggleKeyboardMode,
  toggleShiftLock,
  useKeyboardState,
} from "../ime/keyboard";
import { loadPinyinTable, usePinyinTable } from "../ime/pinyinTable";
// 键面布局是纯数据，放 `src/ime/keyLayout.ts` —— 有测试逐个核对符号覆盖与照片对齐
import {
  CJK_PUNCT,
  KEY_ROWS,
  charFor,
  unitsOf,
  type GamepadBadge,
  type Key,
  type KeyboardLayer,
} from "../ime/keyLayout";

/*
 * 手柄键盘。**布局与手柄键位都对照 OneXPlayer 的屏幕键盘**（用户 2026-10-13 拍的照片）：
 *
 *   - 6 行完整键盘：`Esc+F1–F12` / 数字行 / `Tab`+QWERTY / `Caps`+ASDF / `Shift`+ZXCV /
 *     `Ctrl Win Alt`+空格+方向键（实体键表在 `src/ime/keyLayout.ts`）
 *   - 键面印**手柄角标**：`X` 在 Backspace、`Y` 在空格、`R2` 在 Enter、`L2` 在左 Shift、
 *     `L3` 在 Caps —— 用户不用记「哪个键是退格」，看键面就知道
 *   - `Shift` 的形态切换就是「同一个键印的上下两个字符」（数字行 `1`↔`!`），
 *     没有「字母层 / 符号层」那种分层
 *
 * ## 两条设计约束，都是掌机逼出来的
 *
 *   1. **一击可上屏**。手柄上按一下很贵，所以候选尽量是「整词」而不是单字 ——
 *      `nihao` 按一下空格就出「你好」。靠引擎对整串拼音做切分实现（`src/ime/pinyin.ts`）。
 *   2. **复用现成的焦点系统**。每个按键就是 `button[data-focusable]`，候选也是。
 *      方向键移动、A 确认这些**一行都不用重写** —— `useGamepadNav` 扫的就是这个属性。
 */

/** 键面上的手柄角标。这是这把键盘的识别特征，也真的能帮用户少记一层映射。 */
function Badge({ badge }: { badge: GamepadBadge }) {
  return <span className="hint-key-badge">{badge}</span>;
}

export function GamepadKeyboard() {
  const open = useSyncExternalStore(subscribeGamepadKeyboard, gamepadKeyboardOpen);
  const { composing, candidates, selected, mode, shift, shiftLock, caps } = useKeyboardState();
  const tableState = usePinyinTable();
  const rootRef = useRef<HTMLDivElement>(null);
  /** 上一次渲染时「第一颗候选」的文本：用来判断候选是否需要重新接管焦点。 */

  /**
   * 键面是否处于 Shift 形态（数字显符号、字母显大写）。
   *
   * 三个来源只要有一个成立就算：按住 `LT`、锁上 `L2`、`Caps` 开着。
   * **但中文组字时强制回小写** —— 拼音就是小写，键面显示大写会让人以为打出来是大写。
   */
  const shifted = (shift || shiftLock || caps) && !(mode === "zh" && composing);

  // 键盘一关就清掉没上屏的组字与修饰键状态（理由见 `useGamepadNav.bindKeyboardClosedHook`）
  useEffect(() => {
    bindKeyboardClosedHook(resetKeyboardInput);
    bindKeyboardCloseRequest(() => closeGamepadKeyboard());
    return () => {
      bindKeyboardClosedHook(null);
      bindKeyboardCloseRequest(null);
    };
  }, []);

  // 打开时：把字表拉起来、让键盘能往输入框里写字、并用界面文字建一次词索引
  useEffect(() => {
    if (!open) return;
    bindKeyboardField({ insert: insertIntoField, backspace: backspaceField, multiline: fieldIsMultiline });
    void loadPinyinTable().then(() => ensureWordIndex());
    return () => bindKeyboardField(null);
  }, [open]);

  // 字表加载完（可能晚于打开）也要补建一次索引 —— 它是中文字典的一部分，缺了只有英文
  useEffect(() => {
    if (open && tableState.status === "ready") ensureWordIndex();
  }, [open, tableState.status]);

  // 每次打开都清掉上次残留的组字与修饰键
  useEffect(() => {
    if (open) resetKeyboardInput();
  }, [open]);

  // 面板刚出现：把焦点放进它自己的第一颗按键（否则摇杆还停在输入框上）
  useLayoutEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>("[data-focusable]")?.focus();
  }, [open]);

  /*
   * 这里原来有一段：候选一变就把焦点**抢到第一颗候选**上（理由曾是「接着按 A 就是选第一个」）。
   *
   * 用户 2026-10-13 要求去掉：「为什么每次我输入只要识别到能拼成中文了，你就把焦点自动聚焦到
   * 上面的文字了？正常逻辑应该是留在原位置……我输入不管是中文还是英文，只要它符合联想就会自动
   * 聚焦，很容易误操作」。
   *
   * 新规矩：**焦点永远不自己跑**。候选词带 1…9 序号，想选第几个就按数字键（见下面字符键）。
   */

  if (!open) return null;

  const label = text().keyboard;
  const composingShown = displayComposing(composing);
  const layer: KeyboardLayer = shifted ? "upper" : "lower";

  /** 功能键按下时干什么。照片里带角标的那几颗都在这里接上。 */
  const pressWide = (id: Extract<Key, { kind: "wide" }>["id"]) => {
    switch (id) {
      case "backspace":
        pressBackspace();
        return;
      case "enter":
        pressEnter();
        return;
      // 左右两颗 Shift 都是 `L2` 那颗键：按下锁上、再按松开（用户要的「相当于长按 Shift」）
      case "shift-left":
      case "shift-right":
        toggleShiftLock();
        return;
      case "caps":
        toggleCaps();
        return;
      case "esc":
        // 与手柄 B 同义：先取消组字，没有组字才关键盘
        if (!cancelComposition()) closeGamepadKeyboard();
        return;
      case "arrow-left":
        moveDirectionalFocus(-1, 0);
        return;
      case "arrow-right":
        moveDirectionalFocus(1, 0);
        return;
      case "arrow-up":
        moveDirectionalFocus(0, -1);
        return;
      case "arrow-down":
        moveDirectionalFocus(0, 1);
        return;
      default:
        // Tab / Ctrl / Win / Alt：照片上有这几颗键，但本键盘里没有对应行为。
        // **不能让它「按了毫无反应」**（用户会以为卡住），所以发一声轻响表示收到了。
        playSfx("click");
        return;
    }
  };

  return (
    <div ref={rootRef} className="gamepad-keyboard" data-gamepad-keyboard role="group" aria-label={label.label}>
      {/* 组字行：中英切换 + 拼音与候选 + 修饰键指示灯 */}
      <div className="gamepad-kb-compose">
        <button
          type="button"
          className={`gamepad-kb-mode${mode === "zh" ? " is-on" : ""}`}
          data-focusable
          onClick={() => toggleKeyboardMode()}
          title={label.chinese}
        >
          {mode === "zh" ? label.chinese : label.english}
        </button>
        {composing ? (
          <>
            <span className="gamepad-kb-pinyin">{composingShown}</span>
            <div className="gamepad-kb-candidates" role="listbox" aria-label={composingShown}>
              {candidates.map((candidate, index) => (
                <button
                  key={candidate.text}
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  data-focusable
                  data-candidate
                  className={`gamepad-kb-candidate${index === selected ? " is-selected" : ""}`}
                  onClick={() => commitCandidate(index)}
                >
                  <span className="gamepad-kb-cand-num" aria-hidden="true">
                    {index + 1}
                  </span>
                  {candidate.learned ? <span className="gamepad-kb-learned-dot" aria-hidden="true" /> : null}
                  {candidate.text}
                </button>
              ))}
            </div>
          </>
        ) : (
          <span className="gamepad-kb-hint">
            {tableState.status === "missing" ? label.noChinese : ""}
          </span>
        )}

        {/*
          修饰键状态必须**看得见**：用户按一下 L2 把 Shift 锁上了，没有指示就不知道
          自己是「按住」还是「锁着」，打出一串大写会莫名其妙。锁定的用实底牌子区分。
        */}
        <span className="gamepad-kb-mods">
          {shift ? <span className="gamepad-kb-mod">{label.shift}</span> : null}
          {shiftLock ? <span className="gamepad-kb-mod is-locked">{label.shift} ⇪</span> : null}
          {caps ? <span className="gamepad-kb-mod is-locked">{label.caps}</span> : null}
        </span>
      </div>

      {KEY_ROWS.map((row, rowIndex) => (
        <div key={`row-${rowIndex}`} className="gamepad-keyboard-row">
          {row.map((key, keyIndex) => {
            if (key.kind === "space") {
              return (
                <button
                  key={`space-${keyIndex}`}
                  type="button"
                  className="gamepad-key is-space"
                  style={{ flexGrow: unitsOf(key) }}
                  data-focusable
                  onClick={() => pressSpace()}
                >
                  <Badge badge={key.badge} />
                  <span>{label.space}</span>
                </button>
              );
            }
            if (key.kind === "wide") {
              const active =
                key.id === "shift-left" || key.id === "shift-right"
                  ? shiftLock
                  : key.id === "caps"
                    ? caps
                    : false;
              return (
                <button
                  key={key.id}
                  type="button"
                  className={`gamepad-key is-wide${active ? " is-active" : ""}`}
                  // 宽度按 `keyLayout` 里逐键标好的单位（照片里的相对宽度），
                  // 这样各行合计一致、键宽看起来是齐的（测试 `keyLayout.test.ts` 钉着这条）
                  style={{ flexGrow: unitsOf(key) }}
                  data-focusable
                  onClick={() => pressWide(key.id)}
                >
                  {key.badge ? <Badge badge={key.badge} /> : null}
                  <span>{key.label}</span>
                </button>
              );
            }
            // 字符键：Shift 形态下数字键显示它上面印的符号（照片里就是上下两个字符）。
            // `code` 缺省的是 F1–F12 这类功能键：能聚焦、按下去有反馈，但不输入文字。
            const shown = charFor(key, layer) ?? key.label;
            return (
              <button
                key={`${key.code ?? key.label}-${keyIndex}`}
                type="button"
                className="gamepad-key has-label"
                data-focusable
                onClick={() => {
                  /*
                   * 组字中按 `1`–`9` = 选第几颗候选（用户 2026-10-13：「联想词前面出现 1、2、
                   * 3…一直到第九个，我移动到对应的数字键按下后，它就选第几个」）。
                   * 只在**组字中**这么解释；没组字时数字键还是打数字。
                   */
                  const bare = key.code ?? "";
                  const pick = /^[1-9]$/.test(bare) ? Number(bare) - 1 : -1;
                  if (composing && pick >= 0 && pick < candidates.length) {
                    commitCandidate(pick);
                    return;
                  }
                  if (key.code) pressKey(key.code);
                  else playSfx("click");
                }}
              >
                {key.shiftedOf ? (
                  <span className="gamepad-key-shifted" aria-hidden="true">
                    {layer === "upper" ? key.code : key.shiftedOf}
                  </span>
                ) : null}
                <span className="gamepad-key-main">{shown}</span>
              </button>
            );
          })}
        </div>
      ))}

      {/* 中文标点行：本仓库自己加的（照片里没有，但中文输入需要，见 keyLayout.ts） */}
      <div className="gamepad-keyboard-row">
        {CJK_PUNCT.map((mark) => (
          <button key={mark} type="button" className="gamepad-key" data-focusable onClick={() => pressKey(mark)}>
            {mark}
          </button>
        ))}
      </div>

      <div className="gamepad-keyboard-row">
        <button
          type="button"
          className="gamepad-key is-wide is-primary"
          data-focusable
          onClick={() => closeGamepadKeyboard()}
        >
          {label.done}
        </button>
      </div>
    </div>
  );
}
