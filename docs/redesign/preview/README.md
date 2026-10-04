# M0 外壳的实际渲染（自检用截图）

这四张是 **1920×1080 下的真实渲染**（本机 Chrome 无头截图，`--window-size=1920,1080`，非设计稿），用来在没有 Windows 真机的时候核对外壳：顶栏 / 左侧栏 / 内容区比例、提示条、锁定项、以及各页在新壳里是否还正常。设计稿在 `../artboards/`。

| 文件 | 看什么 |
| --- | --- |
| `m0-shell-games.jpg` | 默认页：侧栏选中态（accent 竖条 + panel-2 底）、8 项导航 + 2 个锁定锁头、存储卡、提示条按键角标。**游戏库内部还是旧网格** —— K1 的横向卡片条是 M1 的活。 |
| `m0-shell-files.jpg` | 文件页所有既有按钮（新建 / 粘贴 / 全选 / 位置 / 显示隐藏 / 软键盘 / 搜索 / 排序）在新壳里都还在。 |
| `m0-shell-toolbox.jpg` | 工具箱的前端卡片与运行库卡片。 |
| `m0-shell-home-scheduled.jpg` | 首页目前是「排期中」占位页（需要最近启动记录 / 存储容量等数据源），文案写清原因，不摆假数据。 |

重新生成（改完外壳后）：

```sh
npm run dev -- --port 1420 --strictPort &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1920,1080 --virtual-time-budget=6000 \
  --screenshot=/tmp/shell.png 'http://localhost:1420/'
```

注意：浏览器预览里 `inTauri()` 是 false，走的是 `src/data/preview*.ts` 的假数据（封面来自 Steam CDN），所以卡片数量与真机不同 —— 看的是外壳，不是数据。
