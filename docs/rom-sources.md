# ROM 来源调研（2026-10-12，写下来给以后接下载源的人看）

**用途**：模拟器页「游戏列表」面板以后要接在线下载源。这份是**实测记录**，不是道听途说 ——
每条都带状态码 / 字节数 / 响应头证据。**结论先写在最前面：现在没有可用的公开源，
所以 0.1.76 只做了列表（本机已有文件），下载没做。**

## 一、两个决定性的事实

1. **Myrient（业界标准、最好脚本化的那家）已经关站**：`https://myrient.erista.me/` 首页原文
   *"Myrient was shut down on 31 March 2026."*
   ⚠️ **软 200 陷阱**：`/files/`、`/files/No-Intro/`、`/files/Redump/` 全都返回 **HTTP 200**，
   但内容都是同一份 **2334 字节**的公告页 —— 健康检查只看状态码会误判成"可用"。
2. **archive.org 在国内网络是 IP 级封锁**（不只是慢）：`dig +short archive.org` → `199.59.149.206`，
   但 `@1.1.1.1` 返回的是 Facebook 的 `31.13.75.12`（DNS 污染）；强制真实 IP `207.241.224.2` 也超时；
   `web.archive.org` / `openlibrary.org` / `ia*.us.archive.org` 全部不通。
   对照组：github.com / myrient / vimm.net 都能连。
   - `https://archive.org/metadata/<identifier>` 接口本身很干净（通过 CORS 代理实测 200：
     顶层 `files_count` / `files` / `item_size` / `item_last_updated`，每个文件给
     `name` / `size` / `mtime` / `md5` / `crc32` / `sha1` / `format`），
     **但 `https://archive.org/download/<id>/<file>` 的直链在本机无法实测**（代理返回 520/522，
     那是代理自己到不了节点，不能当成"链接失效"的证据）。
     要在目标网络复测：`curl -sIL --max-time 20 "https://archive.org/download/<id>/<file>"`。

## 二、六个平台逐个实测

| 平台 | 最接近的源 | 实测证据 | 致命缺陷 |
| --- | --- | --- | --- |
| 街机（MAME） | [mdk.cab](https://mdk.cab/) | `https://mdk.cab/download/split/mslug.zip` → **206**，`Content-Range: bytes 0-200/13165412` | 锁死 **0.289**（正好对上我们发的 MAME，但 MAME 一升级它就过期）；**不支持 HEAD**（只能 `GET -r 0-0 -D -`）；无 JSON API；25 条/页翻页 |
| 全能（RetroArch） | [romspedia](https://romspedia.com/) 覆盖 13 个系统 | N64 `007 - GoldenEye (USA).zip` → **200**，10,834,702 字节 | 下载要**两步过广告页**；资源停在 2021-03；每页 ~50 条。⚠️ SNES 的路径是 `/roms/super-nintendo`，NES 没有独立目录 |
| 全能备源 | edgeemu.net | `Mario Golf (USA).zip` → 200/206，17,314,913 字节 | **列表每次只随机返回 10 条**（同一 URL 两次请求的 MD5 不同）→ 枚举不出全量 |
| PS2 | romspedia | `downloads.romspedia.com/roms/Bully (USA).7z` → **200**，2,112,552,544 字节 | 同上的广告页问题 |
| PS2 备源 | Romulation / Vimm's / EmuParadise | Romulation 有 1606 条 JSON-LD | Romulation **下载是付费墙**（guest 直链返回 200 + 升级页）；Vimm's 全站 Cloudflare Turnstile **且所有游戏页 404**；EmuParadise 的下载链接 **2018 年就被剥离**（`id="download-link"` 是空元素） |
| PS3 / PS4 | [NoPayStation 的 TSV 表](https://nopaystation.com/) | `PS3_GAMES.tsv` 200 / 1,808,847 字节 / 7907 行（5513 有直链）；`PS4_GAMES.tsv` 200 / 604,165 字节 / 2286 行。直链抽检 **PS3 56/56、PS4 18/18 存活**（`zeus.dl.playstation.net`，206 + `Content-Range`，magic `7f 50 4b 47`） | 是 **Sony 官方 CDN 上的加密 PKG**：RPCS3 不吃、**要自备 RAP**（nopaystation 不提供 RAP 直链）；**Sony 在持续删档**（实测有 2009 年的 PKG 已 404，同一清单第二次请求变 404）；PS4 最大单文件 83.1 GB（RDR2） |
| Switch | —— | nsw2u.com **已被执法查封**（200 + `<title>This Website Has Been Seized</title>`）；nxbrew 要 **JS 生成 JWT** 再 302 到 `survey-smiles.com` 广告站 | **没有可脚本化的源** |

**已经死掉的（别再试）**：`pleasuredome.org.uk`、`romsey.xyz`（都成了域名停放页，114 字节跳 `/lander`）、
`retroroms.info`、`the-eye.eu`、`mameworld.info`（全部 `HTTP=000`）。
**Myrient 留下的空缺没有被同等质量补上。**

## 三、结论（当时给用户的建议）

1. **不要把这个功能钉在某个具体站上**：唯一接口干净的（NoPayStation TSV）是灰色库存 + 正在被删档 +
   PS3 缺 RAP 没法自动解密；其余死于被查封 / 付费墙 / JS / Turnstile / 链接被剥离 / 枚举不出来。
2. 建议的形态：**来源地址用户自填 + 通用下载引擎**。引擎要有：断点续传、跟随重定向、
   `Content-Length` / `Content-Range` 双路进度、校验（SHA256/MD5）、**每源可达性预检**
   （尤其防 Myrient 那种"软 200 公告页"）。
3. 用户 2026-10-12 的决定：**先不做下载，只留「游戏列表」页**（列本机已有文件），
   等他找到可用的源再回来接。所以 `src/emulators/RomsPanel.tsx` 里现在只有列表 + 一句实话。

## 四、接源时要遵守的既有约定

- **ROM 目录**：`<第一块非系统盘>:\Emulation\ROMs\<平台子目录>`，子目录名以
  `src-tauri/src/emulator.rs` 里每张卡的 `rom_dir` 为准（ps2 / ps3 / switch / ps4 / arcade / retro），
  其中 ps2 / switch / retro 必须与 `src/files/taskMeta.ts` 的 `ROM_PLATFORMS[].folder` **同一个字符串**
  —— 探针里有一条断言盯着这件事（「导入到 A、列表看 B」是最难查的那种 bug）。
- **街机 ROM 必须与 MAME 版本对齐**：romset 会随版本变动，被改动过的 set 在别的版本上直接报缺文件
  （依据：[MAME FAQ:ROMs](https://wiki.mamedev.org/index.php/FAQ:ROMs)）。我们发的是 0.289。
- **不要摆按了没反应的假按钮**：源没接上之前，列表里就不该出现「下载」按钮（探针也断言了这一条）。
