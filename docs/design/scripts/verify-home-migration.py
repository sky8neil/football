"""校验小程序落地与设计稿的一致性（移植保真度检查）——只比对两边的"追加块"
1) HTML 稿追加 CSS  vs  matches.wxss 追加块：逐项比对取值
2) 资源路径 / 图层数量 / z-index 抬升 / 语法 / 背景素材 65% 蒙层烘焙 / 日期条开放范围
3) 本次改版不变式：vs 框保持实色；卡片为模糊（36rpx）、托盘为轻模糊（14rpx）（2026-09-26）
"""
import os
import re
import sys

ROOT = "/home/football"
HTML = os.path.join(ROOT, "docs/design/赛事预言家首页-高保真-v8.6-球场背景玻璃版.html")
WXSS = os.path.join(ROOT, "miniprogram/pages/matches/matches.wxss")
WXML = os.path.join(ROOT, "miniprogram/pages/matches/matches.wxml")
JS = os.path.join(ROOT, "miniprogram/pages/matches/matches.js")
BG = os.path.join(ROOT, "miniprogram/assets/images/home-pitch-bg.webp")

fails, warns = [], []
html_all = open(HTML, encoding="utf-8").read()
wxss_all = open(WXSS, encoding="utf-8").read()
wxml = open(WXML, encoding="utf-8").read()
js = open(JS, encoding="utf-8").read()

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

# 日期条（2026-09-26 决策）：移除日历入口、日期条铺满整行、开放 今天 … 今天+10（共 11 个）。
# 本节防回退：日历入口不许加回来，日期项尺寸不许被压缩，开放天数不许被改回 5。
dates_wrap_rule = re.search(r"\.dates-wrap \{([^}]*)\}", wxss_all)
dates_rule = re.search(r"\.dates \{([^}]*)\}", wxss_all)
date_rule = re.search(r"\.date \{([^}]*)\}", wxss_all)
strip_problems = []
if re.search(r'class="cal\b', wxml) or "cal-icon" in wxml:
    strip_problems.append("WXML 仍有日历入口节点")
if re.search(r"\.cal(\b|[-.])", wxss_all):
    strip_problems.append("WXSS 仍有 .cal 规则残留")
if "onCalendarTap" in js:
    strip_problems.append("matches.js 仍有 onCalendarTap 死代码")
span = re.search(r"DATE_SPAN_DAYS\s*=\s*(\d+)", js)
if not span:
    strip_problems.append("matches.js 缺少 DATE_SPAN_DAYS 常量")
elif span.group(1) != "11":
    strip_problems.append(f"DATE_SPAN_DAYS={span.group(1)}，应为 11（今天 + 10 天）")
if not dates_rule or "width: 100%" not in dates_rule.group(1):
    strip_problems.append(".dates 未铺满整行（应为 width: 100%）")
if not date_rule or "width: 112rpx" not in date_rule.group(1):
    strip_problems.append(".date 尺寸被改动（应保持 112rpx）")
if dates_wrap_rule and "flex" in dates_wrap_rule.group(1):
    strip_problems.append(".dates-wrap 仍是 flex（日历按钮已移除，不再需要）")
print(f"  日期条铺满整行     {'✅ 无日历入口 + 开放 11 天 + 尺寸未压缩' if not strip_problems else '❌ ' + '；'.join(strip_problems)}")
if strip_problems:
    fails.append("日期条: " + "；".join(strip_problems))

# 品牌行（第一行）：2026-09-26 需求 —— 写死的「用户ID」改为登录用户的微信昵称，
# 文案一行连写「昵称，今天看哪场？」，两个标点必须都是中文全角。
FULLWIDTH_COMMA = "\uff0c"     # ，
FULLWIDTH_QUESTION = "\uff1f"  # ？
brand_line = next((line for line in wxml.splitlines() if 'class="brand-name"' in line), None)
brand_problems = []
if not brand_line:
    brand_problems.append("WXML 找不到 .brand-name（品牌行）")
else:
    if "{{nickname}}" not in brand_line:
        brand_problems.append("品牌行昵称不是数据驱动（缺 {{nickname}}）")
    if "用户ID" in brand_line:
        brand_problems.append("品牌行仍写死「用户ID」")
    if FULLWIDTH_COMMA not in brand_line or FULLWIDTH_QUESTION not in brand_line:
        brand_problems.append("品牌行标点不是中文全角（应为 U+FF0C 与 U+FF1F）")
    if re.search(r"[,?]", brand_line):
        brand_problems.append("品牌行混入了半角逗号或问号")
    if "今天看哪场" not in brand_line:
        brand_problems.append("品牌行缺少「今天看哪场」")
    # 结构守卫：品牌行必须是一个行内文本流（view 容器 + 两个不带样式的行内 text 段），
    # 外层用 view 才能稳定承载整行省略。
    if '<view class="brand-name">' not in brand_line:
        brand_problems.append("品牌行外层不是 view（text 做省略容器不稳）")
    if "<text>{{nickname}}</text>" not in brand_line:
        brand_problems.append("品牌行昵称段应为不带样式的行内 <text>{{nickname}}</text>")
    if '<text class="brand-sub">' not in brand_line:
        brand_problems.append('品牌行问候段应为 <text class="brand-sub">')

# 错行根因守卫：品牌行两段必须是纯行内元素。微信的 <text> 是组件而非标准行内元素，
# 一旦设 display:inline-block / 宽度 / vertical-align，同一行会被拆成两个盒子而上下错行
# （2026-09-26 实机踩到过）。
DANGEROUS_PROPS = ("display:", "max-width", "width:", "vertical-align")
for cls in (".brand-nick", ".brand-sub"):
    rule = re.search(re.escape(cls) + r" \{([^}]*)\}", wxss_all)
    if rule and any(prop in rule.group(1) for prop in DANGEROUS_PROPS):
        brand_problems.append(f"{cls} 含 inline-block/宽度/vertical-align，会上下错行")

print(f"  品牌行昵称文案     {'✅ 数据驱动 + 中文全角标点 + 纯行内不错行' if not brand_problems else '❌ ' + '；'.join(brand_problems)}")
if brand_problems:
    fails.append("品牌行: " + "；".join(brand_problems))

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
