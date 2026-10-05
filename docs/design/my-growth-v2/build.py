from base64 import b64encode
from pathlib import Path
import re


OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]


def load_tokens():
    tokens = (ROOT / "miniprogram/styles/design-tokens.wxss").read_text(encoding="utf-8")
    tokens = re.sub(r"\bpage\s*\{", ":root {", tokens, count=1)
    tokens = re.sub(
        r"([0-9]+(?:\.[0-9]+)?)rpx",
        lambda match: f"{float(match.group(1)) / 2:g}px",
        tokens,
    )
    tokens = re.sub(
        r'--font-family-number:\s*"Outfit",\s*-apple-system,\s*BlinkMacSystemFont,\s*"SF Pro Text",\s*sans-serif;',
        "--font-family-number: var(--font-family-cn);",
        tokens,
    )
    return tokens


CSS = r"""
* { box-sizing: border-box; }
html { min-height: 100%; background: var(--surface-canvas); }
body {
  margin: 0;
  color: var(--text-primary);
  background: var(--surface-page);
  font-family: var(--font-family-cn);
  font-size: var(--font-24);
  line-height: 1.5;
}
button { border: 0; color: inherit; font: inherit; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--color-brand-primary-pressed); outline-offset: 2px; }
.preview {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) 375px minmax(220px, 1fr);
  gap: var(--space-8);
  align-items: start;
  max-width: 1120px;
  min-height: 100vh;
  margin: 0 auto;
  padding: var(--space-8) var(--space-6);
}
.design-note {
  grid-column: 1;
  position: sticky;
  top: var(--space-8);
  padding: var(--space-6);
  border: 1px solid var(--border-glass-strong);
  border-radius: var(--radius-card);
  background: var(--surface-card);
  box-shadow: var(--shadow-card);
  backdrop-filter: blur(var(--blur-card));
}
.design-note .eyebrow { color: var(--color-brand-primary-pressed); font-size: var(--font-18); font-weight: var(--weight-bold); letter-spacing: .08em; }
.design-note h2 { margin: var(--space-4) 0; font-size: var(--font-32); line-height: 1.2; }
.design-note p { margin: var(--space-3) 0; color: var(--text-secondary); font-size: var(--font-22); }
.design-note .note-rule { height: 1px; margin: var(--space-6) 0; background: var(--border-glass-strong); }
.phone {
  grid-column: 2;
  position: relative;
  isolation: isolate;
  width: 375px;
  min-height: 100vh;
  margin: 0 auto;
  overflow: hidden;
  color: var(--text-primary);
}
.backdrop {
  position: fixed;
  z-index: -1;
  top: 0;
  left: calc(50% - 187.5px);
  width: 375px;
  height: 100vh;
  height: 100dvh;
  object-fit: cover;
  pointer-events: none;
}
.statusbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  height: var(--topbar-offset);
  padding: 0 var(--space-8) var(--space-1);
  color: var(--text-primary);
  font-size: var(--font-18);
  font-weight: var(--weight-bold);
}
.status-icons { display: flex; align-items: center; gap: var(--space-2); height: 12px; }
.status-icons svg { display: block; width: 14px; height: 12px; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--topbar-height);
  padding: 0 var(--space-8);
}
.topbar h1 { margin: 0; font-size: var(--font-30); font-weight: var(--weight-bold); }
.icon-button {
  display: grid;
  width: var(--mark-size);
  height: var(--mark-size);
  place-items: center;
  border-radius: var(--radius-pill);
  background: var(--surface-tray);
  color: var(--text-primary);
}
.icon-button svg { width: 18px; height: 18px; fill: currentColor; }
.content { position: relative; z-index: 1; padding: var(--space-4) var(--space-8) 104px; }
.card {
  border: 1px solid var(--border-glass-strong);
  border-radius: var(--radius-card);
  background: var(--surface-card);
  box-shadow: var(--shadow-card);
}
.identity-card, .info-card, .ranking-list, .share-card { backdrop-filter: blur(var(--blur-card)); }
.identity-card { padding: var(--space-6); }
.profile-line { display: flex; align-items: center; gap: var(--space-4); }
.avatar {
  display: grid;
  flex: 0 0 var(--mark-size);
  width: var(--mark-size);
  height: var(--mark-size);
  place-items: center;
  border: 1px solid var(--border-glass-strong);
  border-radius: var(--radius-md);
  background: var(--surface-solid);
  color: var(--green-800);
  font-size: var(--font-26);
  font-weight: var(--weight-heavy);
}
.profile-meta { display: grid; flex: 1; gap: var(--space-1); min-width: 0; }
.profile-meta strong { overflow: hidden; font-size: var(--font-26); text-overflow: ellipsis; white-space: nowrap; }
.profile-meta small { color: var(--text-secondary); font-size: var(--font-20); }
.eyebrow { color: var(--text-muted); font-size: var(--font-18); font-weight: var(--weight-semibold); }
.level-hero { display: flex; align-items: center; gap: var(--space-5); margin-top: var(--space-6); }
.level-mark {
  display: flex;
  flex: 0 0 64px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: var(--radius-xl);
  background: var(--mark-gradient);
  box-shadow: var(--shadow-mark);
  color: var(--text-on-brand);
}
.level-mark span { font-size: var(--font-18); font-weight: var(--weight-bold); }
.level-mark strong { font-family: var(--font-family-number); font-size: var(--font-26); line-height: 1.1; }
.level-copy { min-width: 0; }
.level-copy h2 { margin: var(--space-1) 0; font-size: var(--font-32); line-height: 1.2; }
.level-copy p { margin: 0; color: var(--text-secondary); font-size: var(--font-20); }
.season-tile {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-6);
  padding: var(--space-4);
  border: 1px solid var(--border-glass);
  border-radius: var(--radius-lg);
  background: var(--surface-tray);
  backdrop-filter: blur(var(--blur-tray));
}
.season-copy { display: grid; gap: var(--space-1); min-width: 0; }
.season-copy strong { font-size: var(--font-22); }
.season-copy small { color: var(--text-secondary); font-size: var(--font-18); }
.season-lv { flex: 0 0 auto; color: var(--color-brand-primary-pressed); font-family: var(--font-family-number); font-size: var(--font-26); font-weight: var(--weight-bold); }
.section-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  margin: var(--space-8) 0 var(--space-4);
}
.section-title h2 { margin: 0; font-size: var(--font-26); font-weight: var(--weight-bold); }
.section-title small { color: var(--text-secondary); font-size: var(--font-18); }
.stats-grid { display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: var(--space-3); }
.stat-card { min-width: 0; padding: var(--space-4); }
.stat-card:first-child { background: var(--surface-card-strong); }
.stat-value { display: block; font-family: var(--font-family-number); font-size: var(--font-36); font-weight: var(--weight-heavy); line-height: 1.1; }
.stat-label { display: block; margin-top: var(--space-2); color: var(--text-secondary); font-size: var(--font-18); }
.stat-hint { display: block; margin-top: var(--space-1); color: var(--text-muted); font-size: var(--font-18); }
.info-card { display: flex; align-items: flex-start; gap: var(--space-4); padding: var(--space-5); }
.info-mark {
  display: grid;
  flex: 0 0 var(--mark-size);
  width: var(--mark-size);
  height: var(--mark-size);
  place-items: center;
  border-radius: var(--radius-md);
  background: var(--color-brand-soft);
  color: var(--color-brand-primary-pressed);
  font-size: var(--font-22);
  font-weight: var(--weight-bold);
}
.info-copy { flex: 1; min-width: 0; }
.info-copy strong { display: block; font-size: var(--font-22); }
.info-copy p { margin: var(--space-1) 0 0; color: var(--text-secondary); font-size: var(--font-20); }
.info-copy small { display: block; margin-top: var(--space-2); color: var(--text-muted); font-size: var(--font-18); }
.scope-switch { display: flex; gap: var(--space-2); padding: var(--space-1); border: 1px solid var(--border-glass); border-radius: var(--radius-pill); background: var(--surface-tray); }
.scope-switch button { min-height: 28px; padding: 0 var(--space-4); border-radius: var(--radius-pill); background: transparent; color: var(--text-secondary); font-size: var(--font-20); }
.scope-switch button.selected { background: var(--surface-date-active); color: var(--color-brand-primary-pressed); box-shadow: var(--shadow-sm); font-weight: var(--weight-bold); }
.ranking-list { overflow: hidden; padding: 0 var(--space-5); }
.rank-row { display: flex; align-items: center; gap: var(--space-4); min-height: 62px; border-bottom: 1px solid var(--border-glass); }
.rank-row:last-child { border-bottom: 0; }
.rank-type {
  display: grid;
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: var(--radius-md);
  background: var(--color-brand-soft);
  color: var(--color-brand-primary-pressed);
  font-size: var(--font-20);
  font-weight: var(--weight-bold);
}
.rank-name { display: grid; flex: 1; gap: var(--space-1); min-width: 0; }
.rank-name strong { font-size: var(--font-22); }
.rank-name small { color: var(--text-muted); font-size: var(--font-18); }
.rank-result { display: grid; justify-items: end; gap: var(--space-1); text-align: right; }
.rank-result strong { color: var(--green-800); font-family: var(--font-family-number); font-size: var(--font-24); line-height: 1.2; }
.rank-result small { color: var(--text-muted); font-size: var(--font-18); }
.rank-footer { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-top: var(--space-4); color: var(--text-muted); font-size: var(--font-18); }
.rank-footer button, .text-button { padding: 0; background: transparent; color: var(--color-brand-primary-pressed); font-size: var(--font-20); font-weight: var(--weight-bold); }
.compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
.compare-card { padding: var(--space-5); }
.compare-card .scope-label { color: var(--text-muted); font-size: var(--font-18); }
.compare-card h3 { margin: var(--space-2) 0; font-size: var(--font-24); }
.compare-card .compare-level { color: var(--color-brand-primary-pressed); font-size: var(--font-22); font-weight: var(--weight-bold); }
.compare-card p { margin: var(--space-2) 0 0; color: var(--text-secondary); font-size: var(--font-18); }
.gate-copy { color: var(--text-secondary); font-size: var(--font-20); font-weight: var(--weight-semibold); }
.share-card { padding: var(--space-6); }
.share-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
.share-head h3 { margin: var(--space-1) 0 0; font-size: var(--font-26); }
.share-meta { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: var(--space-5) 0; }
.share-meta span { padding: var(--space-1) var(--space-3); border-radius: var(--radius-pill); background: var(--surface-tray); color: var(--text-secondary); font-size: var(--font-18); }
.share-values { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); padding: var(--space-4) 0; border-top: 1px solid var(--border-glass); border-bottom: 1px solid var(--border-glass); }
.share-value strong { display: block; font-family: var(--font-family-number); font-size: var(--font-30); line-height: 1.15; }
.share-value small { display: block; margin-top: var(--space-1); color: var(--text-muted); font-size: var(--font-18); }
.share-level { display: flex; justify-content: space-between; gap: var(--space-3); margin: var(--space-4) 0; color: var(--text-secondary); font-size: var(--font-20); }
.primary-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: var(--cta-height);
  border-radius: var(--radius-md);
  background: var(--cta-background);
  box-shadow: var(--shadow-floating);
  color: var(--text-on-brand);
  font-size: var(--font-22);
  font-weight: var(--weight-bold);
}
.nav {
  position: fixed;
  z-index: 5;
  bottom: 0;
  left: calc(50% - 187.5px);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  width: 375px;
  min-height: 60px;
  padding: var(--space-2) var(--space-8) calc(var(--space-2) + env(safe-area-inset-bottom));
  border-top: 1px solid var(--border-glass-strong);
  background: var(--surface-tray);
  backdrop-filter: blur(var(--blur-tray));
}
.nav button { display: grid; justify-items: center; gap: var(--space-1); background: transparent; color: var(--text-secondary); font-size: var(--font-18); }
.nav button svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.nav button.selected { color: var(--color-brand-primary-pressed); font-weight: var(--weight-bold); }
.toast {
  position: fixed;
  z-index: 10;
  right: var(--space-5);
  bottom: calc(68px + env(safe-area-inset-bottom));
  left: var(--space-5);
  max-width: 343px;
  margin: 0 auto;
  padding: var(--space-3) var(--space-5);
  border: 1px solid var(--border-glass-strong);
  border-radius: var(--radius-pill);
  background: var(--surface-card-strong);
  box-shadow: var(--shadow-card);
  color: var(--text-primary);
  font-size: var(--font-20);
  text-align: center;
  backdrop-filter: blur(var(--blur-card));
}
.toast[hidden] { display: none; }
.num { font-family: var(--font-family-number); font-variant-numeric: tabular-nums; }
@media (max-width: 720px) {
  .preview { display: block; min-height: 0; padding: 0; }
  .design-note { display: none; }
  .phone { width: min(375px, 100vw); }
  .backdrop { left: 0; width: min(375px, 100vw); }
  .nav { left: 0; width: min(375px, 100vw); }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
}
"""


