const { getTeamLogo, getLeagueLogo } = require("../../utils/logo-registry.js");
const { resolveNickname, truncateNickname } = require("../../utils/nickname.js");
const { listMatches } = require("../../services/matches.js");
const { resolveDefaultLeague } = require("../../utils/matches-default-league.js");
const { createUuidV4, submitPrediction } = require("../../services/predictions.js");
const { COPY: CROWD_COPY } = require("../../utils/crowd-copy.js");

const LEAGUES = [
  { id: "premier_league", name: "英超" },
  { id: "la_liga", name: "西甲" },
  { id: "bundesliga", name: "德甲" },
  { id: "serie_a", name: "意甲" },
  { id: "ligue_1", name: "法甲" },
  { id: "chinese_super_league", name: "中超" },
];
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const REASON_TEXT = { ALREADY_SUBMITTED: "已锁定 · 不可修改", AUTH_REQUIRED: "需登录后预测", USER_DELETED: "账号已注销", KICKOFF_UNCONFIRMED: "开球未确认", NOT_SCHEDULED: "非可预测赛程", CLOSED: "预测已关闭" };
const RESULT_TEXT = {
  hit3: { reasonChip: "+3 赛果命中", chipClass: "hit3" },
  hit12: { reasonChip: "+12 精确命中", chipClass: "hit12" },
  miss: { reasonChip: "+0 未命中", chipClass: "miss" },
};
const scope = (league, date, matchId) => `${league}:${date}:${matchId}`;
const pad = (n) => (n < 10 ? `0${n}` : String(n));

function beijingParts(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const text = date.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
  const [ymd, hms] = text.split(" ");
  const [year, month, day] = ymd.split("-").map(Number);
  const [hour, minute] = hms.split(":").map(Number);
  return { year, month, day, hour, minute, key: ymd };
}

// 日期条开放范围：今天起共 11 个日期（今天 … 今天+10）。
// 2026-09-26 决策：移除日历入口、日期条铺满整行，开放 n+10 天以内的选择（n = 今天，含今天）。
// 要改开放范围只需改这一个常量；verify-home-migration.py 会校验它等于 11。
const DATE_SPAN_DAYS = 11;

function buildDates(anchor) {
  const dates = [];
  const start = new Date(anchor.getTime());
  start.setHours(12, 0, 0, 0);
  for (let i = 0; i < DATE_SPAN_DAYS; i += 1) {
    const date = new Date(start.getTime());
    date.setDate(start.getDate() + i);
    dates.push({ key: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, label: i === 0 ? "今天" : i === 1 ? "明天" : WEEKDAYS[date.getDay()], day: pad(date.getDate()) });
  }
  return dates;
}

