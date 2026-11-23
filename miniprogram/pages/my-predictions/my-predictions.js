const { listMyPredictions } = require("../../services/predictions.js");
const { listLeagueSeasons } = require("../../services/league-seasons.js");
const COPY = require("../../utils/rankings-copy.js");
const { getLeagueLogo } = require("../../utils/logo-registry.js");
const { findTeam } = require("../../utils/team-registry.js");
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

function historyTeam(teamId) {
  const found = findTeam(teamId);
  return { team_id: teamId, name: found ? found.source_name : undefined };
}

function presentItem(item) {
  const leagueId = item.league_id;
  const homePresented = presentTeam(historyTeam(item.home_team_id), leagueId);
  const awayPresented = presentTeam(historyTeam(item.away_team_id), leagueId);
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
    leagues: [],
    seasonsByLeague: {},
    leagueOptions: ["全部联赛"],
    seasonOptions: ["全部赛季"],
    leagueIndex: 0,
    seasonIndex: 0,
    selectedLeagueId: null,
    selectedSeasonId: null,
    filterReady: false,
    filterError: "",
  },

  requestSerial: 0,

  onLoad() {
    this.loadFilters();
    this.loadFirstPage();
  },

  loadFilters() {
    return listLeagueSeasons().then((result) => {
      if (result.statusCode !== 200) {
        this.setData({ filterError: "筛选选项加载失败" });
        return;
      }
      const items = result.data && Array.isArray(result.data.items) ? result.data.items : [];
      const leagues = [];
      const seasonsByLeague = {};
      const seen = new Set();
      for (const item of items) {
        const leagueId = item.league_id;
        if (!seen.has(leagueId)) {
          seen.add(leagueId);
          leagues.push({
            id: leagueId,
            name: LEAGUE_NAMES[leagueId] || leagueId,
          });
        }
        if (!seasonsByLeague[leagueId]) seasonsByLeague[leagueId] = [];
        seasonsByLeague[leagueId].push({
          id: item.season_id,
          label: item.season_label,
        });
      }
      this.setData({
        leagues,
        seasonsByLeague,
        leagueOptions: ["全部联赛", ...leagues.map((league) => league.name)],
        seasonOptions: ["全部赛季"],
        filterReady: true,
        filterError: "",
      });
    }).catch(() => {
      this.setData({ filterError: "筛选选项加载失败" });
    });
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
    return listMyPredictions({
      leagueId: this.data.selectedLeagueId || undefined,
      seasonId: this.data.selectedSeasonId || undefined,
      limit: 20,
    }).then((result) => this.applyListResult(result, true, serial));
  },

  applyListResult(result, replace, serial = this.requestSerial) {
    if (serial !== this.requestSerial) return Promise.resolve();
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
    if (result.statusCode === 0 || result.code === "NETWORK_ERROR") {
      this.setData({
        state: "error",
        errorMessage: "网络异常，请重试",
        loadingMore: false,
      });
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
      emptyText: items.length === 0 && (this.data.selectedLeagueId || this.data.selectedSeasonId)
        ? "你在这个赛季还没有预测记录"
        : COPY.predictionsEmpty,
    });
    return Promise.resolve();
  },

  onLeagueChange(event) {
    const index = Number(event.detail.value);
    if (index === 0) {
      this.setData({
        leagueIndex: 0,
        selectedLeagueId: null,
        seasonIndex: 0,
        selectedSeasonId: null,
        seasonOptions: ["全部赛季"],
      });
    } else {
      const league = this.data.leagues[index - 1];
      const seasons = (league && this.data.seasonsByLeague[league.id]) || [];
      this.setData({
        leagueIndex: index,
        selectedLeagueId: league ? league.id : null,
        seasonIndex: 0,
        selectedSeasonId: null,
        seasonOptions: ["全部赛季", ...seasons.map((season) => season.label)],
      });
    }
    return this.loadFirstPage();
  },

  onSeasonChange(event) {
    const index = Number(event.detail.value);
    if (index === 0) {
      this.setData({
        seasonIndex: 0,
        selectedSeasonId: null,
      });
    } else {
      const seasons = this.data.seasonsByLeague[this.data.selectedLeagueId] || [];
      const season = seasons[index - 1];
      this.setData({
        seasonIndex: index,
        selectedSeasonId: season ? season.id : null,
      });
    }
    return this.loadFirstPage();
  },

  onCardTap(event) {
    const matchId = event.currentTarget.dataset.matchId;
    if (matchId) wx.navigateTo({ url: "/pages/match-detail/match-detail?id=" + matchId });
  },

  onShareCardTap() {
    const params = [];
    if (this.data.selectedLeagueId) {
      params.push("league_id=" + encodeURIComponent(this.data.selectedLeagueId));
    }
    if (this.data.selectedSeasonId) {
      params.push("season_id=" + encodeURIComponent(this.data.selectedSeasonId));
    }
    const query = params.length ? "?" + params.join("&") : "";
    wx.navigateTo({ url: "/pages/share-card/share-card" + query });
  },

  onMore() {
    this.loadNextPage(this.requestSerial);
  },

  loadNextPage(serial = this.requestSerial) {
    if (this.data.loadingMore || !this.data.hasMore || this.data.nextCursor === null) return;
    const cursor = this.data.nextCursor;
    this.setData({ loadingMore: true, errorMessage: "" });
    listMyPredictions({
      leagueId: this.data.selectedLeagueId || undefined,
      seasonId: this.data.selectedSeasonId || undefined,
      cursor,
    }).then((result) => this.applyListResult(result, false, serial));
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
