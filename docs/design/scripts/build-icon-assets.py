#!/usr/bin/env python3
"""生成小程序线性图标资源（位图）。

几何来源（唯一真相）：
  docs/design/赛事预言家首页-高保真-v8.6-球场背景玻璃版.html 的 .cal 内联 SVG
  viewBox 0 0 16 16，stroke-width 1.4，stroke-linecap round：
    <rect x="2" y="3.2" width="12" height="10.6" rx="2"/>
    <path d="M2 6.4h12M5.2 2v2.4M10.8 2v2.4"/>

为什么要烘成位图：小程序 WXSS 不能引用本地图片路径（只能 base64，会撑体积），
所以按设计稿几何生成 @6x PNG，用 <image mode="aspectFit"> 引用。
本机没有 rsvg-convert，无法用 ImageMagick 光栅化 SVG，故用 PIL 复刻描边几何。

用法：python3 docs/design/scripts/build-icon-assets.py
输出：miniprogram/assets/icons/icon-calendar.png  96×96，透明底
      docs/design/assets/icons/icon-calendar.svg  矢量源（便于后续改色/复用）
"""
import math
import os
import sys
from typing import Optional, Tuple

from PIL import Image, ImageDraw

ROOT = "/home/football"
OUT_PNG = os.path.join(ROOT, "miniprogram/assets/icons/icon-calendar.png")
OUT_SVG = os.path.join(ROOT, "docs/design/assets/icons/icon-calendar.svg")

VIEW = 16.0        # 设计稿 viewBox 边长
ASSET_PX = 96      # 32rpx 图标在 3x 屏 = 48 物理 px，96 即 @6x，细描边也够锐
SS = 6             # 超采样倍数：先画大再做整数倍面积平均（BOX）缩小 = 盒式滤波抗锯齿。
                   # 不要用 LANCZOS：它有负瓣，会在细描边外缘染出一圈很淡的振铃噪边。

# 首页 --color-text-secondary（对比度增强后为 #3b4f43）；设计稿里是 currentColor
INK = (0x3B, 0x4F, 0x43, 255)

# —— 设计稿几何（viewBox 单位；SVG 描边以路径中心线为轴，两侧各半个描边宽度）——
STROKE = 1.4
RECT_X, RECT_Y, RECT_W, RECT_H, RECT_R = 2.0, 3.2, 12.0, 10.6, 2.0
DIVIDER_Y = 6.4
DIVIDER_X = (2.0, 14.0)
RING_XS = (5.2, 10.8)
RING_Y = (2.0, 4.4)

SVG_SOURCE = """<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" style="color:#3b4f43">
  <!-- 与 docs/design/赛事预言家首页-高保真-v8.6-球场背景玻璃版.html 的 .cal 内联 SVG 同源 -->
  <rect x="2" y="3.2" width="12" height="10.6" rx="2" stroke="currentColor" stroke-width="1.4"/>
  <path d="M2 6.4h12M5.2 2v2.4M10.8 2v2.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>
"""


def build_png() -> Image.Image:
    side = ASSET_PX * SS
    s = side / VIEW                      # viewBox 单位 → 画布像素
    ink_w = max(1, round(STROKE * s))
    half = STROKE / 2.0

    img = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 1) 圆角矩形：先填外轮廓（半径 = rx + 半个描边），
    # 2) 再以内轮廓（半径 = rx - 半个描边）挖空，等价于 SVG 的居中描边
    outer = (s * (RECT_X - half), s * (RECT_Y - half),
             s * (RECT_X + RECT_W + half), s * (RECT_Y + RECT_H + half))
    d.rounded_rectangle(outer, radius=s * (RECT_R + half), fill=INK)
    inner = (s * (RECT_X + half), s * (RECT_Y + half),
             s * (RECT_X + RECT_W - half), s * (RECT_Y + RECT_H - half))
    d.rounded_rectangle(inner, radius=s * (RECT_R - half), fill=(0, 0, 0, 0))

    # 3) 分隔线与挂环画在挖空之后（否则会被挖掉）。
    #    设计稿的 path 整体带 stroke-linecap="round"，故三条子路径都是圆头。
    def line(x1: float, y1: float, x2: float, y2: float, round_caps: bool = True) -> None:
        d.line([(s * x1, s * y1), (s * x2, s * y2)], fill=INK, width=ink_w)
        if round_caps:
            for px, py in ((x1, y1), (x2, y2)):
                d.ellipse((s * (px - half), s * (py - half),
                           s * (px + half), s * (py + half)), fill=INK)

    line(DIVIDER_X[0], DIVIDER_Y, DIVIDER_X[1], DIVIDER_Y)
    for x in RING_XS:
        line(x, RING_Y[0], x, RING_Y[1])

    return img.resize((ASSET_PX, ASSET_PX), Image.Resampling.BOX)


def ink_bbox(img: Image.Image) -> Optional[Tuple[int, int, int, int]]:
    return img.getchannel("A").getbbox()


def main() -> int:
    png = build_png()
    for path in (OUT_PNG, OUT_SVG):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    png.save(OUT_PNG, "PNG", optimize=True)
    with open(OUT_SVG, "w", encoding="utf-8") as fh:
        fh.write(SVG_SOURCE)

    box = ink_bbox(png)
    print("=" * 74)
    print("生成线性图标 icon-calendar")
    print("=" * 74)
    print(f"  位图   {os.path.relpath(OUT_PNG, ROOT)}  {png.size[0]}×{png.size[1]}  "
          f"{os.path.getsize(OUT_PNG)} B")
    print(f"  矢量   {os.path.relpath(OUT_SVG, ROOT)}  {os.path.getsize(OUT_SVG)} B")

    fails = []
    # 期望墨迹范围（viewBox 单位）：x 1.3→14.7（圆角矩形外沿），y 1.3→14.5（挂环圆头顶端 → 矩形下外沿）
    # 换算到像素后 left/top 取 floor、right/bottom 取 ceil（getbbox 的 right/bottom 是开区间），
    # 边缘像素受抗锯齿影响会各占 1px，故容差 ±1。
    scale = ASSET_PX / VIEW
    want = (math.floor(1.3 * scale), math.floor(1.3 * scale),
            math.ceil(14.7 * scale), math.ceil(14.5 * scale))
    if box is None:
        fails.append("位图为空：没有任何墨迹")
    else:
        got = tuple(box)
        ok = all(abs(a - b) <= 1 for a, b in zip(want, got))
        print(f"  墨迹 bbox {got}  期望 {want}  {'✅' if ok else '❌'}")
        if not ok:
            fails.append(f"墨迹 bbox {got} 与设计稿几何期望 {want} 不符")
        px = png.getchannel("A").getextrema()
        print(f"  alpha 范围 {px}  {'✅ 半透明边缘正常' if px[0] == 0 and px[1] == 255 else '❌'}")
        if px[0] != 0:
            fails.append("缺少全透明像素（可能底未清空）")

    print("=" * 74)
    print("结论：" + ("生成成功 ✅" if not fails else f"{len(fails)} 项异常 ❌"))
    for f in fails:
        print("   ❌", f)
    print("=" * 74)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
