# 幻想枢纽（FantasyHub）

Windows 掌机全屏前端启动器。当前完成全屏壳，以及 Windows 安装包里的 Steam / Epic 游戏扫描和已安装软件扫描。前端界面是随启动器安装的 **Game Bar 小组件**（`Win+G`）；独立的前端程序已在 0.1.62 删除，小组件的后端改成**启动器进程自己**（回环 + 发现文件，见 `frontend/gamebar/HANDOFF.txt`）。

## 技术栈

- Tauri 2 + Rust（系统能力）
- React + TypeScript + Vite（UI）

## 本机开发（macOS）

```bash
cd ~/Desktop/handheld-launcher
npm install
# 仅预览 UI（浏览器）
npm run dev
# 桌面壳（需已安装 Rust）
source "$HOME/.cargo/env"
npm run tauri:dev
```

顶部四个标签水平居中：游戏库、软件库、文件管理、工具箱。手柄 LB / RB 切换标签（键盘 Q / E）。**双击** Xbox 的 Back（View）或 PS 的 Share 从左侧拉出设置（键盘 Esc 仍是按一次即可，再按一次关闭）。方向键或摇杆移动焦点，A / Enter 确认。游戏卡片菜单里有「安装 Mod / 工具」，可直接为该游戏下载并安装 OptiScaler（工具箱标签页只剩运行库）。

## 在 Windows 掌机上下载使用（推荐）

Mac 上开发即可。推送 `v*` 标签后，GitHub Actions 会自动打 Windows 安装包并发布到 **Releases**：

```bash
git tag v0.1.0
git push origin v0.1.0
```

掌机浏览器打开仓库 → **Releases** → 下载 NSIS 安装包（`.exe`）安装即可，**无需开发环境**。

也可在 **Actions → Build Windows → Artifacts** 下载构建产物。

手动触发：Actions → Build Windows → Run workflow（会发 prerelease）。

## 里程碑路线

1. ✅ 全屏壳 + 手柄/键盘焦点 + 自启设置
2. ✅ 游戏库扫描（Steam、Epic），卡片上按 A 启动
3. ✅ 软件库扫描（已安装程序），卡片上按 A 启动
4. ✅ 手柄文件管理：浏览、新建、复制/粘贴、移动、打开、编辑保存
5. Xbox 模式 / FSE（Custom Capability）接入
