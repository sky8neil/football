const { initSession } = require("../../services/session.js");
const { storeNickname } = require("../../utils/nickname.js");

// 注意：/pages/matches/matches 在 app.json 的 tabBar 里，属于 tabBar 页面。
// tabBar 页面只能用 wx.switchTab 跳转；wx.redirectTo / wx.navigateTo 不被受理，
// 且是静默失败（不报错、不跳转），用错会让用户卡在会话页出不去。
const HOME_URL = "/pages/matches/matches";

Page({
  data: {
    nickname: "",
    loading: false,
    errorMessage: "",
    canSkip: false,
    canRetry: false,
  },

  onNicknameInput(event) {
    this.setData({ nickname: event.detail.value });
  },

  onSubmit() {
    if (this.data.loading) {
      return;
    }
    this.setData({ loading: true, errorMessage: "", canSkip: false, canRetry: false });
    initSession(this.data.nickname).then((result) => {
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
          ? "身份缺失"
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
