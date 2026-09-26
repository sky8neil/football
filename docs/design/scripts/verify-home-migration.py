"""首页实现的自洽性与防回退校验。

⚠️ V1 Design System 之后，本脚本的角色变了：
   视觉事实来源是**小程序实现**（tokens + matches.wxss），设计稿 HTML 只作参考比对。
   真正证明「视觉没变」的是 computed 快照回归（extract/diff-home-visuals.py）。
   本脚本负责：取值与参考稿对齐 + 结构与不变式不倒退（便宜、无需浏览器）。

因为 matches.wxss 已全面 token 化，所有取值比对都先把 var() 解析成实际值再比。
覆盖：1) 取值 ↔ 设计稿参考  2) 资源/图层/z-index/语法/蒙层/日期条/logo/打包排除
      3) 不变式（vs 框实色、卡片与托盘模糊档位）  4) 顶栏↔联赛行间距
"""
import json
import os
import re
import sys

ROOT = "/home/football"
HTML = os.path.join(ROOT, "docs/design/赛事预言家首页-高保真-v8.6-球场背景玻璃版.html")
WXSS = os.path.join(ROOT, "miniprogram/pages/matches/matches.wxss")
WXML = os.path.join(ROOT, "miniprogram/pages/matches/matches.wxml")
JS = os.path.join(ROOT, "miniprogram/pages/matches/matches.js")
BG = os.path.join(ROOT, "miniprogram/assets/images/home-pitch-bg.webp")
PROJ = os.path.join(ROOT, "miniprogram/project.config.json")
TOKENS = os.path.join(ROOT, "miniprogram/styles/design-tokens.wxss")
APP_WXSS = os.path.join(ROOT, "miniprogram/app.wxss")

fails, warns = [], []
html_all = open(HTML, encoding="utf-8").read()
wxss_all = open(WXSS, encoding="utf-8").read()
wxml = open(WXML, encoding="utf-8").read()
js = open(JS, encoding="utf-8").read()

# —— token 解析：把 var(--x) 递归展开成实际取值 ——
# 否则「WXSS 只写了 var(--match-card-background)」会被判成失配。
TOKEN_TEXT = open(TOKENS, encoding="utf-8").read()
TOKEN_TEXT += "\n" + open(APP_WXSS, encoding="utf-8").read()
TOKEN_DEFS = dict(re.findall(r"^\s*(--[\w-]+)\s*:\s*([^;]+);",
                             re.sub(r"/\*[\s\S]*?\*/", "", TOKEN_TEXT), re.M))


def resolve_vars(text: str, depth: int = 10) -> str:
    seen = set()
    for _ in range(depth):
        def sub(m):
            name = m.group(1)
            seen.add(name)
            return TOKEN_DEFS.get(name, m.group(0))
        new = re.sub(r"var\((--[\w-]+)(?:\s*,\s*[^)]*)?\)", sub, text)
        if new == text:
            break
        text = new
    return text


def compact_colors(text: str) -> str:
    """把 rgba(255, 255, 255, 0.54) 统一成 rgba(255,255,255,.54)，与设计稿字面量对齐。"""
    def rgba(m):
        a = m.group(4)
        a = a[1:] if a.startswith("0.") else a
        return f"rgba({m.group(1)},{m.group(2)},{m.group(3)},{a})"
    return re.sub(r"rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(0?\.\d+|0|1)\s*\)", rgba, text)


# 设计稿侧仍取「本次改版追加」段（设计稿自 V1 起降级为参考）
html = html_all.split("本次改版追加")[1].split("</style>")[0]
# 小程序侧：全部取值检查都跑在「已解析 token + 颜色紧凑化」的文本上。
# 注意要把 token 定义本身也拼进来 —— 文字色这类语义 token 的定义在 tokens 文件里，
# 页面上只写 var()，只看 WXSS 是找不到 `--text-secondary: #3b4f43` 的。
token_raw = open(TOKENS, encoding="utf-8").read()
SCAN = compact_colors(resolve_vars(TOKEN_TEXT)) + "\n" + compact_colors(resolve_vars(wxss_all))
wxss_all = SCAN
wxss = SCAN


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

