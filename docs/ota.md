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

## 四点五、国内镜像（Gitee，2026-10-13 起）

用户原话：「github 上不翻墙下载实在是太费劲了」。所以发布物**同时**推两份：

| | 地址 | 谁写 |
| --- | --- | --- |
| 国内优先 | `https://gitee.com/saber200/fantasyhub-releases/raw/master/latest.json` | CI 的「Publish to Gitee」这一步 |
| 兜底 | `https://github.com/saber200/fantasyhub-releases/releases/latest/download/latest.json` | CI 的 tauri-action 那一步 |

- 应用里的 `plugins.updater.endpoints` 是**数组，按顺序试** —— 国内源抽风会自动落到 GitHub ✓。
- **换源不影响安全**：更新包必须通过私钥签名校验才装得上，镜像站换了文件也没用 ✓。
- Gitee 那一步是 **`continue-on-error`**：它挂了不影响 GitHub 那份发布 ✓；没配 `GITEE_TOKEN`
  时它会打一条 warning 然后跳过 ✓。
- Gitee 的限额（官方帮助中心）：**单附件 ≤ 100M**、**每仓库附件总量 ≤ 1G**。安装包约 72M ✓，
  但总量会攒 —— **发版多了要删旧发行版**（应用只读最新那份 `latest.json`，旧版留着没用）。
- 令牌：Gitee → 设置 → 私人令牌 → 新建（权限只要 `projects`）→ 存到私有仓的
  Actions secret **`GITEE_TOKEN`**。过期/换令牌只改这个 secret，代码不用动。
- ⚠️ 两个**未在本机验证过**的假设（第一次发版后会知道）：Gitee 发行版附件的下载地址形如
  `https://gitee.com/<owner>/<repo>/releases/download/<tag>/<file>`；默认分支是 `master`。
  哪个不对，改 CI 里那两处字符串即可 —— 而**即使两个都不对，更新也只是回落到 GitHub**（不会坏）。
  2026-10-13 起两个假设都已被真实下载验证过（地址形状对、`master` 对）。

### 四点六、Gitee 附件名带内容指纹（2026-10-15，掌机报 `The signature verification failed` 之后）

事故经过：重推 tag → GitHub 重新构建、附件被换掉 → 镜像那一步的口径是「**同名附件已存在就跳过
上传**」→ Gitee 上留着的还是上一次构建的包，而指针里的签名已经换成新的 → **包和签名分属两次
构建**，掌机下完包在最后一步拒装。两份文件同名、只差 376 字节，从外面完全看不出来；当时 CI 全绿，
因为它只确认了「传上去了、下载地址返回 MZ 头」。

现在两条硬规矩（改 CI 时别把它们拆掉）：

1. **附件名里写进 sha256 前 12 位**（`FantasyHub_<版本>_<指纹>_x64-setup.exe`）：同名 = 同一份
   字节（重跑作业就跳过、不用再传 72 MB），换了字节就自动换新名字，**永远不会被同名旧附件顶替**。
   指针的 `url` 就指这个名字。老式不带指纹的旧附件不再被引用，脚本会 warning 提醒去 Gitee 页面上删。
2. **发布后真下一个包、用应用里的公钥验签名**：`node scripts/verify-update.mjs <包> <latest.json>`
   （零依赖，用 Node 内置 crypto 复刻 `minisign_verify` 的口径：blake2b-512 预哈希 + ed25519，
   含全局签名与 key id 比对）。CI 里验两次：先从 GitHub 下载的那份、再**从 Gitee 公开地址整份下回来**
   的那份（比 sha256 + 验签名）。这一步才是「掌机真的会装吗」的判据 —— 只看 MZ 头是不够的。

本机也能随时验（不用装应用、不用编译）：

```bash
node scripts/verify-update.mjs /path/FantasyHub_0.1.109_x64-setup.exe /path/latest.json
```

## 五、排错对照表

| 现象 | 多半是 | 怎么办 |
| --- | --- | --- |
| 抽屉里一直「检查更新失败：…」 | 网络到不了 GitHub / 公开仓还没有 Release | 先按第四节手工 curl 一次；404 = 还没有发布物 |
| 一直显示「已是最新」但明明发了新版 | `latest.json` 没产出（CI 输入名写错）或版本号没升 | 看公开仓 Release 里有没有 `latest.json`；跑 `npm run audit:ota` |
| 提示有新版本，点了却报"签名不符" | 应用里的公钥与 CI 私钥不是同一对 | `npm run audit:ota` 报出 key id；对不上就重新生成一对、发一版手动装一次 |
| 掌机报 `The signature verification failed`（换源/镜像之后才出现） | **镜像站上的包与指针里的签名不是同一次构建**（重推 tag、同名旧附件顶替 —— 0.1.109 的真因） | 一条命令定死：`node scripts/verify-update.mjs <下载到的包> <latest.json>`；修法是重跑镜像作业（附件名现在带指纹，不会再撞名） |
| tag 构建在发布那一步 403 | `RELEASE_TOKEN` 过期或权限不对 | 重新生成 fine-grained token（只勾发布物仓库 + Contents: Read and write），更新 secret |
| 更新装完版本没变 | 安装包没升级（`tauri.conf.json` 的 version 没改） | 版本号三处要一起改 |

## 六、已知限制

- **第一次装 0.1.81 得手动**（老版本没有更新能力）；
- 更新时**可能弹一次 UAC**（安装包没有微软 Authenticode 签名 —— 那是另一张证书，要花钱买，
  与 OTA 的 minisign 签名无关；后者只保证"包是我们发的"）；
- Tauri 的更新是**整包替换**，没有增量补丁：每次都要下完整的安装包（几十 MB），
  但全程在后台、你不用管；
- macOS / Linux 上的构建也能走同一套（插件是跨平台的），但本项目只发 Windows 包。