BASE = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light">
  <title>__TITLE__ · 我的成长</title>
  <style>
__TOKENS__
__CSS__
  </style>
</head>
<body>
  <div class="preview">
    <aside class="design-note">
      <div class="eyebrow">赛事预言家 ／ MY GROWTH V2</div>
      <h2>__TITLE__</h2>
      <p>__DESCRIPTION__</p>
      <div class="note-rule"></div>
      <p>375px 移动画布，球场原图与 V1 玻璃卡内嵌。</p>
      <p>全部内容为自洽模拟数据。交互仅作静态稿提示，不连接业务接口。</p>
      <p>概念底栏不代表已冻结的正式导航。</p>
    </aside>
    <div class="phone">
      <img class="backdrop" src="data:image/webp;base64,__PITCH__" alt="" aria-hidden="true">
      <div class="statusbar" aria-label="系统状态栏示意">
        <span class="num">9:41</span>
        <div class="status-icons" aria-hidden="true">
          <svg viewBox="0 0 16 12" fill="currentColor"><path d="M1 8h2v4H1zm4-3h2v7H5zm4-3h2v10H9zm4-1h2v11h-2z"/></svg>
          <svg viewBox="0 0 16 12" fill="currentColor"><path d="M1 3.5C5-.2 11-.2 15 3.5l-1.7 1.8c-3-2.7-7.6-2.7-10.6 0L1 3.5Zm3 3C6.2 4.6 9.8 4.6 12 6.5l-4 4-4-4Z"/></svg>
          <svg viewBox="0 0 18 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x=".7" y="1" width="15" height="10" rx="2"/><path fill="currentColor" stroke="none" d="M17 4h1v4h-1z"/><path fill="currentColor" stroke="none" d="M3 3h10v6H3z"/></svg>
        </div>
      </div>
      <header class="topbar">
        <h1>我的成长</h1>
        <button class="icon-button" type="button" aria-label="更多选项" data-toast="静态设计稿，仅展示视觉与信息层级。">
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/></svg>
        </button>
      </header>
      <main class="content">
