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

## 在 Windows 掌机上打包验证

你当前开发机是 Mac，**Windows 安装包需要在 Windows 上构建**（推荐直接在掌机上构建）。

### 掌机一次性环境

1. 安装 [Node.js LTS](https://nodejs.org/)
2. 安装 [Rust](https://rustup.rs/)（`rustup-init.exe`）
3. 安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（勾选「使用 C++ 的桌面开发」）
4. 安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 一般自带）

### 构建

把整个 `handheld-launcher` 文件夹拷到掌机后：

```bat
cd handheld-launcher
npm install
npm run tauri:build
```

产物通常在：

- `src-tauri\target\release\handheld-launcher.exe`
- `src-tauri\target\release\bundle\nsis\*.exe`（安装包）

安装后在「设置」里可测开机自启与全屏切换。

## 里程碑路线

1. ✅ 全屏壳 + 主页导航 + 手柄/键盘焦点 + 自启设置
2. 游戏库扫描与启动（Steam 优先）
3. 软件库扫描与启动
4. 手柄文件管理器
5. Xbox 模式 / FSE（Custom Capability）接入
