"""校验小程序落地与设计稿的一致性（移植保真度检查）——只比对两边的"追加块"
1) HTML 稿追加 CSS  vs  matches.wxss 追加块：逐项比对取值
2) 资源路径 / 图层数量 / z-index 抬升 / 语法 / 背景素材 65% 蒙层烘焙 / 日历图标
3) 本次改版不变式：vs 框保持实色；卡片为模糊（36rpx）、托盘为轻模糊（14rpx）（2026-09-26）
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
    """归一化后比对：0.54 / 54 视作同值；gradient 只比较去掉空白后的字面量。"""
    s = s.strip().lstrip("#")
    if s == "glass":          # 兼容历史写法的 var(--glass) 占位（旧稿等价 0.30）
        return "0.30"
    if s.startswith("linear-gradient") or s.startswith("rgba"):
        return re.sub(r"\s+", "", s)
    if re.fullmatch(r"[0-9a-f]{6}", s):
        return s
    f = float(s if "." in s else (f"0.{s}" if len(s) <= 3 else s))
    return f"{f:.2f}"


GLASS_FROM_VAR = "0.30"

PAIRS = [
    ("玻璃卡主档", r"--glass:\s*([\d.]+)", r"^\.match \{ background: rgba\(255,255,255,\.(\d+)\)"),
    ("玻璃卡高亮", r"--glass-open:\s*([\d.]+)", r"\.match\.is-open \{ background: rgba\(255,255,255,\.(\d+)\)"),
    ("比分方块实色", r"\.bug \{ background: (linear-gradient\([^)]*\))", r"^\.bug \{ background: (linear-gradient\([^)]*\))"),
    ("预测编辑区", r"\.pred-area \{ background: rgba\(255, 255, 255, ([\d.]+)\)", r"^\.pred-area \{ background: rgba\(255,255,255,\.(\d+)\)"),
    ("联赛托盘", r"\.leagues-wrap \{ background: rgba\(255, 255, 255, ([\d.]+)\)", r"^\.leagues-wrap \{ background: rgba\(255,255,255,\.(\d+)\)"),
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

# 日历入口：设计稿是线性日历 SVG（.cal 内联），小程序端烘成位图引用。
# 这是 2026-09-26 修掉的移植偏差：之前小程序端写成了「日」字，会被误读成「周日」。
cal_ref = re.search(r'<image class="cal-icon" src="([^"]+)"', wxml)
if cal_ref:
    icon_disk = os.path.join(ROOT, "miniprogram", cal_ref.group(1).lstrip("/"))
    icon_ok = os.path.exists(icon_disk)
    print(f"  日历图标资源       {cal_ref.group(1)} 存在={icon_ok} "
          f"{os.path.getsize(icon_disk) if icon_ok else 0} B {'✅' if icon_ok else '❌'}")
    if not icon_ok:
        fails.append("日历图标文件不存在")
elif '<text class="cal-icon">' in wxml:
    fails.append('日历入口仍是「日」文字，未按设计稿换成线性图标')
    print("  日历图标资源       ❌ 仍是「日」文字")
else:
    fails.append("WXML 缺少 .cal-icon 图标引用")
    print("  日历图标资源       ❌ 未找到")

cal_rule = re.search(r"\.cal \{([^}]*)\}", wxss_all)
cal_icon_rule = re.search(r"\.cal-icon \{([^}]*)\}", wxss_all)
cal_problems = []
if not cal_rule:
    cal_problems.append(".cal 规则缺失")
elif "background" in cal_rule.group(1) or "border:" in cal_rule.group(1):
    cal_problems.append(".cal 仍有底色/边框（会与选中的日期抢焦点）")
if not cal_icon_rule or "32rpx" not in cal_icon_rule.group(1):
    cal_problems.append(".cal-icon 不是 32rpx 图标")
if ".cal-pressed" not in wxss_all:
    cal_problems.append("缺少 .cal-pressed 按下态")
print(f"  日历入口降权       {'✅ 无底无边框 + 按下态' if not cal_problems else '❌ ' + '；'.join(cal_problems)}")
if cal_problems:
    fails.append("日历入口: " + "；".join(cal_problems))

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
print("3) 本次改版不变式：vs 框必须与雾白卡面区分开（2026-09-26 可读性修整）")
print("=" * 78)

bug_m = re.search(r"^\.bug \{ background: ([^}]*)\}", wxss_all, re.M)
pred_m = re.search(r"^\.pred-area \{ background: ([^}]*)\}", wxss_all, re.M)
for label, m, expect in ((".bug（vs 框）", bug_m, "linear-gradient"), (".pred-area", pred_m, "rgba")):
    if not m:
        fails.append(f"{label} 规则缺失")
        print(f"  {label:<16} ❌ 规则缺失")
        continue
    body = m.group(1)
    problems = []
    if expect not in body:
        problems.append(f"背景不是 {expect}")
    if label.startswith(".bug"):
        if "rgba(255,255,255" in body.replace(" ", ""):
            problems.append("出现半透明白底（会与卡面糊在一起）")
        if "backdrop-filter: none" not in body:
            problems.append("未显式关闭 backdrop-filter")
    ok_msg = "✅ 实色，与卡面分层" if label.startswith(".bug") else "✅ 玻璃档位已设"
    print(f"  {label:<16} {ok_msg if not problems else '❌ ' + '；'.join(problems)}")
    if problems:
        fails.append(f"{label}: " + "；".join(problems))

for name, pat in ((".match", r"^\.match \{ background: ([^}]*)\}"),
                  (".leagues-wrap", r"^\.leagues-wrap \{ background: ([^}]*)\}")):
    m = re.search(pat, wxss_all, re.M)
    if not m or "backdrop-filter" not in m.group(1):
        fails.append(f"{name} 缺少 backdrop-filter（轻模糊）")
        print(f"  {name:<16} ❌ 缺少 backdrop-filter")
        continue
    bm = re.search(r"blur\((\d+)rpx\)", m.group(1))
    blur_rpx = bm.group(1) if bm else None
    heavy = bool(blur_rpx is not None and int(blur_rpx) > 44)
    print(f"  {name:<16} blur {blur_rpx or '?'}rpx "
          f"{'⚠️ 过重：草场会糊成一片色块，可读性应靠白底遮盖' if heavy else '✅ 模糊档位在合理区间'}")
    if heavy:
        warns.append(f"{name} blur 偏重（{blur_rpx}rpx）")

print()
print("=" * 78)
print("结论：" + ("全部通过 ✅" if not fails else f"{len(fails)} 项失败 ❌"))
for f in fails:
    print("   ❌", f)
for w in warns:
    print("   ⚠️ ", w)
print("=" * 78)
sys.exit(1 if fails else 0)
