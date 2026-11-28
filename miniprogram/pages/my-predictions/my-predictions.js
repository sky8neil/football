const { listMyPredictions } = require("../../services/predictions.js");
const { listLeagueSeasons } = require("../../services/league-seasons.js");
const authService = require("../../services/auth.js");
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
const MAX_EMPTY_SCAN_PAGES = 5;
const MATCH_STATUS = {
  scheduled: "未开赛",
  live: "进行中",
  finished: "已完场",
  postponed: "延期",
  cancelled: "取消",
  abandoned: "腰斩",
};

function currentLoginGeneration() {
  if (!authService || typeof authService.getLoginGeneration !== "function") return 0;
  const value = authService.getLoginGeneration();
  return Number.isFinite(value) ? value : 0;
}

function formatScore(home, away) {
  return home === null || home === undefined || away === null || away === undefined
    ? "待结算"
    : `${home} : ${away}`;
}

function historyTeam(teamId) {
  const found = findTeam(teamId);
  return { team_id: teamId, name: found ? found.source_name : undefined };
}

function resolveHistoryTeam(teamObj, teamId) {
  return teamObj && teamObj.team_id ? teamObj : historyTeam(teamId);
}

const MY_PREDICTIONS_DIRTY_KEY = "my_predictions_dirty";
const SHARE_LEAGUE_PLACEHOLDER = "选择联赛";
const SHARE_SEASON_PLACEHOLDER = "选择赛季";
const SHARE_ROUND_PLACEHOLDER = "选择轮次";

function normalizeRoundId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return String(Number(text)).padStart(2, "0");
  return text;
}

