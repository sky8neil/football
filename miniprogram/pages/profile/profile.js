const { getMyProfile } = require("../../services/profile.js");
const { getMyLevels } = require("../../services/levels.js");

function displayTeamId(value) {
  if (value === null || value === undefined) {
    return "未设置";
  }
  return String(value);
}

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
  },

  onShow() {
    this.loadPage();
  },

  loadPage() {
    this.setData({
      state: "loading",
      errorMessage: "",
    });
    Promise.all([getMyProfile(), getMyLevels()]).then((results) => {
      const profileResult = results[0];
      const levelsResult = results[1];
      if (applyErrorState(this, profileResult)) {
        return;
      }
      if (applyErrorState(this, levelsResult)) {
        return;
      }
      const profile = profileResult.data || {};
      const levels = levelsResult.data || {};
      const season = levels.season || {};
      const career = levels.career || {};
      this.setData({
        state: "ready",
        errorMessage: "",
        nickname: profile.nickname,
        favoriteTeamText: displayTeamId(profile.favorite_team_id),
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
      });
    });
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
