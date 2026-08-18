const { getTeamLogo, getLeagueLogo } = require("../../utils/logo-registry.js");

const MOCK_MATCHES = [
  { match_id: "mock-pl-001", league_id: "premier_league", league_name: "英超", round_id: "第1轮", kickoff_at: "2026-08-18T19:00:00+08:00", match_status: "scheduled", can_predict: true, can_predict_reason: null, regular_home_score: null, regular_away_score: null, home_team: { team_id: "arsenal", name: "阿森纳" }, away_team: { team_id: "chelsea", name: "切尔西" } },
  { match_id: "mock-pl-002", league_id: "premier_league", league_name: "英超", round_id: "第1轮", kickoff_at: "2026-08-18T21:30:00+08:00", match_status: "scheduled", can_predict: true, can_predict_reason: null, regular_home_score: null, regular_away_score: null, home_team: { team_id: "liverpool", name: "利物浦" }, away_team: { team_id: "manchester-city", name: "曼城" } },
  { match_id: "mock-laliga-001", league_id: "la_liga", league_name: "西甲", round_id: "第1轮", kickoff_at: "2026-08-18T22:00:00+08:00", match_status: "scheduled", can_predict: true, can_predict_reason: null, regular_home_score: null, regular_away_score: null, home_team: { team_id: "real-madrid", name: "皇家马德里" }, away_team: { team_id: "barcelona", name: "巴塞罗那" } },
  { match_id: "mock-ligue-001", league_id: "ligue_1", league_name: "法甲", round_id: "第1轮", kickoff_at: "2026-08-18T20:00:00+08:00", match_status: "scheduled", can_predict: true, can_predict_reason: null, regular_home_score: null, regular_away_score: null, home_team: { team_id: "paris-saint-germain", name: "巴黎圣日耳曼" }, away_team: { team_id: "marseille", name: "马赛" } },
  { match_id: "mock-csl-001", league_id: "chinese_super_league", league_name: "中超", round_id: "第1轮", kickoff_at: "2026-08-18T18:00:00+08:00", match_status: "scheduled", can_predict: true, can_predict_reason: null, regular_home_score: null, regular_away_score: null, home_team: { team_id: "beijing-guoan", name: "北京国安" }, away_team: { team_id: "shanghai-shenhua", name: "上海申花" } },
];

const LEAGUES = [
  { id: "premier_league", name: "英超" },
  { id: "la_liga", name: "西甲" },
  { id: "ligue_1", name: "法甲" },
  { id: "chinese_super_league", name: "中超" },
];
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const REASON_TEXT = { ALREADY_SUBMITTED: "已锁定 · 不可修改", AUTH_REQUIRED: "需登录后预测", USER_DELETED: "账号已注销", KICKOFF_UNCONFIRMED: "开球未确认", NOT_SCHEDULED: "非可预测赛程", CLOSED: "预测已关闭" };
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

function buildDates(anchor) {
  const dates = [];
  const start = new Date(anchor.getTime());
  start.setHours(12, 0, 0, 0);
  for (let i = 0; i < 5; i += 1) {
    const date = new Date(start.getTime());
    date.setDate(start.getDate() + i);
    dates.push({ key: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, label: i === 0 ? "今天" : i === 1 ? "明天" : WEEKDAYS[date.getDay()], day: pad(date.getDate()) });
  }
  return dates;
}

function dayBounds(key) { return { from: `${key}T00:00:00+08:00`, to: `${key}T23:59:59+08:00` }; }
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
  if (item.can_predict && item.can_predict_reason === null) return { reasonChip: "", chipClass: "" };
  if (REASON_TEXT[item.can_predict_reason]) return { reasonChip: REASON_TEXT[item.can_predict_reason], chipClass: item.can_predict_reason === "ALREADY_SUBMITTED" ? "lock" : "closed" };
  if (item.match_status === "live") return { reasonChip: "预测已关闭", chipClass: "live" };
  if (item.match_status === "finished") return { reasonChip: "已结束", chipClass: "lock" };
  return { reasonChip: "", chipClass: "" };
}

