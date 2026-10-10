const { getMyProfile } = require("../../services/profile.js");
const { getMyLevels } = require("../../services/levels.js");
const { listMyGroups, createGroup } = require("../../services/groups.js");
const COPY = require("../../utils/rankings-copy.js");

function applyErrorState(page, result) {
  if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
    page.setData({
      state: "unauthorized",
      errorMessage: result.message || "身份缺失",
    });
    return true;
  }
  if (result.statusCode === 409 && result.code === "USER_DELETED") {
    page.setData({
      state: "userDeleted",
      errorMessage: result.message || "账号已注销",
    });
    return true;
  }
  if (result.statusCode === 404 && result.code === "USER_NOT_FOUND") {
    page.setData({
      state: "userNotFound",
      errorMessage: result.message || "用户不存在",
    });
    return true;
  }
  if (result.statusCode === 429 && result.code === "RATE_LIMITED") {
    page.setData({
      state: "rateLimited",
      errorMessage: result.message || result.code,
    });
    return true;
  }
  if (result.statusCode !== 200) {
    page.setData({
      state: "error",
      errorMessage: result.message || String(result.code || result.statusCode),
    });
    return true;
  }
  return false;
}

Page({
  data: {
    state: "loading",
    errorMessage: "",
    nickname: "",
    avatarText: "球",
    favoriteTeamText: "",
    careerPoints: "",
    careerValidPredictions: "",
    careerExactHits: "",
    careerLevel: "",
    careerBestLevel: "",
    seasonId: "",
    seasonValidPredictions: "",
    seasonLevel: "",
    seasonBestLevel: "",
    levelsCareerValidPredictions: "",
    levelsCareerLevel: "",
    levelsCareerBestLevel: "",
    previousSeasonRecap: "",
    groups: [],
    hasGroups: false,
    groupCreating: false,
    emptyGroupsText: COPY.profileEmptyGroups,
    joinGroupText: COPY.joinGroup,
    createGroupText: COPY.createGroup,
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 2 });
    this.loadPage();
  },

  loadPage() {
    this.setData({
      state: "loading",
      errorMessage: "",
    });
    Promise.all([getMyProfile(), getMyLevels(), listMyGroups({ limit: 20 })]).then((results) => {
      const profileResult = results[0];
      const levelsResult = results[1];
      const groupsResult = results[2];
      if (applyErrorState(this, profileResult)) {
        return;
      }
      if (applyErrorState(this, levelsResult)) {
        return;
      }
      if (applyErrorState(this, groupsResult)) {
        return;
      }
      const profile = profileResult.data || {};
      const levels = levelsResult.data || {};
      const season = levels.season || {};
      const career = levels.career || {};
      const groups = groupsResult.data && Array.isArray(groupsResult.data.items)
        ? groupsResult.data.items
        : [];
      this.setData({
        state: "ready",
        errorMessage: "",
        nickname: profile.nickname,
        avatarText: Array.from(profile.nickname || "球")[0] || "球",
        favoriteTeamText: profile.favorite_team_id === null || profile.favorite_team_id === undefined
          ? "未设置"
          : "已选择球队",
        careerPoints: String(profile.career_points),
        careerValidPredictions: String(profile.career_valid_predictions),
        careerExactHits: String(profile.career_exact_hits),
        careerLevel: String(profile.career_level),
        careerBestLevel: String(profile.career_best_level),
        seasonId: season.level_season_id,
        seasonValidPredictions: String(season.valid_predictions),
        seasonLevel: String(profile.season_level),
        seasonBestLevel: String(season.best_level),
        levelsCareerValidPredictions: String(career.valid_predictions),
        levelsCareerLevel: String(career.level),
        levelsCareerBestLevel: String(career.best_level),
        previousSeasonRecap: profile.previous_season
          ? COPY.recapDetails(profile.previous_season.points, profile.previous_season.best_level,
            profile.previous_season.valid_predictions)
          : "",
        groups: groups.map((group) => ({
          ...group,
          memberCountText: COPY.groupMemberCount(group.member_count),
        })),
        hasGroups: groups.length > 0,
      });
    });
  },

  onPredictionsTap() {
    wx.navigateTo({ url: "/pages/my-predictions/my-predictions" });
  },

  onGroupsTap() {
    wx.navigateTo({ url: "/pages/groups/groups" });
  },

  onJoinGroupTap() {
    wx.navigateTo({ url: "/pages/groups/join" });
  },

  onCreateGroupTap() {
    this.setData({ groupCreating: true, errorMessage: "" });
    return createGroup().then((result) => {
      this.setData({ groupCreating: false });
      if (result.statusCode !== 201) {
        this.setData({ errorMessage: result.message || COPY.groupActionFailed });
        return;
      }
      wx.navigateTo({ url: `/pages/groups/detail?group_id=${result.data.group_id}&created=1&owned_count=1` });
    });
  },

  onGroupTap(event) {
    const groupId = event.currentTarget.dataset.groupId;
    if (groupId) wx.navigateTo({ url: `/pages/groups/detail?group_id=${groupId}` });
  },

  onSessionTap() {
    wx.navigateTo({ url: "/pages/session/session" });
  },

  onUnlocksTap() {
    wx.navigateTo({
      url: "/pages/unlocks/unlocks",
    });
  },

  onRetry() {
    if (this.data.state === "rateLimited") {
      return;
    }
    this.loadPage();
  },
});
