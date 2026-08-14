const { listMyPredictions } = require("../../services/predictions.js");

function formatRegularScore(item) {
  if (
    !item ||
    item.regular_home_score === null ||
    item.regular_home_score === undefined ||
    item.regular_away_score === null ||
    item.regular_away_score === undefined
  ) {
    return "待结算/暂无比分";
  }
  return item.regular_home_score + " - " + item.regular_away_score;
}

function settlementText(value) {
  return value === null || value === undefined ? "待结算" : String(value);
}

function presentItem(item) {
  return {
    prediction_id: item.prediction_id,
    match_id: item.match_id,
    round_id: item.round_id,
    home_team_id: item.home_team_id,
    away_team_id: item.away_team_id,
    kickoff_at: item.kickoff_at,
    pred_home_score: item.pred_home_score,
    pred_away_score: item.pred_away_score,
    derived_result: item.derived_result,
    match_status: item.match_status,
    regularScoreText: formatRegularScore(item),
    matchScoreText: settlementText(item.match_score),
    wdlHitText: settlementText(item.wdl_hit),
    exactHitText: settlementText(item.exact_hit),
  };
}

Page({
  data: {
    state: "loading",
    items: [],
    errorMessage: "",
    hasMore: false,
    nextCursor: null,
    loadingMore: false,
  },

  onLoad() {
    this.loadFirstPage();
  },

  loadFirstPage() {
    this.setData({
      state: "loading",
      items: [],
      errorMessage: "",
      hasMore: false,
      nextCursor: null,
      loadingMore: false,
    });
    listMyPredictions({}).then((result) => {
      this.applyListResult(result, true);
    });
  },

  applyListResult(result, replace) {
    if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
      this.setData({
        state: "unauthorized",
        errorMessage: "身份缺失",
        loadingMore: false,
      });
      return;
    }
    if (result.statusCode === 409 && result.code === "USER_DELETED") {
      this.setData({
        state: "userDeleted",
        errorMessage: result.message || "账号已注销",
        loadingMore: false,
      });
      return;
    }
    if (result.statusCode === 404 && result.code === "USER_NOT_FOUND") {
      this.setData({
        state: "userNotFound",
        errorMessage: result.message || "用户不存在",
        loadingMore: false,
      });
      return;
    }
    if (result.statusCode === 429 && result.code === "RATE_LIMITED") {
      this.setData({
        state: replace && this.data.items.length === 0 ? "rateLimited" : this.data.state,
        errorMessage: result.message || result.code,
        loadingMore: false,
      });
      return;
    }
    if (result.statusCode !== 200) {
      this.setData({
        state: "error",
        errorMessage: result.message || String(result.code || result.statusCode),
        loadingMore: false,
      });
      return;
    }
    const payload = result.data || {};
    const items = Array.isArray(payload.items) ? payload.items.map(presentItem) : [];
    const page = payload.page || {};
    const merged = replace ? items : this.data.items.concat(items);
    this.setData({
      state: merged.length === 0 ? "empty" : "list",
      items: merged,
      hasMore: page.has_more === true,
      nextCursor: page.next_cursor === undefined ? null : page.next_cursor,
      errorMessage: "",
      loadingMore: false,
    });
  },

  onCardTap(event) {
    const matchId = event.currentTarget.dataset.matchId;
    if (!matchId) {
      return;
    }
    wx.navigateTo({
      url: "/pages/match-detail/match-detail?id=" + matchId,
    });
  },

  onMore() {
    if (this.data.loadingMore || !this.data.hasMore || this.data.nextCursor === null) {
      return;
    }
    this.setData({ loadingMore: true, errorMessage: "" });
    listMyPredictions({ cursor: this.data.nextCursor }).then((result) => {
      this.applyListResult(result, false);
    });
  },

  onRetry() {
    if (this.data.state === "rateLimited") {
      return;
    }
    this.loadFirstPage();
  },
});
