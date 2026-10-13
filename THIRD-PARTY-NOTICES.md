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

## 数据：Unicode Unihan 数据库（手柄键盘的拼音字表）

- 文件：`public/pinyin-syllables.txt`（约 290 KB，随安装包分发）
- 生成方式：`npm run gen:pinyin`（`scripts/gen-pinyin-data.mjs`）从 Unicode 官方
  `Unihan.zip` 的 `Unihan_Readings.txt`（`kMandarin` / `kHanyuPinlu`）与
  `Unihan_Variants.txt`（`kSimplifiedVariant`）提取，**不含任何第三方输入法词库**。
- 许可证：**Unicode License v3**（MIT 类，允许随产品分发；要求保留版权与许可声明）
- 版权：Copyright © 1991-2024 Unicode, Inc.
- 用于：`src/ime/` 的拼音引擎 —— 手柄键盘的候选字、字频与繁简判断都来自这份表。

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2024 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS
INCLUDED IN THIS NOTICE BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT
OR CONSEQUENTIAL DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF
USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THE DATA FILES OR SOFTWARE.
```

**为什么不用现成的中文输入法词库**：雾凇拼音 / 小狼毫那一套（`rime-ice` 等）是
**GPL-3.0**，随安装包分发会传染本仓库；网上流传的 HSK / 词频表多半派生自 CC-CEDICT
（BY-SA）且往往没有 LICENSE 文件。所以中文候选改走「官方字表 + 从用户自己的库里学词」
（见 `src/ime/wordIndex.ts`），不引入任何第三方词库。

## 商标

上列品牌图标（Steam、Epic Games、Xbox、Windows、PlayStation）是各自权利人的**商标**，
此处仅用于**指代对应的游戏平台 / 操作系统**（指示性合理使用），不代表任何背书或关联。
