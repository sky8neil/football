/* v0.41-cc 首页比赛卡次入口：进行中 / 完场的卡片出现「大家怎么选 ›」，进入比赛详情页。
   未截止的卡片不出现（截止前不展示分布）。样式只作用于这个新增的链接。 */
(function () {
  const feed = document.getElementById('feed');
  if (!feed) return;
  const style = document.createElement('style');
  style.textContent = '.crowd-link{font-size:11px;font-weight:650;color:#2f8a3a;text-decoration:none;margin-right:8px;white-space:nowrap;flex:none}';
  document.head.appendChild(style);
  function enhance() {
    feed.querySelectorAll('.match').forEach((card) => {
      if (card.querySelector('.crowd-link')) return;
      let target = null;
      if (card.classList.contains('is-live')) target = 'D04';
      else if (card.classList.contains('is-done')) target = card.classList.contains('is-miss') ? 'D07' : 'D05';
      const top = card.querySelector('.match-top');
      const state = top && top.querySelector('.state');
      if (!target || !state) return;
      const a = document.createElement('a');
      a.className = 'crowd-link';
      a.href = 'match-detail-states.html?state=' + target;
      a.textContent = '大家怎么选 ›';
      top.insertBefore(a, state);
    });
  }
  new MutationObserver(enhance).observe(feed, { childList: true });
  enhance();
})();
