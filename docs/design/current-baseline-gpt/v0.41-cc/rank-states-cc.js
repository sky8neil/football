/* v0.3-cc 排行榜状态图册：按 ?state=Rxx 把同一个完整页面切到不同状态。
   只在新状态下追加块；常态（R06）与 v0.2.2-cc 的排行榜页一致。 */
(function () {
  const params = new URLSearchParams(location.search);
  const id = params.get('state') || 'R06';
  const ALL = ['week', 'career', 'strength', 'season'];
  const HOME = '赛事预言家首页-高保真-v8.6-球场背景玻璃版.html';
  const CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const TICK = '<svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const INFO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
  const CLOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const LOCK = '<svg class="lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  const BARS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10h5v10m0 0V4h6v16m0 0V13h5v7M2 20h20"/></svg>';

  const WEEKS = [
    { key: 'current', label: '本周', range: '09.28—10.04' },
    { key: 'previous', label: '上周', range: '09.21—09.27' },
    { key: 'w2', label: '', range: '09.14—09.20' },
    { key: 'w3', label: '', range: '09.07—09.13' }
  ];
  const SEASONS = [
    { key: 'current', id: '2027/28', tag: '当前赛季' },
    { key: 'prev', id: '2026/27', tag: '上赛季' }
  ];

  /* 各状态：N=入榜人数（缺省=常态 20 人），me=我的名次，tabs=可见标签（available_boards） */
  const SCEN = {
    R01: { N: 0, tabs: ['week'], weeks: 1 },
    R02: { N: 0, tabs: ['week'], weeks: 1, scope: 'group', group: 'mine' },
    R03: { N: 1, me: 1, tabs: ['week', 'career'], weeks: 2 },
    R04: { N: 2, me: 2, tabs: ['week', 'career'], weeks: 2 },
    R05: { N: 5, me: 3, tabs: ['week', 'career'], weeks: 2 },
    R06: {},
    R07: { guest: true },
    R08: { board: 'career', notice: 'firstSeason', tabs: ['week', 'career', 'strength'] },
    R09: { board: 'season', N: 8, me: 3, notice: 'seasonStart', seasonCurrentLabel: true },
    R10: { board: 'season', seasonView: 'prev', final: true, recap: true, staleDays: 5, currentEmpty: true },
    R11: { board: 'season', seasonView: 'prev', provisional: true, recap: true, currentEmpty: true },
    R12: { board: 'season', seasonView: 'prev', final: true, staleDays: 5, currentEmpty: true, openSheet: 'season' },
    R13: { openSheet: 'week' },
    R14: { week: 'previous' },
    R15: { week: 'w2', staleDays: 6 },
    R16: { nogroup: true, openSheet: 'scope' },
    R17: { board: 'strength', N: 4, me: 2 },
    R18: { board: 'career', inactiveDays: 11 }
  };
  const S = Object.assign({ tabs: ALL, board: 'week', scope: 'global', group: 'zhang', week: 'current', seasonView: 'current', weeks: 4 }, SCEN[id] || SCEN.R06);
  const view = { week: S.week, season: S.seasonView };

  if (S.inactiveDays !== undefined && window.rankingActivity) {
    window.rankingActivity.lastPredictionAt = window.rankingActivity.serverNow - S.inactiveDays * 864e5;
  }

  function effN() {
    if (state.board === 'season' && S.currentEmpty && view.season === 'current') return 0;
    return S.N;
  }

  /* ---- 数据层覆盖：按入榜人数裁剪、我的名次、领奖台空位 ---- */
  const baseEntries = entries;
  entries = function () {
    const n = effN();
    let list = baseEntries();
    if (n !== undefined && n < 20) list = list.slice(0, n);
    if (S.me && n !== undefined && n >= S.me && list[S.me - 1]) {
      Object.assign(list[S.me - 1], { isMe: true, name: '徐sir', avatar: rankingIdentity.avatar, wechatAvatar: rankingIdentity.wechatAvatar, team: '阿森纳', level: 4, id: '102846' });
    }
    return list;
  };
  const basePersonal = personalStanding;
  personalStanding = function () {
    const base = basePersonal();
    const n = effN();
    if (n === undefined || n >= 20) return base;
    const scope = state.scope === 'group' ? '群内' : '全站';
    if (n === 0 || !S.me) {
      return Object.assign({}, base, { total: n, rank: null, eligible: false, publicRank: false, label: '暂无排名', count: 0, value: state.board === 'strength' ? '—' : '0', hits: 0, empty: true, status: '完成首场有效预测并结算后参与排名。' });
    }
    return Object.assign({}, base, { total: n, rank: S.me, eligible: true, publicRank: true, label: '第 ' + S.me + ' 名', status: '你位于' + scope + '第 ' + S.me + ' 名（共 ' + n + ' 人）。' });
  };
  const basePodium = podiumPerson;
  podiumPerson = function (person, winner) { return person ? basePodium(person, winner) : ''; };

  /* ---- 渲染后处理 ---- */
  const baseRender = render;
  render = function () {
    baseRender();
    apply();
  };

  function weekLabel(w) { return (w.label ? w.label + ' · ' : '') + w.range; }
  function seasonLabel(key) {
    const s = SEASONS.find((x) => x.key === key);
    return s.id + ' 赛季' + (key === 'prev' ? ' · 上赛季' : '');
  }

  function updatedText(board) {
    if (S.staleDays !== undefined && (board === 'week' || board === 'season')) return '<span>' + S.staleDays + ' 天前更新</span>';
    const t = typeof relUpdated === 'function' ? relUpdated(board) : '';
    return '<span>' + t + '</span>';
  }

  function metaHTML() {
    const b = state.board;
    let left = '<span></span>';
    let right = '';
    if (b === 'week') {
      const cur = WEEKS.find((w) => w.key === view.week);
      left = S.weeks > 1
        ? '<button class="period-btn" type="button" data-ccs="week"><span>' + weekLabel(cur) + '</span>' + CHEV + '</button>'
        : '<span>' + weekLabel(WEEKS[0]) + '</span>';
      right = updatedText('week');
    } else if (b === 'season') {
      left = '<button class="period-btn" type="button" data-ccs="season"><span>' + seasonLabel(view.season) + '</span>' + CHEV + '</button>';
      if (view.season === 'prev' && S.provisional) right = '<span class="ccs-chip">' + CLOCK + '等待最终确认</span>';
      else if (view.season === 'prev') right = updatedText('season');
      else right = updatedText('season');
    } else if (b === 'career') {
      left = '<span>永久累计</span>';
      right = updatedText('career');
    } else {
      right = updatedText('strength');
    }
    return left + right;
  }

  function noticeHTML(text) { return '<div class="notice-line">' + INFO + '<span>' + text + '</span></div>'; }

  function recapHTML() {
    return '<section class="ccs-card recap-card"><div class="recap-top"><h3>上赛季回顾 · 2026/27</h3></div>' +
      '<div class="recap-metrics"><div><b>312</b><small>赛季积分</small></div><div><b>Lv.4</b><small>最高等级</small></div><div><b>96</b><small>有效预测</small></div></div></section>';
  }

  function leaderHTML(person) {
    return '<section class="ccs-card leader-card"><img src="' + personAvatar(person) + '" alt="' + esc(person.name) + '的头像">' +
      '<div class="leader-copy"><span class="tag">第 1 名</span><b>' + esc(person.name) + (person.isMe ? ' · 我' : '') + '</b><small>' + person.team + ' · ' + person.n + ' 场有效</small></div>' +
      '<div class="leader-score">' + person.value + '<small>' + config[state.board].metric + '</small></div></section>';
  }

  function emptyHTML() {
    let h2 = '这里还没有人入榜';
    let p = '第一场预测结算后，榜单会更新';
    let actions = '<a class="ccs-cta" href="' + HOME + '">去预测</a>';
    if (state.board === 'week' && state.scope === 'group') {
      h2 = '群里本周还没有人入榜';
      p = '先去预测一场，也可以邀请好友一起来';
      actions += '<button class="ccs-ghost ccs-invite" type="button">邀请好友</button>';
    } else if (state.board === 'week') {
      h2 = '本周还没有人入榜';
      p = '第一场预测结算后，\n你就是第一名';
    } else if (state.board === 'season') {
      h2 = '新赛季还没有人入榜';
      p = '第一场预测结算后，榜单会在整点更新';
    }
    return '<section class="ccs-card empty-board"><div class="empty-art">' + BARS + '</div><h2>' + h2 + '</h2><p>' + p + '</p><div class="empty-actions">' + actions + '</div></section>';
  }

  function inviteHTML() {
    const group = state.scope === 'group';
    const title = group ? '邀请好友加入这个群' : '邀请好友建个群';
    const sub = group ? '群里目前只有你一个人' : '看看谁更懂球';
    return '<section class="ccs-card invite-card"><p><b>' + title + '</b>' + sub + '</p><button class="ccs-ghost ccs-invite" type="button">邀请好友</button></section>';
  }

  function renderGuest(app) {
    app.innerHTML = '<div class="page-heading"><div><h1>排行榜</h1><p>让每一次判断，都有回响。</p></div></div>' +
      '<div class="guest-stage"><div class="guest-skeleton" aria-hidden="true">' +
      '<div class="tabs"><span class="bar"></span><span class="bar"></span><span class="bar"></span></div>' +
      '<div class="hero-s"></div>' +
      '<div class="pod"><i style="height:84px"></i><i style="height:112px"></i><i style="height:70px"></i></div>' +
      '<div class="rows">' + '<div><i></i><span class="bar"></span><span class="bar s"></span></div>'.repeat(5) + '</div></div>' +
      '<div class="guest-note" role="status">请登录查看榜单</div></div>';
  }

  function apply() {
    const app = document.querySelector('#ranking-app');
    if (!app) return;
    if (S.guest) { renderGuest(app); return; }

    app.querySelectorAll('.board-tabs button').forEach((b) => { if (!S.tabs.includes(b.dataset.board)) b.remove(); });

    const meta = app.querySelector('.board-meta');
    if (meta) meta.innerHTML = metaHTML();

    const hero = app.querySelector('.hero');
    if (hero) {
      const stamp = hero.querySelector('.hero-stamp');
      if (stamp && state.board === 'week' && view.week !== 'current') stamp.remove();
      const h2 = hero.querySelector('h2');
      if (h2 && state.board === 'season' && view.season === 'prev' && h2.firstChild) h2.firstChild.textContent = '我的上赛季表现';
    }

    let before = '';
    if (state.board === 'season' && S.recap) before += recapHTML();
    if (state.board === 'career' && S.notice === 'firstSeason') before += noticeHTML('你正在第一个赛季，生涯榜与赛季榜内容相同');
    if (state.board === 'season' && S.notice === 'seasonStart' && view.season === 'current') before += noticeHTML('赛季刚开始，名次变化会比较大');
    if (before && meta) meta.insertAdjacentHTML('afterend', before);

    const n = effN();
    if (n !== undefined && n < 20) {
      const podium = app.querySelector('.podium');
      const heading = app.querySelector('.list-heading');
      const list = app.querySelector('.rank-list');
      const more = app.querySelector('.load-more');
      if (n === 0) {
        [podium, heading, list, more].forEach((x) => x && x.remove());
        app.insertAdjacentHTML('beforeend', emptyHTML());
        return;
      }
      if (n < 3 && podium) podium.remove();
      if (n <= 2 && heading) heading.insertAdjacentHTML('beforebegin', leaderHTML(entries()[0]));
      if (heading) heading.querySelector('h2').textContent = '全部 ' + n + ' 位预言家';
      const wantInvite = state.scope === 'group' ? n <= 1 : true;
      if (wantInvite) app.insertAdjacentHTML('beforeend', inviteHTML());
    }
  }

  /* ---- 弹层：周 / 赛季 / 无群的范围 ---- */
  function opt(attr, val, checked, title, sub, cls) {
    return '<button class="opt ' + (cls || '') + '" type="button" role="radio" aria-checked="' + checked + '" ' + attr + '="' + val + '"><span>' + title + (sub ? '<small>' + sub + '</small>' : '') + '</span>' + TICK + '</button>';
  }
  function openWeekSheet() {
    const rows = WEEKS.slice(0, S.weeks).map((w) => opt('data-ccs-week', w.key, view.week === w.key, weekLabel(w), '')).join('');
    const note = S.weeks > 1 ? '仅显示最近 4 周' : '榜单从本周开始记录';
    openModal('选择周', '<div class="scope-sheet" role="radiogroup" aria-label="选择周">' + rows + '</div><div class="sheet-note">' + note + '</div>');
  }
  function openSeasonSheet() {
    const rows = SEASONS.map((s) => {
      let sub = s.key === 'current' ? (S.currentEmpty ? '暂无人入榜' : '进行中') : (S.provisional ? '等待最终确认' : '终榜 · 已确认');
      return opt('data-ccs-season', s.key, view.season === s.key, s.id + ' 赛季 · ' + s.tag, sub);
    }).join('');
    openModal('选择赛季', '<div class="scope-sheet" role="radiogroup" aria-label="选择赛季">' + rows + '</div><div class="sheet-note">往期赛季只显示全站榜</div>');
  }
  function openNoGroupSheet() {
    const html = '<div class="scope-sheet" role="radiogroup" aria-label="榜单范围">' +
      opt('data-ccs-scope', 'global', true, '全站排行榜', '所有预言家同榜竞争') +
      '<div class="sheet-label">我的群 · 每个群独立排名</div>' +
      '<a class="opt locked" href="group-states.html?state=G01"><span>我的群<small>创建或加入群后解锁</small></span>' + LOCK + '</a></div>';
    openModal('查看范围', html);
  }

  document.addEventListener('click', (event) => {
    const chip = event.target.closest('.scope-chip');
    if (chip && S.nogroup) { event.stopImmediatePropagation(); event.preventDefault(); openNoGroupSheet(); return; }
    const t = event.target;
    const open = t.closest('[data-ccs]');
    if (open) {
      if (open.dataset.ccs === 'week') openWeekSheet();
      if (open.dataset.ccs === 'season') openSeasonSheet();
      return;
    }
    const w = t.closest('[data-ccs-week]');
    if (w) { view.week = w.dataset.ccsWeek; state.period = view.week === 'current' ? 'current' : 'previous'; modal.close(); render(); return; }
    const s = t.closest('[data-ccs-season]');
    if (s) { view.season = s.dataset.ccsSeason; modal.close(); render(); return; }
    if (t.closest('[data-ccs-scope]')) { modal.close(); return; }
    if (t.closest('.ccs-invite')) notify('已复制邀请码 · 示例');
  }, true);

  /* ---- 初始化 ---- */
  if (S.guest) {
    const copy = document.querySelector('.welcome-copy');
    if (copy) { copy.querySelector('b').textContent = '你好，游客'; copy.querySelector('small').textContent = '登录后查看榜单与个人成绩'; }
    const idTag = document.querySelector('.welcome-id');
    if (idTag) idTag.remove();
  }
  const dock = document.querySelector('#my-rank');
  if (dock) dock.style.display = 'none';
  state.board = S.board;
  state.scope = S.scope;
  state.group = S.group;
  state.period = view.week === 'current' ? 'current' : 'previous';
  state.page = 1;
  render();
  if (S.openSheet === 'week') openWeekSheet();
  if (S.openSheet === 'season') openSeasonSheet();
  if (S.openSheet === 'scope' && S.nogroup) openNoGroupSheet();
})();
