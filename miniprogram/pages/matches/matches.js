const { headerHeight } = require("../../utils/ui-layout.js");
const { getLeagueLogo } = require("../../utils/logo-registry.js");
const { presentTeam } = require("../../utils/team-presentation.js");
const { resolveNickname, truncateNickname } = require("../../utils/nickname.js");
const { listMatches } = require("../../services/matches.js");
const { getLeagueStatus } = require("../../services/leagues.js");
const { resolveDefaultLeagueFromStatus } = require("../../utils/matches-default-league.js");
const { createUuidV4, submitPrediction, getMyLeagueSummary } = require("../../services/predictions.js");
const { COPY: CROWD_COPY } = require("../../utils/crowd-copy.js");
const { formatRound } = require("../../utils/match-presentation.js");
const { buildCardState } = require("../../utils/match-card-state.js");
const { currentSeasonId } = require("../../utils/rankings-view-model.js");
const { formatLevelSeasonLabel } = require("../../utils/level-season.js");
const { getLoginGeneration, onAuthRestored } = require("../../services/auth.js");

const LEAGUES = [
  { id: "premier_league", name: "英超" },
  { id: "la_liga", name: "西甲" },
  { id: "serie_a", name: "意甲" },
  { id: "bundesliga", name: "德甲" },
  { id: "ligue_1", name: "法甲" },
  { id: "chinese_super_league", name: "中超" },
];
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const scope = (league, date, matchId) => `${league}:${date}:${matchId}`;
const pad = (n) => (n < 10 ? `0${n}` : String(n));
const DAY_MS = 24 * 60 * 60 * 1000;

function formatSummarySeasonLabel(seasonId) {
  const match = /^(\d{4})_(\d{4})$/.exec(seasonId || "");
  return match ? `${match[1]}/${match[2]}` : (seasonId || "");
}

