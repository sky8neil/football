const { initSession } = require("../../services/session.js");

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
        wx.redirectTo({ url: "/pages/matches/matches" });
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
    wx.redirectTo({ url: "/pages/matches/matches" });
  },
});
