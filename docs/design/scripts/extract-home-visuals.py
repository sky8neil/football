#!/usr/bin/env python3
"""首页「最终生效样式」快照提取器 —— V1 Design System 的取证工具。

为什么要这个工具：
  反向提炼 Design System 时，不能只看 WXSS 里写了什么，也不能只看某个选择器
  有没有引用 token —— CSS cascade 可能被后面的规则覆盖（例如 .match 的
  box-shadow 先引用 token、又被玻璃卡追加块整条覆盖，实际生效的根本不是 token 值）。
  所以本工具走真实浏览器：把 WXML + 全部 WXSS 还原成 DOM，让 Chromium 自己算 cascade，
  再取 getComputedStyle 的最终值。

做法：
  1. node docs/design/scripts/home-view-model.mjs  → 用真实页面代码产出各状态 data
  2. 本脚本把 WXML 渲染成 HTML（浏览器里执行 docs/design/scripts/wxml-render.js）
  3. Chromium（375×812，rpx 按 750rpx=375px 折算成 px）逐个场景采集计算样式
  4. 写出快照 JSON；改 token / 接线后用 diff-home-visuals.py 比对，证明「视觉 100% 不变」

用法：
  node docs/design/scripts/home-view-model.mjs --out /tmp/hv
  python3 docs/design/scripts/extract-home-visuals.py --views /tmp/hv --out before.json

依赖：playwright（python）+ 系统 chromium。非标准环境需 playwright install chromium，
或把 CHROMIUM_PATH 指向可执行文件。
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = "/home/football"
MP = os.path.join(ROOT, "miniprogram")
SCRIPTS = os.path.join(ROOT, "docs/design/scripts")
TOKENS = os.path.join(MP, "styles/design-tokens.wxss")
APP_WXSS = os.path.join(MP, "app.wxss")
PAGE_WXSS = os.path.join(MP, "pages/matches/matches.wxss")
PAGE_WXML = os.path.join(MP, "pages/matches/matches.wxml")
APP_JSON = os.path.join(MP, "app.json")
RENDERER_JS = os.path.join(SCRIPTS, "wxml-render.js")

VIEWPORT = {"width": 375, "height": 812}   # 750rpx = 375px → 1rpx = 0.5px
CHROMIUM = os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium")

# 采样属性：覆盖用户要求的全部维度（背景/玻璃/透明/blur/边框/阴影/色/字号/字重/行高/
# 间距/圆角/尺寸/动效/交互态）
PROPS = [
    "display", "position", "zIndex", "top", "right", "bottom", "left",
    "width", "height", "minHeight", "maxHeight", "minWidth",
    "margin", "padding", "gap", "rowGap", "columnGap", "boxSizing",
    "backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition",
    "borderTopWidth", "borderTopStyle", "borderTopColor", "borderRightWidth",
    "borderLeftWidth", "borderBottomWidth", "borderTopLeftRadius", "borderTopRightRadius",
    "borderBottomLeftRadius", "borderBottomRightRadius",
    "backdropFilter", "boxShadow", "opacity", "filter",
    "color", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight",
    "letterSpacing", "textAlign", "textOverflow", "whiteSpace", "textDecorationLine",
    "overflow", "overflowX", "overflowY",
    "flexDirection", "flexWrap", "alignItems", "justifyContent", "alignSelf",
    "flexGrow", "flexShrink", "flexBasis", "order", "verticalAlign",
    "transform", "transitionProperty", "transitionDuration", "transitionTimingFunction",
    "animationName", "animationDuration", "animationTimingFunction", "animationFillMode",
    "pointerEvents", "visibility", "cursor",
]

# 探针：label → (选择器, 伪元素)。选择器按当前 WXML/WXSS 真实结构写。
PROBES = {
    # 页面与背景
    "page": ("body", None),
    "page.page": (".page", None),
    "page-bg": (".page-bg", None),
    "decor-arc": (".decor-arc", None),
    # 顶栏 / 品牌行
    "topbar-spacer": (".topbar-spacer", None),
    "topbar": (".topbar", None),
    "brand": (".brand", None),
    "mark": (".mark", None),
    "mark-ball": (".mark-ball", None),
    "brand-copy": (".brand-copy", None),
    "brand-name": (".brand-name", None),
    "brand-name.text": (".brand-name > span:first-child", None),
    "brand-sub": (".brand-sub", None),
    # 联赛托盘
    "leagues-wrap": (".leagues-wrap", None),
    "leagues": (".leagues", None),
    "league": (".league", None),
    "league.active": (".league.active", None),
    "league-logo": (".league-logo", None),
    "league.active.after": (".league.active > span", "::after"),
    # 日期条
    "dates-wrap": (".dates-wrap", None),
    "dates": (".dates", None),
    "date": (".date:not(.active)", None),   # dates[0] 即选中态，非选中态必须 :not(.active)
    "date.active": (".date.active", None),
    "date-label": (".date-label", None),
    "date-num": (".date-num", None),
    "date-num.active": (".date.active .date-num", None),
    "date-num.inactive": (".date:not(.active) .date-num", None),
    # 提示条
    "hint": (".hint", None),
    "hint-num": (".hint-num", None),
    "hint-plus": (".hint-plus", None),
    # 结果区骨架
    "results": (".results", None),
    "results.enter": (".results.results-enter", None),
    "results.exit": (".results.results-exit", None),
    "feed": (".feed", None),
    # 比赛卡（各状态）
    "match": (".match", None),
    "match.before": (".match", "::before"),
    "match.is-open": (".match.is-open", None),
    "match.is-open.before": (".match.is-open", "::before"),
    "match.is-submitted": (".match.is-submitted", None),
    "match.is-live": (".match.is-live", None),
    "match.is-live.before": (".match.is-live", "::before"),
    "match.is-done": (".match.is-done", None),
    "match.is-done.before": (".match.is-done", "::before"),
    "match.is-closed": (".match.is-closed", None),
    "match.ui-submitted_locked": (".match.submitted_locked", None),
    "match-top": (".match-top", None),
    "kick": (".kick", None),
    "kick-time": (".kick-time", None),
    "kick-meta": (".kick-meta", None),
    "state": (".state", None),
    "state.live": (".state.live", None),
    "state.done": (".state.done", None),
    "state.closed": (".state.closed", None),
    "state.lock": (".state.lock", None),
    "faceoff": (".faceoff", None),
    "team": (".team", None),
    "team.away": (".team.away", None),
    "crest": (".crest", None),
    "team-copy": (".team-copy", None),
    "team-name": (".team-name", None),
    "team-role": (".team-role", None),
    "bug": (".bug", None),
    "bug.dark": (".bug.dark", None),
    "bug-score": (".bug-score", None),
    "bug-sub": (".bug-sub", None),
    "foot": (".foot", None),
    "pred": (".pred", None),
    "cta": (".cta", None),
    "chip": (".chip", None),
    "chip.hit3": (".chip.hit3", None),
    "chip.hit12": (".chip.hit12", None),
    "chip.miss": (".chip.miss", None),
    "chip.lock": (".chip.lock", None),
    # 预测展开区
    "pred-wrap": (".pred-wrap", None),
    "pred-area": (".pred-area", None),
    "pred-body": (".pred-body", None),
    "pred-editor": (".pred-editor", None),
    "stepper-group": (".stepper-group", None),
    "stepper-team": (".stepper-team", None),
    "stepper-team.text": (".stepper-team span", None),   # WXML <text> → HTML <span>
    "stepper-team.img": (".stepper-team img", None),     # WXML <image> → HTML <img>
    "stepper": (".stepper", None),
    "stepper.button": (".stepper button", None),
    "stepper.value": (".stepper span", None),
    "stepper-sep": (".stepper-sep", None),
    "derived": (".derived", None),
    "derived.text": (".derived span", None),
    "pred-hint": (".pred-hint", None),
    "pred-actions": (".pred-actions", None),
    "submit-btn": (".submit-btn", None),
    "submit-note": (".submit-note", None),
    "submit-err": (".submit-err", None),
    "pred-success": (".pred-success", None),
    # 更多 / 状态页
    "more": (".more", None),
    "loading": (".loading", None),
    "empty": (".empty", None),
    "error": (".error", None),
    "retry": (".retry", None),
}

MEASURE_JS = """
(spec) => {
  const out = {};
  for (const [label, [selector, pseudo]] of Object.entries(spec.probes)) {
    let nodes;
    try { nodes = document.querySelectorAll(selector); } catch (e) { out[label] = { error: String(e) }; continue; }
    if (!nodes.length) { out[label] = { count: 0 }; continue; }
    const el = nodes[0];
    const cs = getComputedStyle(el, pseudo || undefined);
    const props = {};
    for (const p of spec.props) props[p] = cs[p];
    const r = el.getBoundingClientRect();
    out[label] = {
      count: nodes.length,
      rect: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
      props: props,
    };
  }
  return out;
}
"""


def extract_keyframes(css):
    """按花括号配对提取 @keyframes（正则 \\{[^}]*\\} 会被内层 from/to 的 } 提前截断）。"""
    out = {}
    for m in re.finditer(r"@keyframes\s+([\w-]+)\s*\{", css):
        name = m.group(1)
        i, depth, start = m.end(), 1, m.end()
        while i < len(css) and depth:
            if css[i] == "{":
                depth += 1
            elif css[i] == "}":
                depth -= 1
            i += 1
        out[name] = re.sub(r"\s+", " ", css[start:i - 1]).strip()
    return out


def sha1(path):
    with open(path, "rb") as fh:
        return hashlib.sha1(fh.read()).hexdigest()[:12]


def rpx_to_px(css):
    return re.sub(r"(-?\d+(?:\.\d+)?)rpx", lambda m: f"{float(m.group(1)) / 2:g}px", css)


def build_css():
    """把 @import 链展开成单份 CSS，并做小程序 → 浏览器的等价转换。"""
    tokens = open(TOKENS, encoding="utf-8").read()
    app = open(APP_WXSS, encoding="utf-8").read()
    page = open(PAGE_WXSS, encoding="utf-8").read()
    # 去掉 @import（tokens 已单独内联一次，避免重复）
    app_body = re.sub(r'@import\s+"[^"]+";', "", app)
    page_body = re.sub(r'@import\s+"[^"]+";', "", page)

    css = "\n".join([tokens, app_body, page_body])
    css = rpx_to_px(css)
    # env(safe-area-inset-*)：浏览器里没有该环境变量，按小程序在无刘海设备上的 0 处理
    css = re.sub(r"env\(\s*safe-area-inset-(?:top|bottom)\s*,\s*[^)]*\)", "0px", css)
    css = re.sub(r"env\(\s*safe-area-inset-(?:top|bottom)\s*\)", "0px", css)
    # page 选择器 → body（小程序 page 即根节点）
    css = re.sub(r"(?<![.\w-])page(?=\s*[,{])", "body", css)
    return css


def ua_reset():
    """把浏览器 UA 默认样式中和到「微信组件的等价起点」。

    小程序里 <view>/<text> 无 UA 样式，<button> 有自己的默认外观但仓库 WXSS 已显式覆盖
    背景/内距/行高。这里只清掉会凭空多出视觉的 UA 部分（按钮边框/内距/字体、img 边框、
    body 外边距），不引入任何仓库 WXSS 之外的取值。
    """
    return """
