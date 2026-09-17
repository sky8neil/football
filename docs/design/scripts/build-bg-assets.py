#!/usr/bin/env python3
"""生成首页球场背景素材（改版：白蒙层 + 降饱和 + 轻模糊）

为什么这么做：
  - 背景图要压在文字和玻璃卡下面，必须足够淡（否则文字对比度不合格）；
    把"白蒙层 + 降饱和"直接烘进素材，比运行时再叠一层更省（少一层渲染、体积更小）。
  - 轻微高斯模糊对视觉几乎无影响（外面还有一层白），但能砍掉草地纹理的高频噪声，
    WebP 体积能省掉约 4/5。

用法：
    python3 docs/design/scripts/build-bg-assets.py
输入：
    docs/design/assets/bg/pitch-source.webp    （原始素材，941×1672）
输出：
    docs/design/assets/bg/pitch-preview.webp      （HTML 稿用：不烘蒙层，运行时叠 --bg-veil）
    docs/design/assets/bg/pitch-washed-65-2x.webp （小程序用：941×1672）
    docs/design/assets/bg/pitch-washed-65-1x.webp （小程序用：780×1386，推荐）
目标落地路径：
    miniprogram/assets/images/home-pitch-bg.webp  = pitch-washed-65-1x.webp

参数：蒙层 65% / 降饱和 15% / 模糊 1.0~1.6px
"""
import os
import shutil
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
BG_DIR = os.path.join(ROOT, "docs", "design", "assets", "bg")
SRC = os.path.join(BG_DIR, "pitch-source.webp")

VEIL = 0.65      # 白蒙层不透明度
DESAT = 0.15     # 降饱和比例


def lighten(img: Image.Image) -> Image.Image:
    arr = np.array(img.convert("RGB")).astype(float)
    gray = arr.mean(axis=2, keepdims=True)
    arr = arr * (1 - DESAT) + gray * DESAT
    arr = arr * (1 - VEIL) + 255 * VEIL
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8))


def main() -> None:
    if not os.path.exists(SRC):
        raise SystemExit(f"缺少源图：{SRC}")
    src = Image.open(SRC).convert("RGB")
    print(f"源图 {src.size[0]}×{src.size[1]}  {os.path.getsize(SRC) / 1024:.0f} KB")

    # 1) HTML 设计稿用：保持原饱和度，蒙层在 CSS 里叠（方便调 --bg-veil）
    preview = src.filter(ImageFilter.GaussianBlur(1.6))
    preview.save(os.path.join(BG_DIR, "pitch-preview.webp"), "WEBP", quality=72, method=6)

    # 2) 小程序用：蒙层烘进素材 + 轻模糊
    washed = lighten(src).filter(ImageFilter.GaussianBlur(1.0))
    big = os.path.join(BG_DIR, "pitch-washed-65-2x.webp")
    washed.save(big, "WEBP", quality=70, method=6)
    small_path = os.path.join(BG_DIR, "pitch-washed-65-1x.webp")
    washed.resize((780, round(780 * washed.height / washed.width)), Image.LANCZOS).save(
        small_path, "WEBP", quality=70, method=6)

    for f in ("pitch-preview.webp", "pitch-washed-65-2x.webp", "pitch-washed-65-1x.webp"):
        p = os.path.join(BG_DIR, f)
        print(f"  {f:<28}{os.path.getsize(p) / 1024:6.0f} KB")

    # 3) 同步到小程序资源目录
    target_dir = os.path.join(ROOT, "miniprogram", "assets", "images")
    os.makedirs(target_dir, exist_ok=True)
    target = os.path.join(target_dir, "home-pitch-bg.webp")
    shutil.copy(small_path, target)
    print(f"\n已同步 → {os.path.relpath(target, ROOT)}  {os.path.getsize(target) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