Page({
  data: {
    state: "loading", items: [], errorMessage: "", hasMore: false, nextCursor: null, loadingMore: false,
    leagues: [], selectedLeague: "premier_league", dates: [], selectedDate: "", openCount: 0, doneCount: 0,
    recentScore: 12, scrollIntoView: "", contentTransition: "content-enter",
  },
  drafts: {}, uiStates: {}, submittedMap: {}, idempotencyKeys: {}, lastPayloads: {}, requestSerial: 0,

  onLoad() {
    const dates = buildDates(new Date());
    this.setData({ dates, selectedDate: dates[0].key, leagues: LEAGUES.map((item) => ({ ...item, logo: getLeagueLogo(item.id) })) });
    this.loadFirstPage();
  },

  onLeagueTap(event) {
    const league = event.currentTarget.dataset.id;
    if (!league || league === this.data.selectedLeague) return;
    this.closeEditors();
    this.setData({ selectedLeague: league, scrollIntoView: "", state: "loading", items: [], hasMore: false, nextCursor: null, openCount: 0, doneCount: 0, contentTransition: "content-exit" });
    setTimeout(() => this.loadFirstPage(), 180);
  },

  onDateTap(event) {
    const date = event.currentTarget.dataset.key;
    if (!date || date === this.data.selectedDate) return;
    this.closeEditors();
    this.setData({ selectedDate: date, state: "loading", items: [], scrollIntoView: "", contentTransition: "content-exit" });
    setTimeout(() => this.loadFirstPage(), 180);
  },

  onCalendarTap() { wx.showToast({ title: "日历选择即将开放", icon: "none" }); },
  onRetry() { this.loadFirstPage(); },

  loadFirstPage() {
    const serial = ++this.requestSerial;
    const rawItems = MOCK_MATCHES.filter((item) => item.league_id === this.data.selectedLeague);
    const items = rawItems.map((item) => this.decorateItem(item));
    this.setData({ state: items.length ? "list" : "empty", items, hasMore: false, nextCursor: null, errorMessage: "", loadingMore: false, openCount: items.filter((item) => item.showPredict).length, doneCount: items.filter((item) => item.can_predict_reason === "ALREADY_SUBMITTED").length, contentTransition: "content-enter" });
    return serial;
  },

  applyListResult(result, replace) {
    if (result.statusCode !== 200) { this.setData({ state: "error", errorMessage: result.message || String(result.code || result.statusCode), loadingMore: false }); return; }
    const payload = result.data || {};
    const rawItems = Array.isArray(payload.items) ? payload.items.filter((item) => item.league_id === this.data.selectedLeague) : [];
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
    const homeId = item.home_team && item.home_team.team_id;
    const awayId = item.away_team && item.away_team.team_id;
    const uiState = submitted ? "submitted_locked" : (this.uiStates[key] || "collapsed");
    return Object.assign({}, item, view, chip, {
      key, uiState, editorVisible: uiState !== "collapsed", draft,
      showPredict: item.can_predict === true && item.can_predict_reason === null && !submitted,
      homeLogo: getTeamLogo(item.league_id || this.data.selectedLeague, homeId),
      awayLogo: getTeamLogo(item.league_id || this.data.selectedLeague, awayId),
      timeText: kick ? `${pad(kick.hour)}:${pad(kick.minute)}` : "--:--",
      metaText: `${item.league_name || "英超"} · ${item.round_id || "本轮"}`,
      scoreText: hasScore ? `${item.regular_home_score} : ${item.regular_away_score}` : "VS",
      scoreSub: item.match_status === "live" ? "LIVE" : item.match_status === "finished" ? (hasScore ? "FT" : "待结算") : kick ? `${pad(kick.hour)}:${pad(kick.minute)}` : "",
      bugClass: item.match_status === "live" || item.match_status === "finished" ? "dark" : "",
      predText: submitted ? `我的预测 ${submitted.home} : ${submitted.away}` : item.can_predict_reason === "ALREADY_SUBMITTED" ? "我的预测已提交" : item.match_status === "live" ? "比赛进行中" : item.match_status === "finished" ? (hasScore ? "完场" : "待结算/暂无比分") : "未开赛",
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
    this.uiStates[key] = "submitting";
    this.refreshItems();
    setTimeout(() => {
      this.submittedMap[key] = { ...draft };
      this.uiStates[key] = "submitted_locked";
      delete this.drafts[key];
      this.refreshItems();
    }, 900);
  },

  onMore() {},
});
