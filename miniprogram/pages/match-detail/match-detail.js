const { getMatchDetail, getMatchCrowd } = require("../../services/matches.js");
const { createUuidV4, submitPrediction } = require("../../services/predictions.js");
const authService = require("../../services/auth.js");
const { presentTeam } = require("../../utils/team-presentation.js");
const { crowdPlan, crowdCard } = require("../../utils/crowd-view-model.js");
const { COPY } = require("../../utils/crowd-copy.js");
const { formatRound, formatKickoff } = require("../../utils/match-presentation.js");

function currentLoginGeneration() {
  if (!authService || typeof authService.getLoginGeneration !== "function") return 0;
  const value = authService.getLoginGeneration();
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

const SCORE_CAPTION = {
  live: "进行中",
  finished: "全场比分",
  postponed: "比赛延期",
  cancelled: "比赛取消",
  abandoned: "比赛腰斩",
};

const REASON_TEXT = {
  AUTH_REQUIRED: "登录后可提交预测",
  USER_DELETED: "当前不可预测",
  ALREADY_SUBMITTED: "已提交",
  KICKOFF_UNCONFIRMED: "开球未确认",
  NOT_SCHEDULED: "当前赛程不可预测",
  CLOSED: "预测已截止",
};

const LEAGUE_NAMES = {
  premier_league: "英超",
  la_liga: "西甲",
  serie_a: "意甲",
  bundesliga: "德甲",
  ligue_1: "法甲",
  chinese_super_league: "中超",
};

const LEAGUE_LOGOS = {
  premier_league: "/assets/logos/leagues/premier_league.png",
  la_liga: "/assets/logos/leagues/la_liga.png",
  serie_a: "/assets/logos/leagues/serie_a.png",
  bundesliga: "/assets/logos/leagues/bundesliga.png",
  ligue_1: "/assets/logos/leagues/ligue_1.png",
  chinese_super_league: "/assets/logos/leagues/chinese_super_league.png",
};

const STATUS_TEXT = {
  scheduled: "未开赛",
  live: "进行中",
  finished: "完场",
  postponed: "延期",
  cancelled: "取消",
  abandoned: "腰斩",
};

function statusChipClass(status) {
  if (status === "scheduled") return "chip-brand";
  if (status === "live" || status === "postponed") return "chip-live";
  return "chip-done";
}

function extractKickoffTime(kickoffText) {
  const match = String(kickoffText || "").match(/(\d{2}:\d{2})$/);
  return match ? match[1] : "";
}

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

function parsePrefillScore(raw) {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 0 && raw <= 20 ? raw : null;
  }
  if (typeof raw === "string") {
    return parseScore(raw);
  }
  return null;
}