__BODY__
      </main>
      <nav class="nav" aria-label="主导航概念示意">
        <button type="button" data-toast="静态设计稿，仅展示视觉与信息层级。"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M12 4v16M3 9h4v6H3m18-6h-4v6h4"/><circle cx="12" cy="12" r="3"/></svg>比赛</button>
        <button type="button" data-toast="静态设计稿，仅展示视觉与信息层级。"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10h5v10m0 0V4h6v16m0 0V13h5v7M2 20h20"/></svg>排行榜</button>
        <button class="selected" type="button" aria-current="page"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="3.5"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/></svg>我的</button>
      </nav>
    </div>
  </div>
  <div class="toast" role="status" aria-live="polite" hidden></div>
  <script>
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const toast = document.querySelector(".toast");
    toast.textContent = button.dataset.toast || "静态设计稿，仅展示视觉与信息层级。";
    toast.hidden = false;
    window.clearTimeout(window.__myGrowthToastTimer);
    window.__myGrowthToastTimer = window.setTimeout(() => { toast.hidden = true; }, 2200);
  });
  </script>
</body>
</html>
"""


TEMPLATES = {
    "v2-a.html": {
        "title": "A · 生涯徽章",
        "description": "延续已选徽章稿的视觉记忆，以生涯等级为首屏主锚点，赛季、评估、榜单依序展开。",
        "body": """
        <section class="card identity-card">
          <div class="profile-line">
            <div class="avatar" aria-hidden="true">徐</div>
            <div class="profile-meta"><strong>徐sir</strong><small>主队：阿森纳</small></div>
            <span class="eyebrow">个人主页</span>
          </div>
          <div class="level-hero">
            <div class="level-mark"><span>生涯</span><strong>Lv.3</strong></div>
            <div class="level-copy">
              <div class="eyebrow">生涯主等级 · level_v3.0</div>
              <h2>崭露头角</h2>
              <p>生涯最高：Lv.4 坐稳主力</p>
            </div>
          </div>
          <div class="season-tile">
            <div class="season-copy">
              <span class="eyebrow">当前等级赛季 · 2026_2027</span>
              <strong>潜力新星</strong>
              <small>58 场有效预测 · 赛季未冻结</small>
            </div>
            <span class="season-lv">Lv.2</span>
          </div>
          <div class="rank-footer"><span>等级赛季每年 7 月 1 日切换</span><span>与联赛赛季分开</span></div>
        </section>

        <div class="section-title"><h2>生涯数据</h2><small>当前有效预测</small></div>
        <section class="stats-grid" aria-label="生涯成长数据">
          <div class="card stat-card"><strong class="stat-value num">300</strong><span class="stat-label">生涯积分</span><span class="stat-hint">按有效预测累计</span></div>
          <div class="card stat-card"><strong class="stat-value num">132</strong><span class="stat-label">有效预测</span></div>
          <div class="card stat-card"><strong class="stat-value num">2</strong><span class="stat-label">精确命中</span></div>
        </section>

        <div class="section-title"><h2>评估节奏</h2><small>北京时间</small></div>
        <section class="card info-card">
          <div class="info-mark" aria-hidden="true">周</div>
          <div class="info-copy">
            <strong>每周一 10:00 评估等级</strong>
            <p>赛果修正结算后，本周结论可能改判。</p>
            <small>当前等级赛季：2026_2027 · 未冻结</small>
          </div>
        </section>

        <div class="section-title"><h2>排行榜</h2><small>最多展示前 20 名</small></div>
        <section class="card ranking-list" aria-label="我的榜单摘要">
          <div class="scope-switch" role="group" aria-label="排行榜范围">
            <button class="selected" type="button" data-toast="当前展示全站范围的模拟名次。">全站</button>
            <button type="button" data-toast="切换至我的群后，名次按群成员单独计算。">我的群</button>
          </div>
          <div class="rank-row"><span class="rank-type">周</span><div class="rank-name"><strong>本周榜</strong><small>本周预测分 · 有效预测至少 1 场</small></div><div class="rank-result"><strong>#08</strong><small>我的名次</small></div></div>
          <div class="rank-row"><span class="rank-type">生</span><div class="rank-name"><strong>生涯榜</strong><small>生涯积分 · 有效预测至少 1 场</small></div><div class="rank-result"><strong>前 13%</strong><small>我的位置</small></div></div>
          <div class="rank-row"><span class="rank-type">实</span><div class="rank-name"><strong>实力榜</strong><small>预言指数 1.91 · 窗口 96 场</small></div><div class="rank-result"><strong>#18</strong><small>我的名次</small></div></div>
          <div class="rank-footer"><span>每页 10 人 · 全站／群内分别排名</span><button type="button" data-toast="静态设计稿，榜单列表暂未接入。">查看榜单</button></div>
        </section>
        """,
    },
    "v2-b.html": {
        "title": "B · 场次仪表盘",
        "description": "先给出积分和双范围数据；用确定的有效场次门槛解释未评级与实力榜资格，不展示分差进度。",
        "body": """
        <section class="card identity-card">
          <div class="profile-line">
            <div class="avatar" aria-hidden="true">柠</div>
            <div class="profile-meta"><strong>青柠</strong><small>主队尚未设置</small></div>
            <span class="eyebrow">成长概览</span>
          </div>
          <div class="section-title"><h2>生涯积分</h2><small>当前有效预测总分</small></div>
          <strong class="stat-value num">12</strong>
          <div class="rank-footer"><span>12 场有效预测</span><span>1 次精确命中</span></div>
        </section>

        <div class="section-title"><h2>等级状态</h2><small>level_v3.0 · 六级体系</small></div>
        <section class="compare-grid" aria-label="生涯与本赛季等级">
          <article class="card compare-card">
            <span class="scope-label">生涯等级</span>
            <h3>Lv.1 青训新人</h3>
            <span class="compare-level">尚未评级</span>
            <p>12 场有效预测</p>
            <p class="gate-copy">还差 8 场有效预测获得评级</p>
          </article>
          <article class="card compare-card">
            <span class="scope-label">等级赛季 2026_2027</span>
            <h3>Lv.1 青训新人</h3>
            <span class="compare-level">尚未评级</span>
            <p>12 场有效预测 · 未冻结</p>
            <p class="gate-copy">还差 8 场有效预测获得评级</p>
          </article>
        </section>

        <div class="section-title"><h2>评估说明</h2><small>北京时间</small></div>
        <section class="card info-card">
          <div class="info-mark" aria-hidden="true">一</div>
          <div class="info-copy">
            <strong>每周一 10:00 周评估</strong>
            <p>等级赛季按每年 7 月 1 日切换，不随联赛赛季变化。</p>
            <small>赛果修正结算后，可能改判本周结论。</small>
          </div>
        </section>

        <div class="section-title"><h2>我的榜单</h2><small>每页 10 人 · 最多 20 名</small></div>
        <section class="card ranking-list" aria-label="本周榜、生涯榜、实力榜入口">
          <div class="scope-switch" role="group" aria-label="排行榜范围">
            <button class="selected" type="button" data-toast="当前展示全站范围的模拟名次。">全站</button>
            <button type="button" data-toast="群榜按群成员筛选，并在群内独立计算名次。">我的群</button>
          </div>
          <div class="rank-row"><span class="rank-type">周</span><div class="rank-name"><strong>本周榜</strong><small>12 分 · 本周 1 场有效预测</small></div><div class="rank-result"><strong>#16</strong><small>我的名次</small></div></div>
          <div class="rank-row"><span class="rank-type">生</span><div class="rank-name"><strong>生涯榜</strong><small>生涯积分 · 至少 1 场有效预测</small></div><div class="rank-result"><strong>前 92%</strong><small>我的位置</small></div></div>
          <div class="rank-row"><span class="rank-type">实</span><div class="rank-name"><strong>实力榜</strong><small>评估窗口 12 场 · 尚未入榜</small></div><div class="rank-result"><strong>还差 38 场</strong><small>有效预测入榜</small></div></div>
          <div class="rank-footer"><span>我的群：徐sir的预言群</span><button type="button" data-toast="群榜入口为静态示意，具体群管理布局待确认。">切换群范围</button></div>
        </section>
        """,
    },
    "v2-c.html": {
        "title": "C · 赛季分享",
        "description": "把当前等级赛季与指定联赛轮次分享数据放在前面；个人成长与三榜入口保持轻量。",
        "body": """
        <section class="card identity-card">
          <div class="profile-line">
            <div class="avatar" aria-hidden="true">徐</div>
            <div class="profile-meta"><strong>徐sir</strong><small>主队：阿森纳</small></div>
            <span class="eyebrow">我的主页</span>
          </div>
          <div class="level-hero">
            <div class="level-mark"><span>本季</span><strong>Lv.2</strong></div>
            <div class="level-copy">
              <div class="eyebrow">等级赛季 · 2026_2027</div>
              <h2>潜力新星</h2>
              <p>生涯主等级：Lv.3 崭露头角</p>
            </div>
          </div>
          <div class="rank-footer"><span>生涯最高 Lv.4 坐稳主力</span><span>赛季未冻结</span></div>
        </section>

        <div class="section-title"><h2>分享本轮表现</h2><small>英超 · 指定轮次</small></div>
        <section class="card share-card" aria-label="分享卡数据示意">
          <div class="share-head">
            <div><span class="eyebrow">本轮数据 · 仅有效正式结算</span><h3>2026_2027 赛季</h3></div>
            <span class="season-lv">Lv.2</span>
          </div>
          <div class="share-meta"><span>英超</span><span>第 05 轮</span><span>等级赛季 2026_2027</span></div>
          <div class="share-values">
            <div class="share-value"><strong class="num">10</strong><small>有效预测</small></div>
            <div class="share-value"><strong class="num">2</strong><small>精确命中</small></div>
            <div class="share-value"><strong class="num">33</strong><small>本轮积分</small></div>
          </div>
          <div class="share-level"><span>生涯积分</span><strong class="num">300</strong></div>
          <button class="primary-button" type="button" data-league-id="premier_league" data-season-id="2026_2027" data-round-id="05" data-toast="分享数据请求需明确联赛、赛季与轮次；当前仅为静态示意。">生成分享卡</button>
        </section>

        <div class="section-title"><h2>成长概览</h2><small>当前有效数据</small></div>
        <section class="stats-grid" aria-label="生涯成长数据">
          <div class="card stat-card"><strong class="stat-value num">300</strong><span class="stat-label">生涯积分</span></div>
          <div class="card stat-card"><strong class="stat-value num">132</strong><span class="stat-label">有效预测</span></div>
          <div class="card stat-card"><strong class="stat-value num">2</strong><span class="stat-label">精确命中</span></div>
        </section>

        <div class="section-title"><h2>等级评估</h2><small>北京时间每周一</small></div>
        <section class="card info-card">
          <div class="info-mark" aria-hidden="true">10</div>
          <div class="info-copy">
            <strong>10:00 周评估</strong>
            <p>赛果修正结算后，本周结论可能改判。</p>
            <small>等级赛季每年 7 月 1 日切换；赛季结束后按规范冻结。</small>
          </div>
        </section>

        <div class="section-title"><h2>三榜与我的群</h2><small>全站／群内独立排名</small></div>
        <section class="card ranking-list" aria-label="排行榜入口">
          <div class="scope-switch" role="group" aria-label="排行榜范围">
            <button class="selected" type="button" data-toast="当前展示全站范围的模拟名次。">全站</button>
            <button type="button" data-toast="群榜按群成员筛选；加入或退出会影响群榜范围。">我的群</button>
          </div>
          <div class="rank-row"><span class="rank-type">周</span><div class="rank-name"><strong>本周榜</strong><small>按本周预测分排序</small></div><div class="rank-result"><strong>#08</strong><small>前 20 名显示名次</small></div></div>
          <div class="rank-row"><span class="rank-type">生</span><div class="rank-name"><strong>生涯榜</strong><small>按生涯积分排序</small></div><div class="rank-result"><strong>前 13%</strong><small>超出前 20 名</small></div></div>
          <div class="rank-row"><span class="rank-type">实</span><div class="rank-name"><strong>实力榜</strong><small>预言指数 1.91 · 窗口 96 场</small></div><div class="rank-result"><strong>#18</strong><small>我的名次</small></div></div>
          <div class="rank-footer"><span>最多 20 名 · 每页 10 人</span><button type="button" data-toast="静态设计稿，榜单列表暂未接入。">进入排行榜</button></div>
        </section>
        """,
    },
}


def main():
    pitch = b64encode((ROOT / "miniprogram/assets/images/home-pitch-bg.webp").read_bytes()).decode("ascii")
    token_css = load_tokens()
    css = CSS.strip()
    for filename, template in TEMPLATES.items():
        html = BASE.replace("__TITLE__", template["title"])
        html = html.replace("__DESCRIPTION__", template["description"])
        html = html.replace("__TOKENS__", token_css)
        html = html.replace("__CSS__", css)
        html = html.replace("__PITCH__", pitch)
        html = html.replace("__BODY__", template["body"].strip())
        (OUT / filename).write_text(html, encoding="utf-8")
        print(f"Wrote {filename} ({len(html.encode('utf-8'))} bytes)")


if __name__ == "__main__":
    main()