function currentLoginGeneration() {
  if (typeof getLoginGeneration !== "function") return 0;
  const value = getLoginGeneration();
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function beijingParts(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  return { year, month, day, hour, minute, key: `${year}-${pad(month)}-${pad(day)}` };
}

// 日期条开放范围：今天 - 11 天 到 今天 + 11 天（共 23 个日期），默认选中并定位到今天。
// 要改开放范围只需改这三个常量；verify-home-migration.py 会校验 DATE_SPAN_DAYS 等于 23。
const DATE_PAST_DAYS = 11;
const DATE_FUTURE_DAYS = 11;
const DATE_SPAN_DAYS = 23;

function buildDates(anchor) {
  const dates = [];
  const parts = beijingParts(anchor);
  if (!parts) return dates;
  const start = Date.UTC(parts.year, parts.month - 1, parts.day, 4, 0, 0);
  for (let offset = -DATE_PAST_DAYS; offset <= DATE_FUTURE_DAYS; offset += 1) {
    const date = new Date(start + offset * DAY_MS);
    const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const key = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
    const label = offset === -1 ? "昨天" : offset === 0 ? "今天" : offset === 1 ? "明天" : WEEKDAYS[shifted.getUTCDay()];
    dates.push({ key, label, day: key.slice(-2) });
  }
  return dates;
}

function todayKeyFromDates(dates, fallbackAnchor) {
  const todayItem = Array.isArray(dates) ? dates.find((item) => item.label === "今天") : null;
  if (todayItem && todayItem.key) return todayItem.key;
  const parts = beijingParts(fallbackAnchor);
  return parts ? parts.key : "";
}

function markMyPredictionsDirty() {
  try {
    if (typeof wx !== "undefined" && typeof wx.setStorageSync === "function") {
      wx.setStorageSync("my_predictions_dirty", true);
    }
  } catch (_error) {
    /* 存储不可用时不阻断主流程 */
  }
}

function dayBounds(key) {
  const start = new Date(`${key}T00:00:00+08:00`);
  return {
    from: start.toISOString(),
    to: new Date(start.getTime() + DAY_MS).toISOString(),
  };
}

function buildHintText({ selectedDate, todayKey, openCount, doneCount, hasMore }) {
  let dateLabel = "今天";
  if (selectedDate !== todayKey) {
    const parts = String(selectedDate || "").split("-");
    dateLabel = `${Number(parts[1])} 月 ${Number(parts[2])} 日`;
  }
  const plus = hasMore ? "+" : "";
  const suffix = hasMore ? "（继续加载可看全部）" : "";
  return `${dateLabel} · 待预测 ${openCount}${plus} 场 · 已预测 ${doneCount}${plus} 场${suffix}`;
}

function daysBetweenBeijingDates(from, to) {
  const start = beijingParts(from);
  const end = beijingParts(to);
  if (!start || !end) return null;
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  const endDay = Date.UTC(end.year, end.month - 1, end.day);
  return Math.max(0, Math.round((endDay - startDay) / DAY_MS));
}

function hasUsablePrediction(prediction) {
  if (prediction == null || typeof prediction !== "object") return false;
  const home = prediction.pred_home_score !== undefined ? prediction.pred_home_score : prediction.home;
  const away = prediction.pred_away_score !== undefined ? prediction.pred_away_score : prediction.away;
  return home != null && away != null;
}

function isPendingSyncRecord(prediction) {
  return Boolean(prediction && typeof prediction === "object" && prediction.pendingSync === true);
}

function matchesLoginGeneration(record, loginGeneration) {
  if (!record || typeof record !== "object") return true;
  const recordGen = typeof record.loginGeneration === "number"
    ? record.loginGeneration
    : (typeof record.generation === "number" ? record.generation : undefined);
  return recordGen === undefined || recordGen === loginGeneration;
}

function resolveSubmitted(item, localSubmitted, loginGeneration) {
  if (hasUsablePrediction(item && item.my_prediction)) return item.my_prediction;
  if (item && item.can_predict_reason === "AUTH_REQUIRED") return null;
  if (localSubmitted && matchesLoginGeneration(localSubmitted, loginGeneration)) {
    if (hasUsablePrediction(localSubmitted)) return localSubmitted;
    if (isPendingSyncRecord(localSubmitted)) return localSubmitted;
  }
  if (item && item.can_predict_reason === "ALREADY_SUBMITTED") {
    return { pendingSync: true, loginGeneration };
  }
  return null;
}

function listCounts(items) {
  return {
    openCount: items.filter((entry) => entry.showPredict).length,
    doneCount: items.filter((entry) => entry.uiState === "submitted_locked" || entry.can_predict_reason === "ALREADY_SUBMITTED").length,
  };
}

function upcomingMatchInfo(item, now, dates) {
  if (!item || !item.kickoff_at) return null;
  const parts = beijingParts(item.kickoff_at);
  if (!parts) return null;
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const label = `${parts.month}月${parts.day}日（${WEEKDAYS[weekday]}）`;
  const daysUntil = daysBetweenBeijingDates(now, item.kickoff_at);
  const inDateStrip = Array.isArray(dates) && dates.some((date) => date.key === parts.key);
  return {
    date: parts.key,
    label,
    daysUntil,
    inDateStrip,
    displayText: inDateStrip
      ? `跳到下一轮比赛日：${label}→`
      : `距下一轮比赛日还有 ${daysUntil} 天（${parts.month}月${parts.day}日）`,
  };
}

Page({
  data: {
    headerHeight: headerHeight(),
    avatarText: "球",
    state: "loading", items: [], errorMessage: "", hasMore: false, nextCursor: null, loadingMore: false, nickname: "",
    leagues: [], activeLeagueIds: [], leagueStatusById: {}, selectedLeague: "premier_league", dates: [], selectedDate: "", dateScrollIntoView: "", nextMatch: null, offseasonInfo: null, emptyIsBreak: false, summaryState: "loading", summarySeasonId: null, summarySeasonLabel: "", summaryReason: null, leagueSummary: null, openCount: 0, doneCount: 0, hintText: "", recentScore: null, levelSeasonLabel: "", submitErrors: {},
    scrollIntoView: "", resultsTransition: "results-enter",
  },
  drafts: {}, uiStates: {}, submittedMap: {}, idempotencyKeys: {}, lastPayloads: {}, requestSerial: 0, statusSerial: 0, summarySerial: 0, loginGeneration: undefined, reloadTimer: null, scrollTimer: null,

  onLoad() {
    const now = new Date();
    const dates = buildDates(now);
    const todayKey = todayKeyFromDates(dates, now);
    const levelSeasonLabel = formatLevelSeasonLabel(currentSeasonId(now.toISOString()));
    this.setData({
      dates,
      selectedDate: todayKey,
      dateScrollIntoView: todayKey ? `date-${todayKey}` : "",
      leagues: LEAGUES.map((item) => ({ ...item, logo: getLeagueLogo(item.id) })),
      nickname: truncateNickname(resolveNickname()),
      avatarText: Array.from(resolveNickname())[0] || "球",
      levelSeasonLabel,
    });
    this.initialized = true;
    this.hasShown = false;
    this.needsDefaultLeague = true;
    if (typeof this.unsubscribeAuthRestored === "function") {
      this.unsubscribeAuthRestored();
      this.unsubscribeAuthRestored = null;
    }
    if (typeof onAuthRestored === "function") {
      this.unsubscribeAuthRestored = onAuthRestored(() => {
        if (!this.initialized) return;
        this.clearReloadTimer();
        return this.loadFirstPage();
      });
    }
    this.loadFirstPage(true);
  },

  syncHeaderDatesAndSeason() {
    const now = new Date();
    const today = beijingParts(now);
    const nextSeasonLabel = formatLevelSeasonLabel(currentSeasonId(now.toISOString()));
    const currentDates = Array.isArray(this.data.dates) ? this.data.dates : [];
    const currentToday = currentDates.find((item) => item.label === "今天");
    const previousTodayKey = currentToday ? currentToday.key : "";
    const patch = {};
    if (today && (currentDates.length === 0 || previousTodayKey !== today.key)) {
      const dates = buildDates(now);
      const nextTodayKey = todayKeyFromDates(dates, now);
      const currentSelected = this.data.selectedDate;
      const stillValid = dates.some((item) => item.key === currentSelected);
      patch.dates = dates;
      if (!currentSelected || currentSelected === previousTodayKey || !stillValid) {
        patch.selectedDate = nextTodayKey;
        patch.dateScrollIntoView = nextTodayKey ? `date-${nextTodayKey}` : "";
      }
    }
    if (nextSeasonLabel !== this.data.levelSeasonLabel) {
      patch.levelSeasonLabel = nextSeasonLabel;
    }
    if (Object.keys(patch).length > 0) {
      this.setData(patch);
    }
  },

  clearReloadTimer() {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  },

  clearScrollTimer() {
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
  },

  clearTimers() {
    this.clearReloadTimer();
    this.clearScrollTimer();
  },

  rememberLoginGeneration() {
    const generation = currentLoginGeneration();
    if (this.loginGeneration === generation) return generation;
    if (this.loginGeneration !== undefined) {
      this.submittedMap = {};
      this.uiStates = {};
      this.drafts = {};
      this.idempotencyKeys = {};
      this.lastPayloads = {};
      this.setData({
        items: [],
        leagueSummary: null,
        summarySeasonId: null,
        summarySeasonLabel: "",
        summaryReason: null,
        submitErrors: {},
        loadingMore: false,
        hasMore: false,
        nextCursor: null,
      });
    }
    this.loginGeneration = generation;
    return generation;
  },

  handleStaleLoginGeneration(loginGeneration) {
    if (loginGeneration === currentLoginGeneration()) return null;
    if (this.loginGeneration !== currentLoginGeneration()) return this.loadFirstPage();
    return Promise.resolve();
  },

  onShow() {
    if (this.initialized) {
      const nickname = truncateNickname(resolveNickname());
      this.setData({ nickname, avatarText: Array.from(nickname)[0] || "球" });
      this.syncHeaderDatesAndSeason();
    }
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 0 });
    if (this.initialized && this.hasShown) this.loadFirstPage();
    this.hasShown = true;
  },

  onHide() {
    this.clearTimers();
  },

  onUnload() {
    this.clearTimers();
    if (typeof this.unsubscribeAuthRestored === "function") {
      this.unsubscribeAuthRestored();
      this.unsubscribeAuthRestored = null;
    }
  },

  onLeagueTap(event) {
    const league = event.currentTarget.dataset.id;
    if (!league || league === this.data.selectedLeague) return;
    this.userChangedLeague = true;
    this.needsDefaultLeague = false;
    this.closeEditors();
    this.clearReloadTimer();
    this.requestSerial += 1;
    this.statusSerial += 1;
    this.summarySerial += 1;
    this.setData({ selectedLeague: league, scrollIntoView: "", state: "loading", items: [], nextMatch: null, offseasonInfo: null, leagueSummary: null, summarySeasonId: null, summarySeasonLabel: "", summaryReason: null, summaryState: "loading", hasMore: false, nextCursor: null, openCount: 0, doneCount: 0, hintText: "", resultsTransition: "results-exit" });
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.loadFirstPage();
    }, 180);
  },

  onDateTap(event) {
    const date = event.currentTarget.dataset.key;
    if (!date || date === this.data.selectedDate) return;
    this.closeEditors();
    this.clearReloadTimer();
    this.requestSerial += 1;
    this.statusSerial += 1;
    this.summarySerial += 1;
    this.setData({ selectedDate: date, dateScrollIntoView: "", state: "loading", items: [], nextMatch: null, offseasonInfo: null, leagueSummary: null, summarySeasonId: null, summarySeasonLabel: "", summaryReason: null, summaryState: "loading", hasMore: false, nextCursor: null, openCount: 0, doneCount: 0, hintText: "", scrollIntoView: "", resultsTransition: "results-exit" });
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.loadFirstPage();
    }, 180);
  },

  onNextMatchTap(event) {
    const date = event.currentTarget.dataset.date;
    if (!this.data.nextMatch || !this.data.nextMatch.inDateStrip || date !== this.data.nextMatch.date) return;
    if (date === this.data.selectedDate) return;
    this.closeEditors();
    this.clearReloadTimer();
    this.requestSerial += 1;
    this.statusSerial += 1;
    this.summarySerial += 1;
    this.setData({ selectedDate: date, dateScrollIntoView: `date-${date}`, state: "loading", items: [], nextMatch: null, offseasonInfo: null, leagueSummary: null, summarySeasonId: null, summarySeasonLabel: "", summaryReason: null, summaryState: "loading", hasMore: false, nextCursor: null, openCount: 0, doneCount: 0, hintText: "", scrollIntoView: "", resultsTransition: "results-exit" });
    return this.loadFirstPage();
  },

  onRankingsTap() {
    wx.setStorageSync("pending_ranking_target", {
      board: "season",
    });
    wx.switchTab({ url: "/pages/rankings/rankings" });
  },

  onSummaryLoginTap() {
    wx.navigateTo({ url: "/pages/session/session" });
  },

  onRetry() { this.loadFirstPage(); },

  onPullDownRefresh() {
    this.syncHeaderDatesAndSeason();
    return this.loadFirstPage().finally(() => wx.stopPullDownRefresh());
  },

  async loadFirstPage(chooseDefault = false) {
    const serial = ++this.requestSerial;
    const statusSerial = ++this.statusSerial;
    const loginGeneration = this.rememberLoginGeneration();
    const leagueId = this.data.selectedLeague;
    this.summarySerial += 1;
    this.setData({ state: "loading", items: [], nextMatch: null, offseasonInfo: null, leagueSummary: null, summarySeasonId: null, summarySeasonLabel: "", summaryReason: null, summaryState: "loading", hasMore: false, nextCursor: null, errorMessage: "", loadingMore: false, openCount: 0, doneCount: 0, hintText: "", resultsTransition: "results-enter" });
    let statusResult;
    try {
      statusResult = await getLeagueStatus();
    } catch (error) {
      statusResult = null;
    }
    if (serial !== this.requestSerial || statusSerial !== this.statusSerial || leagueId !== this.data.selectedLeague) return;
    const staleAfterStatus = this.handleStaleLoginGeneration(loginGeneration);
    if (staleAfterStatus) return staleAfterStatus;
    const statusOk = Boolean(statusResult && statusResult.statusCode === 200 && statusResult.data && Array.isArray(statusResult.data.items));
    const statuses = statusOk ? statusResult.data.items : [];
    const leagueStatusById = {};
    statuses.forEach((item) => { leagueStatusById[item.league_id] = item; });
    const activeLeagueIds = statuses.filter((item) => item.phase === "in_season" || item.phase === "break").map((item) => item.league_id);
    this.setData({ leagueStatusById, activeLeagueIds, leagues: this.data.leagues.map((league) => ({ ...league, offSeason: !!leagueStatusById[league.id] && ["completed", "between_seasons"].includes(leagueStatusById[league.id].phase) })) });
    if ((chooseDefault || this.needsDefaultLeague) && !this.userChangedLeague) {
      if (statusOk) {
        const selection = resolveDefaultLeagueFromStatus(statuses);
        if (serial !== this.requestSerial || statusSerial !== this.statusSerial || leagueId !== this.data.selectedLeague) return;
        const staleAfterSelect = this.handleStaleLoginGeneration(loginGeneration);
        if (staleAfterSelect) return staleAfterSelect;
        this.setData({ selectedLeague: selection.leagueId });
        this.needsDefaultLeague = false;
      } else {
        this.needsDefaultLeague = true;
      }
    }
    const selectedLeague = this.data.selectedLeague;
    let result;
    try {
      result = await listMatches({ ...dayBounds(this.data.selectedDate), league_id: selectedLeague, limit: 100 });
    } catch (error) {
      if (serial !== this.requestSerial || selectedLeague !== this.data.selectedLeague) return;
      const staleAfterError = this.handleStaleLoginGeneration(loginGeneration);
      if (staleAfterError) return staleAfterError;
      this.setData({ state: "error", errorMessage: (error && error.message) || "加载失败，请重试", loadingMore: false, nextMatch: null, offseasonInfo: null, openCount: 0, doneCount: 0, hintText: "" });
      return;
    }
    if (serial !== this.requestSerial || selectedLeague !== this.data.selectedLeague) return;
    const staleAfterList = this.handleStaleLoginGeneration(loginGeneration);
    if (staleAfterList) return staleAfterList;
    return this.applyListResult(result, true, loginGeneration);
  },

  loadEmptyStateFollowup(serial, loginGeneration) {
    if (loginGeneration !== undefined) {
      const stale = this.handleStaleLoginGeneration(loginGeneration);
      if (stale) return stale;
    }
    const leagueId = this.data.selectedLeague;
    const now = new Date();
    const status = this.data.leagueStatusById[leagueId];
    if (!status || !["completed", "between_seasons"].includes(status.phase)) {
      this.setData({ state: "no-match", nextMatch: status && status.next_matchday ? upcomingMatchInfo(status.next_matchday, now, this.data.dates) : null, emptyIsBreak: !!status && status.phase === "break", offseasonInfo: null });
      return;
    }
    const nextSeasonDate = status.phase === "between_seasons" ? status.next_season_kickoff_at : null;
    const activeLeagueId = this.data.activeLeagueIds.find((id) => id !== leagueId) || "";
    const activeLeagueName = (LEAGUES.find((league) => league.id === activeLeagueId) || {}).name || "";
    const leagueName = (LEAGUES.find((league) => league.id === leagueId) || {}).name || "本联赛";
    this.setData({ state: "offseason", nextMatch: null, offseasonInfo: { leagueName, nextSeasonDate, countdownDays: nextSeasonDate ? daysBetweenBeijingDates(now, nextSeasonDate) : null, activeLeagueId, activeLeagueName } });
    return this.loadLeagueSummary(serial, leagueId, loginGeneration);
  },

  async loadLeagueSummary(serial, leagueId, loginGeneration) {
    const summarySerial = ++this.summarySerial;
    const generation = loginGeneration === undefined ? currentLoginGeneration() : loginGeneration;
    this.setData({ summaryState: "loading", leagueSummary: null, summarySeasonId: null, summarySeasonLabel: "", summaryReason: null });
    try {
      const result = await getMyLeagueSummary({ leagueId });
      if (serial !== this.requestSerial || summarySerial !== this.summarySerial || leagueId !== this.data.selectedLeague) return;
      const stale = this.handleStaleLoginGeneration(generation);
      if (stale) return stale;
      if (result && (result.statusCode === 401 || (result.statusCode === 409 && result.code === "USER_DELETED"))) {
        this.setData({ summaryState: "guest", leagueSummary: null, summarySeasonId: null, summarySeasonLabel: "", summaryReason: null });
        return;
      }
      if (!result || result.statusCode !== 200) { this.setData({ summaryState: "error" }); return; }
      const data = result.data;
      this.setData({ summaryState: "ready", summarySeasonId: data.season_id, summarySeasonLabel: formatSummarySeasonLabel(data.season_id), leagueSummary: data.availability === "available" ? data.summary : null, summaryReason: data.availability === "available" ? null : data.reason });
    } catch (error) {
      if (serial !== this.requestSerial || summarySerial !== this.summarySerial || leagueId !== this.data.selectedLeague) return;
      const stale = this.handleStaleLoginGeneration(generation);
      if (stale) return stale;
      this.setData({ summaryState: "error" });
    }
  },

  onSummaryRetry() { return this.loadLeagueSummary(this.requestSerial, this.data.selectedLeague, currentLoginGeneration()); },

  applyListResult(result, replace, loginGeneration) {
    if (loginGeneration !== undefined) {
      const stale = this.handleStaleLoginGeneration(loginGeneration);
      if (stale) return stale;
    }
    if (!result || typeof result !== "object" || result.statusCode !== 200) {
      const errMsg = result && (result.message || (result.code || result.statusCode ? String(result.code || result.statusCode) : "")) || "加载失败，请重试";
      if (replace === false && this.data.items.length > 0) {
        this.setData({ errorMessage: errMsg, loadingMore: false });
        return;
      }
      this.setData({ state: "error", errorMessage: errMsg, loadingMore: false, nextMatch: null, offseasonInfo: null, openCount: 0, doneCount: 0, hintText: "" });
      return;
    }
    const payload = result.data || {};
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    const items = (replace ? rawItems : this.data.items.concat(rawItems)).map((item) => this.decorateItem(item));
    const page = payload.page || {};
    const hasMore = page.has_more === true;
    const { openCount, doneCount } = listCounts(items);
    const today = beijingParts();
    this.setData({
      state: items.length ? "list" : "empty",
      items,
      nextMatch: null,
      offseasonInfo: null,
      hasMore,
      nextCursor: page.next_cursor || null,
      errorMessage: "",
      loadingMore: false,
      openCount,
      doneCount,
      hintText: buildHintText({
        selectedDate: this.data.selectedDate,
        todayKey: today ? today.key : "",
        openCount,
        doneCount,
        hasMore,
      }),
    });
    if (replace && items.length === 0) return this.loadEmptyStateFollowup(this.requestSerial, loginGeneration);
  },

  clearSubmitError(key) {
    if (!this.data.submitErrors || !(key in this.data.submitErrors)) return;
    const errors = { ...this.data.submitErrors };
    delete errors[key];
    this.setData({ submitErrors: errors });
  },

  decorateItem(item) {
    const loginGeneration = this.rememberLoginGeneration();
    const kick = beijingParts(item.kickoff_at);
    const key = scope(this.data.selectedLeague, this.data.selectedDate, item.match_id);
    let draft = this.drafts[key] || { home: 0, away: 0 };
    if (hasUsablePrediction(item && item.my_prediction) && isPendingSyncRecord(this.submittedMap[key])) {
      delete this.submittedMap[key];
    }
    const submitted = resolveSubmitted(item, this.submittedMap[key], loginGeneration);
    const cardState = buildCardState(item, submitted);
    const hasScore = item.regular_home_score !== null && item.regular_home_score !== undefined && item.regular_away_score !== null && item.regular_away_score !== undefined;
    let storedUi = this.uiStates[key];
    if (!submitted && storedUi === "editing" && !cardState.showPredict) {
      this.uiStates[key] = "collapsed";
      delete this.drafts[key];
      this.clearSubmitError(key);
      storedUi = "collapsed";
      draft = { home: 0, away: 0 };
    }
    const uiState = submitted ? "submitted_locked" : (storedUi && storedUi !== "submitted_locked" ? storedUi : "collapsed");
    const leagueName = (LEAGUES.find((league) => league.id === item.league_id) || {}).name || "比赛";
    const roundText = formatRound(item.round_id);
    const leagueId = item.league_id || this.data.selectedLeague;
    const homePresented = presentTeam(item.home_team, leagueId);
    const awayPresented = presentTeam(item.away_team, leagueId);
    const showCrowdLink = item.match_status === "live" ||
      item.match_status === "finished" ||
      (item.match_status === "scheduled" && (item.is_prediction_closed === true || item.can_predict_reason === "CLOSED"));
    return Object.assign({}, item, cardState, {
      key, uiState, editorVisible: uiState !== "collapsed", draft,
      showCrowdLink,
      crowdLinkText: CROWD_COPY.homeLink,
      homeLogo: homePresented.logo,
      awayLogo: awayPresented.logo,
      homeNameZh: homePresented.nameZh,
      awayNameZh: awayPresented.nameZh,
      homeMissing: homePresented.missing,
      awayMissing: awayPresented.missing,
      timeText: item.display_time || (kick ? `${pad(kick.hour)}:${pad(kick.minute)}` : "--:--"),
      metaText: roundText ? `${leagueName} · ${roundText}` : leagueName,
      scoreText: hasScore ? `${item.regular_home_score} : ${item.regular_away_score}` : "VS",
      bugClass: item.match_status === "live" || item.match_status === "finished" ? "dark" : "",
      derivedResult: draft.home > draft.away ? "主胜" : draft.home < draft.away ? "客胜" : "平局",
      submitError: (this.data.submitErrors && this.data.submitErrors[key]) || "",
    });
  },

  refreshItems() {
    this.rememberLoginGeneration();
    const items = this.data.items.map((item) => this.decorateItem(item));
    const { openCount, doneCount } = listCounts(items);
    const today = beijingParts();
    this.setData({
      items,
      openCount,
      doneCount,
      hintText: buildHintText({
        selectedDate: this.data.selectedDate,
        todayKey: today ? today.key : "",
        openCount,
        doneCount,
        hasMore: this.data.hasMore,
      }),
    });
  },
  closeEditors() {
    Object.keys(this.uiStates).forEach((key) => {
      if (this.uiStates[key] !== "collapsed" && this.uiStates[key] !== "submitting") {
        this.uiStates[key] = "collapsed";
        delete this.drafts[key];
      }
    });
    this.setData({ submitErrors: {} });
    this.refreshItems();
  },

  onCardTap(event) { const id = event.currentTarget.dataset.matchId; if (id) wx.navigateTo({ url: `/pages/match-detail/match-detail?id=${id}` }); },
  stopCardTap() {},
  onFeedTap() {},

  onPredictTap(event) {
    const id = event.currentTarget.dataset.matchId;
    const key = scope(this.data.selectedLeague, this.data.selectedDate, id);
    this.closeEditors();
    this.uiStates[key] = "editing";
    if (!this.drafts[key]) this.drafts[key] = { home: 0, away: 0 };
    this.refreshItems();
    this.setData({ scrollIntoView: `match-${id}` });
    this.clearScrollTimer();
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      this.setData({ scrollIntoView: "" });
    }, 900);
  },

  onScoreTap(event) {
    const { matchId, side, delta } = event.currentTarget.dataset;
    const key = scope(this.data.selectedLeague, this.data.selectedDate, matchId);
    if (this.uiStates[key] === "submitting" || this.uiStates[key] === "submitted_locked") return;
    this.clearSubmitError(key);
    const current = this.drafts[key] || { home: 0, away: 0 };
    current[side] = Math.max(0, Math.min(20, current[side] + Number(delta)));
    this.drafts[key] = current;
    this.refreshItems();
  },

  onSubmitTap(event) {
    const matchId = event.currentTarget.dataset.matchId;
    const key = scope(this.data.selectedLeague, this.data.selectedDate, matchId);
    const item = this.data.items.find((entry) => entry.match_id === matchId);
    if (!item || this.uiStates[key] === "submitting" || this.uiStates[key] === "submitted_locked") return;
    this.clearSubmitError(key);
    const previousGeneration = this.loginGeneration;
    const draft = this.drafts[key] || { home: 0, away: 0 };
    const submittedScore = Object.freeze({ home: draft.home, away: draft.away });
    const previousPayload = this.lastPayloads[key];
    if (!previousPayload || previousPayload.home !== submittedScore.home || previousPayload.away !== submittedScore.away) {
      this.idempotencyKeys[key] = createUuidV4();
      this.lastPayloads[key] = { home: submittedScore.home, away: submittedScore.away };
    }
    this.uiStates[key] = "submitting";
    this.refreshItems();
    const loginGeneration = currentLoginGeneration();
    if (previousGeneration !== undefined && previousGeneration !== this.loginGeneration) {
      return this.loadFirstPage();
    }
    let pending;
    try {
      pending = Promise.resolve(submitPrediction({
        idempotencyKey: this.idempotencyKeys[key],
        matchId,
        homeScore: submittedScore.home,
        awayScore: submittedScore.away,
      }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then((result) => {
      const stale = this.handleStaleLoginGeneration(loginGeneration);
      if (stale) return stale;
      if (!result || typeof result !== "object") {
        this.uiStates[key] = "editing";
        const errors = { ...(this.data.submitErrors || {}) };
        errors[key] = "提交失败，请重试";
        this.setData({ submitErrors: errors });
        this.refreshItems();
        return;
      }
      if (result.statusCode === 200 || result.statusCode === 201) {
        this.clearSubmitError(key);
        this.submittedMap[key] = { home: submittedScore.home, away: submittedScore.away, generation: loginGeneration };
        this.uiStates[key] = "submitted_locked";
        delete this.drafts[key];
        delete this.idempotencyKeys[key];
        delete this.lastPayloads[key];
        markMyPredictionsDirty();
        this.refreshItems();
        return this.silentRefreshAfterSubmit(loginGeneration);
      }
      if (result.statusCode === 409 && result.code === "PREDICTION_ALREADY_SUBMITTED") {
        this.clearSubmitError(key);
        this.submittedMap[key] = { pendingSync: true, loginGeneration };
        this.uiStates[key] = "submitted_locked";
        delete this.drafts[key];
        delete this.idempotencyKeys[key];
        delete this.lastPayloads[key];
        markMyPredictionsDirty();
        this.refreshItems();
        return this.silentRefreshAfterSubmit(loginGeneration);
      }
      if (result.statusCode === 409 && ["MATCH_NOT_PREDICTABLE", "PREDICTION_LOCKED"].includes(result.code)) {
        this.clearSubmitError(key);
        this.uiStates[key] = "collapsed";
        delete this.drafts[key];
        delete this.idempotencyKeys[key];
        delete this.lastPayloads[key];
        this.refreshItems();
        return this.silentRefreshAfterSubmit(loginGeneration);
      }
      if (result.statusCode === 409 && result.code === "IDEMPOTENCY_KEY_REUSED") {
        delete this.idempotencyKeys[key];
        delete this.lastPayloads[key];
      }
      this.uiStates[key] = "editing";
      const errors = { ...(this.data.submitErrors || {}) };
      errors[key] = result.message || String(result.code || result.statusCode);
      this.setData({ submitErrors: errors });
      this.refreshItems();
    }).catch((error) => {
      const stale = this.handleStaleLoginGeneration(loginGeneration);
      if (stale) return stale;
      this.uiStates[key] = "editing";
      const errors = { ...(this.data.submitErrors || {}) };
      errors[key] = (error && error.message) || "提交失败，请重试";
      this.setData({ submitErrors: errors });
      this.refreshItems();
    });
  },

  async silentRefreshAfterSubmit(loginGeneration) {
    const serial = this.requestSerial;
    const selectedLeague = this.data.selectedLeague;
    const selectedDate = this.data.selectedDate;
    let result;
    try {
      result = await listMatches({ ...dayBounds(selectedDate), league_id: selectedLeague, limit: 100 });
    } catch (_error) {
      return;
    }
    if (
      serial !== this.requestSerial ||
      selectedLeague !== this.data.selectedLeague ||
      selectedDate !== this.data.selectedDate
    ) return;
    if (loginGeneration !== undefined) {
      const stale = this.handleStaleLoginGeneration(loginGeneration);
      if (stale) return stale;
    }
    if (!result || result.statusCode !== 200 || !result.data || !Array.isArray(result.data.items)) return;
    const freshById = new Map();
    result.data.items.forEach((entry) => {
      if (entry && entry.match_id) freshById.set(entry.match_id, entry);
    });
    const currentItems = Array.isArray(this.data.items) && this.data.items.length > 0
      ? this.data.items
      : result.data.items;
    const nextItems = currentItems.map((entry) => {
      const fresh = entry && entry.match_id ? freshById.get(entry.match_id) : null;
      return this.decorateItem(fresh || entry);
    });
    const { openCount, doneCount } = listCounts(nextItems);
    const today = beijingParts();
    this.setData({
      items: nextItems,
      openCount,
      doneCount,
      hintText: buildHintText({
        selectedDate: this.data.selectedDate,
        todayKey: today ? today.key : "",
        openCount,
        doneCount,
        hasMore: this.data.hasMore,
      }),
    });
  },

  onMore() {
    if (this.data.loadingMore || !this.data.hasMore || !this.data.nextCursor) return;
    const previousGeneration = this.loginGeneration;
    const serial = this.requestSerial;
    const loginGeneration = this.rememberLoginGeneration();
    if (previousGeneration !== undefined && previousGeneration !== loginGeneration) {
      return this.loadFirstPage();
    }
    this.setData({ loadingMore: true, errorMessage: "" });
    let pending;
    try {
      pending = Promise.resolve(listMatches({
        ...dayBounds(this.data.selectedDate),
        league_id: this.data.selectedLeague,
        limit: 100,
        cursor: this.data.nextCursor,
      }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then((result) => {
      if (serial !== this.requestSerial) return;
      return this.applyListResult(result, false, loginGeneration);
    }).catch((error) => {
      if (serial !== this.requestSerial) return;
      const stale = this.handleStaleLoginGeneration(loginGeneration);
      if (stale) return stale;
      this.setData({ loadingMore: false, errorMessage: (error && error.message) || "加载更多失败，请重试" });
    });
  },
});

if (typeof module !== "undefined") module.exports = { buildDates, beijingParts, buildHintText, upcomingMatchInfo };