# 小程序侧的模式一律写成「选择器 { 任意前置声明 … 目标属性」：
# WXSS 现在由 token 驱动，声明顺序与设计稿不同，不能再假设目标属性紧跟花括号。
PAIRS = [
    ("玻璃卡主档", r"--glass:\s*([\d.]+)", r"^\.match \{[^}]*?background: rgba\(255,255,255,\.(\d+)\)"),
    ("玻璃卡高亮", r"--glass-open:\s*([\d.]+)", r"^\.match\.is-open \{[^}]*?background: rgba\(255,255,255,\.(\d+)\)"),
    ("比分方块实色", r"\.bug \{ background: (linear-gradient\([^)]*\))", r"^\.bug \{[^}]*?background: (linear-gradient\([^)]*\))"),
    ("预测编辑区", r"\.pred-area \{ background: rgba\(255, 255, 255, ([\d.]+)\)", r"^\.pred-area \{[^}]*?background: rgba\(255,255,255,\.(\d+)\)"),
    # 设计稿这条规则现在以 margin-top 开头（2026-09-26 拉开联赛行间距），故用 [^}]*? 跳过前置声明；
    # html 变量本身只含追加块，仍只会匹配到那一条。
    ("联赛托盘", r"\.leagues-wrap \{[^}]*?background: rgba\(255, 255, 255, ([\d.]+)\)", r"^\.leagues-wrap \{[^}]*?background: rgba\(255,255,255,\.(\d+)\)"),
    # 文字色自 V1 起统一收敛到 semantic token（不再有 matches.wxss 的 page 覆盖块），
    # 所以这里读的是「解析 token 之后」的文本。
    ("文字次色", r"\.contrast-boost \{ --ink-soft: (#[0-9a-f]{6})", r"--text-secondary:\s*(#[0-9a-f]{6})"),
    ("文字弱色", r"--ink-faint: (#[0-9a-f]{6});", r"--text-muted:\s*(#[0-9a-f]{6})"),
    ("+K 绿色", r"\.contrast-boost \.hint \.plus \{ color: (#[0-9a-f]{6})", r"^\.hint-plus \{ color:\s*(#[0-9a-f]{6})"),
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

for f, s in (("matches.wxss", wxss_all), ("matches.wxml", wxml), ("design-tokens.wxss", token_raw)):
    ok = s.count("{") == s.count("}")
    print(f"  {f:<15} 括号平衡 {s.count('{')}/{s.count('}')} {'✅' if ok else '❌'}")
    if not ok:
        fails.append(f"{f} 括号不平衡")

bad = re.findall(r"^\.match[^{]*\{[^}]*background:\s*#fff", wxss_all, re.M)
bad += re.findall(r"^\.match\.is-open[^{]*\{[^}]*linear-gradient", wxss_all, re.M)
print(f"  残留实心白卡规则   {len(bad)} 处 {'✅' if not bad else '❌'}")
if bad:
    fails.append("仍有实心白卡规则")

# 顶栏 logo（2026-09-26 修复）：61c3f43 重构顶栏时只删了 .mark / .mark-ring 的样式、
# WXML 节点却留着 → 首页左上角 logo 一直不渲染，而且不报任何错。
# 防回退：.mark 必须有样式，且 .mark 内的球标位图必须真实存在。
mark_rule = re.search(r"\.mark \{([^}]*)\}", wxss_all)
ball_img = re.search(r'<image class="mark-ball" src="([^"]+)"', wxml)
logo_problems = []
if not mark_rule:
    logo_problems.append("WXSS 缺 .mark 规则（logo 会整块不渲染）")
else:
    for prop in ("linear-gradient", "border-radius", "width: 64rpx", "height: 64rpx"):
        if prop not in mark_rule.group(1):
            logo_problems.append(f".mark 缺 {prop}")
if not ball_img:
    logo_problems.append('WXML 的 .mark 内缺 <image class="mark-ball">（球标不渲染）')
else:
    ball_path = os.path.join(ROOT, "miniprogram", ball_img.group(1).lstrip("/"))
    if not os.path.exists(ball_path):
        logo_problems.append(f"球标位图不存在：{ball_img.group(1)}（重跑 build-icon-assets.py）")
    else:
        try:
            from PIL import Image
            with Image.open(ball_path) as im:
                if im.size != (108, 108) or im.mode != "RGBA":
                    logo_problems.append(f"球标位图规格异常 {im.size} {im.mode}（应 108×108 RGBA）")
        except Exception as e:  # noqa: BLE001
            warns.append(f"球标位图规格未校验: {e}")
    print(f"  顶栏球标位图       {ball_img.group(1)}  "
          f"{os.path.getsize(ball_path) if os.path.exists(ball_path) else 0} B "
          f"{'✅' if os.path.exists(ball_path) else '❌'}")
if "mark-ring" in wxml:
    warns.append("WXML 又出现了 .mark-ring（旧实现已被 .mark-ball 位图取代）")
print(f"  顶栏 logo 样式     {'✅ .mark 有样式 + 球标位图存在' if not logo_problems else '❌ ' + '；'.join(logo_problems)}")
if logo_problems:
    fails.append("顶栏 logo: " + "；".join(logo_problems))

# 测试文件不进包（2026-09-26 修复）：packOptions.ignore 之前是空数组，
# miniprogram 下的 *.test.mjs 会被打进小程序包（预览/上传里都能看到源码）。
try:
    proj = json.load(open(PROJ, encoding="utf-8"))
    rules = [(r.get("type"), str(r.get("value", ""))) for r in proj.get("packOptions", {}).get("ignore", [])
             if isinstance(r, dict)]
    tests_on_disk = []
    for dirpath, _dirs, files in os.walk(os.path.join(ROOT, "miniprogram")):
        tests_on_disk += [os.path.relpath(os.path.join(dirpath, f), os.path.join(ROOT, "miniprogram"))
                          for f in files if ".test." in f]
    uncovered = []
    for suffix in (".test.mjs", ".test.ts"):
        hit = any((t == "suffix" and v.lower() == suffix)
                  or (t in ("file", "glob", "prefix") and v.lower().endswith(suffix))
                  or (t == "regexp" and suffix.strip(".") in v)
                  for t, v in rules)
        if not hit:
            uncovered.append(suffix)
    print(f"  测试文件不进包     {len(tests_on_disk)} 个测试文件  ignore 规则 {len(rules)} 条 "
          f"{'✅' if not uncovered else '❌ 未覆盖 ' + '、'.join(uncovered)}")
    if uncovered:
        fails.append(f"packOptions.ignore 未覆盖 {uncovered}，测试文件会被打进包")
except Exception as e:  # noqa: BLE001
    fails.append(f"project.config.json 检查失败: {e}")
    print(f"  测试文件不进包     ❌ {e}")

print()
print("=" * 78)
print("3) 本次改版不变式：vs 框必须与雾白卡面区分开（2026-09-26 可读性修整）")
print("=" * 78)

# 同前：目标属性不再紧跟花括号（规则由 token 驱动），要允许前置声明
bug_m = re.search(r"^\.bug \{[^}]*?background: ([^}]*?)\}", wxss_all, re.M)
pred_m = re.search(r"^\.pred-area \{[^}]*?background: ([^}]*?)\}", wxss_all, re.M)
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

for name, pat in ((".match", r"^\.match \{([^}]*)\}"),
                  (".leagues-wrap", r"^\.leagues-wrap \{([^}]*)\}")):
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
print("4) 顶栏与联赛行的间距（2026-09-26 决策：联赛行起整体下移 8px）")
print("=" * 78)

# 顶栏是绝对定位、联赛行是它之后第一个流式元素 —— 托盘顶 = spacer + margin-top，
# 所以改 .leagues-wrap 的 margin 就等于「联赛行及其下方整体下移」。
spacer_m = re.search(r"\.topbar-spacer \{ height: calc\((\d+)px", wxss_all)
topbar_m = re.search(r"\.topbar \{[^}]*?top: calc\(env\(safe-area-inset-top\) \+ (\d+)px\)[^}]*?height: (\d+)px",
                     wxss_all)
tray_m = re.search(r"\.leagues-wrap \{ margin: (\d+)rpx", wxss_all)
design_tray_m = re.search(r"\.leagues-wrap \{ margin-top: (\d+)px", html)
mark_m = re.search(r"\.mark \{ width: (\d+)rpx", wxss_all)

spacing_problems = []
for label, m in (("topbar-spacer", spacer_m), (".topbar 位置/高度", topbar_m),
                 (".leagues-wrap margin", tray_m), ("设计稿 .leagues-wrap margin-top", design_tray_m),
                 (".mark 尺寸", mark_m)):
    if not m:
        spacing_problems.append(f"未匹配到 {label}")

if spacing_problems:
    print("  ❌ " + "；".join(spacing_problems))
    fails.append("顶栏间距: " + "；".join(spacing_problems))
else:
    assert spacer_m and topbar_m and tray_m and design_tray_m and mark_m   # 类型收窄（上面已判空）
    spacer_px = int(spacer_m.group(1))              # 顶栏占位
    top_off, bar_h = int(topbar_m.group(1)), int(topbar_m.group(2))
    margin_rpx = int(tray_m.group(1))
    design_px = int(design_tray_m.group(1))
    mark_px = int(mark_m.group(1)) / 2.0            # 750rpx = 375px → 2rpx = 1px
    margin_px = margin_rpx / 2.0
    bar_bottom = top_off + bar_h
    mark_bottom = top_off + (bar_h + mark_px) / 2.0  # logo 在顶栏里垂直居中
    tray_top = spacer_px + margin_px
    gap = tray_top - mark_bottom

    print(f"  顶栏底边           {bar_bottom}px（top {top_off} + 高 {bar_h}）")
    print(f"  logo 底边          {mark_bottom:.0f}px（{mark_px:.0f}px 居中于顶栏）")
    print(f"  联赛托盘顶         {tray_top:.0f}px（spacer {spacer_px}px + margin {margin_px:.0f}px）")
    gap_ok = abs(gap - 8) < 0.5
    print(f"  品牌行↔联赛行净空  {gap:.0f}px  期望 8px  {'✅' if gap_ok else '❌'}")
    if not gap_ok:
        fails.append(f"品牌行与联赛行净空 {gap:.0f}px，期望 8px（用户 2026-09-26 要求拉开）")
    if tray_top <= bar_bottom - 4:
        fails.append(f"联赛托盘顶 {tray_top:.0f}px 压到顶栏（底边 {bar_bottom}px）里了")
        print(f"     ❌ 托盘压进顶栏")
    m_ok = abs(design_px - margin_px) < 0.5
    print(f"  设计稿 ↔ 小程序    设计稿 margin-top {design_px}px ／ 小程序 {margin_px:.0f}px  "
          f"{'✅' if m_ok else '❌ 不一致'}")
    if not m_ok:
        fails.append(f"联赛行上间距：设计稿 {design_px}px vs 小程序 {margin_px:.0f}px（2rpx = 1px）")

print()
print("=" * 78)
print("结论：" + ("全部通过 ✅" if not fails else f"{len(fails)} 项失败 ❌"))
for f in fails:
    print("   ❌", f)
for w in warns:
    print("   ⚠️ ", w)
print("=" * 78)
sys.exit(1 if fails else 0)
