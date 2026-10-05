/* v0.2.1-cc 在 v0.2-cc 基础上加入赛季榜资格门槛。
   v0.2-cc 方案：把"全站 / 我的群"收进页头胶囊，点开弹层选择（含具体群）。
   榜单类型 tabs 成为唯一常驻的筛选行；周选择器仍随「本周榜」显示在日期行里。 */
(function () {
  const baseRender = render;
  /* 赛季榜资格（MVP §19.9）：参与过的等级赛季数 ≥ 2 才展示「赛季榜」。演示用 ?seasons=1|2 切换，默认 2。 */
  const seasonsParam = Number(new URLSearchParams(location.search).get('seasons'));
  const seasonsParticipated = seasonsParam === 1 ? 1 : 2;
  const seasonBoardVisible = seasonsParticipated >= 2;
  const chevron = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const tick = '<svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  function restructure() {
    const heading = app.querySelector('.page-heading');
    if (!heading || heading.querySelector('.scope-chip')) return;
    const rule = heading.querySelector('.rule-button');
    const actions = document.createElement('div');
    actions.className = 'heading-actions';
    const chip = document.createElement('button');
    chip.className = 'scope-chip';
    chip.type = 'button';
    chip.dataset.cc = 'scope-sheet';
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.setAttribute('aria-label', '切换榜单范围');
    chip.innerHTML = '<span>' + (state.scope === 'group' ? groups[state.group].name : '全站') + '</span>' + chevron;
    rule.replaceWith(actions);
    actions.append(chip, rule);
  }

  function gateSeasonBoard() {
    if (seasonBoardVisible) return false;
    if (state.board === 'season') { state.board = 'week'; state.page = 1; return true; }
    const tab = app.querySelector('[data-board="season"]');
    if (tab) tab.remove();
    return false;
  }

  render = function () {
    baseRender();
    if (gateSeasonBoard()) { baseRender(); }
    gateSeasonBoard();
    restructure();
  };

  function openScopeSheet() {
    const opt = (pick, checked, title, sub) =>
      '<button class="opt" type="button" role="radio" aria-checked="' + checked + '" data-cc-pick="' + pick + '"><span>' + title + '<small>' + sub + '</small></span>' + tick + '</button>';
    const html = '<div class="scope-sheet" role="radiogroup" aria-label="榜单范围">' +
      opt('global', state.scope === 'global', '全站排行榜', '所有预言家同榜竞争') +
      '<div class="sheet-label">我的群 · 每个群独立排名</div>' +
      Object.entries(groups).map(([key, g]) =>
        opt('group:' + key, state.scope === 'group' && state.group === key, g.name, g.count + ' 人')).join('') +
      '</div>';
    openModal('查看范围', html);
  }

  document.addEventListener('click', (event) => {
    const open = event.target.closest('[data-cc="scope-sheet"]');
    if (open) { openScopeSheet(); return; }
    const pick = event.target.closest('[data-cc-pick]');
    if (!pick) return;
    const [scope, group] = pick.dataset.ccPick.split(':');
    state.scope = scope;
    if (group) state.group = group;
    state.page = 1;
    modal.close();
    render();
  });

  render();
})();
