const { listRankings } = require("../../services/rankings.js");

function displayTeamId(value) {
  if (value === null || value === undefined) {
    return "未设置";
  }
  return String(value);
}

function presentItem(item) {
  return {
    user_id: item.user_id,
    global_rank: item.global_rank,
    display_name: item.display_name,
    favoriteTeamText: displayTeamId(item.favorite_team_id),
    period_score: item.period_score,
    valid_predictions: item.valid_predictions,
    wdl_hits: item.wdl_hits,
    exact_hits: item.exact_hits,
    wdl_accuracy_percent: item.wdl_accuracy_percent,
    last_scoring_match_at: item.last_scoring_match_at === undefined
      ? null
      : item.last_scoring_match_at,
  };
}

Page({
  data: {
    state: "loading",
    periodType: "week",
    items: [],
    errorMessage: "",
    hasMore: false,
    nextCursor: null,
    loadingMore: false,
  },

  onShow() {
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
    listRankings({ periodType: this.data.periodType }).then((result) => {
      this.applyListResult(result, true);
    });
  },

  applyListResult(result, replace) {
    if (result.statusCode === 422 && result.code === "VALIDATION_ERROR") {
      this.setData({
        state: "validationError",
        errorMessage: result.message || result.code,
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

  onPeriodTap(event) {
    const periodType = event.currentTarget.dataset.periodType;
    if (periodType !== "week" && periodType !== "month") {
      return;
    }
    if (periodType === this.data.periodType) {
      return;
    }
    this.setData({ periodType: periodType });
    this.loadFirstPage();
  },

  onMore() {
    if (this.data.loadingMore || !this.data.hasMore || this.data.nextCursor === null) {
      return;
    }
    this.setData({ loadingMore: true, errorMessage: "" });
    listRankings({
      periodType: this.data.periodType,
      cursor: this.data.nextCursor,
    }).then((result) => {
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
