# 外壳与各页的实际渲染（自检用截图）

这些是**真实渲染**（本机 Chrome 无头截图，非设计稿），用来在没有 Windows 真机的时候核对外壳与页面：顶栏 / 左侧栏 / 内容区比例、提示条、锁定项、以及各页在新壳里是否还正常。设计稿在 `../artboards/`。

| 文件 | 看什么 |
| --- | --- |
| `m0-shell-games.jpg` | M0 默认页：侧栏选中态（accent 竖条 + panel-2 底）、8 项导航 + 2 个锁定锁头、存储卡、提示条按键角标。**游戏库内部当时还是旧网格** —— K1 的横向卡片条是 M1 的活。 |
| `m0-shell-files.jpg` | 文件页所有既有按钮（新建 / 粘贴 / 全选 / 位置 / 显示隐藏 / 软键盘 / 搜索 / 排序）在新壳里都还在。 |
| `m0-shell-toolbox.jpg` | 工具箱的前端卡片与运行库卡片。 |
| `m0-shell-home-scheduled.jpg` | 首页目前是「排期中」占位页（需要最近启动记录 / 存储容量等数据源），文案写清原因，不摆假数据。 |
| `m1-k1-games-1280.png` | **M1 的游戏库（画板 K1），1280×720 —— 就是画布本身的尺寸**（`--dp`=1，量出来的坐标可以和 §3.1 直接对）：hero 换成了聚焦游戏的宽图、聚焦卡 158×190 居中并带右下角 A 角标、聚焦卡名称两行 + 「时长 · 体积」一行、信息面板写五个真字段（来源 / 状态 / 占用空间 / 总时长 / 安装位置）+ 名称、右上角是真按钮（不是画板的网格/列表/筛选/排序）。**2026-10-04 按用户的截图反馈重截过一次**：hero 现在铺到卡片条盒底（画板的 396dp 会让卡片下缘探出大图、亮色宽图留一条硬边），焦点环也不再被滚动容器裁掉。 |
| `m1-k1-games-1920.png` | 同一页 1920×1080（`--dp`=1.5）：整屏等比，用来确认缩放没有跑版、内容区没有横向溢出。同样是 2026-10-04 重截的。 |

M0 那四张是 1920×1080；M1 这两张是 1280×720 + 1920×1080 各一张。重新生成（改完外壳后）：

```sh
npm run dev -- --port 1420 --strictPort &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1920,1080 --virtual-time-budget=6000 \
  --screenshot=/tmp/shell.png 'http://localhost:1420/'
```

注意两点：① 浏览器预览里 `inTauri()` 是 false，走的是 `src/data/preview*.ts` 的假数据（封面来自 Steam CDN），所以卡片数量与真机不同 —— 看的是界面，不是数据；② `--window-size=1920,1080` 在 `--headless=new` 下视口会比 1080 矮（Chrome 自己占了条），要精确控制尺寸就用 DevTools 协议发 `Emulation.setDeviceMetricsOverride`（M1 的量测与截图就是这么做的：连 9222 端口、先覆盖设备度量再 reload）。
