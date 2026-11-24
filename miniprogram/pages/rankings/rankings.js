const { listRankings } = require("../../services/rankings.js");
const { getMyProfile } = require("../../services/profile.js");
const { getMyLevels } = require("../../services/levels.js");
const { listMyGroups } = require("../../services/groups.js");
const { buildRankingViewModel } = require("../../utils/rankings-view-model.js");
const { headerHeight } = require("../../utils/ui-layout.js");
const { formatLevelSeasonLabel } = require("../../utils/level-season.js");
const COPY = require("../../utils/rankings-copy.js");
const authService = require("../../services/auth.js");

function currentLoginGeneration() {
  if (!authService || typeof authService.getLoginGeneration !== "function") return 0;
  const value = authService.getLoginGeneration();
  return Number.isFinite(value) ? value : 0;
}

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
    rankText: String(item.rank).padStart(2, "0"),
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

function seasonStartYear(levelSeasonId) {
  const match = /^(\d{4})_(\d{4})$/.exec(levelSeasonId || "");
  if (!match || Number(match[2]) !== Number(match[1]) + 1) return null;
  return Number(match[1]);
}

function previousAvailableSeason(availableLevelSeasons, currentLevelSeasonId) {
  const currentStartYear = seasonStartYear(currentLevelSeasonId);
  if (currentStartYear === null) return null;
  const earlierSeasons = availableLevelSeasons
    .map((seasonId) => ({ seasonId, startYear: seasonStartYear(seasonId) }))
    .filter((season) => season.startYear !== null && season.startYear < currentStartYear)
    .sort((a, b) => b.startYear - a.startYear);
  return earlierSeasons.length > 0 ? earlierSeasons[0].seasonId : null;
}

function applyAuthOrDeletedState(page, result) {
  if (!result) return false;
  if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
    page.setData({
      state: "guest",
      guestText: COPY.emptyGuestLine,
      view: buildRankingViewModel({ guest: true }),
      nickname: "",
      avatarText: "球",
      currentUserId: "",
      loadingMore: false,
    });
    return true;
  }
  if (result.statusCode === 409 && result.code === "USER_DELETED") {
    page.setData({
      state: "userDeleted",
      errorMessage: result.message || "账号已注销",
      nickname: "",
      avatarText: "球",
      currentUserId: "",
      loadingMore: false,
    });
    return true;
  }
  return false;
}

