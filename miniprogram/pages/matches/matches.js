const { listMatches } = require("../../services/matches.js");

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
    this.setData({ state: "loading", items: [], errorMessage: "", hasMore: false, nextCursor: null });
    listMatches({}).then((result) => {
      this.applyListResult(result, true);
    });
  },

  applyListResult(result, replace) {
    if (result.statusCode === 429 && result.code === "RATE_LIMITED") {
      this.setData({
        state: replace && this.data.items.length === 0 ? "error" : this.data.state,
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
    const items = Array.isArray(payload.items) ? payload.items : [];
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
    listMatches({ cursor: this.data.nextCursor }).then((result) => {
      this.applyListResult(result, false);
    });
  },
});
