const { getMyProfile } = require("../../services/profile.js");
const { getMyLevels } = require("../../services/levels.js");
const { listMyGroups, createGroup } = require("../../services/groups.js");
const { listMatches } = require("../../services/matches.js");
const { getTeamLogo, PLACEHOLDER } = require("../../utils/logo-registry.js");
const { presentTeam } = require("../../utils/team-presentation.js");
const { findTeam } = require("../../utils/team-registry.js");
const { listMyPredictions } = require("../../services/predictions.js");
const authService = require("../../services/auth.js");
const { formatShanghaiKickoff } = require("../../utils/prediction-history.js");
const { headerHeight } = require("../../utils/ui-layout.js");
const { buildLevelView } = require("../../utils/level-presentation.js");
const LEVEL_NAMES = ["", "青训新人", "潜力新星", "崭露头角", "坐稳主力", "球队核心", "顶级球星"];
const COPY = require("../../utils/rankings-copy.js");
const MAX_TEAM_LOOKUP_PAGES = 5;

function currentLoginGeneration() {
  if (!authService || typeof authService.getLoginGeneration !== "function") return 0;
  const value = authService.getLoginGeneration();
  return Number.isFinite(value) ? value : 0;
}

function clearIdentityPatch(page) {
  page.recentRequestSerial = (page.recentRequestSerial || 0) + 1;
  page.favoriteTeamRequestId = (page.favoriteTeamRequestId || 0) + 1;
  return {
    userId: "",
    nickname: "",
    avatarText: "球",
    favoriteTeamId: null,
    favoriteTeamText: "",
    favoriteTeamLogo: PLACEHOLDER,
    recentState: "loading",
    recentPredictions: [],
  };
}

