# 掌机启动器（Handheld Launcher）

Windows 掌机全屏前端启动器。当前完成 **里程碑 1：全屏壳**。

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

方向键移动焦点，Enter 确认，Esc 返回。接上手柄后可用摇杆/十字键 + A/B。

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

1. ✅ 全屏壳 + 主页导航 + 手柄/键盘焦点 + 自启设置
2. 游戏库扫描与启动（Steam 优先）
3. 软件库扫描与启动
4. 手柄文件管理器
5. Xbox 模式 / FSE（Custom Capability）接入
