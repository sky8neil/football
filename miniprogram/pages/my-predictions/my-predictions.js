const { listMyPredictions } = require("../../services/predictions.js");
const COPY = require("../../utils/rankings-copy.js");
const { getLeagueLogo } = require("../../utils/logo-registry.js");
const { presentTeam } = require("../../utils/team-presentation.js");
const { groupPredictionsByWeek } = require("../../utils/prediction-history.js");
const { formatRound, formatKickoff } = require("../../utils/match-presentation.js");

const LEAGUE_NAMES = {
  premier_league: "英超",
  la_liga: "西甲",
  serie_a: "意甲",
  bundesliga: "德甲",
  ligue_1: "法甲",
  chinese_super_league: "中超",
};
const MATCH_STATUS = {
  scheduled: "未开赛",
  live: "进行中",
  finished: "已完场",
  postponed: "延期",
  cancelled: "取消",
  abandoned: "腰斩",
};

function formatScore(home, away) {
  return home === null || home === undefined || away === null || away === undefined
    ? "待结算"
    : `${home} : ${away}`;
}

function presentItem(item) {
  const leagueId = item.league_id;
  const homePresented = presentTeam({ team_id: item.home_team_id }, leagueId);
  const awayPresented = presentTeam({ team_id: item.away_team_id }, leagueId);
  const leagueName = LEAGUE_NAMES[leagueId] || "比赛";
  const roundText = formatRound(item.round_id);
  const points = item.match_score === null ? "待结算" : `+${item.match_score}`;
  const resultText = item.exact_hit === true
    ? "精确命中"
    : item.wdl_hit === true
      ? "赛果命中"
      : item.match_score === null ? "等待比赛结算" : "未命中";
  return {
    ...item,
    homeNameZh: homePresented.nameZh,
    awayNameZh: awayPresented.nameZh,
    homeLogo: homePresented.logo,
    awayLogo: awayPresented.logo,
    leagueLogo: getLeagueLogo(leagueId),
    leagueName,
    roundText,
    leagueRoundText: roundText ? `${leagueName} · ${roundText}` : leagueName,
    kickoffText: formatKickoff(item.kickoff_at),
    predictionText: `${item.pred_home_score} : ${item.pred_away_score}`,
    actualText: formatScore(item.regular_home_score, item.regular_away_score),
    pointsText: points,
    resultText,
    statusText: MATCH_STATUS[item.match_status] || item.match_status,
  };
}

Page({
  data: {
    state: "loading",
    items: [],
    weeks: [],
    errorMessage: "",
    hasMore: false,
    nextCursor: null,
    loadingMore: false,
    emptyText: COPY.predictionsEmpty,
    goPredictText: COPY.goPredict,
    endText: COPY.predictionsEnd,
  },

  requestSerial: 0,

  onLoad() {
    this.loadFirstPage();
  },

  loadFirstPage() {
    const serial = ++this.requestSerial;
    this.setData({
      state: "loading",
      items: [],
      weeks: [],
      errorMessage: "",
      hasMore: false,
      nextCursor: null,
      loadingMore: false,
    });
    return listMyPredictions({ limit: 20 }).then((result) =>
      this.applyListResult(result, true, serial),
    );
  },

  applyListResult(result, replace, serial = this.requestSerial) {
    if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
      this.setData({ state: "unauthorized", errorMessage: "身份缺失", loadingMore: false });
      return Promise.resolve();
    }
    if (result.statusCode === 409 && result.code === "USER_DELETED") {
      this.setData({ state: "userDeleted", errorMessage: result.message || "账号已注销", loadingMore: false });
      return Promise.resolve();
    }
    if (result.statusCode === 404 && result.code === "USER_NOT_FOUND") {
      this.setData({ state: "userNotFound", errorMessage: result.message || "用户不存在", loadingMore: false });
      return Promise.resolve();
    }
    if (result.statusCode !== 200) {
      this.setData({
        state: "error",
        errorMessage: result.message || String(result.code || result.statusCode),
        loadingMore: false,
      });
      return Promise.resolve();
    }
    const payload = result.data || {};
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    const page = payload.page || {};
    if (serial !== this.requestSerial) return Promise.resolve();
    const nextItems = rawItems.map((item) => presentItem(item));
    const items = replace ? nextItems : this.data.items.concat(nextItems);
    this.setData({
      state: items.length === 0 ? "empty" : "list",
      items,
      weeks: groupPredictionsByWeek(items),
      hasMore: page.has_more === true,
      nextCursor: page.next_cursor === undefined ? null : page.next_cursor,
      errorMessage: "",
      loadingMore: false,
    });
    return Promise.resolve();
  },

  onCardTap(event) {
    const matchId = event.currentTarget.dataset.matchId;
    if (matchId) wx.navigateTo({ url: "/pages/match-detail/match-detail?id=" + matchId });
  },

  onMore() {
    this.loadNextPage(this.requestSerial);
  },

  loadNextPage(serial = this.requestSerial) {
    if (this.data.loadingMore || !this.data.hasMore || this.data.nextCursor === null) return;
    const cursor = this.data.nextCursor;
    this.setData({ loadingMore: true, errorMessage: "" });
    listMyPredictions({ cursor }).then((result) => this.applyListResult(result, false, serial));
  },

  onSessionTap() {
    wx.navigateTo({ url: "/pages/session/session" });
  },

  onMatchesTap() {
    wx.switchTab({ url: "/pages/matches/matches" });
  },

  onRetry() {
    this.loadFirstPage();
  },
});
