# -*- coding: utf-8 -*-
"""verify_geometry.py — 像素级几何验证（不依赖渲染内核的埋点）
做法：把每个"可点面"当作一个矩形，检查它内部文字像素距矩形边缘的实际距离。
     直接读渲染结果，因此能抓到内核埋点漏掉的越界 / 贴边。
"""
import sys, os, glob
import numpy as np
from PIL import Image

# 人工声明的可点面（逻辑坐标，来自各画板布局），用于反查像素
SURFACES = {
    "K1_games.png": [
        ("分组 chip 全部", 268, 174, 355, 202),
        ("侧栏 游戏库行", 16, 174, 220, 214),
        ("聚焦卡", 664, 320, 822, 492),
        ("信息面板", 260, 482, 690, 620),
        ("主按钮 开始游戏", 810, 484, 988, 530),
    ],
    "K2_apps.png": [
        ("卡片 剪辑与分享工具", 758, 500, 911, 676),
        ("卡片 已装软件 Edge", 260, 174, 413, 350),
        ("底部信息条", 260, 592, 1256, 644),
        ("分组 chip 全部", 268, 172, 358, 200),
    ],
    "K4_toolbox.png": [
        ("TDP 主卡", 260, 158, 876, 334),
        ("运行库合集卡", 260, 350, 753, 508),
        ("按钮 重新安装", 296, 284, 424, 308),
    ],
}


def audit(path, boxes, scale=2.0):
    im = Image.open(path).convert("RGB")
    a = np.array(im)
    bg = a.max(axis=2)
    print(f"\n=== {os.path.basename(path)} ===")
    for name, x0, y0, x1, y1 in boxes:
        X0, Y0, X1, Y1 = [int(round(v * scale)) for v in (x0, y0, x1, y1)]
        sub = bg[Y0 + 2:Y1 - 1, X0 + 2:X1 - 1]
        # 找"文字级"亮像素（明显亮于卡片底）
        thr = max(90, int(np.percentile(sub, 99.5)) - 40)
        mask = sub > thr
        ys, xs = np.nonzero(mask)
        if len(xs) == 0:
            print(f"  {name:22s} 未检出文字像素")
            continue
        left = xs.min() / scale
        right = (sub.shape[1] - 1 - xs.max()) / scale
        top = ys.min() / scale
        bot = (sub.shape[0] - 1 - ys.max()) / scale
        m = min(left, right, top, bot)
        flag = "OK " if m >= 3 else "⚠ 贴边"
        print(f"  {name:22s} 内边距 左{left:5.1f} 右{right:5.1f} 上{top:5.1f} 下{bot:5.1f}  → {flag}")


if __name__ == "__main__":
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "artboards2")
    for fn, boxes in SURFACES.items():
        p = os.path.join(base, fn)
        if os.path.exists(p):
            audit(p, boxes)
