const { listRankings } = require("../../services/rankings.js");

function displayTeamId(value) {
  if (value === null || value === undefined) {
    return "未设置";
  }
  return String(value);
}

function presentItem(item, board) {
  const displayed = {
    user_id: item.user_id,
    rank: item.rank,
    display_name: item.display_name,
    favoriteTeamText: displayTeamId(item.favorite_team_id),
    career_level: item.career_level,
    exact_hits: null,
    last_scoring_match_at: item.last_scoring_match_at === undefined
      ? null
      : item.last_scoring_match_at,
  };
  if (board === "career") {
    displayed.mainLabel = "生涯积分";
    displayed.mainValue = item.career_points;
    displayed.countLabel = "有效预测";
    displayed.countValue = item.career_valid_predictions;
    displayed.exact_hits = item.exact_hits;
  } else if (board === "strength") {
    displayed.mainLabel = "实力指数";
    displayed.mainValue = item.strength_index;
    displayed.countLabel = "统计场次";
    displayed.countValue = item.window_n;
  } else {
    displayed.mainLabel = "周积分";
    displayed.mainValue = item.period_score;
    displayed.countLabel = "有效预测";
    displayed.countValue = item.valid_predictions;
    displayed.exact_hits = item.exact_hits;
  }
  return displayed;
}

Page({
  data: {
    state: "loading",
    board: "week",
    items: [],
    me: null,
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
      me: null,
      errorMessage: "",
      hasMore: false,
      nextCursor: null,
      loadingMore: false,
    });
    listRankings({ board: this.data.board }).then((result) => {
      this.applyListResult(result, true);
    });
  },

  onBoardTap(event) {
    const board = event.currentTarget.dataset.board;
    if (board !== "week" && board !== "career" && board !== "strength") {
      return;
    }
    if (board === this.data.board) {
      return;
    }
    this.setData({ board }, () => this.loadFirstPage());
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
    const items = Array.isArray(payload.items)
      ? payload.items.map((item) => presentItem(item, this.data.board))
      : [];
    const page = payload.page || {};
    const merged = replace ? items : this.data.items.concat(items);
    let me = null;
    if (payload.me && typeof payload.me === "object") {
      me = { status: payload.me.status };
      if (payload.me.status === "ranked") {
        me.rank = payload.me.rank;
        me.top_percent = payload.me.top_percent;
      } else if (payload.me.status === "below_threshold") {
        me.remaining_valid_predictions = payload.me.remaining_valid_predictions;
      }
    }
    this.setData({
      state: merged.length === 0 && me === null ? "empty" : "list",
      items: merged,
      me,
      hasMore: page.has_more === true,
      nextCursor: page.next_cursor === undefined ? null : page.next_cursor,
      errorMessage: "",
      loadingMore: false,
    });
  },

  onMore() {
    if (this.data.loadingMore || !this.data.hasMore || this.data.nextCursor === null) {
      return;
    }
    this.setData({ loadingMore: true, errorMessage: "" });
    listRankings({
      board: this.data.board,
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
