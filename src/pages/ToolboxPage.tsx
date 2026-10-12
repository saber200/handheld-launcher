import { ToolboxPanel } from "./ToolboxPanel";

/**
 * 工具箱（画板 K4）。页面本体在 ToolboxPanel 里（它连页头一起渲染 —— 右上那颗「自检」
 * 和下面几张卡读的是同一批状态）；这里只给 `.page` 这个 flex 列容器，样式在 styles/toolbox.css。
 *
 */
export function ToolboxPage() {
  return (
    <main className="page k4-page">
      <ToolboxPanel />
    </main>
  );
}
