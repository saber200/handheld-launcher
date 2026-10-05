# 第三方组件与图标许可

本仓库自身的代码没有附许可证文件；下面列的是**随安装包分发**的第三方素材，
以及各自的署名要求。新增会打进产物的第三方素材时，往这里加一条。

## 图标

### Tabler Icons（线性 UI 图标 + 品牌图标）

- 包：`@tabler/icons-react`
- 许可证：**MIT**
- 版权：Copyright (c) 2020-2026 Paweł Kuna
- 用于：`src/components/NavIcons.tsx`（全部 22 个 UI 图标）、
  `src/components/DeviceIcons.tsx`（`brand-xbox` / `brand-windows` / PS 按键符号与硬件图标）

MIT 要求把版权声明与许可声明包含在软件的所有副本或实质性部分中。完整许可文本随包提供：
`node_modules/@tabler/icons/LICENSE`。

```
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Simple Icons（Steam / Epic 品牌 logo）

- 包：`simple-icons`（**devDependency** —— 只在开发时取 path，不进运行时产物）
- 许可证：**CC0-1.0**（公有领域奉献，**无署名义务**，可商用）
- 用于：`src/components/DeviceIcons.tsx` 里 `SteamMark` / `EpicMark` 两枚内联 SVG path
  （来源：`icons/steam.svg`、`icons/epicgames.svg`，viewBox `0 0 24 24` 原样内联）

CC0 不要求署名，这里记一笔只是为了讲清 path 的出处。

**注意**：Simple Icons 因商标方要求**下架**了 `xbox` / `nintendoswitch` / `battlenet` / `ea`
等标记。需要这几家的 logo 时不要指望这个包，本项目 Xbox 用的是 Tabler 的线性 `brand-xbox`。

## 商标

上列品牌图标（Steam、Epic Games、Xbox、Windows、PlayStation）是各自权利人的**商标**，
此处仅用于**指代对应的游戏平台 / 操作系统**（指示性合理使用），不代表任何背书或关联。
