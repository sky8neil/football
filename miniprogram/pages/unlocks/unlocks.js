const { getMyUnlocks } = require("../../services/unlocks.js");
const { getMyProfile } = require("../../services/profile.js");

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

/** 云端 unlocked_at 是 ISO 字符串，直接插值会把 2026-11-06T19:50:00.000Z 甩给用户。 */
function formatShanghaiDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
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

  onLoad() {
    this.loadPage();
  },

  loadPage() {
    this.setData({
      state: "loading",
      errorMessage: "",
      items: [],
    });
    Promise.all([getMyUnlocks(), getMyProfile()]).then((results) => {
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
    });
  },

  onRetry() {
    if (this.data.state === "rateLimited") {
      return;
    }
    this.loadPage();
  },
});