function applyErrorState(page, result) {
  if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
    page.setData({
      ...clearIdentityPatch(page),
      state: "unauthorized",
      errorMessage: result.message || "身份缺失",
    });
    return true;
  }
  if (result.statusCode === 409 && result.code === "USER_DELETED") {
    page.setData({
      ...clearIdentityPatch(page),
      state: "userDeleted",
      errorMessage: result.message || "账号已注销",
    });
    return true;
  }
  if (result.statusCode === 404 && result.code === "USER_NOT_FOUND") {
    page.setData({
      ...clearIdentityPatch(page),
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
  if (result.statusCode === 500 || result.code === "INTERNAL_ERROR") {
    page.setData({
      state: "error",
      errorMessage: "暂时无法读取你的等级数据，请稍后重试",
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

function myGroupsItems(result) {
  return result.data && Array.isArray(result.data.items) ? result.data.items : [];
}

function myGroupsNextCursor(result) {
  const page = (result.data && result.data.page) || {};
  if (page.has_more !== true) {
    return { complete: true, cursor: null };
  }
  const cursor = page.next_cursor;
  if (typeof cursor !== "string" || cursor.length === 0) {
    return { complete: false, cursor: null };
  }
  return { complete: false, cursor };
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
    favoriteTeamId: null,
    favoriteTeamLogo: PLACEHOLDER,
    careerPoints: "",
    careerValidPredictions: "",
    careerExactHits: "",
    careerLevel: "",
    careerBestLevel: "",
    seasonId: "",
    seasonPoints: "",
    seasonValidPredictions: "",
    seasonExactHits: "",
    seasonLevel: "",
    seasonBestLevel: "",
    ownedCount: 0,
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

  profileRequestSerial: 0,
  recentRequestSerial: 0,
  recentLoginGeneration: null,

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) tabBar.setData({ selected: 2 });
    const generation = currentLoginGeneration();
    if (this.recentLoginGeneration !== null && generation !== this.recentLoginGeneration) {
      this.setData(clearIdentityPatch(this));
    }
    this.recentLoginGeneration = generation;
    this.loadPage();
    this.loadRecentPredictions();
  },

  loadPage() {
    const requestSerial = (this.profileRequestSerial || 0) + 1;
    this.profileRequestSerial = requestSerial;
    this.setData({
      state: "loading",
      errorMessage: "",
    });
    return Promise.all([getMyProfile(), getMyLevels(), listMyGroups({ limit: 20 })]).then(async (results) => {
      if (this.profileRequestSerial !== requestSerial) return;
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
      const groups = myGroupsItems(groupsResult).slice();
      const seenCursors = new Set();
      let nextPage = myGroupsNextCursor(groupsResult);
      while (!nextPage.complete) {
        if (nextPage.cursor === null || seenCursors.has(nextPage.cursor) || seenCursors.size >= 100) {
          this.setData({
            state: "error",
            errorMessage: "暂时无法读取你的等级数据，请稍后重试",
          });
          return;
        }
        seenCursors.add(nextPage.cursor);
        const pageResult = await listMyGroups({ limit: 20, cursor: nextPage.cursor });
        if (this.profileRequestSerial !== requestSerial) return;
        if (applyErrorState(this, pageResult)) {
          return;
        }
        groups.push(...myGroupsItems(pageResult));
        nextPage = myGroupsNextCursor(pageResult);
      }
      if (this.profileRequestSerial !== requestSerial) return;
      const ownedCount = groups.filter((group) => group.role === "owner").length;
      const level = Number(profile.career_level) || 1;
      const nextThreshold = ({2: 80, 3: 170, 4: 380, 5: 630})[level] ?? null;
      const points = career.b_points == null ? null : Number(career.b_points);
      const levelView = buildLevelView({
        level,
        bPoints: points,
        isRated: career.is_rated,
        remainingToRated: career.remaining_to_rated,
        nextThreshold,
      });
      const progressPercent = points === null ? 0 : nextThreshold === null ? (level === 6 ? 100 : 0) : nextThreshold === 0 ? 0 : Math.min(100, Math.floor(points / nextThreshold * 100));
      const startLevel = Math.min(4, Math.max(1, level - 1));
      this.setData({
        userId: profile.user_id,
        favoriteTeamId: profile.favorite_team_id || null,
        favoriteTeamLogo: profile.favorite_team_id && wx.getStorageSync("team_logo:" + profile.favorite_team_id) || PLACEHOLDER,
        levelName: LEVEL_NAMES[level],
        seasonLevelName: LEVEL_NAMES[Number(profile.season_level) || 1],
        progressDegrees: progressPercent * 3.6,
        levelViewState: levelView.state,
        levelViewTitle: levelView.title,
        levelViewDetail: levelView.detail,
        levelProgressPercent: levelView.progressPercent,
        levelShowProgress: levelView.showProgress,
        performanceText: career.is_rated ? "以每周评估结果为准" : "还需 " + (career.remaining_to_rated || 0) + " 场有效预测定级",
        levelPath: [startLevel, startLevel + 1, startLevel + 2].map(value => ({level:value, name:LEVEL_NAMES[value], kind:value === level ? "current" : value === level + 1 ? "next" : ""})),
        state: "ready",
        errorMessage: "",
        nickname: profile.nickname,
        avatarText: Array.from(profile.nickname || "球")[0] || "球",
        favoriteTeamText: profile.favorite_team_id === null || profile.favorite_team_id === undefined
          ? "未设置"
          : ((findTeam(profile.favorite_team_id) || {}).name_zh || wx.getStorageSync("team_name:" + profile.favorite_team_id) || "已选择球队"),
        careerPoints: String(profile.career_points),
        careerValidPredictions: String(profile.career_valid_predictions),
        careerExactHits: String(profile.career_exact_hits),
        careerLevel: String(profile.career_level),
        careerBestLevel: String(profile.career_best_level),
        seasonId: season.level_season_id,
        seasonPoints: season.season_points == null ? "—" : String(season.season_points),
        seasonValidPredictions: String(season.valid_predictions),
        seasonExactHits: season.exact_hits == null ? "—" : String(season.exact_hits),
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
        ownedCount,
      });
      this.loadFavoriteTeam(profile.favorite_team_id || null);
    }).catch(() => {
      if (this.profileRequestSerial !== requestSerial) return;
      this.setData({
        state: "error",
        errorMessage: "暂时无法读取你的等级数据，请稍后重试",
      });
    });
  },

  async loadFavoriteTeam(teamId) {
    const requestId = (this.favoriteTeamRequestId || 0) + 1;
    this.favoriteTeamRequestId = requestId;
    if (!teamId) { this.setData({ favoriteTeamLogo: PLACEHOLDER, favoriteTeamText: "未设置" }); return; }
    const registered = findTeam(teamId);
    if (registered) {
      const teamLogo = getTeamLogo(registered.league_id, {
        team_id: teamId,
        name: registered.source_name,
      });
      if (teamLogo && teamLogo !== PLACEHOLDER) {
        wx.setStorageSync("team_name:" + teamId, registered.source_name);
        wx.setStorageSync("team_logo:" + teamId, teamLogo);
        this.setData({
          favoriteTeamText: registered.name_zh || registered.source_name,
          favoriteTeamLogo: teamLogo,
        });
        return;
      }
    } else {
      const logo = wx.getStorageSync("team_logo:" + teamId);
      if (logo && logo !== PLACEHOLDER) { this.setData({ favoriteTeamLogo: logo }); return; }
      if (logo === PLACEHOLDER && typeof wx.removeStorageSync === "function") {
        wx.removeStorageSync("team_logo:" + teamId);
      }
    }
    // Resolve the server's team ID after a fresh login or cleared cache.
    let cursor = null;
    let pages = 0;
    const seen = new Set();
    try {
      do {
        pages += 1;
        const result = await listMatches({ limit: 100, cursor });
        if (this.favoriteTeamRequestId !== requestId || result.statusCode !== 200) return;
        const payload = result.data || {};
        for (const match of payload.items || []) {
          const team = [match.home_team, match.away_team].find(item => item && item.team_id === teamId);
          if (!team) continue;
          const presented = presentTeam(team, match.league_id);
          const teamName = (presented && presented.nameZh && presented.nameZh !== "球队资料待补全")
            ? presented.nameZh
            : (team.name_zh || (findTeam(teamId) || {}).name_zh || team.name);
          const teamLogo = (presented && presented.logo) || getTeamLogo(match.league_id, team);
          wx.setStorageSync("team_name:" + teamId, teamName);
          if (teamLogo && teamLogo !== PLACEHOLDER) {
            wx.setStorageSync("team_logo:" + teamId, teamLogo);
          } else if (typeof wx.removeStorageSync === "function") {
            wx.removeStorageSync("team_logo:" + teamId);
          }
          this.setData({
            favoriteTeamText: teamName,
            favoriteTeamLogo: teamLogo || PLACEHOLDER,
          });
          return;
        }
        if (pages >= MAX_TEAM_LOOKUP_PAGES) return;
        cursor = (payload.page || {}).next_cursor || null;
        if (seen.has(cursor)) return;
        seen.add(cursor);
      } while (cursor);
    } catch (_) { /* Team lookup must not hide the growth profile. */ }
  },

  onTeamLogoError() {
    if (this.data.favoriteTeamId && typeof wx.removeStorageSync === "function") {
      wx.removeStorageSync("team_logo:" + this.data.favoriteTeamId);
    }
    this.setData({ favoriteTeamLogo: PLACEHOLDER });
  },

  onStatScope(event) {
    this.setData({ statScope: event.currentTarget.dataset.scope });
  },

  onLevelHelp() {
    wx.showModal({ title: "生涯等级与升级", content: "圆环仅表示最近一次评估的 B 分门槛进度。升级需要表现与积分同时达线，每周一 10:00（北京时间）评估，每次最多升一级。实际等级以服务端评估为准。", showCancel: false });
  },

  onRulesTap() {
    wx.showModal({ title: "计分与玩法规则", content: "精确比分命中 +12 分，仅胜平负命中 +3 分，未命中 0 分。正式比分以90分钟与伤停补时为准，不含加时和点球。开赛前10分钟截止，提交后不可修改或删除。", showCancel: false });
  },

  loadRecentPredictions() {
    const serial = (this.recentRequestSerial || 0) + 1;
    this.recentRequestSerial = serial;
    const generation = currentLoginGeneration();
    this.recentLoginGeneration = generation;
    const isCurrent = () => serial === this.recentRequestSerial
      && generation === currentLoginGeneration();
    this.setData({ recentState: "loading", recentPredictions: [] });
    return listMyPredictions({ limit: 2 }).then(result => {
      if (!isCurrent()) return;
      if (result.statusCode !== 200) { this.setData({ recentState: "error" }); return; }
      const items = result.data && result.data.items || [];
      this.setData({ recentState: "ready", recentPredictions: items.map((item) => {
        const homeTeam = item.home_team && item.home_team.team_id
          ? item.home_team
          : { team_id: item.home_team_id, name: (findTeam(item.home_team_id) || {}).source_name };
        const awayTeam = item.away_team && item.away_team.team_id
          ? item.away_team
          : { team_id: item.away_team_id, name: (findTeam(item.away_team_id) || {}).source_name };
        const homePresented = presentTeam(homeTeam, item.league_id);
        const awayPresented = presentTeam(awayTeam, item.league_id);
        const cancelled = item.match_status === "cancelled" || item.settlement_status === "voided";
        return ({
        homeNameZh: homePresented.nameZh,
        awayNameZh: awayPresented.nameZh,
        homeLogo: homePresented.logo,
        awayLogo: awayPresented.logo,
        ...item,
        kickoffText: formatShanghaiKickoff(item.kickoff_at),
        predictionText: item.pred_home_score + " : " + item.pred_away_score,
        actualText: cancelled ? "—" : item.regular_home_score == null ? "待结算" : item.regular_home_score + " : " + item.regular_away_score,
        pointsText: cancelled ? "不计分" : item.match_score == null ? "待结算" : "+" + item.match_score + " 分",
        resultClass: cancelled ? "pending" : item.match_score == null ? "pending" : item.exact_hit ? "exact" : item.wdl_hit ? "wdl" : "miss",
        resultText: cancelled
          ? "比赛取消 · 不计分"
          : item.exact_hit
            ? "精确命中"
            : item.wdl_hit
              ? "胜平负命中"
              : item.match_score == null
                ? (item.match_status === "postponed" ? "比赛延期" : item.match_status === "abandoned" ? "比赛腰斩" : "等待结算")
                : "未命中",
      }); }) });
    }).catch(() => {
      if (!isCurrent()) return;
      this.setData({ recentState: "error" });
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
    if (this.data.state !== "ready" || this.data.groupCreating) {
      return;
    }
    const generation = currentLoginGeneration();
    this.setData({ groupCreating: true, errorMessage: "" });
    return createGroup().then((result) => {
      if (generation !== currentLoginGeneration()) {
        this.setData({ groupCreating: false });
        return;
      }
      if (result.statusCode === 201 && result.data && result.data.group_id) {
        this.setData({ groupCreating: false });
        wx.navigateTo({ url: `/pages/groups/detail?group_id=${result.data.group_id}&created=1&owned_count=${this.data.ownedCount + 1}` });
        return;
      }
      if (
        (result.statusCode === 401 && result.code === "UNAUTHORIZED") ||
        (result.statusCode === 409 && result.code === "USER_DELETED") ||
        (result.statusCode === 404 && result.code === "USER_NOT_FOUND") ||
        (result.statusCode === 429 && result.code === "RATE_LIMITED")
      ) {
        this.setData({ groupCreating: false });
        applyErrorState(this, result);
        return;
      }
      this.setData({
        groupCreating: false,
        errorMessage: result.code === "GROUP_OWNED_LIMIT_REACHED"
          ? COPY.groupCreateLimitReached
          : result.code === "GROUP_JOIN_LIMIT_REACHED"
            ? COPY.groupJoinErrors.GROUP_JOIN_LIMIT_REACHED
            : result.message || COPY.groupActionFailed,
      });
    }).catch(() => {
      if (generation !== currentLoginGeneration()) {
        this.setData({ groupCreating: false });
        return;
      }
      this.setData({ groupCreating: false, errorMessage: COPY.groupActionFailed });
    });
  },

  onGroupTap(event) {
    const groupId = event.currentTarget.dataset.groupId;
    if (groupId) wx.navigateTo({ url: `/pages/groups/detail?group_id=${groupId}` });
  },

  onLoginTap() {
    wx.navigateTo({ url: "/pages/session/session" });
  },

  onSessionTap() {
    wx.navigateTo({ url: "/pages/settings/settings" });
  },

  onFavoriteTeamTap() {
    wx.navigateTo({ url: "/pages/settings/settings?section=team" });
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
    return Promise.all([this.loadPage(), this.loadRecentPredictions()]);
  },
});
