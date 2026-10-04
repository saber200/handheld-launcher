# -*- coding: utf-8 -*-
"""audit_spacing.py — 间距审计
拦截一次渲染里所有「有底色的圆角矩形」（= 卡片/面板/按钮/chip）与其内部文字/图标，
检查：① 元素是否越出容器；② 元素距容器边缘是否 ≥ 4dp（贴边即报错）。
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds2 as D
from ds2 import Panel

SURFACES = []      # (x0,y0,x1,y1,radius)
ITEMS = []         # (kind, x0,y0,x1,y1, desc)

_o_rrect, _o_T, _o_icon, _o_ellipse = Panel.rrect, Panel.T, Panel.icon, Panel.ellipse


def rrect(self, b, radius, fill=None, outline=None, width=1, layer=None):
    if fill:
        SURFACES.append((b[0], b[1], b[2], b[3], radius))
    return _o_rrect(self, b, radius, fill, outline, width, layer)


def T(self, x, y, s, size=13, color=None, weight="regular", anchor="la", tracking=0.0,
      max_w=None, fit=False):
    if s:
        w = self.tw(s, size, weight, tracking)
        # 用「实际字形包围盒」而不是「行高」：CJK 字形的 descender 通常是空的，
        # 用行高会多算约 3dp，导致纵向居中的文字被误判为贴边
        f = D.font(size, self.S, weight)
        bb = f.getbbox(s)
        asc, desc = f.getmetrics()
        h = (bb[3] - bb[1]) / self.S if bb and bb[3] > bb[1] else (asc + desc) / self.S
        # 依据 anchor 反推包围盒
        x0 = x - (w if anchor[0] == "r" else w / 2 if anchor[0] == "m" else 0)
        y0 = y - (h * 0.65 if anchor[1] == "m" else h * 0.5 if anchor[1] == "a" else h)
        ITEMS.append(("text", x0, y0, x0 + w, y0 + h, repr(s)[:22]))
    return _o_T(self, x, y, s, size, color, weight, anchor, tracking, max_w, fit)


def icon(self, name, cx, cy, size=18, color=None, w=None):
    ITEMS.append(("icon", cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2, name))
    return _o_icon(self, name, cx, cy, size, color, w)


def ellipse(self, cx, cy, rx, ry=None, fill=None, outline=None, width=1, layer=None):
    if fill and rx >= 3:
        ry = rx if ry is None else ry
        ITEMS.append(("dot", cx - rx, cy - ry, cx + rx, cy + ry, "dot"))
    return _o_ellipse(self, cx, cy, rx, ry, fill, outline, width, layer)


MIN_INSET = 3.0   # 文字包围盒按真实字体度量，3dp 以下才算贴边


def contains(outer, inner):
    return (inner[0] >= outer[0] - 0.6 and inner[1] >= outer[1] - 0.6 and
            inner[2] <= outer[2] + 0.6 and inner[3] <= outer[3] + 0.6)


def check(name):
    overflow, tight = [], []
    for kind, ix0, iy0, ix1, iy1, desc in ITEMS:
        # 找包住这个元素的最小容器
        host = None
        for sfc in SURFACES:
            if contains(sfc, (ix0, iy0, ix1, iy1)):
                if host is None or (sfc[2] - sfc[0]) * (sfc[3] - sfc[1]) < (host[2] - host[0]) * (host[3] - host[1]):
                    host = sfc
        if host is None:
            continue
        if not contains(host, (ix0, iy0, ix1, iy1)):
            overflow.append((desc, kind, host))
            continue
        gaps = [ix0 - host[0], iy0 - host[1], host[2] - ix1, host[3] - iy1]
        m = min(gaps)
        need = MIN_INSET if kind == "text" else 1.0
        # 只看有意义的容器（面积 > 2000dp²）
        if (host[2] - host[0]) * (host[3] - host[1]) > 2000 and m < need:
            tight.append((desc, kind, round(m, 1), tuple(round(v, 1) for v in host[:4])))
    print(f"\n=== {name} ===")
    print(f"容器 {len(SURFACES)} 个 · 内部元素 {len(ITEMS)} 个")
    if overflow:
        print(f"❌ 越出容器 {len(overflow)} 处：")
        for d, k, h in overflow[:10]:
            print(f"   {k} {d}  容器 {tuple(round(v,1) for v in h[:4])}")
    else:
        print("✅ 无元素越出容器")
    if tight:
        print(f"⚠ 贴边（距容器边缘 < {MIN_INSET}dp）{len(tight)} 处：")
        for d, k, m, h in tight[:10]:
            print(f"   {k} {d}  最小间距 {m}dp  容器 {h}")
    else:
        print("✅ 无贴边元素")


def diagnose(name_filter):
    """打印某个元素所有可能的宿主容器，用于人工确认归属"""
    for kind, ix0, iy0, ix1, iy1, desc in ITEMS:
        if name_filter not in desc:
            continue
        print(f"\n元素 {desc} {kind} 盒={tuple(round(v,1) for v in (ix0,iy0,ix1,iy1))}")
        cands = [sfc for sfc in SURFACES
                 if sfc[0]-1 <= ix0 and sfc[1]-1 <= iy0 and sfc[2]+1 >= ix1 and sfc[3]+1 >= iy1]
        for sfc in sorted(cands, key=lambda r: (r[2]-r[0])*(r[3]-r[1])):
            print(f"   宿主 {tuple(round(v,1) for v in sfc[:4])} 宽{round(sfc[2]-sfc[0],1)} 高{round(sfc[3]-sfc[1],1)}")


if __name__ == "__main__":
    Panel.rrect, Panel.T, Panel.icon, Panel.ellipse = rrect, T, icon, ellipse
    import boards2
    for fn in [boards2.board_home, boards2.board_games, boards2.board_apps, boards2.board_downloads,
               boards2.board_files, boards2.board_toolbox, boards2.board_overlay,
               boards2.board_settings, boards2.board_tokens]:
        SURFACES.clear(); ITEMS.clear()
        fn()
        check(fn.__name__)
