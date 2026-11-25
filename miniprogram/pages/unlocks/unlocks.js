const { getMyUnlocks } = require("../../services/unlocks.js");
const { getMyProfile } = require("../../services/profile.js");

let authService = null;
try {
  authService = require("../../services/auth.js");
} catch (_error) {
  authService = null;
}

function currentLoginGeneration() {
  if (!authService || typeof authService.getLoginGeneration !== "function") return 0;
  const value = authService.getLoginGeneration();
  return Number.isFinite(value) ? value : 0;
}

const UNLOCK_LABELS = {
  profile_card_style_1: "资料卡样式 1",
  favorite_team_name_accent: "主队名配色",
  favorite_team_avatar_frame_1: "主队头像框 1",
};

function applyErrorState(page, result) {
  if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
    page.setData({
      state: "unauthorized",
      errorMessage: result.message || "身份缺失",
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
  if (result.statusCode === 409 && result.code === "USER_DELETED") {
    page.setData({
      state: "userDeleted",
      errorMessage: result.message || "账号已注销",
    });
    return true;
  }
  if (result.statusCode === 422 && result.code === "VALIDATION_ERROR") {
    page.setData({
      state: "validationError",
      errorMessage: result.message || result.code,
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
  if (result.statusCode === 500) {
    page.setData({
      state: "serverError",
      errorMessage: result.message || result.code || "500",
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

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, "0");
}

/** 云端 unlocked_at 是 ISO 字符串，直接插值会把 2026-11-06T19:50:00.000Z 甩给用户。 */
function formatShanghaiDate(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  const date = new Date(time + SHANGHAI_OFFSET_MS);
  return `${date.getUTCFullYear()}/${pad2(date.getUTCMonth() + 1)}/${pad2(date.getUTCDate())}`;
}

function presentUnlock(item, careerPoints) {
  const code = item && item.unlock_code !== undefined ? String(item.unlock_code) : "";
  const mapped = Object.prototype.hasOwnProperty.call(UNLOCK_LABELS, code);
  const threshold = item && item.threshold_points !== undefined ? item.threshold_points : "";
  const unlockedAt = item && item.unlocked_at !== undefined ? item.unlocked_at : "";
  return {
    unlock_code: code,
    label: mapped ? UNLOCK_LABELS[code] : code,
    mapped: mapped,
    threshold_points: threshold,
    unlocked_at: unlockedAt,
    unlockedText: formatShanghaiDate(unlockedAt),
    progressText: String(careerPoints) + "/" + String(threshold),
  };
}

Page({
  data: {
    state: "loading",
    errorMessage: "",
    items: [],
  },

  requestSerial: 0,
  loginGeneration: null,

  onLoad() {
    this.loginGeneration = currentLoginGeneration();
    return this.loadPage();
  },

  onShow() {
    const generation = currentLoginGeneration();
    const generationChanged = this.loginGeneration !== null && generation !== this.loginGeneration;
    this.loginGeneration = generation;
    if (generationChanged || this.data.state === "unauthorized") {
      return this.loadPage();
    }
  },

  loadPage() {
    const requestSerial = (this.requestSerial || 0) + 1;
    this.requestSerial = requestSerial;
    const generation = currentLoginGeneration();
    this.loginGeneration = generation;
    const isCurrent = () => this.requestSerial === requestSerial && currentLoginGeneration() === generation;
    this.setData({
      state: "loading",
      errorMessage: "",
      items: [],
    });
    return Promise.all([getMyUnlocks(), getMyProfile()]).then((results) => {
      if (!isCurrent()) return;
      const unlocksResult = results[0];
      const profileResult = results[1];
      if (applyErrorState(this, unlocksResult)) {
        return;
      }
      if (applyErrorState(this, profileResult)) {
        return;
      }
      const payload = unlocksResult.data || {};
      const unlocked = Array.isArray(payload.unlocked) ? payload.unlocked : [];
      const profile = profileResult.data || {};
      const careerPoints = profile.career_points;
      const items = unlocked.map((item) => presentUnlock(item, careerPoints));
      this.setData({
        state: items.length === 0 ? "empty" : "list",
        items: items,
        errorMessage: "",
      });
    }).catch(() => {
      if (!isCurrent()) return;
      this.setData({ state: "error", errorMessage: "网络异常，请重试" });
    });
  },

  onLoginTap() {
    wx.navigateTo({ url: "/pages/session/session?return_to=unlocks" });
  },

  onRetry() {
    if (this.data.state === "rateLimited") {
      return;
    }
    return this.loadPage();
  },

  onGoPredict() {
    wx.switchTab({ url: "/pages/matches/matches" });
  },
});
