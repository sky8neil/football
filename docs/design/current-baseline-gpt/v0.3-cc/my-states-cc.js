/* v0.3-cc「我的」页状态：?state=M01 常态 / M02 新赛季回顾卡 / M03 无群。其余沿用原页面。 */
(function () {
  const id = new URLSearchParams(location.search).get('state') || 'M01';

  if (id === 'M02') {
    const stats = document.querySelector('.stats-card');
    if (stats) {
      stats.insertAdjacentHTML('beforebegin',
        '<section class="card season-recap" aria-label="上赛季回顾">' +
        '<div class="recap-top"><h2>上赛季回顾</h2><span class="ccs-chip">2026/27 赛季</span></div>' +
        '<div class="recap-metrics"><div><b>312</b><small>赛季积分</small></div><div><b>Lv.4</b><small>最高等级</small></div><div><b>96</b><small>有效预测</small></div></div>' +
        '</section>');
    }
  }

  if (id === 'M03') {
    const row = document.querySelector('.group-card .group-row');
    if (row) {
      row.outerHTML = '<div class="group-empty"><p>还没有加入任何群<br>创建一个，或用邀请码加入朋友的群</p></div>';
    }
  }

  /* 入口：加入 / 创建 / 全部预测，跳到对应的状态页面 */
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const map = { join: 'group-states.html?state=G02', create: 'group-states.html?state=G03', predictions: 'predictions-states.html?state=P01', groups: 'group-states.html?state=G01' };
    const url = map[btn.dataset.action];
    if (!url) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    location.href = url;
  }, true);
})();
