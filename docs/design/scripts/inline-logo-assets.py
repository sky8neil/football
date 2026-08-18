#!/usr/bin/env python3
"""
将 Logo Asset Registry 内联进首页 HTML（单文件自包含）。

背景：首页原本依赖 assets/logos/manifest.js + logo-registry.js 两个外部脚本，
用户只下载 HTML 单文件本地打开时脚本加载失败 → 渲染中断 → 看不到卡片。
本脚本把 manifest 数据 + registry 逻辑（含 alias 表）直接内联进 <script>，
并让占位图使用内联 SVG data URI（不依赖任何外部文件）。

用法：
  python3 docs/design/scripts/inline-logo-assets.py
  # 重新生成 assets 后重跑本脚本即可同步内联数据

图片路径仍指向 assets/logos/...（有 assets 显示真实队徽）；
无 assets 时 onerror 回退到内联 SVG 占位，不破图、卡片正常渲染。
"""
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent  # docs/design
HTML = ROOT / "赛事预言家首页-高保真-v8.6-联赛无底.html"
MANIFEST = ROOT / "assets" / "logos" / "manifest.json"
REGISTRY = ROOT / "assets" / "logos" / "logo-registry.js"

# 内联 SVG 占位图（灰色圆角底 + 足球线条，约 128x128 视觉）
SVG_PLACEHOLDER = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">'
    '<rect x="8" y="8" width="112" height="112" rx="28" fill="#e9f0ea"/>'
    '<circle cx="64" cy="64" r="40" fill="none" stroke="#5b7166" stroke-width="6"/>'
    '<circle cx="64" cy="64" r="14" fill="none" stroke="#5b7166" stroke-width="4"/>'
    '<path d="M64 50v28M50 64h28M51.5 51.5l25 25M76.5 51.5l-25 25" '
    'stroke="#5b7166" stroke-width="4" stroke-linecap="round"/>'
    "</svg>"
)
PLACEHOLDER_DATA_URI = "data:image/svg+xml," + quote(SVG_PLACEHOLDER, safe="")


def extract_aliases(registry_js: str) -> str:
    """从 logo-registry.js 提取 TEAM_ALIASES 对象字面量（保持单一事实来源）。"""
    m = re.search(r"const TEAM_ALIASES = (\{.*?\n  \});", registry_js, re.S)
    if not m:
        raise RuntimeError("logo-registry.js 中找不到 TEAM_ALIASES")
    return m.group(1)


def build_inline_script() -> str:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    registry_js = REGISTRY.read_text(encoding="utf-8")
    aliases = extract_aliases(registry_js)

    return f"""<script>
/* ---- Logo Asset Registry（内联自包含，勿手改；重新生成：python3 docs/design/scripts/inline-logo-assets.py） ---- */
(function () {{
  const LOGO_MANIFEST = {json.dumps(manifest, ensure_ascii=False, indent=2)};
  const PLACEHOLDER = "{PLACEHOLDER_DATA_URI}";

  const TEAM_ALIASES = {aliases};

  const ALIAS_INDEX = {{}};
  for (const [key, aliasList] of Object.entries(TEAM_ALIASES)) {{
    ALIAS_INDEX[key.toLowerCase()] = key;
    for (const a of aliasList) ALIAS_INDEX[a.toLowerCase()] = key;
  }}

  function resolveTeamKey(teamId) {{
    if (!teamId) return null;
    const v = String(teamId).trim();
    if (!v) return null;
    return ALIAS_INDEX[v.toLowerCase()] || v.toLowerCase();
  }}

  function getTeamLogo(leagueId, teamId) {{
    const league = LOGO_MANIFEST.team_logos[leagueId];
    if (!league) return PLACEHOLDER;
    const key = resolveTeamKey(teamId);
    if (!key) return PLACEHOLDER;
    return league[key] || PLACEHOLDER;
  }}

  function getLeagueLogo(leagueId) {{
    return LOGO_MANIFEST.league_logos[leagueId] || null;
  }}

  window.FootballLogoRegistry = {{
    getTeamLogo, getLeagueLogo, resolveTeamKey,
    PLACEHOLDER, MANIFEST: LOGO_MANIFEST,
    getAllTeams: () => LOGO_MANIFEST.team_logos,
  }};
}})();
</script>"""


def inline_into_html() -> int:
    html = HTML.read_text(encoding="utf-8")
    script = build_inline_script()

    # 去掉外部 script 引入（manifest.js / logo-registry.js）
    new_html = re.sub(
        r'\s*<script src="assets/logos/(?:manifest|logo-registry)\.js"></script>',
        "",
        html,
    )
    # 在第一个 <script>（页面业务脚本）前插入内联块
    anchor = "\n  <script>\n    const MATCHES"
    if anchor not in new_html:
        raise RuntimeError("找不到业务脚本锚点")
    new_html = new_html.replace(anchor, "\n" + script + anchor, 1)

    HTML.write_text(new_html, encoding="utf-8")
    return new_html.count('window.FootballLogoRegistry')


if __name__ == "__main__":
    try:
        n = inline_into_html()
    except Exception as e:  # noqa: BLE001
        print(f"❌ 内联失败: {e}")
        sys.exit(1)
    print(f"✅ 已内联 Logo Registry 到首页（registry 出现 {n} 处，含定义与使用）")
