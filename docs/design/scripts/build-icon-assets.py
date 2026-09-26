#!/usr/bin/env python3
"""生成小程序图标位图资源（矢量源 → PNG）。

为什么要烘成位图：小程序 WXSS 不能引用本地图片路径（只能 base64，会撑体积），
所以按设计稿几何生成 PNG，用 <image mode="aspectFit"> 引用。

矢量源是唯一真相（本脚本会把它写到 docs/design/assets/icons/ 下）：
  icon-ball.svg      首页顶栏 .mark 内的白色足球（2026-09-26 新增，对应设计稿 18×18 内联 SVG）
  icon-calendar.svg  首页日期行的日历入口（该入口已随日期条改造移除 → 暂不生成位图，
                     矢量源保留，将来要恢复重跑一次即可）

光栅化用 cairosvg（依赖系统 libcairo2），也就是真正的 SVG 渲染器。
  ⚠️ 历史做法是用 PIL 手搓描边几何 + 超采样，再缩小时只能退到 BOX 面积平均——
     因为 LANCZOS 有负瓣，会在细描边外缘染出一圈很淡的振铃噪边。既然现在有
     cairosvg，就别再手搓几何了。

用法：
  python3 docs/design/scripts/build-icon-assets.py            # 只生成「启用中」的图标
  python3 docs/design/scripts/build-icon-assets.py --all      # 连暂未使用的也一起生成
  python3 docs/design/scripts/build-icon-assets.py icon-ball  # 只生成指定图标
"""
import math
import io
import os
import sys
from dataclasses import dataclass, field
from typing import Dict, List, Tuple

from PIL import Image

try:
    import cairosvg
except ImportError as _exc:  # noqa: N816  只有真正调用时才报错，免得连 --help 都跑不起来
    cairosvg = None
    _CAIROSVG_ERR = _exc
else:
    _CAIROSVG_ERR = None

ROOT = "/home/football"
OUT_PNG_DIR = os.path.join(ROOT, "miniprogram/assets/icons")
OUT_SVG_DIR = os.path.join(ROOT, "docs/design/assets/icons")

ICON_BALL_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" fill="none">
  <!-- 与 docs/design/赛事预言家首页-高保真-v8.6-球场背景玻璃版.html 的 .mark 内联 SVG 同源 -->
  <circle cx="9" cy="9" r="6.2" stroke="#ffffff" stroke-width="1.5"/>
  <path d="M9 2.8c1.7 1.8 2.6 3.9 2.6 6.2S10.7 13.4 9 15.2C7.3 13.4 6.4 11.3 6.4 9S7.3 4.6 9 2.8z" stroke="#ffffff" stroke-width="1.3"/>
  <path d="M3.2 9h11.6" stroke="#ffffff" stroke-width="1.3"/>
  <circle cx="9" cy="9" r="1.3" fill="#c6f36b"/>
</svg>
"""

ICON_CALENDAR_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
  <!-- 与设计稿 .cal 内联 SVG 同源（#3b4f43 = 落地时的 --color-text-secondary） -->
  <rect x="2" y="3.2" width="12" height="10.6" rx="2" stroke="#3b4f43" stroke-width="1.4"/>
  <path d="M2 6.4h12M5.2 2v2.4M10.8 2v2.4" stroke="#3b4f43" stroke-width="1.4" stroke-linecap="round"/>
</svg>
"""


@dataclass(frozen=True)
class Icon:
    """一个图标资产的规格。

    view   设计稿 viewBox 边长（图标按此尺寸在界面里显示，如 18 表示显示为 18px）
    px     生成的位图边长：6x —— 3x 屏下 18px 显示 = 54 物理 px，108 即 @6x，细描边也够锐
    ink    期望墨迹范围（viewBox 单位，左/上/右/下），用于自检渲染有没有跑偏
    active 是否默认生成位图（False = 只留矢量源）
    """

    name: str
    svg: str
    view: float
    px: int
    ink: Tuple[float, float, float, float]
    active: bool
    note: str = field(default="")


ICONS: Dict[str, Icon] = {
    "icon-ball": Icon(
        name="icon-ball",
        svg=ICON_BALL_SVG,
        view=18.0,
        px=108,
        # 最外沿是圆形描边：r 6.2 + 1.5/2 = 6.95 → 9±6.95 = 2.05…15.95
        ink=(2.05, 2.05, 15.95, 15.95),
        active=True,
        note="首页顶栏 logo（.mark 的绿底方块内的白球）",
    ),
    "icon-calendar": Icon(
        name="icon-calendar",
        svg=ICON_CALENDAR_SVG,
        view=16.0,
        px=96,
        # 圆角矩形外沿 x 1.3→14.7；挂环圆头顶端 y 1.3 → 矩形下外沿 14.5
        ink=(1.3, 1.3, 14.7, 14.5),
        active=False,
        note="首页日期行日历入口（入口已移除，位图暂不生成）",
    ),
}


