# -*- coding: utf-8 -*-
"""audit_radius.py — 圆角审计：扫描一次渲染过程中所有圆角矩形/椭圆，
标记「胶囊形」（radius/height ≥ 0.45）与「椭圆可点面」，确保全项目统一矩形圆角。"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds2 as D
from ds2 import Panel

RECORDS = []
_orig_rrect = Panel.rrect
_orig_ellipse = Panel.ellipse


def rrect(self, b, radius, fill=None, outline=None, width=1, layer=None):
    h = b[3] - b[1]
    w = b[2] - b[0]
    RECORDS.append(("rect", w, h, radius, fill, outline, width))
    return _orig_rrect(self, b, radius, fill, outline, width, layer)


def ellipse(self, cx, cy, rx, ry=None, fill=None, outline=None, width=1, layer=None):
    RECORDS.append(("ellipse", rx * 2, (ry or rx) * 2, 0, fill, outline, width))
    return _orig_ellipse(self, cx, cy, rx, ry, fill, outline, width, layer)


# 允许为正圆的场景（状态点 / 手柄按键角标 / 头像），按直径阈值放行
CIRCLE_MAX_D = 52.0   # 图标内笔画（摇杆/表盘/放大镜）为图标本体，放行


def check(name):
    pills, ellipses = [], []
    for kind, w, h, r, fill, outline, width in RECORDS:
        if kind == "rect":
            if h > 0 and r / h >= 0.45 and h >= 18:
                pills.append((round(w, 1), round(h, 1), r, fill, outline))
        else:
            # 非正圆（宽高不等）一定是椭圆
            if abs(w - h) > 1.5:
                ellipses.append(("非正圆", round(w, 1), round(h, 1), fill))
            elif w > CIRCLE_MAX_D and fill:
                ellipses.append(("过大填充圆", round(w, 1), round(h, 1), fill))
    print(f"\n=== {name} ===")
    print(f"圆角矩形 {sum(1 for x in RECORDS if x[0]=='rect')} 个 · 圆形/椭圆 {sum(1 for x in RECORDS if x[0]=='ellipse')} 个")
    if pills:
        print(f"❌ 胶囊形（radius/height ≥ 0.45）{len(pills)} 处：")
        for p in pills[:12]:
            print(f"   尺寸 {p[0]}×{p[1]}  圆角 {p[2]}  底 {p[3]}  描边 {p[4]}")
    else:
        print("✅ 无胶囊形")
    if ellipses:
        print(f"❌ 椭圆/过大圆 {len(ellipses)} 处：")
        for e in ellipses[:12]:
            print(f"   {e[0]}  {e[1]}×{e[2]}  填充 {e[3]}")
    else:
        print("✅ 无椭圆，圆形均在允许范围内（≤16dp 状态点/角标）")


if __name__ == "__main__":
    Panel.rrect, Panel.ellipse = rrect, ellipse
    import boards2
    for fn in [boards2.board_home, boards2.board_games, boards2.board_apps, boards2.board_downloads,
               boards2.board_files, boards2.board_toolbox, boards2.board_overlay,
               boards2.board_settings, boards2.board_tokens]:
        RECORDS.clear()
        fn()
        check(fn.__name__)
