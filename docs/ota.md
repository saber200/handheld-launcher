# OTA 升级（0.1.81 起）

用户 2026-10-12 的要求：「能不能做 ota 升级啊？每次都要重新下载，好麻烦」。这份文档写清**它是怎么跑的、
密钥在哪、坏了怎么修** —— 出问题时不用再翻代码。

## 一、链路长什么样

```
私有仓 saber200/handheld-launcher          公开仓 saber200/fantasyhub-releases
  ┌───────────────────────────┐              ┌──────────────────────────────────┐
  │ 推 tag v0.1.82            │              │ Release: v0.1.82                 │
  │   ↓ CI（Build Windows）   │  发布物 →    │   FantasyHub_0.1.82_x64-setup.exe│
  │   编译 + 用私钥签名        │ ───────────→ │   …_x64-setup.exe.sig（签名）     │
  └───────────────────────────┘              │   latest.json（版本 + 地址 + 签名）│
                                             └──────────────────────────────────┘
                                                          ↑ 应用开机静默 GET
                                             掌机上的启动器（公钥写死在应用里）
                                             对得上签名才装 → 静默安装 → 自动重启
```

- **代码仓保持私有**：应用更新要去一个**不登录就能读**的地址，把 token 塞进应用等于把仓库权限发出去，
  所以发布物单独放一个公开仓（里面**只有安装包**，没有源码）。
- **发布物仓库是空的也没关系**：CI 推 tag 时自己建 Release。

## 二、密钥与令牌

| 名字 | 在哪 | 作用 | 丢了/泄了会怎样 |
| --- | --- | --- | --- |
| 更新包私钥 | CI secret `TAURI_SIGNING_PRIVATE_KEY`（+ `_PASSWORD`）+ 你自己的备份 | **签更新包** | 丢了 → 你发不出更新（老机器只认老公钥，得让每台机器手动装一次新版才能恢复）；泄了 → 别人能签出你的机器愿意装的包，**必须立刻换钥匙并让所有机器手动重装** |
| 公钥（minisign） | `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`（可公开） | 校验更新包 | 改错/换掉 = 所有老机器拒收更新 |
| `RELEASE_TOKEN` | CI secret（fine-grained，**只对发布物仓库**有 Contents: Read and write） | CI 把产物推到公开仓 | 过期 → tag 构建那一步失败（**看 Actions 日志里的 403**）；换新的即可，应用不受影响 |

- 私钥是 `npm run tauri signer generate -w <文件>` 生成的（本机做过一次，公钥 key id
  `8B142F2BFDDC57A3`）。**私钥不进仓库**，只在 CI secret 与你自己的密码管理器里。
- `RELEASE_TOKEN` **有有效期**（fine-grained token 必须选，最长一年）。**到期前要换**，
  否则下一个 tag 发布会失败。换的时候：重新生成 → 更新 secret → 不用改代码。

## 三、发一版要做的事

1. 改版本号（三处 + 两个 lock，和以前一样）；
2. 推 main（日常构建仍然发私有仓，用于自测）；
3. `npm run audit:ota` 过一遍（pre-commit 也会跑）—— 它专门盯"错了也不报错"的那些配置；
4. 推 tag `vX.Y.Z` → CI 编译、签名、推到公开仓；
5. 到公开仓确认 Release 里有 **三个**文件：`*-setup.exe`、`*-setup.exe.sig`、`latest.json`；
6. 掌机上：设置抽屉 →「版本与更新」→ 应该显示「有新版本 vX.Y.Z」→ 点「更新并重启」。

## 四、怎么手工核对（不用装应用）

```bash
# 1) 应用读的那份清单（版本号 + 下载地址 + 签名）
curl -sL https://github.com/saber200/fantasyhub-releases/releases/latest/download/latest.json | python3 -m json.tool

# 2) 安装包与签名在不在
curl -sIL https://github.com/saber200/fantasyhub-releases/releases/latest/download/FantasyHub_<版本>_x64-setup.exe | head -3
```

`latest.json` 里 `version` 必须是**比掌机上装的更新**的版本号 —— 一样或更旧，应用就不会提示更新。

## 五、排错对照表

| 现象 | 多半是 | 怎么办 |
| --- | --- | --- |
| 抽屉里一直「检查更新失败：…」 | 网络到不了 GitHub / 公开仓还没有 Release | 先按第四节手工 curl 一次；404 = 还没有发布物 |
| 一直显示「已是最新」但明明发了新版 | `latest.json` 没产出（CI 输入名写错）或版本号没升 | 看公开仓 Release 里有没有 `latest.json`；跑 `npm run audit:ota` |
| 提示有新版本，点了却报"签名不符" | 应用里的公钥与 CI 私钥不是同一对 | `npm run audit:ota` 报出 key id；对不上就重新生成一对、发一版手动装一次 |
| tag 构建在发布那一步 403 | `RELEASE_TOKEN` 过期或权限不对 | 重新生成 fine-grained token（只勾发布物仓库 + Contents: Read and write），更新 secret |
| 更新装完版本没变 | 安装包没升级（`tauri.conf.json` 的 version 没改） | 版本号三处要一起改 |

## 六、已知限制

- **第一次装 0.1.81 得手动**（老版本没有更新能力）；
- 更新时**可能弹一次 UAC**（安装包没有微软 Authenticode 签名 —— 那是另一张证书，要花钱买，
  与 OTA 的 minisign 签名无关；后者只保证"包是我们发的"）；
- Tauri 的更新是**整包替换**，没有增量补丁：每次都要下完整的安装包（几十 MB），
  但全程在后台、你不用管；
- macOS / Linux 上的构建也能走同一套（插件是跨平台的），但本项目只发 Windows 包。
