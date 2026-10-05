/* v0.3-cc 方案：不再单独占一行 —— 「全站 / 我的群」迁入深色概览卡顶部，
   选群的下拉也在卡内；页面只剩榜单类型 tabs 一行常驻筛选。 */
(function () {
  const baseRender = render;

  function restructure() {
    const hero = app.querySelector('.hero');
    const top = hero && hero.querySelector('.hero-top');
    const scope = app.querySelector('.scope-switch');
    if (!hero || !top || !scope || hero.contains(scope)) return;
    top.before(scope);
    const picker = app.querySelector('.group-picker');
    if (picker) {
      picker.classList.add('in-hero');
      scope.after(picker);
    }
  }

  render = function () { baseRender(); restructure(); };
  render();
})();
