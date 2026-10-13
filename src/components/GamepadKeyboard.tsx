import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { text } from "../i18n";
import {
  backspaceField,
  closeGamepadKeyboard,
  gamepadKeyboardOpen,
  insertIntoField,
  subscribeGamepadKeyboard,
} from "../hooks/useGamepadNav";
import {
  bindKeyboardField,
  commitCandidate,
  ensureWordIndex,
  displayComposing,
  pressBackspace,
  pressKey,
  pressSpace,
  resetKeyboardInput,
  toggleKeyboardMode,
  useKeyboardState,
} from "../ime/keyboard";
import { loadPinyinTable, usePinyinTable } from "../ime/pinyinTable";

/*
 * 手柄键盘（全键盘 + 拼音候选）。
 *
 * 历史：这里原来是一把**数字键盘**（3×3 数字 + 删除 + 完成），只够敲路径里的数字。
 * `FUTURE.md` 功能 12 的「这一版仍缺」写的就是这件事 ——「手柄上的文字输入（搜索与批量
 * 重命名要借系统键盘；现有数字键盘只够数字）」。现在补上：英文、数字、符号、拼音中文。
 *
 * 两条设计约束，都是掌机逼出来的：
 *
 *   1. **一击可上屏**。手柄上按一下很贵，所以候选必须尽量是「整词」而不是单字 ——
 *      `nihao` 按一下空格就出「你好」，而不是先选「你」再选「好」。这靠引擎对整串
 *      拼音做切分实现（见 `src/ime/pinyin.ts`）。
 *   2. **复用现成的焦点系统**。每个按键就是 `button[data-focusable]`，候选也是。
 *      于是方向键移动、A 确认这些**一行都不用重写** —— `useGamepadNav` 扫的就是这个属性。
 *      新增的只有 LB/RB 翻候选（接在 App 的 `onBumperLeft/Right` 上）。
 */

/** 字母排布。四行十列 —— 留出宽度给候选条，同时按键不至于小到看不清。 */
const LETTER_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"] as const;
/** 数字与常用符号。文件名、搜索词里最常出现的那些，常用的排前面。 */
const PLAIN_ROWS = ["1234567890", "-_=+()[]", "!#$%&*/,;:"] as const;
/** 中文标点单独一行 —— 打中文时它比 `#` `%` 有用得多，而且键盘上别处打不出来。 */
const CJK_PUNCT = ["，", "。", "？", "！", "、", "：", "；", "“", "”", "…"] as const;

export function GamepadKeyboard() {
  const open = useSyncExternalStore(subscribeGamepadKeyboard, gamepadKeyboardOpen);
  const { composing, candidates, selected, mode } = useKeyboardState();
  const tableState = usePinyinTable();
  const rootRef = useRef<HTMLDivElement>(null);
  /** 上一次渲染时「第一颗候选」的文本：用来判断候选是否需要重新接管焦点。 */
  const topCandidate = useRef<string | null>(null);

  // 打开时：把字表拉起来、用界面文字建一次词索引、并让键盘能往输入框里写字
  useEffect(() => {
    if (!open) return;
    bindKeyboardField({ insert: insertIntoField, backspace: backspaceField });
    void loadPinyinTable().then(() => ensureWordIndex());
    return () => bindKeyboardField(null);
  }, [open]);

  // 表加载完（可能晚于打开）也要补建一次索引 —— 它是中文字典的一部分，缺了就只有英文
  useEffect(() => {
    if (open && tableState.status === "ready") ensureWordIndex();
  }, [open, tableState.status]);

  // 每次打开都清掉上次残留的组字
  useEffect(() => {
    if (open) resetKeyboardInput();
  }, [open]);

  // 面板刚出现：把焦点放进它自己的第一颗按键（否则摇杆还停在输入框上）
  useLayoutEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>("[data-focusable]")?.focus();
  }, [open]);

  /*
   * 候选变了要重新接焦点。
   *
   * 为什么必须做：用户敲 `n` 时焦点在 `n` 这颗键上；敲到 `ni` 出现候选后，如果那颗键
   * 消失了（`z` 行不动，但候选是新增的），焦点会掉回 body —— 此时摇杆就没反应了。
   * 所以第一颗候选一出现就把焦点交给它：接着按 A 就是「选第一个候选」，这正是用户要的。
   */
  useLayoutEffect(() => {
    if (!open || !composing) {
      topCandidate.current = null;
      return;
    }
    const first = candidates[0]?.text ?? null;
    if (first === null || first === topCandidate.current) return;
    topCandidate.current = first;
    rootRef.current?.querySelector<HTMLElement>("[data-candidate]")?.focus();
  }, [open, composing, candidates]);

  if (!open) return null;

  const label = text().keyboard;
  const composingShown = displayComposing(composing);

  return (
    <div ref={rootRef} className="gamepad-keyboard" data-gamepad-keyboard role="group" aria-label={label.label}>
      {/* 组字行：左边是「中/英」切换，中间是拼音与候选，右边在没候选时说明原因 */}
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
      </div>

      {[...LETTER_ROWS, ...PLAIN_ROWS, CJK_PUNCT].map((row, rowIndex) => (
        <div key={`row-${rowIndex}`} className="gamepad-keyboard-row">
          {(typeof row === "string" ? [...row] : row).map((key) => (
            <button
              key={key}
              type="button"
              className="gamepad-key"
              data-focusable
              onClick={() => pressKey(key)}
            >
              {key}
            </button>
          ))}
        </div>
      ))}

      <div className="gamepad-keyboard-row">
        <button type="button" className="gamepad-key is-wide" data-focusable onClick={() => pressSpace()}>
          {label.space}
        </button>
        <button type="button" className="gamepad-key is-wide" data-focusable onClick={() => pressBackspace()}>
          {label.backspace}
        </button>
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
