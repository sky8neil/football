const { getPublicProfile } = require("../../services/profile.js");
const {
  isPlaceholderLogo,
  resolveFavoriteTeamSync,
  resolveFavoriteTeamRemote,
} = require("../../services/teams.js");
const { findTeam } = require("../../utils/team-registry.js");
const { presentTeam } = require("../../utils/team-presentation.js");
const { PLACEHOLDER } = require("../../utils/logo-registry.js");

const LEVEL_NAMES = ["", "青训新人", "潜力新星", "崭露头角", "坐稳主力", "球队核心", "顶级球星"];
const DELETED_API_DISPLAY_NAME = "\u5df2\u6ce8\u9500\u7528\u6237";
const HISTORICAL_DISPLAY_NAME = "历史用户";

function resolveFavoriteTeam(favoriteTeamId) {
  const { needsRemoteLookup: _needsRemoteLookup, ...team } = resolveFavoriteTeamSync(favoriteTeamId, {
    findTeam,
    presentTeam,
    placeholder: PLACEHOLDER,
  });
  return team;
}

function levelName(level) {
  return LEVEL_NAMES[level] || LEVEL_NAMES[1];
}

function normalizePublicGender(value, isDeleted) {
  if (isDeleted) return "";
  if (value === "male" || value === "female") return value;
  return "";
}

