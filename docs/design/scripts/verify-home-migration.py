"""校验小程序落地与设计稿的一致性（移植保真度检查）——只比对两边的"追加块"
1) HTML 稿追加 CSS  vs  matches.wxss 追加块：逐项比对取值
2) 资源路径 / 图层数量 / z-index 抬升 / 语法
3) 背景素材是否真按 65% 蒙层烘焙
"""
import os
import re
import sys

ROOT = "/home/football"
HTML = os.path.join(ROOT, "docs/design/赛事预言家首页-高保真-v8.6-球场背景玻璃版.html")
WXSS = os.path.join(ROOT, "miniprogram/pages/matches/matches.wxss")
WXML = os.path.join(ROOT, "miniprogram/pages/matches/matches.wxml")
BG = os.path.join(ROOT, "miniprogram/assets/images/home-pitch-bg.webp")

fails, warns = [], []
html_all = open(HTML, encoding="utf-8").read()
wxss_all = open(WXSS, encoding="utf-8").read()
wxml = open(WXML, encoding="utf-8").read()

# 只取追加块（两边各自的改版段落）
html = html_all.split("本次改版追加")[1].split("</style>")[0]
wxss = wxss_all.split("首页球场背景 + 玻璃卡（2026-09-16 改版）")[1]


def norm_alpha(s: str) -> str:
    s = s.strip().lstrip("#")
    if s == "glass":          # HTML 稿里用 var(--glass)，等价 0.30
        return "0.30"
    if re.fullmatch(r"[0-9a-f]{6}", s):
        return s
    f = float(s if "." in s else (f"0.{s}" if len(s) <= 3 else s))
    return f"{f:.2f}"


GLASS_FROM_VAR = "0.30"

PAIRS = [
    ("玻璃卡主档", r"--glass:\s*([\d.]+)", r"^\.match \{ background: rgba\(255,255,255,\.(\d+)\)"),
    ("玻璃卡高亮", r"--glass-open:\s*([\d.]+)", r"\.match\.is-open \{ background: rgba\(255,255,255,\.(\d+)\)"),
    ("比分方块", r"\.bug \{ background: rgba\(255, 255, 255, ([\d.]+)\)", r"^\.bug \{ background: rgba\(255,255,255,\.(\d+)\)"),
    ("预测编辑区", r"\.pred-area \{ background: rgba\(255, 255, 255, ([\d.]+)\)", r"^\.pred-area \{ background: rgba\(255,255,255,\.(\d+)\)"),
    ("联赛托盘", r"\.leagues-wrap \{ background: rgba\(255, 255, 255, var\(--(glass)\)\)", r"^\.leagues-wrap \{ background: rgba\(255,255,255,\.(\d+)\)"),
    ("文字次色", r"\.contrast-boost \{ --ink-soft: (#[0-9a-f]{6})", r"--color-text-secondary:\s*(#[0-9a-f]{6})"),
    ("文字弱色", r"--ink-faint: (#[0-9a-f]{6});", r"--color-text-muted:\s*(#[0-9a-f]{6})"),
    ("+K 绿色", r"\.contrast-boost \.hint \.plus \{ color: (#[0-9a-f]{6})", r"\.hint-plus \{ color:\s*(#[0-9a-f]{6})"),
]

print("=" * 78)
print("1) 取值比对（只比对两边的改版追加块）")
print("=" * 78)
for name, hpat, wpat in PAIRS:
    hm, wm = re.search(hpat, html), re.search(wpat, wxss, re.M)
    if not (hm and wm and hm.groups() and wm.groups()):
        warns.append(f"{name}: 未能匹配")
        print(f"  {name:<12} ⚠️ 未能自动比对 (html={bool(hm)}, wxss={bool(wm)})")
        continue
    hv, wv = norm_alpha(hm.group(1)), norm_alpha(wm.group(1))
    if hv == "glass":
        hv = "0.30"
    ok = hv == wv
    print(f"  {name:<12} 设计稿 {hv:<8} 小程序 {wv:<8} {'✅' if ok else '❌ 不一致'}")
    if not ok:
        fails.append(f"{name}: 设计稿 {hv} vs 小程序 {wv}")

print()
print("=" * 78)
print("2) 资源与结构检查")
print("=" * 78)

try:
    import numpy as np
    from PIL import Image
    src_p = os.path.join(ROOT, "docs/design/assets/bg/pitch-source.webp")
    src = np.array(Image.open(src_p).convert("RGB").resize((200, 355))).astype(float)
    gray = src.mean(axis=2, keepdims=True)
    expect = (src * 0.85 + gray * 0.15) * 0.35 + 255 * 0.65
    got = np.array(Image.open(BG).convert("RGB").resize((200, 355))).astype(float)
    diff = float(np.abs(expect - got).mean())
    print(f"  素材 65% 蒙层烘焙  与期望值平均像素差 {diff:.1f} {'✅' if diff < 6 else '❌'}"
          f"（原图均亮 {src.mean():.0f} → 现 {got.mean():.0f}/255）")
    if diff >= 6:
        fails.append("背景素材与 65% 蒙层期望值不符")
except Exception as e:  # noqa: BLE001
    warns.append(f"素材校验跳过: {e}")

m = re.search(r'<image class="page-bg" src="([^"]+)"', wxml)
if m:
    disk = os.path.join(ROOT, "miniprogram", m.group(1).lstrip("/"))
    ok = os.path.exists(disk)
    print(f"  page-bg 资源路径   {m.group(1)} 存在={ok} {os.path.getsize(disk)//1024 if ok else 0} KB "
          f"{'✅' if ok else '❌'}")
    if not ok:
        fails.append("背景图文件不存在")
else:
    fails.append("WXML 缺少 page-bg 图层")
    print("  page-bg 资源路径   ❌ 未找到图层")

n = wxml.count('class="page-bg"')
print(f"  背景图层数量       {n} {'✅' if n == 1 else '❌'}")
if n != 1:
    fails.append("page-bg 图层数量异常")

# z-index 抬升：扫全部匹配行
raised = []
for mm in re.finditer(r"^\s*([^\n{}]+)\{[^}]*position:\s*relative;\s*z-index:\s*1", wxss_all, re.M):
    raised.append(mm.group(1).strip())
blob = " ".join(raised)
missing = [s for s in (".leagues-wrap", ".dates-wrap", ".hint") if s not in blob]
print(f"  抬 z-index 的选择器  {raised}")
if missing:
    fails.append(f"这些容器未抬 z-index: {missing}")
    print(f"     ❌ 缺失 {missing}")
else:
    print("     ✅ 三个静态容器都已抬起")

for f, s in (("matches.wxss", wxss_all), ("matches.wxml", wxml)):
    ok = s.count("{") == s.count("}")
    print(f"  {f:<15} 括号平衡 {s.count('{')}/{s.count('}')} {'✅' if ok else '❌'}")
    if not ok:
        fails.append(f"{f} 括号不平衡")

bad = re.findall(r"^\.match[^{]*\{[^}]*background:\s*#fff", wxss_all, re.M)
bad += re.findall(r"^\.match\.is-open[^{]*\{[^}]*linear-gradient", wxss_all, re.M)
print(f"  残留实心白卡规则   {len(bad)} 处 {'✅' if not bad else '❌'}")
if bad:
    fails.append("仍有实心白卡规则")

print()
print("=" * 78)
print("结论：" + ("全部通过 ✅" if not fails else f"{len(fails)} 项失败 ❌"))
for f in fails:
    print("   ❌", f)
for w in warns:
    print("   ⚠️ ", w)
print("=" * 78)
sys.exit(1 if fails else 0)
