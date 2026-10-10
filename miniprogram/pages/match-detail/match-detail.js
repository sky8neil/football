const { getMatchDetail, getMatchCrowd } = require("../../services/matches.js");
const { createUuidV4, submitPrediction } = require("../../services/predictions.js");
const { getTeamLogo } = require("../../utils/logo-registry.js");
const { crowdPlan, crowdCard } = require("../../utils/crowd-view-model.js");
const { COPY } = require("../../utils/crowd-copy.js");

const REASON_TEXT = {
  AUTH_REQUIRED: "登录后可提交预测",
  USER_DELETED: "账号已注销",
  ALREADY_SUBMITTED: "已提交",
  KICKOFF_UNCONFIRMED: "开球未确认",
  NOT_SCHEDULED: "当前赛程不可预测",
  CLOSED: "预测已截止",
};

const STATUS_TEXT = {
  scheduled: "未开赛",
  live: "进行中",
  finished: "完场",
  postponed: "延期",
  cancelled: "取消",
  abandoned: "腰斩",
};

function parseScore(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0 || value > 20) {
    return null;
  }
  return value;
}

function formatRegularScore(match) {
  if (
    !match ||
    match.regular_home_score === null ||
    match.regular_home_score === undefined ||
    match.regular_away_score === null ||
    match.regular_away_score === undefined
  ) {
    return "待结算/暂无比分";
  }
  return match.regular_home_score + " - " + match.regular_away_score;
}

function settlementText(value) {
  return value === null || value === undefined ? "待结算" : String(value);
}

function reasonText(reason) {
  if (reason === null || reason === undefined) {
    return "";
  }
  return REASON_TEXT[reason] || reason;
}

function formatShanghaiTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function derivedResult(home, away) {
  if (Number(home) > Number(away)) return "主胜";
  if (Number(home) < Number(away)) return "客胜";
  return "平局";
}

