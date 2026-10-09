const { listRankings } = require("../../services/rankings.js");
const { getMyProfile } = require("../../services/profile.js");
const { getMyLevels } = require("../../services/levels.js");
const { listMyGroups } = require("../../services/groups.js");
const { buildRankingViewModel } = require("../../utils/rankings-view-model.js");
const COPY = require("../../utils/rankings-copy.js");

function displayTeamId(value) {
  if (value === null || value === undefined) {
    return "未设置";
  }
  return "已选球队";
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
  } else if (board === "season") {
    displayed.mainLabel = "赛季积分";
    displayed.mainValue = item.season_points;
    displayed.countLabel = "有效预测";
    displayed.countValue = item.season_valid_predictions;
    displayed.exact_hits = item.exact_hits;
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
    availableBoards: ["week", "career", "strength"],
    showCareerBoard: true,
    showStrengthBoard: true,
    showSeasonBoard: false,
    scope: "global",
    groupId: null,
    groups: [],
    showGroupScope: true,
    groupNames: [],
    selectedGroupIndex: 0,
    selectedPeriodKey: null,
    weekOptions: [],
    weekOptionLabels: [],
    selectedWeekIndex: 0,
    availableLevelSeasons: [],
    selectedLevelSeasonId: null,
    selectedSeasonIndex: 0,
    entryCount: 0,
    view: {},
    podiumItems: [],
    guestText: COPY.emptyGuestLine,
    guestBars: [0, 1, 2, 3],
    scopeGlobalText: COPY.scopeGlobal,
    scopeGroupText: COPY.scopeGroup,
    groupLockedText: COPY.noGroups,
    inviteButtonText: COPY.scopeGroup,
    inviteActionText: COPY.inviteAction,
    goPredictText: COPY.goPredict,
    items: [],
    listItems: [],
    me: null,
    errorMessage: "",
    hasMore: false,
    nextCursor: null,
    loadingMore: false,
  },

  onShow() {
    const pendingGroupId = wx.getStorageSync("pending_ranking_group_id");
    if (pendingGroupId) {
      wx.removeStorageSync("pending_ranking_group_id");
      this.setData({ scope: "group", groupId: pendingGroupId }, () => this.loadFirstPage());
      return;
    }
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
    getMyProfile().then((profileResult) => {
      if (profileResult.statusCode === 401 && profileResult.code === "UNAUTHORIZED") {
        this.setData({
          state: "guest",
          guestText: COPY.emptyGuestLine,
          view: buildRankingViewModel({ guest: true }),
        });
        return;
      }
      if (profileResult.statusCode === 409 && profileResult.code === "USER_DELETED") {
        this.setData({ state: "userDeleted", errorMessage: profileResult.message || "账号已注销" });
        return;
      }
      if (profileResult.statusCode !== 200) {
        this.setData({ state: "error", errorMessage: profileResult.message || "读取个人资料失败" });
        return;
      }
      const profile = profileResult.data || {};
      Promise.all([listMyGroups({}), getMyLevels(), this.fetchRankings(true)]).then((results) => {
        const groupsResult = results[0];
        const levelsResult = results[1];
        if (groupsResult.statusCode !== 200 || levelsResult.statusCode !== 200) {
          const failed = groupsResult.statusCode !== 200 ? groupsResult : levelsResult;
          this.setData({ state: "error", errorMessage: failed.message || "读取用户数据失败" });
          return;
        }
        const groupItems = groupsResult.data && Array.isArray(groupsResult.data.items)
          ? groupsResult.data.items
          : [];
        const season = levelsResult.data && levelsResult.data.season || {};
        this.profileData = profile;
        this.currentSeasonRanked = season.valid_predictions > 0;
        const selectedGroupIndex = groupItems.findIndex((item) => item.group_id === this.data.groupId);
        if (this.data.scope === "group" && selectedGroupIndex < 0) {
          this.setData({ state: "error", errorMessage: COPY.groupMembershipChanged });
          return;
        }
        this.setData({
          groups: groupItems,
          groupNames: groupItems.map((item) => item.display_name),
          selectedGroupIndex: selectedGroupIndex < 0 ? 0 : selectedGroupIndex,
        }, () => this.applyListResult(results[2], true));
      });
    });
  },

  fetchRankings(replace, cursor) {
    return listRankings({
      board: this.data.board,
      scope: this.data.scope,
      groupId: this.data.scope === "group" ? this.data.groupId : null,
      periodKey: this.data.board === "week" ? this.data.selectedPeriodKey : null,
      levelSeasonId: this.data.board === "season" ? this.data.selectedLevelSeasonId : null,
      cursor: replace ? null : cursor,
    });
  },

  onBoardTap(event) {
    const board = event.currentTarget.dataset.board;
    if (
      board !== "week" && board !== "career" && board !== "strength" && board !== "season"
    ) {
      return;
    }
    if (this.data.availableBoards.indexOf(board) === -1) {
      return;
    }
    if (board === this.data.board) {
      return;
    }
    this.setData({ board, selectedPeriodKey: null, selectedLevelSeasonId: null }, () => this.loadFirstPage());
  },

  onScopeTap(event) {
    const scope = event.currentTarget.dataset.scope;
    if (scope === "global") {
      if (this.data.scope === "global") return;
      this.setData({ scope, groupId: null, selectedPeriodKey: null }, () => this.loadFirstPage());
      return;
    }
    if (scope !== "group") return;
    if (
      this.data.board === "season" &&
      this.data.selectedLevelSeasonId !== this.data.availableLevelSeasons[0]
    ) return;
    if (this.data.groups.length === 0) {
      wx.navigateTo({ url: "/pages/groups/groups" });
      return;
    }
    const group = this.data.groups[this.data.selectedGroupIndex] || this.data.groups[0];
    this.setData({ scope, groupId: group.group_id, selectedPeriodKey: null }, () => this.loadFirstPage());
  },

  onGroupChange(event) {
    const index = Number(event.detail.value);
    const group = this.data.groups[index];
    if (!group) return;
    this.setData({ selectedGroupIndex: index, scope: "group", groupId: group.group_id }, () => this.loadFirstPage());
  },

  onWeekChange(event) {
    const option = this.data.weekOptions[Number(event.detail.value)];
    if (!option || option.key === this.data.selectedPeriodKey) return;
    this.setData({ selectedPeriodKey: option.key }, () => this.loadFirstPage());
  },

  onSeasonChange(event) {
    const seasonId = this.data.availableLevelSeasons[Number(event.detail.value)];
    if (!seasonId || seasonId === this.data.selectedLevelSeasonId) return;
    const selectedIndex = this.data.availableLevelSeasons.indexOf(seasonId);
    const scope = selectedIndex > 0 ? "global" : this.data.scope;
    this.setData({
      selectedLevelSeasonId: seasonId,
      selectedSeasonIndex: selectedIndex,
      scope,
      groupId: scope === "global" ? null : this.data.groupId,
    }, () => this.loadFirstPage());
  },

  onInviteTap() {
    if (this.data.scope === "group" && this.data.groupId) {
      wx.navigateTo({ url: `/pages/groups/detail?group_id=${this.data.groupId}` });
      return;
    }
    wx.navigateTo({ url: "/pages/groups/groups" });
  },

  onGoPredict() {
    wx.switchTab({ url: "/pages/matches/matches" });
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
    const availableBoards = Array.isArray(payload.available_boards)
      ? payload.available_boards.filter((board) =>
        board === "week" || board === "career" || board === "strength" || board === "season"
      )
      : ["week", "career", "strength"];
    const view = buildRankingViewModel({
      payload,
      board: this.data.board,
      scope: this.data.scope,
      serverNow: payload.server_now,
      previousSeason: this.profileData && this.profileData.previous_season,
      currentSeasonRanked: this.currentSeasonRanked,
      hasGroups: this.data.groups.length > 0,
    });
    if (this.data.board !== "week" && availableBoards.indexOf(this.data.board) === -1) {
      this.setData({
        board: "week",
        availableBoards,
        showCareerBoard: availableBoards.indexOf("career") !== -1,
        showStrengthBoard: availableBoards.indexOf("strength") !== -1,
        showSeasonBoard: availableBoards.indexOf("season") !== -1,
      }, () => this.loadFirstPage());
      return;
    }
    const items = Array.isArray(payload.items)
      ? payload.items.map((item) => presentItem(item, this.data.board))
      : [];
    const page = payload.page || {};
    const merged = replace ? items : this.data.items.concat(items);
    const availableLevelSeasons = Array.isArray(payload.available_level_seasons)
      ? payload.available_level_seasons
      : [];
    const selectedLevelSeasonId = payload.level_season_id || this.data.selectedLevelSeasonId;
    const selectedWeekIndex = Math.max(0, view.weekOptions.findIndex((item) => item.key === payload.period_key));
    const selectedSeasonIndex = Math.max(0, availableLevelSeasons.indexOf(selectedLevelSeasonId));
    let me = null;
    if (payload.me && typeof payload.me === "object") {
      const statusText = {
        ranked: "已入榜",
        not_participated: "尚未入榜",
        below_threshold: "未达到入榜场次",
        not_eligible: "尚未达到赛季榜条件",
      };
      me = { status: payload.me.status, statusText: statusText[payload.me.status] || payload.me.status };
      if (payload.me.status === "ranked") {
        me.rank = payload.me.rank;
        me.top_percent = payload.me.top_percent;
      } else if (payload.me.status === "below_threshold") {
        me.remaining_valid_predictions = payload.me.remaining_valid_predictions;
      } else if (payload.me.status === "not_eligible") {
        me.seasons_participated = payload.me.seasons_participated;
      }
    }
    this.setData({
      state: "list",
      items: merged,
      listItems: view.showPodium ? merged.slice(3) : merged,
      me,
      entryCount: payload.entry_count === undefined ? merged.length : payload.entry_count,
      view,
      podiumItems: merged.slice(0, 3).map((item, index) => ({
        ...item,
        placeText: ["第 1 名", "第 2 名", "第 3 名"][index],
      })),
      weekOptions: view.weekOptions,
      weekOptionLabels: view.weekOptions.map((item) => item.label),
      selectedWeekIndex,
      selectedPeriodKey: payload.period_key,
      availableLevelSeasons,
      selectedLevelSeasonId,
      selectedSeasonIndex,
      showGroupScope: this.data.board !== "season" ||
        selectedLevelSeasonId === availableLevelSeasons[0],
      hasMore: page.has_more === true,
      nextCursor: page.next_cursor === undefined ? null : page.next_cursor,
      availableBoards,
      showCareerBoard: availableBoards.indexOf("career") !== -1,
      showStrengthBoard: availableBoards.indexOf("strength") !== -1,
      showSeasonBoard: availableBoards.indexOf("season") !== -1,
      errorMessage: "",
      loadingMore: false,
    });
  },

  onMore() {
    if (this.data.loadingMore || !this.data.hasMore || this.data.nextCursor === null) {
      return;
    }
    this.setData({ loadingMore: true, errorMessage: "" });
    this.fetchRankings(false, this.data.nextCursor).then((result) => {
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