function dayBounds(key) {
  const start = new Date(`${key}T00:00:00+08:00`);
  return {
    from: start.toISOString(),
    to: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}
function statusView(item) {
  const reason = item.can_predict_reason;
  if (item.match_status === "live") return { cardClass: "is-live", stateClass: "live", stateText: "进行中" };
  if (item.match_status === "finished") return { cardClass: "is-done", stateClass: "done", stateText: "完场" };
  if (["postponed", "cancelled", "abandoned"].includes(item.match_status)) return { cardClass: "is-closed", stateClass: "closed", stateText: item.match_status === "postponed" ? "延期" : item.match_status === "cancelled" ? "取消" : "腰斩" };
  if (reason === "ALREADY_SUBMITTED") return { cardClass: "is-submitted", stateClass: "lock", stateText: "已提交" };
  if (item.match_status === "scheduled" && item.can_predict && reason === null) return { cardClass: "is-open", stateClass: "", stateText: "未开赛" };
  return { cardClass: "is-closed", stateClass: "closed", stateText: "未开赛" };
}

function reasonChip(item) {
  if (item.result_type && RESULT_TEXT[item.result_type]) return RESULT_TEXT[item.result_type];
  if (item.can_predict && item.can_predict_reason === null) return { reasonChip: "", chipClass: "" };
  if (item.match_status === "live") return { reasonChip: "预测已关闭", chipClass: "live" };
  if (REASON_TEXT[item.can_predict_reason]) return { reasonChip: REASON_TEXT[item.can_predict_reason], chipClass: item.can_predict_reason === "ALREADY_SUBMITTED" ? "lock" : "closed" };
  if (item.match_status === "finished") return { reasonChip: "已结束", chipClass: "lock" };
  return { reasonChip: "", chipClass: "" };
}

function formatPrediction(prediction) {
  if (!prediction) return "";
  const home = prediction.home === undefined ? prediction.pred_home_score : prediction.home;
  const away = prediction.away === undefined ? prediction.pred_away_score : prediction.away;
  return `我的预测 ${home} : ${away}`;
}

Page({
  data: {
    state: "loading", items: [], errorMessage: "", hasMore: false, nextCursor: null, loadingMore: false, nickname: "",
    leagues: [], selectedLeague: "premier_league", dates: [], selectedDate: "", openCount: 0, doneCount: 0, recentScore: null,
    scrollIntoView: "", resultsTransition: "results-enter",
  },
  drafts: {}, uiStates: {}, submittedMap: {}, idempotencyKeys: {}, lastPayloads: {}, requestSerial: 0,

  onLoad() {
    const dates = buildDates(new Date());
    this.setData({ dates, selectedDate: dates[0].key, leagues: LEAGUES.map((item) => ({ ...item, logo: getLeagueLogo(item.id) })), nickname: truncateNickname(resolveNickname()) });
    resolveDefaultLeague(listMatches, new Date()).then((leagueId) => {
      if (!this.userChangedLeague) this.setData({ selectedLeague: leagueId });
      this.initialized = true;
      this.loadFirstPage();
    });
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 0 });
    if (this.initialized) this.loadFirstPage();
  },

  onLeagueTap(event) {
    const league = event.currentTarget.dataset.id;
    if (!league || league === this.data.selectedLeague) return;
    this.userChangedLeague = true;
    this.closeEditors();
    this.setData({ selectedLeague: league, scrollIntoView: "", state: "loading", items: [], hasMore: false, nextCursor: null, openCount: 0, doneCount: 0, resultsTransition: "results-exit" });
    setTimeout(() => this.loadFirstPage(), 180);
  },

  onDateTap(event) {
    const date = event.currentTarget.dataset.key;
    if (!date || date === this.data.selectedDate) return;
    this.closeEditors();
    this.setData({ selectedDate: date, state: "loading", items: [], scrollIntoView: "", resultsTransition: "results-exit" });
    setTimeout(() => this.loadFirstPage(), 180);
  },

  onRetry() { this.loadFirstPage(); },

  loadFirstPage() {
    const serial = ++this.requestSerial;
    this.setData({ state: "loading", items: [], hasMore: false, nextCursor: null, errorMessage: "", loadingMore: false, resultsTransition: "results-enter" });
    return listMatches({ ...dayBounds(this.data.selectedDate), league_id: this.data.selectedLeague, limit: 100 })
      .then((result) => {
        if (serial !== this.requestSerial) return;
        this.applyListResult(result, true);
      });
  },

  applyListResult(result, replace) {
    if (result.statusCode !== 200) { this.setData({ state: "error", errorMessage: result.message || String(result.code || result.statusCode), loadingMore: false }); return; }
    const payload = result.data || {};
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    const items = (replace ? rawItems : this.data.items.concat(rawItems)).map((item) => this.decorateItem(item));
    const page = payload.page || {};
    this.setData({ state: items.length ? "list" : "empty", items, hasMore: page.has_more === true, nextCursor: page.next_cursor || null, errorMessage: "", loadingMore: false, openCount: items.filter((item) => item.showPredict).length, doneCount: items.filter((item) => item.can_predict_reason === "ALREADY_SUBMITTED").length });
  },

  decorateItem(item) {
    const kick = beijingParts(item.kickoff_at);
    const view = statusView(item);
    const key = scope(this.data.selectedLeague, this.data.selectedDate, item.match_id);
    const draft = this.drafts[key] || { home: 0, away: 0 };
    const submitted = this.submittedMap[key];
    const chip = submitted ? { reasonChip: "已锁定 · 不可修改", chipClass: "lock" } : reasonChip(item);
    const hasScore = item.regular_home_score !== null && item.regular_home_score !== undefined && item.regular_away_score !== null && item.regular_away_score !== undefined;
    const uiState = submitted ? "submitted_locked" : (this.uiStates[key] || "collapsed");
    return Object.assign({}, item, view, chip, {
      key, uiState, editorVisible: uiState !== "collapsed", draft,
      crowdLinkText: CROWD_COPY.homeLink,
      showPredict: item.can_predict === true && item.can_predict_reason === null && !submitted,
      homeLogo: getTeamLogo(item.league_id || this.data.selectedLeague, item.home_team),
      awayLogo: getTeamLogo(item.league_id || this.data.selectedLeague, item.away_team),
      timeText: item.display_time || (kick ? `${pad(kick.hour)}:${pad(kick.minute)}` : "--:--"),
      metaText: `${(LEAGUES.find((league) => league.id === item.league_id) || {}).name || "比赛"} · ${item.round_id || "本轮"}`,
      scoreText: hasScore ? `${item.regular_home_score} : ${item.regular_away_score}` : "VS",
      scoreSub: item.can_predict_reason === "ALREADY_SUBMITTED" ? "已锁定" : item.match_status === "live" ? "LIVE" : item.match_status === "finished" ? (hasScore ? "FT" : "待结算") : item.display_time || (kick ? `${pad(kick.hour)}:${pad(kick.minute)}` : ""),
      bugClass: item.match_status === "live" || item.match_status === "finished" ? "dark" : "",
      predText: submitted ? formatPrediction(submitted) : item.my_prediction ? formatPrediction(item.my_prediction) : item.match_status === "live" ? formatPrediction(item.my_prediction) : item.match_status === "finished" ? formatPrediction(item.my_prediction) : "未开赛",
      derivedResult: draft.home > draft.away ? "主胜" : draft.home < draft.away ? "客胜" : "平局",
      submitError: this.data.submitErrors ? this.data.submitErrors[key] : "",
    });
  },

  refreshItems() { this.setData({ items: this.data.items.map((item) => this.decorateItem(item)) }); },
  closeEditors() { Object.keys(this.uiStates).forEach((key) => { if (this.uiStates[key] !== "collapsed") { this.uiStates[key] = "collapsed"; delete this.drafts[key]; } }); this.refreshItems(); },

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
    setTimeout(() => this.setData({ scrollIntoView: "" }), 900);
  },

  onScoreTap(event) {
    const { matchId, side, delta } = event.currentTarget.dataset;
    const key = scope(this.data.selectedLeague, this.data.selectedDate, matchId);
    const current = this.drafts[key] || { home: 0, away: 0 };
    current[side] = Math.max(0, Math.min(20, current[side] + Number(delta)));
    this.drafts[key] = current;
    this.refreshItems();
  },

  onSubmitTap(event) {
    const matchId = event.currentTarget.dataset.matchId;
    const key = scope(this.data.selectedLeague, this.data.selectedDate, matchId);
    const item = this.data.items.find((entry) => entry.match_id === matchId);
    if (!item || this.uiStates[key] === "submitting") return;
    const draft = this.drafts[key] || { home: 0, away: 0 };
    const previousPayload = this.lastPayloads[key];
    if (!previousPayload || previousPayload.home !== draft.home || previousPayload.away !== draft.away) {
      this.idempotencyKeys[key] = createUuidV4();
      this.lastPayloads[key] = { ...draft };
    }
    this.uiStates[key] = "submitting";
    this.refreshItems();
    submitPrediction({
      idempotencyKey: this.idempotencyKeys[key],
      matchId,
      homeScore: draft.home,
      awayScore: draft.away,
    }).then((result) => {
      if (result.statusCode === 200 || result.statusCode === 201) {
        this.submittedMap[key] = { ...draft };
        this.uiStates[key] = "submitted_locked";
        delete this.drafts[key];
        delete this.idempotencyKeys[key];
        delete this.lastPayloads[key];
        this.refreshItems();
        this.loadFirstPage();
        return;
      }
      if (result.statusCode === 409 && result.code === "PREDICTION_ALREADY_SUBMITTED") {
        this.uiStates[key] = "submitted_locked";
        delete this.drafts[key];
        this.loadFirstPage();
        return;
      }
      if (result.statusCode === 409 && ["MATCH_NOT_PREDICTABLE", "PREDICTION_LOCKED"].includes(result.code)) {
        this.uiStates[key] = "collapsed";
        this.loadFirstPage();
        return;
      }
      this.uiStates[key] = "editing";
      const errors = { ...(this.data.submitErrors || {}) };
      errors[key] = result.message || String(result.code || result.statusCode);
      this.setData({ submitErrors: errors });
      this.refreshItems();
    });
  },

  onMore() {
    if (this.data.loadingMore || !this.data.hasMore || !this.data.nextCursor) return;
    const serial = this.requestSerial;
    this.setData({ loadingMore: true });
    listMatches({
      ...dayBounds(this.data.selectedDate),
      league_id: this.data.selectedLeague,
      limit: 100,
      cursor: this.data.nextCursor,
    }).then((result) => {
      if (serial === this.requestSerial) this.applyListResult(result, false);
    });
  },
});
