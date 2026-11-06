const { initSession } = require("../../services/session.js");
const { storeNickname, normalizeNickname, NICKNAME_STORAGE_KEY } = require("../../utils/nickname.js");

// 注意：/pages/matches/matches 在 app.json 的 tabBar 里，属于 tabBar 页面。
// tabBar 页面只能用 wx.switchTab 跳转；wx.redirectTo / wx.navigateTo 不被受理，
// 且是静默失败（不报错、不跳转），用错会让用户卡在会话页出不去。
const HOME_URL = "/pages/matches/matches";

// 与服务端一致：1～32 个字符（src/application/session.ts 的 validateNickname）。
// 前端只做前置拦截，最终以服务端校验结果为准。
const NICKNAME_MAX_CHARS = 32;

function charCount(value) {
  // 按 code point 计数，避免 emoji 被算成两个字符（与 utils/nickname.js 的截断口径一致）。
  return Array.from(value).length;
}

/** 回填上次用过的昵称；缓存缺失或脏数据一律当空。 */
function cachedNickname() {
  try {
    if (typeof normalizeNickname !== "function" || !NICKNAME_STORAGE_KEY) return "";
    return normalizeNickname(wx.getStorageSync(NICKNAME_STORAGE_KEY)) || "";
  } catch (_error) {
    return "";
  }
}

Page({
  data: {
    nickname: "",
    loading: false,
    errorMessage: "",
    canSkip: false,
    canRetry: false,
    returnTo: "",
    overflow: false,
    lengthText: "",
  },

  onLoad(query) {
    const patch = {
      returnTo: query && query.return_to === "match-detail" ? "match-detail" : "",
    };
    // 只在缓存里有可用昵称时回填，避免把用户已输入的内容清空。
    const nickname = cachedNickname();
    if (nickname) {
      const count = charCount(nickname);
      patch.nickname = nickname;
      patch.overflow = count > NICKNAME_MAX_CHARS;
      patch.lengthText = `${count}/${NICKNAME_MAX_CHARS}`;
    }
    this.setData(patch);
  },

  onNicknameInput(event) {
    const value = event && event.detail && typeof event.detail.value === "string"
      ? event.detail.value
      : "";
    this.updateNickname(value);
  },

  updateNickname(value) {
    const count = charCount(value);
    this.setData({
      nickname: value,
      overflow: count > NICKNAME_MAX_CHARS,
      lengthText: count === 0 ? "" : `${count}/${NICKNAME_MAX_CHARS}`,
      errorMessage: "",
    });
  },

  onClear() {
    this.updateNickname("");
  },

  onSubmit() {
    if (this.data.loading) return;
    const nickname = String(this.data.nickname || "").trim();
    if (nickname.length === 0) {
      this.setData({ errorMessage: "先填个昵称，球友们才好认出你" });
      return;
    }
    if (charCount(nickname) > NICKNAME_MAX_CHARS) {
      this.setData({ errorMessage: `昵称最多 ${NICKNAME_MAX_CHARS} 个字符` });
      return;
    }
    this.setData({ loading: true, errorMessage: "", canSkip: false, canRetry: false });
    initSession(nickname).then((result) => {
      const ok = result.statusCode === 200 || result.statusCode === 201;
      if (ok) {
        // 昵称取服务端校验并 trim 后的值（MVP §24.1 Response data 含 nickname），
        // 写入本地缓存，供首页第一行展示。
        const payload = result.data && typeof result.data === "object" ? result.data : {};
        storeNickname(payload.nickname);
        const pendingInviteCode = wx.getStorageSync("pending_group_invite_code");
        if (pendingInviteCode) {
          wx.removeStorageSync("pending_group_invite_code");
          wx.reLaunch({ url: `/pages/groups/join?code=${encodeURIComponent(pendingInviteCode)}` });
          return;
        }
        if (this.data.returnTo === "match-detail") {
          wx.navigateBack({ delta: 1 });
          return;
        }
        wx.switchTab({ url: HOME_URL });
        return;
      }
      if (result.statusCode === 409 && result.code === "USER_DELETED") {
        this.setData({
          loading: false,
          errorMessage: "账号已注销",
          canSkip: true,
          canRetry: false,
        });
        return;
      }
      const unauthorized = result.statusCode === 401 && result.code === "UNAUTHORIZED";
      const rateLimited = result.statusCode === 429 && result.code === "RATE_LIMITED";
      this.setData({
        loading: false,
        errorMessage: unauthorized
          ? "请在微信中打开"
          : rateLimited
            ? "请稍后重试"
            : result.message || String(result.code || result.statusCode),
        canSkip: unauthorized,
        canRetry: true,
      });
    });
  },

  onRetry() {
    this.onSubmit();
  },

  onSkip() {
    wx.switchTab({ url: HOME_URL });
  },
});
