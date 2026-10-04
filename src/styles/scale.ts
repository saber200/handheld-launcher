/**
 * 界面缩放：把设计稿的逻辑画布换算成 `--dp`。
 *
 * 设计稿（docs/redesign/artboards）的逻辑画布是 **1280×720**，9 张图都是它的 2× 渲染，
 * 所以缩放按画布等比算：
 *
 *     dp = min(窗口宽 / 1280, 窗口高 / 720)
 *
 *   1920×1080 → 1.5    2560×1440 → 2.0    1280×800 → 1.0（16:10 上下留边，不拉伸）
 *
 * 为什么不照抄规格书 §11 那张表（min(h/1080, w/1280)，1080p 记作 1.00×）：那张表的
 * 「物理 px」列和 §1 的几何自相矛盾 —— §1 是 236 侧栏 + 996 内容 + 24 安全边 = 1280 宽，
 * 按 1280 画的；照 §11 在 1080p 上排 1.00×，侧栏只占屏宽 12.3%，和画板上的 18.4% 对不上。
 * 视觉比例以画板为准，所以这里用画布等比。**要改回那一套只改这一个函数**，其它地方
 * 全都读 --dp，不用动。
 */
const DESIGN_W = 1280;
const DESIGN_H = 720;

export function uiScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  return Math.min(width / DESIGN_W, height / DESIGN_H);
}

/** 写一次 --dp。窗口尺寸变化时再调一次即可。 */
export function applyUiScale(): void {
  if (typeof document === "undefined") return;
  const scale = uiScale(window.innerWidth, window.innerHeight);
  document.documentElement.style.setProperty("--dp", `${scale}px`);
}

/** 监听窗口尺寸变化（掌机上外接屏 / 分辨率切换都会触发）。 */
export function watchUiScale(): () => void {
  applyUiScale();
  const onChange = () => applyUiScale();
  window.addEventListener("resize", onChange);
  // 全屏切换后 innerWidth/innerHeight 是异步更新的，再补一次避免用旧值渲染。
  window.setTimeout(onChange, 300);
  return () => window.removeEventListener("resize", onChange);
}