Page({
  data: {
    state: "loading",
    userId: "",
    displayName: "",
    avatarInitial: "球",
    isDeleted: false,
    gender: "",
    favoriteTeamId: null,
    favoriteTeamText: "未设置",
    favoriteTeamLogo: PLACEHOLDER,
    hasFavoriteTeam: false,
    careerPoints: "0",
    careerValidPredictions: "0",
    careerExactHits: "0",
    careerLevel: "1",
    careerLevelName: LEVEL_NAMES[1],
    careerBestLevel: "1",
    careerBestLevelName: LEVEL_NAMES[1],
    seasonLevel: "1",
    seasonLevelName: LEVEL_NAMES[1],
    errorMessage: "",
  },

  requestSerial: 0,
  unloaded: false,

  onLoad(options) {
    this.unloaded = false;
    const rawUserId = options && typeof options.user_id === "string" ? options.user_id.trim() : "";
    let userId = rawUserId;
    if (userId) {
      try {
        userId = decodeURIComponent(userId);
      } catch (_error) {
        userId = rawUserId;
      }
    }
    this.userId = userId;
    return this.loadProfile();
  },

  onUnload() {
    this.unloaded = true;
    this.requestSerial += 1;
  },

  loadProfile() {
    const requestSerial = (this.requestSerial || 0) + 1;
    this.requestSerial = requestSerial;
    if (!this.userId) {
      this.setData({
        state: "validationError",
        userId: "",
        errorMessage: "缺少用户信息",
      });
      return Promise.resolve();
    }
    this.setData({
      state: "loading",
      userId: this.userId,
      errorMessage: "",
    });
    return getPublicProfile(this.userId).then((result) => {
      if (this.unloaded || this.requestSerial !== requestSerial) return;
      if (!result || typeof result !== "object") {
        this.setData({
          state: "error",
          errorMessage: "暂时无法读取公开主页，请稍后重试",
        });
        return;
      }
      if (result.statusCode === 404) {
        this.setData({
          state: "notFound",
          errorMessage: result.message || "用户不存在",
        });
        return;
      }
      if (result.statusCode === 422) {
        this.setData({
          state: "validationError",
          errorMessage: result.message || "用户信息无效",
        });
        return;
      }
      if (result.statusCode === 429 && result.code === "RATE_LIMITED") {
        this.setData({
          state: "rateLimited",
          errorMessage: result.message || "请求过于频繁，请稍后重试",
        });
        return;
      }
      if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
        this.setData({
          state: "unauthorized",
          errorMessage: result.message || "请先登录后查看",
        });
        return;
      }
      if (result.statusCode === 500 || result.code === "INTERNAL_ERROR") {
        this.setData({
          state: "error",
          errorMessage: "暂时无法读取公开主页，请稍后重试",
        });
        return;
      }
      if (result.statusCode !== 200 || !result.data) {
        this.setData({
          state: "error",
          errorMessage: result.message || String(result.code || result.statusCode || "加载失败"),
        });
        return;
      }
      const profile = result.data;
      const rawDisplayName = typeof profile.display_name === "string" && profile.display_name
        ? profile.display_name
        : "预言家";
      const isDeleted = rawDisplayName === DELETED_API_DISPLAY_NAME;
      const displayName = isDeleted ? HISTORICAL_DISPLAY_NAME : rawDisplayName;
      const avatarInitial = Array.from(displayName)[0] || "球";
      const gender = normalizePublicGender(profile.gender, isDeleted);
      const careerLevel = Number(profile.career_level) || 1;
      const careerBestLevel = Number(profile.career_best_level) || careerLevel;
      const seasonLevel = Number(profile.season_level) || 1;
      const team = isDeleted
        ? resolveFavoriteTeam(null)
        : resolveFavoriteTeam(profile.favorite_team_id || null);

      this.setData({
        state: "ready",
        userId: profile.user_id || this.userId,
        displayName,
        avatarInitial,
        isDeleted,
        gender,
        ...team,
        careerPoints: String(profile.career_points ?? 0),
        careerValidPredictions: String(profile.career_valid_predictions ?? 0),
        careerExactHits: String(profile.career_exact_hits ?? 0),
        careerLevel: String(careerLevel),
        careerLevelName: levelName(careerLevel),
        careerBestLevel: String(careerBestLevel),
        careerBestLevelName: levelName(careerBestLevel),
        seasonLevel: String(seasonLevel),
        seasonLevelName: levelName(seasonLevel),
        errorMessage: "",
      });
      return this.hydrateFavoriteTeam(team.favoriteTeamId, isDeleted, requestSerial);
    }).catch(() => {
      if (this.unloaded || this.requestSerial !== requestSerial) return;
      this.setData({
        state: "error",
        errorMessage: "网络异常，请稍后重试",
      });
    });
  },

  async hydrateFavoriteTeam(favoriteTeamId, isDeleted, requestSerial) {
    if (!favoriteTeamId || isDeleted) return;
    const syncState = resolveFavoriteTeamSync(favoriteTeamId, {
      findTeam,
      presentTeam,
      placeholder: PLACEHOLDER,
    });
    if (!syncState.needsRemoteLookup) return;
    try {
      const resolved = await resolveFavoriteTeamRemote(favoriteTeamId, {
        presentTeam,
        placeholder: PLACEHOLDER,
      });
      if (!resolved) return;
      if (
        this.unloaded ||
        this.requestSerial !== requestSerial ||
        this.data.state !== "ready" ||
        this.data.isDeleted ||
        this.data.favoriteTeamId !== favoriteTeamId
      ) {
        return;
      }
      const nextText = resolved.favoriteTeamText || this.data.favoriteTeamText || "已选择球队";
      const nextLogo = !isPlaceholderLogo(resolved.favoriteTeamLogo, PLACEHOLDER)
        ? resolved.favoriteTeamLogo
        : (this.data.favoriteTeamLogo || PLACEHOLDER);
      if (nextText === this.data.favoriteTeamText && nextLogo === this.data.favoriteTeamLogo) {
        return;
      }
      this.setData({
        favoriteTeamText: nextText,
        favoriteTeamLogo: nextLogo,
      });
    } catch (_error) {
      /* 远端球队资料补全失败时保留兜底展示，不阻塞公开主页 */
    }
  },

  onTeamLogoError() {
    this.setData({ favoriteTeamLogo: PLACEHOLDER });
  },

  onRetry() {
    if (
      this.data.state === "rateLimited" ||
      this.data.state === "notFound" ||
      this.data.state === "validationError"
    ) {
      return;
    }
    return this.loadProfile();
  },

  onLoginTap() {
    wx.navigateTo({ url: "/pages/session/session" });
  },

  onBackTap() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.switchTab({ url: "/pages/rankings/rankings" }),
    });
  },
});