Page({
  data: {
    state: "loading",
    headerHeight: headerHeight(),
    nickname: "", avatarText: "球", currentUserId: "",
    board: "week",
    availableBoards: ["week", "career", "strength"],
    showCareerBoard: true,
    showStrengthBoard: true,
    showSeasonBoard: false,
    scope: "global",
    scopeSheetOpen: false,
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
    seasonOptionLabels: [],
    selectedLevelSeasonId: null,
    selectedSeasonLabel: "",
    currentLevelSeasonId: null,
    selectedSeasonIndex: 0,
    showHistorySeasonEntry: false,
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
    weekWindowHint: COPY.weekWindowHint,
    items: [],
    listItems: [],
    me: null,
    errorMessage: "",
    showSwitchToGlobal: false,
    hasMore: false,
    nextCursor: null,
    loadingMore: false,
  },

  onLoad() {
    this.userChangedSeason = false;
    this.autoSeasonFallback = false;
    this.userSelectedWeek = false;
    this.explicitTargetSeasonId = null;
    this.invalidGroupIds = {};
    this.loginGeneration = currentLoginGeneration();
  },

  resetLoginGeneration() {
    this.userSelectedWeek = false;
    this.userChangedSeason = false;
    this.autoSeasonFallback = false;
    this.explicitTargetSeasonId = null;
    this.invalidGroupIds = {};
    this.profileData = null;
    this.currentSeasonRanked = false;
    this.setData({
      scope: "global",
      groupId: null,
      board: "week",
      selectedLevelSeasonId: null,
      selectedPeriodKey: null,
      groups: [],
      groupNames: [],
      selectedGroupIndex: 0,
      nickname: "",
      avatarText: "球",
      currentUserId: "",
    });
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 1 });
    const generation = currentLoginGeneration();
    if (generation !== this.loginGeneration) {
      this.loginGeneration = generation;
      this.resetLoginGeneration();
    }
    if (!this.userSelectedWeek) {
      this.setData({ selectedPeriodKey: null });
    }
    const pendingGroupId = wx.getStorageSync("pending_ranking_group_id");
    if (pendingGroupId) {
      wx.removeStorageSync("pending_ranking_group_id");
      wx.removeStorageSync("pending_ranking_target");
      this.forgetInvalidGroup(pendingGroupId);
      this.userChangedSeason = false;
      this.autoSeasonFallback = false;
      this.userSelectedWeek = false;
      this.explicitTargetSeasonId = null;
      this.setData({
        scope: "group",
        groupId: pendingGroupId,
        board: "week",
        selectedLevelSeasonId: null,
        selectedPeriodKey: null,
      }, () => this.loadFirstPage());
      return;
    }
    const pendingTarget = wx.getStorageSync("pending_ranking_target");
    if (pendingTarget && typeof pendingTarget === "object") {
      wx.removeStorageSync("pending_ranking_target");
      const targetSeasonId = pendingTarget.levelSeasonId || null;
      this.userChangedSeason = false;
      this.autoSeasonFallback = false;
      this.userSelectedWeek = false;
      this.explicitTargetSeasonId = targetSeasonId;
      this.setData({
        board: "season",
        scope: "global",
        groupId: null,
        selectedLevelSeasonId: targetSeasonId,
        selectedPeriodKey: null,
      }, () => this.loadFirstPage());
      return;
    }
    return this.loadFirstPage();
  },

  loadFirstPage() {
    const requestSerial = (this.requestSerial || 0) + 1;
    this.requestSerial = requestSerial;
    this.setData({
      state: "loading",
      items: [],
      me: null,
      errorMessage: "",
      showSwitchToGlobal: false,
      hasMore: false,
      nextCursor: null,
      loadingMore: false,
    });
    return getMyProfile().then((profileResult) => {
      if (this.requestSerial !== requestSerial) return;
      if (applyAuthOrDeletedState(this, profileResult)) {
        return;
      }
      if (profileResult.statusCode === 500 || profileResult.code === "INTERNAL_ERROR") {
        this.setData({ state: "error", errorMessage: "暂时无法读取排行榜数据，请稍后重试" });
        return;
      }
      if (profileResult.statusCode !== 200) {
        this.setData({ state: "error", errorMessage: profileResult.message || "读取个人资料失败" });
        return;
      }
      const profile = profileResult.data || {};
      this.setData({ nickname: profile.nickname, avatarText: Array.from(profile.nickname || "球")[0], currentUserId: profile.user_id });
      return Promise.all([listMyGroups({}), getMyLevels(), this.fetchRankings(true)]).then((results) => {
        if (this.requestSerial !== requestSerial) return;
        const groupsResult = results[0];
        const levelsResult = results[1];
        const rankingsResult = results[2];
        if (this.isGroupBoardUnavailable(rankingsResult)) {
          return this.recoverInvalidGroup(requestSerial);
        }
        if (
          applyAuthOrDeletedState(this, groupsResult)
          || applyAuthOrDeletedState(this, levelsResult)
          || applyAuthOrDeletedState(this, rankingsResult)
        ) {
          return;
        }
        if (groupsResult.statusCode !== 200 || levelsResult.statusCode !== 200) {
          if (this.data.scope === "group" && !this.hasGroupId()) {
            this.enterGroupInvalidState(this.data.groups);
            return;
          }
          if (this.data.scope === "group" && groupsResult.statusCode === 200) {
            const rawGroupItems = groupsResult.data && Array.isArray(groupsResult.data.items)
              ? groupsResult.data.items
              : [];
            this.clearInvalidGroups(rawGroupItems);
            const groupItems = this.excludeInvalidGroups(rawGroupItems);
            if (groupItems.findIndex((item) => item.group_id === this.data.groupId) < 0) {
              this.rememberInvalidGroup(this.data.groupId);
              this.enterGroupInvalidState(groupItems);
              return;
            }
          }
          const failed = groupsResult.statusCode !== 200 ? groupsResult : levelsResult;
          if (failed.statusCode === 500 || failed.code === "INTERNAL_ERROR") {
            this.setData({ state: "error", errorMessage: "暂时无法读取排行榜数据，请稍后重试" });
            return;
          }
          this.setData({ state: "error", errorMessage: failed.message || "读取用户数据失败" });
          return;
        }
        const rawGroupItems = groupsResult.data && Array.isArray(groupsResult.data.items)
          ? groupsResult.data.items
          : [];
        this.clearInvalidGroups(rawGroupItems);
        const groupItems = this.excludeInvalidGroups(rawGroupItems);
        const season = levelsResult.data && levelsResult.data.season || {};
        this.profileData = profile;
        this.currentSeasonRanked = season.valid_predictions > 0;
        const selectedGroupIndex = groupItems.findIndex((item) => item.group_id === this.data.groupId);
        if (this.data.scope === "group" && selectedGroupIndex < 0) {
          if (this.hasGroupId() || groupItems.length === 0) {
            this.rememberInvalidGroup(this.data.groupId);
            this.enterGroupInvalidState(groupItems);
            return;
          }
          const group = groupItems[0];
          return new Promise((resolve) => {
            this.setData({
              groups: groupItems,
              groupNames: groupItems.map((item) => item.display_name),
              selectedGroupIndex: 0,
              groupId: group.group_id,
            }, () => {
              if (this.requestSerial !== requestSerial) {
                resolve();
                return;
              }
              resolve(this.fetchRankings(true).then((result) => this.applyListResult(result, true, requestSerial)));
            });
          });
        }
        return new Promise((resolve) => {
          this.setData({
            groups: groupItems,
            groupNames: groupItems.map((item) => item.display_name),
            selectedGroupIndex: selectedGroupIndex < 0 ? 0 : selectedGroupIndex,
          }, () => {
            if (this.requestSerial !== requestSerial) {
              resolve();
              return;
            }
            resolve(this.applyListResult(rankingsResult, true, requestSerial));
          });
        });
      });
    }).catch(() => {
      if (this.requestSerial !== requestSerial) return;
      this.setData({
        state: "error",
        errorMessage: "暂时无法读取排行榜数据，请稍后重试",
        loadingMore: false,
      });
    });
  },

  hasGroupId() {
    return this.data.groupId != null && this.data.groupId !== "";
  },

  rememberInvalidGroup(groupId) {
    if (groupId == null || groupId === "") return;
    this.invalidGroupIds = this.invalidGroupIds || {};
    this.invalidGroupIds[groupId] = true;
  },

  forgetInvalidGroup(groupId) {
    if (!this.invalidGroupIds || groupId == null || groupId === "") return;
    delete this.invalidGroupIds[groupId];
  },

  clearInvalidGroups(groupItems) {
    if (!Array.isArray(groupItems)) return;
    for (const item of groupItems) {
      if (item && item.group_id) this.forgetInvalidGroup(item.group_id);
    }
  },

  isKnownInvalidGroup(groupId) {
    return !!(this.invalidGroupIds && groupId && this.invalidGroupIds[groupId]);
  },

  excludeInvalidGroups(groupItems) {
    const items = Array.isArray(groupItems) ? groupItems : [];
    return items.filter((item) => !this.isKnownInvalidGroup(item.group_id));
  },

  isGroupBoardUnavailable(result) {
    if (this.data.scope !== "group" || !this.hasGroupId() || !result) return false;
    return (result.statusCode === 404 && result.code === "GROUP_NOT_FOUND")
      || (result.statusCode === 403 && result.code === "FORBIDDEN");
  },

  enterGroupInvalidState(groupItems) {
    this.rememberInvalidGroup(this.data.groupId);
    const items = this.excludeInvalidGroups(groupItems);
    this.setData({
      groups: items,
      groupNames: items.map((item) => item.display_name),
      selectedGroupIndex: 0,
      groupId: null,
      state: "error",
      errorMessage: COPY.groupMembershipChanged,
      showSwitchToGlobal: true,
      items: [],
      listItems: [],
      podiumItems: [],
      me: null,
      hasMore: false,
      nextCursor: null,
      loadingMore: false,
    });
  },

  recoverInvalidGroup(requestSerial) {
    if (requestSerial !== undefined && this.requestSerial !== requestSerial) return;
    this.enterGroupInvalidState(this.data.groups);
    return listMyGroups({}).then((groupsResult) => {
      if (requestSerial !== undefined && this.requestSerial !== requestSerial) return;
      if (groupsResult.statusCode !== 200) return;
      const groupItems = this.excludeInvalidGroups(
        groupsResult.data && Array.isArray(groupsResult.data.items)
          ? groupsResult.data.items
          : [],
      );
      this.setData({
        groups: groupItems,
        groupNames: groupItems.map((item) => item.display_name),
        selectedGroupIndex: 0,
      });
    });
  },

  queueLoadFirstPage(patch) {
    const requestSerial = (this.requestSerial || 0) + 1;
    this.requestSerial = requestSerial;
    return new Promise((resolve) => {
      this.setData(patch, () => {
        if (this.requestSerial !== requestSerial) {
          resolve();
          return;
        }
        resolve(this.loadFirstPage());
      });
    });
  },

  fetchRankings(replace, cursor) {
    if (this.data.scope === "group" && !this.hasGroupId()) {
      return Promise.resolve({ skipped: true });
    }
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
    this.userSelectedWeek = false;
    this.explicitTargetSeasonId = null;
    return this.queueLoadFirstPage({ board, selectedPeriodKey: null, selectedLevelSeasonId: null });
  },

  onScopeTap(event) {
    const scope = event.currentTarget.dataset.scope;
    if (scope === "global") {
      if (this.data.scope === "global") return;
      this.userSelectedWeek = false;
      this.explicitTargetSeasonId = null;
      return this.queueLoadFirstPage({ scope, groupId: null, selectedPeriodKey: null });
    }
    if (scope !== "group") return;
    if (
      this.data.board === "season" &&
      this.data.selectedLevelSeasonId !== this.data.currentLevelSeasonId
    ) return;
    if (this.data.groups.length === 0) {
      wx.navigateTo({ url: "/pages/groups/groups" });
      return;
    }
    const group = this.data.groups[this.data.selectedGroupIndex] || this.data.groups[0];
    this.userSelectedWeek = false;
    this.explicitTargetSeasonId = null;
    return this.queueLoadFirstPage({ scope, groupId: group.group_id, selectedPeriodKey: null });
  },

  onGroupChange(event) {
    const index = Number(event.detail.value);
    const group = this.data.groups[index];
    if (!group) return;
    this.forgetInvalidGroup(group.group_id);
    this.explicitTargetSeasonId = null;
    return this.queueLoadFirstPage({ selectedGroupIndex: index, scope: "group", groupId: group.group_id });
  },

  onWeekChange(event) {
    const index = Number(event.detail.value);
    const option = this.data.weekOptions[index];
    if (!option || option.key === this.data.selectedPeriodKey) return;
    this.userSelectedWeek = index !== 0;
    return this.queueLoadFirstPage({ selectedPeriodKey: option.key });
  },

  onSeasonChange(event) {
    const seasonId = this.data.availableLevelSeasons[Number(event.detail.value)];
    if (!seasonId) return;
    this.userChangedSeason = true;
    if (seasonId === this.data.selectedLevelSeasonId) return;
    this.explicitTargetSeasonId = null;
    const selectedIndex = this.data.availableLevelSeasons.indexOf(seasonId);
    const scope = seasonId !== this.data.currentLevelSeasonId ? "global" : this.data.scope;
    return this.queueLoadFirstPage({
      selectedLevelSeasonId: seasonId,
      selectedSeasonLabel: formatLevelSeasonLabel(seasonId),
      selectedSeasonIndex: selectedIndex,
      scope,
      groupId: scope === "global" ? null : this.data.groupId,
    });
  },

  onViewHistorySeason() {
    const seasonId = previousAvailableSeason(
      this.data.availableLevelSeasons,
      this.data.currentLevelSeasonId,
    );
    const index = this.data.availableLevelSeasons.indexOf(seasonId);
    if (index < 0) return;
    this.onSeasonChange({ detail: { value: String(index) } });
  },

  onScopeSheet() { this.setData({ scopeSheetOpen: true }); },

  onScopeSheetClose() { this.setData({ scopeSheetOpen: false }); },

  stopScopeTap() {},

  onScopePick(event) {
    this.setData({ scopeSheetOpen: false });
    if (event.currentTarget.dataset.scope === "global") {
      this.onScopeTap({ currentTarget: { dataset: { scope: "global" } } });
    } else {
      this.onGroupChange({ detail: { value: event.currentTarget.dataset.index } });
    }
  },

  onRulesTap() {
    wx.showModal({ title: "排行榜规则", content: "本周榜按本周已结算积分排名；生涯榜累计历史积分；赛季榜需参与至少2个等级赛季后开放。实力榜取近两年最多300场有效预测，满50场参与排名。公开前20名，其余显示前百分比。", showCancel: false });
  },

  onScoreHelp() {
    wx.showModal({ title: "预测评分", content: "预测评分 =（近期预测积分 + 68）÷（有效预测场数 + 40），展示值向下保留两位小数。取最近两年内最多300场有效预测，满50场参与实力榜。", showCancel: false });
  },

  onLoginTap() { wx.navigateTo({ url: "/pages/session/session" }); },

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

  applyListResult(result, replace, requestSerial) {
    if (requestSerial !== undefined && this.requestSerial !== requestSerial) return;
    if (!result || result.skipped) return;
    if (this.isGroupBoardUnavailable(result)) {
      return this.recoverInvalidGroup(requestSerial);
    }
    if (applyAuthOrDeletedState(this, result)) {
      return;
    }
    if (result.statusCode === 422 && result.code === "VALIDATION_ERROR") {
      this.explicitTargetSeasonId = null;
      this.setData({
        state: "validationError",
        errorMessage: result.message || result.code,
        loadingMore: false,
      });
      return;
    }
    const isPagination = replace === false && this.data.items.length > 0;
    if (result.statusCode === 429 && result.code === "RATE_LIMITED") {
      this.setData({
        state: replace && this.data.items.length === 0 ? "rateLimited" : this.data.state,
        errorMessage: result.message || result.code,
        loadingMore: false,
      });
      return;
    }
    if (result.statusCode === 500 || result.code === "INTERNAL_ERROR") {
      this.setData({
        ...(isPagination ? {} : { state: "error" }),
        errorMessage: "暂时无法读取排行榜数据，请稍后重试",
        loadingMore: false,
      });
      return;
    }
    if (result.statusCode !== 200) {
      this.setData({
        ...(isPagination ? {} : { state: "error" }),
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
      firstPeriodKey: payload.first_period_key,
    });
    if (this.data.board !== "week" && availableBoards.indexOf(this.data.board) === -1) {
      this.explicitTargetSeasonId = null;
      this.setData({
        board: "week",
        availableBoards,
        showCareerBoard: availableBoards.indexOf("career") !== -1,
        showStrengthBoard: availableBoards.indexOf("strength") !== -1,
        showSeasonBoard: availableBoards.indexOf("season") !== -1,
      }, () => {
        if (requestSerial !== undefined && this.requestSerial !== requestSerial) return;
        this.loadFirstPage();
      });
      return;
    }
    const items = Array.isArray(payload.items)
      ? payload.items.map((item) => presentItem(item, this.data.board))
      : [];
    const page = payload.page || {};
    const merged = replace ? items : this.data.items.concat(items);
    const payloadAvailableLevelSeasons = Array.isArray(payload.available_level_seasons)
      ? payload.available_level_seasons
      : [];
    const availableLevelSeasons = payloadAvailableLevelSeasons.slice();
    const currentLevelSeasonId = view.currentLevelSeasonId || this.data.currentLevelSeasonId;
    if (
      this.data.board === "season" &&
      currentLevelSeasonId &&
      availableLevelSeasons.indexOf(currentLevelSeasonId) === -1
    ) {
      availableLevelSeasons.push(currentLevelSeasonId);
    }
    const selectedLevelSeasonId = payload.level_season_id || this.data.selectedLevelSeasonId;
    const fallbackSeasonId = previousAvailableSeason(payloadAvailableLevelSeasons, currentLevelSeasonId);
    if (
      this.data.board === "season" &&
      this.data.scope === "global" &&
      replace === true &&
      this.userChangedSeason !== true &&
      this.autoSeasonFallback !== true &&
      this.explicitTargetSeasonId == null &&
      payload.level_season_id === currentLevelSeasonId &&
      Array.isArray(payload.items) && payload.items.length === 0 &&
      fallbackSeasonId
    ) {
      this.autoSeasonFallback = true;
      this.setData({
        selectedLevelSeasonId: fallbackSeasonId,
        selectedSeasonLabel: formatLevelSeasonLabel(fallbackSeasonId),
        selectedSeasonIndex: availableLevelSeasons.indexOf(fallbackSeasonId),
        availableLevelSeasons,
        seasonOptionLabels: availableLevelSeasons.map((seasonId) => formatLevelSeasonLabel(seasonId)),
        currentLevelSeasonId,
        scope: "global",
        groupId: null,
      }, () => {
        if (requestSerial !== undefined && this.requestSerial !== requestSerial) return;
        this.loadFirstPage();
      });
      return;
    }
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
    const metricLabel = { week: "周积分", career: "生涯积分", season: "赛季积分", strength: "预测评分" }[this.data.board];
    const ranked = me && me.status === "ranked";
    const rankLabel = ranked ? (me.rank != null && me.rank <= 20 ? "第 " + me.rank + " 名" : me.top_percent != null ? "前 " + me.top_percent + "%" : "已入榜") : "暂无排名";
    const standingValue = ranked ? presentItem(payload.me, this.data.board).mainValue : "—";
    const standingLabel = this.data.board === "strength" && ranked
      ? rankLabel + " · 共 " + payload.entry_count + " 人" : rankLabel;
    const standingStatus = view.standingStatus;
    const seasonOptionLabels = availableLevelSeasons.map((seasonId) => formatLevelSeasonLabel(seasonId));
    const selectedSeasonLabel = formatLevelSeasonLabel(selectedLevelSeasonId);
    const historySeasonId = previousAvailableSeason(availableLevelSeasons, currentLevelSeasonId);
    const showHistorySeasonEntry = this.data.board === "season"
      && selectedLevelSeasonId === currentLevelSeasonId
      && (standingValue === "—" || me == null)
      && !ranked
      && historySeasonId != null;
    this.setData({
      metricLabel, standingLabel, standingValue, standingStatus,
      state: "list",
      items: merged,
      listItems: view.showPodium ? merged.slice(3) : merged,
      me,
      entryCount: payload.entry_count === undefined ? merged.length : payload.entry_count,
      view,
      podiumItems: merged.slice(0, 3).map((item, index) => ({
        ...item,
        isWinner: index === 0,
        placeText: "第 " + item.rank + " 名",
      })),
      weekOptions: view.weekOptions,
      weekOptionLabels: view.weekOptions.map((item) => item.label),
      selectedWeekIndex,
      selectedPeriodKey: payload.period_key,
      availableLevelSeasons,
      seasonOptionLabels,
      selectedLevelSeasonId,
      selectedSeasonLabel,
      currentLevelSeasonId,
      selectedSeasonIndex,
      showHistorySeasonEntry,
      showGroupScope: this.data.board !== "season" ||
        selectedLevelSeasonId === currentLevelSeasonId,
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
    const requestSerial = this.requestSerial;
    return this.fetchRankings(false, this.data.nextCursor).then((result) => {
      return this.applyListResult(result, false, requestSerial);
    }).catch(() => {
      if (this.requestSerial !== requestSerial) return;
      this.setData({
        loadingMore: false,
        errorMessage: "暂时无法读取排行榜数据，请稍后重试",
      });
    });
  },

  onRetry() {
    if (!this.userSelectedWeek) {
      this.setData({ selectedPeriodKey: null });
    }
    if (this.data.state === "validationError") {
      this.userSelectedWeek = false;
      this.userChangedSeason = false;
      this.autoSeasonFallback = false;
      this.setData({ selectedPeriodKey: null, selectedLevelSeasonId: null });
    }
    return this.loadFirstPage();
  },

  onSwitchToGlobal() {
    this.userSelectedWeek = false;
    this.explicitTargetSeasonId = null;
    return this.queueLoadFirstPage({
      scope: "global",
      groupId: null,
      selectedPeriodKey: null,
      showSwitchToGlobal: false,
    });
  },
});