function parsePrefillPair(query) {
  if (!query || typeof query !== "object") {
    return null;
  }
  const homeScore = parsePrefillScore(query.prefill_home);
  const awayScore = parsePrefillScore(query.prefill_away);
  if (homeScore === null || awayScore === null) {
    return null;
  }
  return { homeScore, awayScore };
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
    roundText: "",
    deadlineText: "",
    statusText: "",
    statusChipClass: "chip-brand",
    leagueName: "",
    leagueLogo: "",
    leagueRoundText: "",
    isDarkScoreBug: false,
    scoreBugSubText: "开球时间",
    prefillBannerText: "",
    myPredictionChipText: "已锁定",
    myPredictionChipClass: "chip-hit",
    submittedText: "",
    homeLogo: "",
    awayLogo: "",
    homeNameZh: "",
    awayNameZh: "",
    homeMissing: false,
    awayMissing: false,
    scoreCaption: "开球时间",
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
  detailRequestSerial: 0,
  crowdRequestSerial: 0,
  loginGeneration: undefined,
  prefillScores: null,
  prefillApplied: false,
  hasUserEditedScore: false,
  unloaded: false,
  unsubscribeAuthRestored: null,

  rememberLoginGeneration() {
    const generation = currentLoginGeneration();
    if (this.loginGeneration === generation) return generation;
    if (this.loginGeneration !== undefined) {
      this.idempotencyKey = null;
      this.lastPayload = null;
      this.prefillScores = null;
      this.prefillApplied = false;
      this.hasUserEditedScore = false;
      this.detailRequestSerial += 1;
      this.crowdRequestSerial += 1;
      this.setData({
        homeScore: 0,
        awayScore: 0,
        derivedResultText: derivedResult(0, 0),
        prefillBannerText: "",
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
        submitting: false,
        formError: "",
        crowdState: "idle",
        crowdKind: "hidden",
        crowdMessage: "",
        crowdSegments: [],
        crowdComparisonText: "",
        crowdFooter: "",
      });
    }
    this.loginGeneration = generation;
    return generation;
  },

  handleStaleLoginGeneration(loginGeneration) {
    if (loginGeneration === currentLoginGeneration()) return null;
    if (this.unloaded) return Promise.resolve();
    if (this.loginGeneration !== currentLoginGeneration()) {
      if (this.data.matchId) return this.loadDetail();
      this.rememberLoginGeneration();
      return Promise.resolve();
    }
    return Promise.resolve();
  },

  onLoad(query) {
    const rawId = query && query.id
      ? String(query.id)
      : (query && query.match_id ? String(query.match_id) : "");
    const matchId = rawId.trim();
    this.unloaded = false;
    this.hasShown = false;
    this.prefillScores = parsePrefillPair(query);
    this.prefillApplied = false;
    this.hasUserEditedScore = false;
    if (typeof this.unsubscribeAuthRestored === "function") {
      this.unsubscribeAuthRestored();
      this.unsubscribeAuthRestored = null;
    }
    if (authService && typeof authService.onAuthRestored === "function") {
      this.unsubscribeAuthRestored = authService.onAuthRestored(() => {
        if (!this.unloaded && this.data.matchId && !this.data.submitting) {
          return this.loadDetail();
        }
      });
    }
    this.rememberLoginGeneration();
    this.setData({ matchId });
    this.loadDetail();
  },

  onUnload() {
    this.unloaded = true;
    if (typeof this.unsubscribeAuthRestored === "function") {
      this.unsubscribeAuthRestored();
      this.unsubscribeAuthRestored = null;
    }
    this.detailRequestSerial += 1;
    this.crowdRequestSerial += 1;
  },

  onShow() {
    if (!this.hasShown) {
      this.hasShown = true;
      return;
    }
    const generationChanged = this.loginGeneration !== undefined && this.loginGeneration !== currentLoginGeneration();
    if (generationChanged) {
      this.rememberLoginGeneration();
      if (this.data.matchId) {
        return this.loadDetail();
      }
      return;
    }
    if (!this.data.submitting && this.data.matchId) {
      return this.loadDetail();
    }
  },

  ensureIntentKey() {
    if (!this.idempotencyKey) {
      this.idempotencyKey = createUuidV4();
    }
  },

  loadDetail() {
    if (this.unloaded) return Promise.resolve();
    if (!this.data.matchId) {
      this.setData({ state: "error", errorMessage: "缺少比赛 id" });
      return Promise.resolve();
    }
    const loginGeneration = this.rememberLoginGeneration();
    const serial = ++this.detailRequestSerial;
    const matchId = this.data.matchId;
    this.setData({ state: "loading", errorMessage: "" });
    let pending;
    try {
      pending = Promise.resolve(getMatchDetail(matchId));
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then((result) => {
      if (this.unloaded) return;
      if (serial !== this.detailRequestSerial || matchId !== this.data.matchId) return;
      const stale = this.handleStaleLoginGeneration(loginGeneration);
      if (stale) return stale;
      this.applyDetailResult(result);
    }).catch((error) => {
      if (this.unloaded) return;
      if (serial !== this.detailRequestSerial || matchId !== this.data.matchId) return;
      const stale = this.handleStaleLoginGeneration(loginGeneration);
      if (stale) return stale;
      this.setData({
        state: "error",
        errorMessage: (error && error.message) || "加载失败，请重试",
        submitting: false,
      });
    });
  },

  applyDetailResult(result) {
    if (!result || typeof result !== "object") {
      this.setData({
        state: "error",
        errorMessage: "加载失败，请重试",
      });
      return;
    }
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
    const cancelled = match.match_status === "cancelled" || match.settlement_status === "voided";
    const unsettledText = match.match_status === "postponed"
      ? "比赛延期"
      : match.match_status === "abandoned"
        ? "比赛腰斩"
        : "等待比赛结算";
    const homePresented = presentTeam(match.home_team, match.league_id);
    const awayPresented = presentTeam(match.away_team, match.league_id);
    const scoreCaption = SCORE_CAPTION[match.match_status] || "开球时间";
    const kickoffText = formatKickoff(match.kickoff_at);
    const roundText = formatRound(match.round_id);
    const leagueName = LEAGUE_NAMES[match.league_id] || "";
    const leagueLogo = LEAGUE_LOGOS[match.league_id] || "";
    const leagueRoundText = leagueName && roundText
      ? `${leagueName} · ${roundText}`
      : (leagueName || roundText);
    const hasRegularScore =
      match.regular_home_score !== null &&
      match.regular_home_score !== undefined &&
      match.regular_away_score !== null &&
      match.regular_away_score !== undefined;
    const isDarkScoreBug =
      match.match_status === "live" ||
      match.match_status === "finished" ||
      hasRegularScore;
    const scoreBugSubText = match.match_status === "scheduled"
      ? (extractKickoffTime(kickoffText) || scoreCaption)
      : scoreCaption;
    const myPredictionChipText = myPrediction
      ? (cancelled
        ? "不计分"
        : myPrediction.exact_hit === true
          ? "精确命中"
          : myPrediction.wdl_hit === true
            ? "赛果命中"
            : myPrediction.match_score === null
              ? "已锁定"
              : "未命中")
      : "";
    const myPredictionChipClass = myPrediction
      ? (cancelled
        ? "chip-done"
        : myPrediction.exact_hit === true
          ? "chip-brand"
          : myPrediction.wdl_hit === true || myPrediction.match_score === null
            ? "chip-hit"
            : "chip-done")
      : "chip-hit";
    let nextHomeScore = this.data.homeScore;
    let nextAwayScore = this.data.awayScore;
    let nextPrefillBannerText = canSubmit ? this.data.prefillBannerText : "";
    if (canSubmit && this.prefillScores && !this.prefillApplied && !this.hasUserEditedScore) {
      nextHomeScore = this.prefillScores.homeScore;
      nextAwayScore = this.prefillScores.awayScore;
      nextPrefillBannerText = `已为你预填分享卡预测 ${nextHomeScore} : ${nextAwayScore}，可调整后提交`;
      this.prefillApplied = true;
      this.prefillScores = null;
    }
    this.setData({
      state: "ready",
      match,
      regularScoreText: formatRegularScore(match),
      scoreCaption,
      scoreBugSubText,
      isDarkScoreBug,
      leagueName,
      leagueLogo,
      leagueRoundText,
      statusChipClass: statusChipClass(match.match_status),
      prefillBannerText: nextPrefillBannerText,
      myPrediction,
      myPredictionChipText,
      myPredictionChipClass,
      // 同 deadlineText：submitted_at 是云端 ISO 字符串，必须格式化后再插值。
      submittedText: myPrediction ? formatKickoff(myPrediction.submitted_at) : "",
      myPredictionScore: myPrediction
        ? myPrediction.pred_home_score + " - " + myPrediction.pred_away_score
        : "",
      myMatchScoreText: myPrediction ? (cancelled ? "—" : settlementText(myPrediction.match_score)) : "",
      myWdlHitText: myPrediction ? (cancelled ? "—" : settlementText(myPrediction.wdl_hit)) : "",
      myExactHitText: myPrediction ? (cancelled ? "—" : settlementText(myPrediction.exact_hit)) : "",
      predictionPointsText: myPrediction
        ? (cancelled ? "不计分" : myPrediction.match_score !== null ? `+${myPrediction.match_score}` : "待结算")
        : "待结算",
      predictionResultText: myPrediction
        ? (cancelled
          ? (match.match_status === "abandoned" ? "比赛腰斩 · 不计分" : "比赛取消 · 不计分")
          : myPrediction.exact_hit === true
            ? "精确命中"
            : myPrediction.wdl_hit === true
              ? "赛果命中"
              : myPrediction.match_score === null
                ? unsettledText
                : "未命中")
        : "",
      canSubmit,
      submitDisabledReason: canSubmit ? "" : reasonText(reason),
      identityMissing: reason === "AUTH_REQUIRED",
      userDeleted: reason === "USER_DELETED",
      errorMessage: "",
      formError: "",
      submitting: false,
      homeLogo: homePresented.logo,
      awayLogo: awayPresented.logo,
      homeNameZh: homePresented.nameZh,
      awayNameZh: awayPresented.nameZh,
      homeMissing: homePresented.missing,
      awayMissing: awayPresented.missing,
      kickoffText,
      roundText,
      // 截止时间必须格式化后再上屏：云端返回的是 ISO 字符串，
      // 直接在 WXML 里插值会把 2026-11-06T19:50:00.000Z 原样显示给用户。
      deadlineText: formatKickoff(match.prediction_deadline_at),
      statusText: STATUS_TEXT[match.match_status] || match.match_status,
      homeScore: nextHomeScore,
      awayScore: nextAwayScore,
      derivedResultText: derivedResult(nextHomeScore, nextAwayScore),
    });
    this.loadCrowd(match);
  },

  loadCrowd(match) {
    if (this.unloaded) return;
    const loginGeneration = this.rememberLoginGeneration();
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
    let pending;
    try {
      pending = Promise.resolve(getMatchCrowd(this.data.matchId));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then((response) => {
      if (this.unloaded) return;
      if (serial !== this.crowdRequestSerial || this.data.matchId !== match.match_id) return;
      const stale = this.handleStaleLoginGeneration(loginGeneration);
      if (stale) return stale;
      if (!response || typeof response !== "object") {
        this.setData({ crowdState: "error", crowdKind: "error", crowdMessage: COPY.failed, crowdSegments: [], crowdComparisonText: "" });
        return;
      }
      if (response.statusCode === 401 && response.code === "UNAUTHORIZED") {
        this.setData({ identityMissing: true, crowdState: "ready", crowdKind: "guest", crowdMessage: COPY.guest, crowdSegments: [], crowdComparisonText: "" });
        return;
      }
      if (response.statusCode === 409 && response.code === "USER_DELETED") {
        const nextMatch = this.data.match
          ? Object.assign({}, this.data.match, { can_predict: false, can_predict_reason: "USER_DELETED" })
          : this.data.match;
        this.setData({
          match: nextMatch,
          canSubmit: false,
          identityMissing: false,
          userDeleted: true,
          submitDisabledReason: REASON_TEXT.USER_DELETED,
          crowdState: "idle",
          crowdKind: "hidden",
          crowdMessage: "",
          crowdSegments: [],
          crowdComparisonText: "",
          crowdFooter: "",
        });
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
    }).catch(() => {
      if (this.unloaded) return;
      if (serial !== this.crowdRequestSerial || this.data.matchId !== match.match_id) return;
      const stale = this.handleStaleLoginGeneration(loginGeneration);
      if (stale) return stale;
      this.setData({ crowdState: "error", crowdKind: "error", crowdMessage: COPY.failed, crowdSegments: [], crowdComparisonText: "" });
    });
  },

  onCrowdRetry() {
    if (this.data.match) this.loadCrowd(this.data.match);
  },

  onScoreStep(event) {
    if (this.data.submitting) return;
    const side = event.currentTarget.dataset.side;
    const delta = Number(event.currentTarget.dataset.delta);
    if ((side !== "home" && side !== "away") || !Number.isFinite(delta)) return;
    this.hasUserEditedScore = true;
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
    wx.navigateTo({ url: "/pages/session/session?return_to=match-detail" });
  },

  onHomeScoreInput(event) {
    this.hasUserEditedScore = true;
    this.setData({ homeScore: event.detail.value, formError: "" });
    if (this.data.canSubmit) {
      this.ensureIntentKey();
    }
  },

  onAwayScoreInput(event) {
    this.hasUserEditedScore = true;
    this.setData({ awayScore: event.detail.value, formError: "" });
    if (this.data.canSubmit) {
      this.ensureIntentKey();
    }
  },

  onSubmit() {
    if (this.data.submitting || !this.data.canSubmit) {
      return;
    }
    const previousGeneration = this.loginGeneration;
    const loginGeneration = this.rememberLoginGeneration();
    if (previousGeneration !== undefined && previousGeneration !== loginGeneration) {
      return this.loadDetail();
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
    const matchId = this.data.matchId;
    this.setData({ submitting: true, formError: "" });
    let pending;
    try {
      pending = Promise.resolve(submitPrediction({
        idempotencyKey: this.idempotencyKey,
        matchId,
        homeScore,
        awayScore,
      }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then((result) => {
      if (this.unloaded) return;
      if (matchId !== this.data.matchId) return;
      const stale = this.handleStaleLoginGeneration(loginGeneration);
      if (stale) return stale;
      this.applySubmitResult(result);
    }).catch((error) => {
      if (this.unloaded) return;
      if (matchId !== this.data.matchId) return;
      const stale = this.handleStaleLoginGeneration(loginGeneration);
      if (stale) return stale;
      this.setData({
        submitting: false,
        formError: (error && error.message) || "提交失败，请重试",
      });
    });
  },

  applySubmitResult(result) {
    if (!result || typeof result !== "object") {
      this.setData({
        submitting: false,
        formError: "提交失败，请重试",
      });
      return;
    }
    const ok = result.statusCode === 200 || result.statusCode === 201;
    if (ok) {
      this.idempotencyKey = null;
      this.lastPayload = null;
      markMyPredictionsDirty();
      this.setData({ submitting: false, canSubmit: false, prefillBannerText: "", formError: "" });
      this.loadDetail();
      return;
    }
    if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
      this.setData({
        submitting: false,
        canSubmit: false,
        identityMissing: true,
        submitDisabledReason: REASON_TEXT.AUTH_REQUIRED,
        formError: "",
      });
      return;
    }
    if (result.statusCode === 409 && result.code === "USER_DELETED") {
      this.crowdRequestSerial += 1;
      const nextMatch = this.data.match
        ? Object.assign({}, this.data.match, { can_predict: false, can_predict_reason: "USER_DELETED" })
        : this.data.match;
      this.setData({
        match: nextMatch,
        submitting: false,
        canSubmit: false,
        identityMissing: false,
        userDeleted: true,
        submitDisabledReason: REASON_TEXT.USER_DELETED,
        formError: "",
        crowdState: "idle",
        crowdKind: "hidden",
        crowdMessage: "",
        crowdSegments: [],
        crowdComparisonText: "",
        crowdFooter: "",
      });
      return;
    }
    if (result.statusCode === 409 && result.code === "PREDICTION_ALREADY_SUBMITTED") {
      this.idempotencyKey = null;
      this.lastPayload = null;
      markMyPredictionsDirty();
      this.setData({ submitting: false, canSubmit: false, formError: "" });
      this.loadDetail();
      return;
    }
    if (result.statusCode === 409 && result.code === "MATCH_NOT_PREDICTABLE") {
      this.idempotencyKey = null;
      this.lastPayload = null;
      this.setData({ submitting: false });
      this.loadDetail();
      return;
    }
    if (result.statusCode === 409 && result.code === "PREDICTION_LOCKED") {
      this.idempotencyKey = null;
      this.lastPayload = null;
      this.setData({
        submitting: false,
        canSubmit: false,
        submitDisabledReason: REASON_TEXT.CLOSED,
        formError: "",
      });
      this.loadDetail();
      return;
    }
    if (result.statusCode === 409 && result.code === "IDEMPOTENCY_KEY_REUSED") {
      this.idempotencyKey = createUuidV4();
      this.lastPayload = null;
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
