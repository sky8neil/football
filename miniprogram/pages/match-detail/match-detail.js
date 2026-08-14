const { getMatchDetail } = require("../../services/matches.js");
const { createUuidV4, submitPrediction } = require("../../services/predictions.js");

const REASON_TEXT = {
  AUTH_REQUIRED: "需登录态",
  USER_DELETED: "账号已注销",
  ALREADY_SUBMITTED: "已提交",
  KICKOFF_UNCONFIRMED: "开球未确认",
  NOT_SCHEDULED: "非可预测赛程态",
  CLOSED: "预测已截止",
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
    canSubmit: false,
    submitDisabledReason: "",
    identityMissing: false,
    userDeleted: false,
    homeScore: "",
    awayScore: "",
    submitting: false,
    formError: "",
  },

  idempotencyKey: null,
  lastPayload: null,

  onLoad(query) {
    const matchId = query && query.id ? String(query.id) : "";
    this.setData({ matchId });
    this.loadDetail();
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
      canSubmit,
      submitDisabledReason: canSubmit ? "" : reasonText(reason),
      identityMissing: reason === "AUTH_REQUIRED",
      userDeleted: reason === "USER_DELETED",
      errorMessage: "",
      formError: "",
      submitting: false,
    });
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
    const homeScore = parseScore(this.data.homeScore);
    const awayScore = parseScore(this.data.awayScore);
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
