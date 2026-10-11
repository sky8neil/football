const { getMyProfile } = require("../../services/profile.js");
const { getMyLevels } = require("../../services/levels.js");
const { listMyGroups, createGroup } = require("../../services/groups.js");
const { getMatchDetail } = require("../../services/matches.js");
const { getTeamLogo } = require("../../utils/logo-registry.js");
const { listMyPredictions } = require("../../services/predictions.js");
const { formatShanghaiKickoff } = require("../../utils/prediction-history.js");
const { headerHeight } = require("../../utils/ui-layout.js");
const LEVEL_NAMES = ["", "青训新人", "潜力新星", "崭露头角", "坐稳主力", "球队核心", "顶级球星"];
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
    headerHeight: headerHeight(),
    statScope: "career",
    recentState: "loading",
    recentPredictions: [],
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
    this.loadRecentPredictions();
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
      const level = Number(profile.career_level) || 1;
      const nextThreshold = ({2: 80, 3: 170, 4: 380, 5: 630})[level] ?? null;
      const points = Number(profile.career_points) || 0;
      const progressPercent = nextThreshold === null ? (level === 6 ? 100 : 0) : nextThreshold === 0 ? 0 : Math.min(100, Math.floor(points / nextThreshold * 100));
      const startLevel = Math.min(4, Math.max(1, level - 1));
      this.setData({
        userId: profile.user_id,
        maxLevel: level === 6,
        levelName: LEVEL_NAMES[level],
        seasonLevelName: LEVEL_NAMES[Number(profile.season_level) || 1],
        nextThreshold, progressPercent, progressDegrees: progressPercent * 3.6,
        remainingPoints: nextThreshold === null ? 0 : Math.max(0, nextThreshold - points),
        performanceText: career.is_rated ? "以每周评估结果为准" : "还需 " + (career.remaining_to_rated || 0) + " 场有效预测定级",
        levelPath: [startLevel, startLevel + 1, startLevel + 2].map(value => ({level:value, name:LEVEL_NAMES[value], kind:value === level ? "current" : value === level + 1 ? "next" : ""})),
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

  onStatScope(event) {
    this.setData({ statScope: event.currentTarget.dataset.scope });
  },

  onLevelHelp() {
    wx.showModal({ title: "生涯等级与升级", content: "圆环仅表示累计积分门槛进度。升级需要表现与积分同时达线，每周一 10:00（北京时间）评估，每次最多升一级。实际等级以服务端评估为准。", showCancel: false });
  },

  onRulesTap() {
    wx.showModal({ title: "计分与玩法规则", content: "精确比分命中 +12 分，仅胜平负命中 +3 分，未命中 0 分。正式比分以90分钟与伤停补时为准，不含加时和点球。开赛前10分钟截止，提交后不可修改或删除。", showCancel: false });
  },

  loadRecentPredictions() {
    return listMyPredictions({ limit: 2 }).then(async result => {
      if (result.statusCode !== 200) { this.setData({ recentState: "error" }); return; }
      const items = result.data && result.data.items || [];
      const details = await Promise.all(items.map(item => getMatchDetail(item.match_id).catch(() => null)));
      this.setData({ recentState: "ready", recentPredictions: items.map((item, index) => {
        const detail = details[index];
        const match = detail && detail.statusCode === 200 && detail.data || {};
        return ({
        homeName: match.home_team && match.home_team.name || "主队",
        awayName: match.away_team && match.away_team.name || "客队",
        homeLogo: getTeamLogo(item.league_id, match.home_team),
        awayLogo: getTeamLogo(item.league_id, match.away_team),
        ...item,
        kickoffText: formatShanghaiKickoff(item.kickoff_at),
        predictionText: item.pred_home_score + " : " + item.pred_away_score,
        actualText: item.regular_home_score == null ? "待结算" : item.regular_home_score + " : " + item.regular_away_score,
        pointsText: item.match_score == null ? "待结算" : "+" + item.match_score + " 分",
        resultClass: item.exact_hit ? "exact" : item.wdl_hit ? "wdl" : "miss",
        resultText: item.exact_hit ? "精确命中" : item.wdl_hit ? "胜平负命中" : item.match_score == null ? "等待结算" : "未命中",
      }); }) });
    }).catch(() => this.setData({ recentState: "error" }));
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