function sortedRounds(roundIds) {
  if (!Array.isArray(roundIds)) return [];
  const seen = new Set();
  const deduped = [];
  for (const roundId of roundIds) {
    const normalized = normalizeRoundId(roundId);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped.sort((left, right) => {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return String(left).localeCompare(String(right));
  });
}

function buildShareRoundChoices(items, seasonsByLeague) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const seen = new Set();
  const choices = [];
  for (const item of items) {
    const leagueId = item && item.league_id ? String(item.league_id).trim() : "";
    const seasonId = item && item.season_id ? String(item.season_id).trim() : "";
    const roundId = normalizeRoundId(item && item.round_id);
    if (!leagueId || !seasonId || !roundId) continue;
    const key = `${leagueId}|${seasonId}|${roundId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const leagueName = LEAGUE_NAMES[leagueId] || leagueId;
    const seasons = (seasonsByLeague && seasonsByLeague[leagueId]) || [];
    const matchedSeason = seasons.find((season) => season && season.id === seasonId);
    const seasonLabel = (matchedSeason && matchedSeason.label) || seasonId.replace(/_/g, "/");
    const roundText = formatRound(roundId) || roundId;
    choices.push({
      key,
      leagueId,
      seasonId,
      roundId,
      label: `${leagueName} · ${seasonLabel} · ${roundText}`,
    });
  }
  return choices;
}

function hasPredictionsDirty() {
  try {
    if (typeof wx === "undefined" || typeof wx.getStorageSync !== "function") return false;
    return Boolean(wx.getStorageSync(MY_PREDICTIONS_DIRTY_KEY));
  } catch (_error) {
    return false;
  }
}

function clearPredictionsDirty() {
  try {
    if (typeof wx !== "undefined" && typeof wx.removeStorageSync === "function") {
      wx.removeStorageSync(MY_PREDICTIONS_DIRTY_KEY);
    }
  } catch (_error) {
    /* ignore storage cleanup failure */
  }
}

function presentItem(item) {
  const leagueId = item.league_id;
  const homePresented = presentTeam(resolveHistoryTeam(item.home_team, item.home_team_id), leagueId);
  const awayPresented = presentTeam(resolveHistoryTeam(item.away_team, item.away_team_id), leagueId);
  const leagueName = LEAGUE_NAMES[leagueId] || "比赛";
  const roundText = formatRound(item.round_id);
  const cancelled = item.match_status === "cancelled" || item.settlement_status === "voided";
  const points = cancelled ? "不计分" : item.match_score === null ? "待结算" : `+${item.match_score}`;
  const resultText = cancelled
    ? (item.match_status === "abandoned" ? "比赛腰斩 · 不计分" : "比赛取消 · 不计分")
    : item.exact_hit === true
      ? "精确命中"
      : item.wdl_hit === true
        ? "赛果命中"
        : item.match_score === null
          ? (item.match_status === "postponed" ? "比赛延期" : item.match_status === "abandoned" ? "比赛腰斩" : "等待比赛结算")
          : "未命中";
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
    actualText: cancelled ? "—" : formatScore(item.regular_home_score, item.regular_away_score),
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
    roundsBySeason: {},
    leagueOptions: ["全部联赛"],
    seasonOptions: ["全部赛季"],
    leagueIndex: 0,
    seasonIndex: 0,
    selectedLeagueId: null,
    selectedSeasonId: null,
    filterReady: false,
    filterError: "",
    showShareSheet: false,
    shareLeagueOptions: [SHARE_LEAGUE_PLACEHOLDER],
    shareSeasonOptions: [SHARE_SEASON_PLACEHOLDER],
    shareRoundOptions: [SHARE_ROUND_PLACEHOLDER],
    shareLeagueIndex: 0,
    shareSeasonIndex: 0,
    shareRoundIndex: 0,
    shareLeagueId: null,
    shareSeasonId: null,
    shareRoundId: null,
    shareRoundChoices: [],
  },

  requestSerial: 0,
  filterRequestSerial: 0,
  loginGeneration: 0,
  hasShown: false,

  onLoad() {
    this.loginGeneration = currentLoginGeneration();
    this.hasShown = false;
    clearPredictionsDirty();
    this.loadFilters();
    this.loadFirstPage();
  },

  onShow() {
    const generation = currentLoginGeneration();
    if (generation !== this.loginGeneration || this.data.state === "unauthorized") {
      this.loginGeneration = generation;
      this.hasShown = true;
      clearPredictionsDirty();
      this.resetFilters();
      this.loadFirstPage();
      return;
    }
    const dirty = hasPredictionsDirty();
    if (this.hasShown && dirty) {
      clearPredictionsDirty();
      this.hasShown = true;
      return this.silentRefreshFirstPage();
    }
    if (dirty) {
      clearPredictionsDirty();
    }
    this.hasShown = true;
  },

  silentRefreshFirstPage() {
    const serial = ++this.requestSerial;
    return listMyPredictions({
      leagueId: this.data.selectedLeagueId || undefined,
      seasonId: this.data.selectedSeasonId || undefined,
      limit: 20,
    })
      .then((result) => {
        if (serial !== this.requestSerial) return;
        if (
          result &&
          (result.statusCode === 200
            || (result.statusCode === 401 && result.code === "UNAUTHORIZED")
            || (result.statusCode === 409 && result.code === "USER_DELETED")
            || (result.statusCode === 404 && result.code === "USER_NOT_FOUND"))
        ) {
          return this.applyListResult(result, true, serial);
        }
        if (this.data.state !== "list" && this.data.state !== "empty") {
          return this.applyListResult(result || { statusCode: 0, code: "NETWORK_ERROR" }, true, serial);
        }
      })
      .catch(() => {
        if (serial !== this.requestSerial) return;
        if (this.data.state !== "list" && this.data.state !== "empty") {
          return this.applyListResult({ statusCode: 0, code: "NETWORK_ERROR" }, true, serial);
        }
      });
  },

  resetFilters() {
    this.setData({
      leagueIndex: 0,
      seasonIndex: 0,
      selectedLeagueId: null,
      selectedSeasonId: null,
      seasonOptions: ["全部赛季"],
      showShareSheet: false,
      shareLeagueIndex: 0,
      shareSeasonIndex: 0,
      shareRoundIndex: 0,
      shareLeagueId: null,
      shareSeasonId: null,
      shareRoundId: null,
      shareRoundChoices: [],
    });
  },

  loadFilters() {
    const serial = (this.filterRequestSerial || 0) + 1;
    this.filterRequestSerial = serial;
    return listLeagueSeasons().then((result) => {
      if (serial !== this.filterRequestSerial) return;
      if (result.statusCode !== 200) {
        this.setData({ filterError: "筛选选项加载失败" });
        return;
      }
      const items = result.data && Array.isArray(result.data.items) ? result.data.items : [];
      const leagues = [];
      const seasonsByLeague = {};
      const roundsBySeason = {};
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
        roundsBySeason[leagueId + "|" + item.season_id] = sortedRounds(item.round_ids);
      }
      const shareState = this.buildSharePickerState(
        leagues,
        seasonsByLeague,
        roundsBySeason,
        this.data.shareLeagueId,
        this.data.shareSeasonId,
      );
      this.setData({
        leagues,
        seasonsByLeague,
        roundsBySeason,
        leagueOptions: ["全部联赛", ...leagues.map((league) => league.name)],
        seasonOptions: ["全部赛季"],
        filterReady: true,
        filterError: "",
        shareRoundChoices: buildShareRoundChoices(this.data.items, seasonsByLeague),
        ...shareState,
      });
    }).catch(() => {
      if (serial !== this.filterRequestSerial) return;
      this.setData({ filterError: "筛选选项加载失败" });
    });
  },

  buildSharePickerState(leagues, seasonsByLeague, roundsBySeason, leagueId, seasonId) {
    let shareLeagueIndex = 0;
    let shareSeasonIndex = 0;
    let shareLeagueId = null;
    let shareSeasonId = null;
    let shareSeasonOptions = [SHARE_SEASON_PLACEHOLDER];
    let shareRoundOptions = [SHARE_ROUND_PLACEHOLDER];
    if (leagueId) {
      const leagueOffset = leagues.findIndex((league) => league.id === leagueId);
      if (leagueOffset >= 0) {
        shareLeagueIndex = leagueOffset + 1;
        shareLeagueId = leagueId;
        const seasons = seasonsByLeague[leagueId] || [];
        shareSeasonOptions = [SHARE_SEASON_PLACEHOLDER, ...seasons.map((season) => season.label)];
        if (seasonId) {
          const seasonOffset = seasons.findIndex((season) => season.id === seasonId);
          if (seasonOffset >= 0) {
            shareSeasonIndex = seasonOffset + 1;
            shareSeasonId = seasonId;
            const rounds = roundsBySeason[leagueId + "|" + seasonId] || [];
            shareRoundOptions = [SHARE_ROUND_PLACEHOLDER, ...rounds.map((round) => formatRound(round))];
          }
        }
      }
    }
    return {
      shareLeagueOptions: [SHARE_LEAGUE_PLACEHOLDER, ...leagues.map((league) => league.name)],
      shareSeasonOptions,
      shareRoundOptions,
      shareLeagueIndex,
      shareSeasonIndex,
      shareRoundIndex: 0,
      shareLeagueId,
      shareSeasonId,
      shareRoundId: null,
    };
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
    })
      .then((result) => this.applyListResult(result, true, serial))
      .catch(() => this.applyListResult({ statusCode: 0, code: "NETWORK_ERROR" }, true, serial));
  },

  applyListResult(result, replace, serial = this.requestSerial, emptyPages = 1) {
    if (serial !== this.requestSerial) return Promise.resolve();
    if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
      this.setData({ state: "unauthorized", errorMessage: "身份缺失", loadingMore: false });
      return Promise.resolve();
    }
    if (result.statusCode === 409 && result.code === "USER_DELETED") {
      this.setData({ state: "userDeleted", errorMessage: result.message || "当前账号不可用", loadingMore: false });
      return Promise.resolve();
    }
    if (result.statusCode === 404 && result.code === "USER_NOT_FOUND") {
      this.setData({ state: "userNotFound", errorMessage: result.message || "用户不存在", loadingMore: false });
      return Promise.resolve();
    }
    const isPagination = replace === false && this.data.items.length > 0;
    if (result.statusCode === 0 || result.code === "NETWORK_ERROR") {
      this.setData({
        ...(isPagination ? {} : { state: "error" }),
        errorMessage: "网络异常，请重试",
        loadingMore: false,
      });
      return Promise.resolve();
    }
    if (result.statusCode !== 200) {
      this.setData({
        ...(isPagination ? {} : { state: "error" }),
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
    const hasMore = page.has_more === true;
    const nextCursor = page.next_cursor === undefined ? null : page.next_cursor;
    const autoContinue = nextItems.length === 0
      && hasMore
      && nextCursor !== null
      && emptyPages < MAX_EMPTY_SCAN_PAGES;
    this.setData({
      state: items.length === 0 && !hasMore ? "empty" : "list",
      items,
      weeks: groupPredictionsByWeek(items),
      hasMore,
      nextCursor,
      errorMessage: "",
      loadingMore: autoContinue,
      emptyText: items.length === 0 && (this.data.selectedLeagueId || this.data.selectedSeasonId)
        ? "你在这个赛季还没有预测记录"
        : COPY.predictionsEmpty,
    });
    if (autoContinue) {
      return this.fetchNextPage(serial, emptyPages + 1);
    }
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
    const pickerState = this.buildSharePickerState(
      this.data.leagues || [],
      this.data.seasonsByLeague || {},
      this.data.roundsBySeason || {},
      this.data.selectedLeagueId,
      this.data.selectedSeasonId,
    );
    this.setData({
      showShareSheet: true,
      shareRoundChoices: buildShareRoundChoices(this.data.items, this.data.seasonsByLeague),
      ...pickerState,
    });
  },

  onCloseShareSheet() {
    if (!this.data.showShareSheet) return;
    this.setData({ showShareSheet: false });
  },

  onStopPropagation() {},

  onShareLeagueChange(event) {
    const index = Number(event.detail.value);
    if (index === 0) {
      this.setData({
        shareLeagueIndex: 0,
        shareLeagueId: null,
        shareSeasonIndex: 0,
        shareSeasonId: null,
        shareRoundIndex: 0,
        shareRoundId: null,
        shareSeasonOptions: [SHARE_SEASON_PLACEHOLDER],
        shareRoundOptions: [SHARE_ROUND_PLACEHOLDER],
      });
      return;
    }
    const league = (this.data.leagues || [])[index - 1];
    const seasons = (league && this.data.seasonsByLeague[league.id]) || [];
    this.setData({
      shareLeagueIndex: index,
      shareLeagueId: league ? league.id : null,
      shareSeasonIndex: 0,
      shareSeasonId: null,
      shareRoundIndex: 0,
      shareRoundId: null,
      shareSeasonOptions: [SHARE_SEASON_PLACEHOLDER, ...seasons.map((season) => season.label)],
      shareRoundOptions: [SHARE_ROUND_PLACEHOLDER],
    });
  },

  onShareSeasonChange(event) {
    const index = Number(event.detail.value);
    if (index === 0) {
      this.setData({
        shareSeasonIndex: 0,
        shareSeasonId: null,
        shareRoundIndex: 0,
        shareRoundId: null,
        shareRoundOptions: [SHARE_ROUND_PLACEHOLDER],
      });
      return;
    }
    const seasons = (this.data.seasonsByLeague && this.data.seasonsByLeague[this.data.shareLeagueId]) || [];
    const season = seasons[index - 1];
    const rounds = (season && this.data.roundsBySeason && this.data.roundsBySeason[this.data.shareLeagueId + "|" + season.id]) || [];
    this.setData({
      shareSeasonIndex: index,
      shareSeasonId: season ? season.id : null,
      shareRoundIndex: 0,
      shareRoundId: null,
      shareRoundOptions: [SHARE_ROUND_PLACEHOLDER, ...rounds.map((round) => formatRound(round))],
    });
  },

  onShareRoundChange(event) {
    const index = Number(event.detail.value);
    if (index === 0) {
      this.setData({
        shareRoundIndex: 0,
        shareRoundId: null,
      });
      return;
    }
    const rounds = (this.data.roundsBySeason && this.data.roundsBySeason[this.data.shareLeagueId + "|" + this.data.shareSeasonId]) || [];
    const roundId = normalizeRoundId(rounds[index - 1]);
    this.setData({
      shareRoundIndex: index,
      shareRoundId: roundId,
    });
  },

  navigateToShareCard(leagueId, seasonId, roundId) {
    const normalizedRound = normalizeRoundId(roundId);
    if (!leagueId || !seasonId || !normalizedRound) return;
    const query = [
      "league_id=" + encodeURIComponent(leagueId),
      "season_id=" + encodeURIComponent(seasonId),
      "round_id=" + encodeURIComponent(normalizedRound),
    ].join("&");
    this.setData({ showShareSheet: false });
    wx.navigateTo({ url: "/pages/share-card/share-card?" + query });
  },

  onShareConfirm() {
    this.navigateToShareCard(
      this.data.shareLeagueId,
      this.data.shareSeasonId,
      this.data.shareRoundId,
    );
  },

  onShareChoiceTap(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    this.navigateToShareCard(dataset.leagueId, dataset.seasonId, dataset.roundId);
  },

  onMore() {
    this.loadNextPage(this.requestSerial);
  },

  loadNextPage(serial = this.requestSerial) {
    if (this.data.loadingMore || !this.data.hasMore || this.data.nextCursor === null) return;
    return this.fetchNextPage(serial, 1);
  },

  fetchNextPage(serial, emptyPages) {
    const cursor = this.data.nextCursor;
    this.setData({ loadingMore: true, errorMessage: "" });
    return listMyPredictions({
      leagueId: this.data.selectedLeagueId || undefined,
      seasonId: this.data.selectedSeasonId || undefined,
      cursor,
    })
      .then((result) => this.applyListResult(result, false, serial, emptyPages))
      .catch(() => this.applyListResult({ statusCode: 0, code: "NETWORK_ERROR" }, false, serial, emptyPages));
  },

  onSessionTap() {
    wx.navigateTo({ url: "/pages/session/session?return_to=my-predictions" });
  },

  onMatchesTap() {
    wx.switchTab({ url: "/pages/matches/matches" });
  },

  onFilterRetry() {
    this.setData({ filterError: "" });
    return this.loadFilters();
  },

  onRetry() {
    if (!this.data.filterReady) this.loadFilters();
    return this.loadFirstPage();
  },
});
