import {
  IconCircleLetterAFilled,
  IconCircleLetterBFilled,
  IconCircleLetterXFilled,
  IconCircleLetterYFilled,
  IconMenu2,
} from "@tabler/icons-react";

/**
 * 手柄按键角标（底部提示条 / 文件页 chip / 游戏卡右下角）。
 *
 * 以前这三处都是**用字符 + CSS 画圆框**（`<span>{label}</span>` 外加 border + radius），
 * 同一个「A 键」在三个地方各画一遍、尺寸和描边还各不相同。现在收成一个组件：
 * 字母键交给 Tabler 的**实心** `circle-letter-*`（圆和挖空的字母都是图标的一部分），
 * `≡` 交给 `menu-2`。
 *
 * **为什么用实心版而不是线性版**：画板里这几颗角标就是「实心圆 + 挖空字母」
 * （K1 卡片右下角那颗 A 是 accent 实心圆 + 深色 A，提示条是浅圆 + 深字母）。
 * 线性 `circle-letter-*` 是一圈描边加一个描边字母，套进原来的圆框里会变成双层圈。
 *
 * **肩键两个是例外**：`LT/RT` / `LB/RB` 是**两个字母的标签**，不是单个按键符号 ——
 * Lucide / Tabler / Phosphor / Iconoir 四家都没有肩键 / 扳机图标（查过，命中 0），
 * 硬套一个图标只会更看不懂，所以它们继续走文字角标（画板也是这么画的）。
 *
 * 类名由调用方给：三个位置的尺寸与配色本来就不同（`hint-key` / `k7-key` / `k1-a`），
 * 这里只负责选图标并打上 `is-keycap` —— 那个类在各自的 CSS 里把 border 与底色去掉。
 */
const CAPS: Record<string, typeof IconCircleLetterAFilled | typeof IconMenu2> = {
  A: IconCircleLetterAFilled,
  B: IconCircleLetterBFilled,
  X: IconCircleLetterXFilled,
  Y: IconCircleLetterYFilled,
  "≡": IconMenu2,
};

export function KeyCap({ label, className }: { label: string; className: string }) {
  const Glyph = CAPS[label];
  if (!Glyph) {
    return (
      <span className={className} aria-hidden>
        {label}
      </span>
    );
  }
  // 描边只对 `menu-2` 这种线性图标生效；实心的 `circle-letter-*` 走 fill，会忽略它。
  // `className="icon"` 是拿到公共图标类（`.icon` 给 18dp，各处的 `.is-keycap .icon` 再按位置覆盖）。
  return (
    <span className={`${className} is-keycap`} aria-hidden>
      <Glyph className="icon" stroke={1.7} />
    </span>
  );
}
