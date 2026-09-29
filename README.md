# 幻想枢纽（FantasyHub）

Windows 掌机全屏前端启动器。当前完成全屏壳，以及 Windows 安装包里的 Steam / Epic 游戏扫描和已安装软件扫描。

## 功能一览（v0.1.0 稳定版）

- **全屏壳**：无边框独占全屏；开机自启；可登记为 Windows 全屏体验（FSE）主应用
- **标签导航**：游戏库 / 软件库 / 文件管理；手柄 LB/RB（键盘 Q/E）切页；中英切换
- **游戏库**：扫描 Steam / Epic；封面缓存、分组、手动添加、运行中边框；A 启动、强制退出
- **软件库**：扫描已安装程序；图标与启动
- **文件管理**：盘符浏览、新建、复制 / 移动、多选、列表 / 网格视图、打开、文本编辑保存
- **设置抽屉**：开机自启、全屏、回桌面、电源（休眠 / 重启 / 关机）、退出、FSE 登记与设置入口
- **前端浮层（Start）**：独立置顶右侧窗；软件内 Start 开抽屉，游戏中 Back+Start / Ctrl+H 开浮层；手柄 D-pad / A / B 操作
- **TDP（Intel / OXP3）**：WinRing0 MSR，5–40W 预设 + 滑条；驱动检测与一键安装
- **工具箱**：VC++ / .NET 运行库安装；OptiScaler（`dxgi.dll`）一键安装
- **交互反馈**：克制动效与界面音效

> `v0.1.0` 是当前稳定版（内容对应内部构建 0.1.38）。`0.1.31`–`0.1.40` 为测试版，不作为发布版。

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

顶部三个标签水平居中：游戏库、软件库、文件管理。手柄 LB / RB 切换标签（键盘 Q / E）。Xbox 的 Back（View）或 PS 的 Share 从左侧拉出设置（键盘 Esc，再按一次关闭）。方向键或摇杆移动焦点，A / Enter 确认。

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