Page({
  data: {
    matchId: "",
    state: "loading",
    errorMessage: "",
    match: null,
    regularScoreText: "",
    myPrediction: null,
    myPredictionScore: "",
    myMatchScoreText: "",
    myWdlHitText: "",
    myExactHitText: "",
    predictionPointsText: "",
    predictionResultText: "",
    canSubmit: false,
    submitDisabledReason: "",
    identityMissing: false,
    userDeleted: false,
    homeScore: 0,
    awayScore: 0,
    derivedResultText: "平局",
    kickoffText: "",
    statusText: "",
    homeLogo: "",
    awayLogo: "",
    crowdState: "idle",
    crowdKind: "hidden",
    crowdTitle: COPY.title,
    crowdMessage: "",
    crowdRetryText: COPY.retry,
    crowdLoginText: COPY.login,
    crowdYourChoice: COPY.yourChoice,
    crowdActualLabel: COPY.actualTag,
    crowdLoadingText: COPY.loading,
    crowdFooter: "",
    crowdSegments: [],
    crowdComparisonText: "",
    submitting: false,
    formError: "",
  },

  idempotencyKey: null,
  lastPayload: null,
  crowdRequestSerial: 0,
  refreshAfterSession: false,

  onLoad(query) {
    const matchId = query && query.id ? String(query.id) : "";
    this.setData({ matchId });
    this.loadDetail();
  },

  onShow() {
    if (this.refreshAfterSession) {
      this.refreshAfterSession = false;
      this.loadDetail();
    }
  },

  ensureIntentKey() {
    if (!this.idempotencyKey) {
      this.idempotencyKey = createUuidV4();
    }
  },

  loadDetail() {
    if (!this.data.matchId) {
      this.setData({ state: "error", errorMessage: "缺少比赛 id" });
      return;
    }
    this.setData({ state: "loading", errorMessage: "" });
    getMatchDetail(this.data.matchId).then((result) => {
      this.applyDetailResult(result);
    });
  },

  applyDetailResult(result) {
    if (result.statusCode === 429 && result.code === "RATE_LIMITED") {
      this.setData({
        state: "error",
        errorMessage: result.message || result.code,
      });
      return;
    }
    if (result.statusCode !== 200) {
      this.setData({
        state: "error",
        errorMessage: result.message || String(result.code || result.statusCode),
      });
      return;
    }
    const match = result.data || {};
    this.applyMatch(match);
  },

  applyMatch(match) {
    const reason = match.can_predict_reason === undefined ? null : match.can_predict_reason;
    const canSubmit = match.can_predict === true && reason === null;
    if (canSubmit) {
      this.ensureIntentKey();
    }
    const myPrediction = match.my_prediction || null;
    this.setData({
      state: "ready",
      match,
      regularScoreText: formatRegularScore(match),
      myPrediction,
      myPredictionScore: myPrediction
        ? myPrediction.pred_home_score + " - " + myPrediction.pred_away_score
        : "",
      myMatchScoreText: myPrediction ? settlementText(myPrediction.match_score) : "",
      myWdlHitText: myPrediction ? settlementText(myPrediction.wdl_hit) : "",
      myExactHitText: myPrediction ? settlementText(myPrediction.exact_hit) : "",
      predictionPointsText: myPrediction && myPrediction.match_score !== null
        ? `+${myPrediction.match_score}`
        : "待结算",
      predictionResultText: myPrediction && myPrediction.exact_hit === true
        ? "精确命中"
        : myPrediction && myPrediction.wdl_hit === true
          ? "赛果命中"
          : myPrediction && myPrediction.match_score === null
            ? "等待比赛结算"
            : myPrediction ? "未命中" : "",
      canSubmit,
      submitDisabledReason: canSubmit ? "" : reasonText(reason),
      identityMissing: reason === "AUTH_REQUIRED",
      userDeleted: reason === "USER_DELETED",
      errorMessage: "",
      formError: "",
      submitting: false,
      homeLogo: getTeamLogo(match.league_id, match.home_team),
      awayLogo: getTeamLogo(match.league_id, match.away_team),
      kickoffText: formatShanghaiTime(match.kickoff_at),
      statusText: STATUS_TEXT[match.match_status] || match.match_status,
      derivedResultText: derivedResult(this.data.homeScore, this.data.awayScore),
    });
    this.loadCrowd(match);
  },

  loadCrowd(match) {
    const serial = ++this.crowdRequestSerial;
    const plan = crowdPlan({ match, identityMissing: this.data.identityMissing });
    if (plan === "hidden") {
      this.setData({ crowdState: "ready", crowdKind: "hidden", crowdSegments: [], crowdComparisonText: "" });
      return;
    }
    if (plan === "guest") {
      this.setData({ crowdState: "ready", crowdKind: "guest", crowdMessage: COPY.guest, crowdSegments: [], crowdComparisonText: "" });
      return;
    }
    if (plan === "locked") {
      this.setData({ crowdState: "ready", crowdKind: "locked", crowdMessage: COPY.locked, crowdSegments: [], crowdComparisonText: "" });
      return;
    }
    this.setData({ crowdState: "loading", crowdKind: "loading", crowdSegments: [], crowdComparisonText: "" });
    getMatchCrowd(this.data.matchId).then((response) => {
      if (serial !== this.crowdRequestSerial || this.data.matchId !== match.match_id) return;
      if (response.statusCode === 401 && response.code === "UNAUTHORIZED") {
        this.setData({ identityMissing: true, crowdState: "ready", crowdKind: "guest", crowdMessage: COPY.guest, crowdSegments: [], crowdComparisonText: "" });
        return;
      }
      if (response.statusCode !== 200) {
        this.setData({ crowdState: "error", crowdKind: "error", crowdMessage: COPY.failed, crowdSegments: [], crowdComparisonText: "" });
        return;
      }
      const card = crowdCard({ response, match, myPrediction: match.my_prediction });
      this.setData({
        crowdState: "ready",
        crowdKind: card.kind,
        crowdMessage: card.message || "",
        crowdSegments: card.segments || [],
        crowdComparisonText: card.comparisonText || "",
        crowdFooter: card.footer || "",
      });
    });
  },

  onCrowdRetry() {
    if (this.data.match) this.loadCrowd(this.data.match);
  },

  onScoreStep(event) {
    const side = event.currentTarget.dataset.side;
    const delta = Number(event.currentTarget.dataset.delta);
    if ((side !== "home" && side !== "away") || !Number.isFinite(delta)) return;
    const current = Number(this.data[`${side}Score`]) || 0;
    const score = Math.max(0, Math.min(20, current + delta));
    const home = side === "home" ? score : this.data.homeScore;
    const away = side === "away" ? score : this.data.awayScore;
    this.setData({
      [`${side}Score`]: score,
      derivedResultText: derivedResult(home, away),
      formError: "",
    });
    this.ensureIntentKey();
  },

  onSessionTap() {
    this.refreshAfterSession = true;
    wx.navigateTo({ url: "/pages/session/session?return_to=match-detail" });
  },

  onHomeScoreInput(event) {
    this.setData({ homeScore: event.detail.value, formError: "" });
    if (this.data.canSubmit) {
      this.ensureIntentKey();
    }
  },

  onAwayScoreInput(event) {
    this.setData({ awayScore: event.detail.value, formError: "" });
    if (this.data.canSubmit) {
      this.ensureIntentKey();
    }
  },

  onSubmit() {
    if (this.data.submitting || !this.data.canSubmit) {
      return;
    }
    const homeScore = typeof this.data.homeScore === "number"
      ? this.data.homeScore
      : parseScore(this.data.homeScore);
    const awayScore = typeof this.data.awayScore === "number"
      ? this.data.awayScore
      : parseScore(this.data.awayScore);
    if (homeScore === null || awayScore === null) {
      this.setData({ formError: "比分须为 0..20 整数" });
      return;
    }
    if (
      this.lastPayload &&
      (this.lastPayload.homeScore !== homeScore || this.lastPayload.awayScore !== awayScore)
    ) {
      this.idempotencyKey = createUuidV4();
    }
    this.ensureIntentKey();
    this.lastPayload = { homeScore, awayScore };
    this.setData({ submitting: true, formError: "" });
    submitPrediction({
      idempotencyKey: this.idempotencyKey,
      matchId: this.data.matchId,
      homeScore,
      awayScore,
    }).then((result) => {
      this.applySubmitResult(result);
    });
  },

  applySubmitResult(result) {
    const ok = result.statusCode === 200 || result.statusCode === 201;
    if (ok) {
      this.idempotencyKey = null;
      this.lastPayload = null;
      this.setData({ submitting: false, canSubmit: false, formError: "" });
      this.loadDetail();
      return;
    }
    if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
      this.setData({
        submitting: false,
        canSubmit: false,
        identityMissing: true,
        submitDisabledReason: REASON_TEXT.AUTH_REQUIRED,
        formError: result.message || result.code,
      });
      return;
    }
    if (result.statusCode === 409 && result.code === "USER_DELETED") {
      this.setData({
        submitting: false,
        canSubmit: false,
        userDeleted: true,
        submitDisabledReason: REASON_TEXT.USER_DELETED,
        formError: result.message || result.code,
      });
      return;
    }
    if (result.statusCode === 409 && result.code === "PREDICTION_ALREADY_SUBMITTED") {
      this.setData({ submitting: false, canSubmit: false });
      this.loadDetail();
      return;
    }
    if (result.statusCode === 409 && result.code === "MATCH_NOT_PREDICTABLE") {
      this.setData({ submitting: false });
      this.loadDetail();
      return;
    }
    if (result.statusCode === 409 && result.code === "PREDICTION_LOCKED") {
      this.setData({
        submitting: false,
        canSubmit: false,
        submitDisabledReason: REASON_TEXT.CLOSED,
        formError: result.message || result.code,
      });
      return;
    }
    if (result.statusCode === 409 && result.code === "IDEMPOTENCY_KEY_REUSED") {
      this.idempotencyKey = createUuidV4();
      this.setData({
        submitting: false,
        formError: result.message || result.code,
      });
      return;
    }
    if (result.statusCode === 422) {
      this.setData({
        submitting: false,
        formError: result.message || result.code,
      });
      return;
    }
    if (result.statusCode === 429 && result.code === "RATE_LIMITED") {
      this.setData({
        submitting: false,
        formError: result.message || result.code,
      });
      return;
    }
    this.setData({
      submitting: false,
      formError: result.message || String(result.code || result.statusCode || "网络错误"),
    });
  },

  onRetry() {
    this.loadDetail();
  },
});