html, body { margin: 0; padding: 0; }
body { -webkit-font-smoothing: antialiased; }
button { border: 0; margin: 0; padding: 0; background: none; font: inherit; color: inherit; text-align: center; }
img { border: 0; }
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--views", default="/tmp/hv", help="home-view-model.mjs 的输出目录")
    ap.add_argument("--out", required=True, help="快照 JSON 输出路径")
    args = ap.parse_args()

    vm_path = os.path.join(args.views, "view-model.json")
    if not os.path.exists(vm_path):
        print(f"缺少 view model：{vm_path}\n先跑：node docs/design/scripts/home-view-model.mjs --out {args.views}")
        return 2

    vm = json.load(open(vm_path, encoding="utf-8"))
    wxml = open(PAGE_WXML, encoding="utf-8").read()
    css = build_css()
    renderer = open(RENDERER_JS, encoding="utf-8").read()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("缺少 playwright：pip install playwright")
        return 2

    snapshot = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "anchor": vm["anchor"],
            "viewport": VIEWPORT,
            "scale": "1rpx = 0.5px（750rpx = 375px）",
            "sources": {
                "miniprogram/pages/matches/matches.wxml": sha1(PAGE_WXML),
                "miniprogram/pages/matches/matches.wxss": sha1(PAGE_WXSS),
                "miniprogram/styles/design-tokens.wxss": sha1(TOKENS),
                "miniprogram/app.wxss": sha1(APP_WXSS),
                "miniprogram/app.json": sha1(APP_JSON),
            },
            "app_json_tabbar": json.load(open(APP_JSON, encoding="utf-8")).get("tabBar", {}),
            "keyframes": extract_keyframes(css),
        },
        "scenarios": {},
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROMIUM, args=["--force-color-profile=srgb"])
        page = browser.new_page(viewport=VIEWPORT, device_scale_factor=1)  # type: ignore[arg-type]
        for name, data in vm["data"].items():
            page.set_content("<!DOCTYPE html><html><head><meta charset='utf-8'><style>"
                             + ua_reset() + "\n" + css + "</style></head><body></body></html>")
            page.add_script_tag(content=renderer)
            page.evaluate("([wxml, data]) => { document.body.innerHTML = window.__renderWxml(wxml, data); }",
                          [wxml, data])
            measured = page.evaluate(MEASURE_JS, {"probes": PROBES, "props": PROPS})
            snapshot["scenarios"][name] = measured
            present = sum(1 for v in measured.values() if v.get("count"))
            print(f"  场景 {name:<20} 命中探针 {present}/{len(PROBES)}")
        browser.close()

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(snapshot, fh, ensure_ascii=False, indent=1, sort_keys=True)
    print(f"\n快照已写入 {args.out}（{os.path.getsize(args.out) // 1024} KB）")
    print(f"CSS 指纹 {hashlib.sha1(css.encode()).hexdigest()[:12]}｜场景 {len(snapshot['scenarios'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