def expected_bbox(icon: Icon) -> Tuple[int, int, int, int]:
    """viewBox 墨迹范围 → 像素 bbox（left/top 取 floor、right/bottom 取 ceil）。"""
    scale = icon.px / icon.view
    l, t, r, b = icon.ink
    return (math.floor(l * scale), math.floor(t * scale), math.ceil(r * scale), math.ceil(b * scale))


def render(icon: Icon) -> Image.Image:
    if cairosvg is None:
        raise SystemExit(f"缺少依赖 cairosvg：{_CAIROSVG_ERR}\n  pip install cairosvg（需要系统 libcairo2）")
    raw = cairosvg.svg2png(bytestring=icon.svg.encode("utf-8"),
                           output_width=icon.px, output_height=icon.px)
    return Image.open(io.BytesIO(raw)).convert("RGBA")


def export(icons: List[Icon]) -> List[str]:
    os.makedirs(OUT_PNG_DIR, exist_ok=True)
    os.makedirs(OUT_SVG_DIR, exist_ok=True)
    fails: List[str] = []

    for icon in icons:
        png_path = os.path.join(OUT_PNG_DIR, f"{icon.name}.png")
        svg_path = os.path.join(OUT_SVG_DIR, f"{icon.name}.svg")
        img = render(icon)
        img.save(png_path, "PNG", optimize=True)
        with open(svg_path, "w", encoding="utf-8") as fh:
            fh.write(icon.svg)

        want = expected_bbox(icon)
        chan = img.getchannel("A")
        box = chan.getbbox()
        alpha = chan.getextrema()
        solid = sum(1 for v in chan.getdata() if v > 200)

        print("-" * 74)
        print(f"{icon.name}  {icon.note}")
        print(f"  位图   {os.path.relpath(png_path, ROOT)}  {img.size[0]}×{img.size[1]}  "
              f"{os.path.getsize(png_path)} B")
        print(f"  矢量   {os.path.relpath(svg_path, ROOT)}  {os.path.getsize(svg_path)} B")

        if box is None:
            fails.append(f"{icon.name}: 位图为空，没有任何墨迹")
            print("  墨迹   ❌ 空图")
            continue
        ok = all(abs(a - b) <= 2 for a, b in zip(want, box))
        print(f"  墨迹 bbox {tuple(box)}  期望 {want}  {'✅' if ok else '❌'}")
        if not ok:
            fails.append(f"{icon.name}: 墨迹 bbox {tuple(box)} 与期望 {want} 不符")

        a_ok = alpha[0] == 0 and alpha[1] == 255
        print(f"  alpha 范围 {alpha}  {'✅ 透明底 + 实心墨迹（半透明抗锯齿边缘正常）' if a_ok else '❌'}")
        if not a_ok:
            fails.append(f"{icon.name}: alpha 范围异常 {alpha}")

        # 实心部分（alpha>200）不能被抗锯齿糊掉，否则真机上图标会发虚
        fill_ratio = solid / float(icon.px * icon.px)
        print(f"  实心墨迹像素 {solid}  占画布 {fill_ratio:.1%}  "
              f"{'✅' if 0.005 < fill_ratio < 0.8 else '❌ 比例异常'}")
        if not 0.005 < fill_ratio < 0.8:
            fails.append(f"{icon.name}: 实心墨迹占比异常 {fill_ratio:.1%}")

    return fails


def main(argv: List[str]) -> int:
    wanted = [a for a in argv[1:] if not a.startswith("-")]
    if "--all" in argv[1:]:
        picked = list(ICONS.values())
    elif wanted:
        unknown = [w for w in wanted if w not in ICONS]
        if unknown:
            print(f"未知图标：{unknown}（可选：{sorted(ICONS)}）")
            return 2
        picked = [ICONS[w] for w in wanted]
    else:
        picked = [i for i in ICONS.values() if i.active]

    print("=" * 74)
    print("生成小程序图标位图" + (f"：{'、'.join(i.name for i in picked)}" if picked else "（无）"))
    print("=" * 74)
    fails = export(picked)
    print("=" * 74)
    print("结论：" + ("生成成功 ✅" if not fails else f"{len(fails)} 项异常 ❌"))
    for f in fails:
        print("   ❌", f)
    print("=" * 74)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
