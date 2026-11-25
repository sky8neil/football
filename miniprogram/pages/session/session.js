const { initSession } = require("../../services/session.js");
const { storeNickname, normalizeNickname, NICKNAME_STORAGE_KEY } = require("../../utils/nickname.js");

// 注意：/pages/matches/matches 在 app.json 的 tabBar 里，属于 tabBar 页面。
// tabBar 页面只能用 wx.switchTab 跳转；wx.redirectTo / wx.navigateTo 不被受理，
// 且是静默失败（不报错、不跳转），用错会让用户卡在会话页出不去。
const HOME_URL = "/pages/matches/matches";
const RETURN_TARGETS = [
  "match-detail",
  "share-card",
  "my-predictions",
  "groups",
  "group-detail",
  "settings",
  "unlocks",
];

// 与服务端一致：1～32 个 Unicode grapheme（src/application/session.ts 的 validateNickname）。
// 仅 Intl.Segmenter 可用时做前置拦截；不可用时不因本地长度拒绝，最终以服务端为准。
const NICKNAME_MAX_CHARS = 32;

// 隐私协议的兜底名称：getPrivacySetting 拿不到时用它，避免弹窗出现空书名号。
const PRIVACY_CONTRACT_FALLBACK = "《小程序用户隐私保护指引》";
// 同意按钮的 id 必须与 WXML 一致：resolve 时要把 buttonId 回传给微信。
const PRIVACY_AGREE_BUTTON_ID = "privacy-agree-btn";

/** 有 Intl.Segmenter 时返回 grapheme 数；没有时返回 null，调用方不得据此拒绝提交。 */
function graphemeCount(value) {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return null;
  return [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)].length;
}

function lengthFeedback(value) {
  const count = graphemeCount(value);
  if (count === null) return { overflow: false, lengthText: "" };
  return {
    overflow: count > NICKNAME_MAX_CHARS,
    lengthText: count === 0 ? "" : `${count}/${NICKNAME_MAX_CHARS}`,
  };
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
    showPrivacy: false,
    privacyContractName: PRIVACY_CONTRACT_FALLBACK,
    privacyRejected: false,
  },

  onLoad(query) {
    const patch = {
      returnTo: query && RETURN_TARGETS.indexOf(query.return_to) !== -1
        ? query.return_to
        : "",
    };
    // 只在缓存里有可用昵称时回填，避免把用户已输入的内容清空。
    const nickname = cachedNickname();
    if (nickname) {
      const feedback = lengthFeedback(nickname);
      patch.nickname = nickname;
      patch.overflow = feedback.overflow;
      patch.lengthText = feedback.lengthText;
    }
    this.setData(patch);
    this.initPrivacy();
  },

  /**
   * 主动查隐私授权状态。
   *
   * 为什么不能只靠 wx.onNeedPrivacyAuthorization：官方文档明确说
   * <input type="nickname"> 在用户未同意隐私协议时【不会】触发该事件，
   * 而是静默降级成 <input type="text">——用户会以为「微信昵称填不进来」，
   * 却看不到任何授权入口。所以必须在进页面时主动查一次。
   *
   * 基础库 < 2.32.3 不做隐私拦截，接口不存在时直接跳过。
   */
  initPrivacy() {
    if (typeof wx.getPrivacySetting === "function") {
      wx.getPrivacySetting({
        success: (res) => {
          if (res && res.needAuthorization) {
            this.setData({
              showPrivacy: true,
              privacyContractName: res.privacyContractName || PRIVACY_CONTRACT_FALLBACK,
            });
          }
        },
        fail: () => {},
      });
    }
    // 兜底通道：页面里若还有别的隐私接口被调用，也用同一张卡承接，
    // 避免微信弹出样式不一致的系统弹窗。不响应时微信才会自己兜底。
    if (typeof wx.onNeedPrivacyAuthorization === "function" && !this._privacyHandler) {
      this._privacyHandler = (resolve) => {
        this._privacyResolve = resolve;
        this.setData({ showPrivacy: true });
      };
      wx.onNeedPrivacyAuthorization(this._privacyHandler);
    }
  },

  onUnload() {
    // 不注销会在页面销毁后仍持有旧的 resolve，下一个页面触发隐私接口时
    // 微信拿到的是已经没人处理的回调。
    if (this._privacyHandler && typeof wx.offNeedPrivacyAuthorization === "function") {
      wx.offNeedPrivacyAuthorization(this._privacyHandler);
    }
    this._privacyHandler = null;
    this._privacyResolve = null;
  },

  /** 同意/拒绝都必须 resolve，否则被挂起的隐私接口永远不会返回。 */
  settlePrivacy(event) {
    if (this._privacyResolve) {
      this._privacyResolve({ buttonId: PRIVACY_AGREE_BUTTON_ID, event });
      this._privacyResolve = null;
    }
    this.setData({ showPrivacy: false, privacyRejected: event === "disagree" });
  },

  // 绑定在 open-type="agreePrivacyAuthorization" 的 bindagreeprivacyauthorization 上：
  // 微信在用户点击时完成同意同步，这里只负责收尾。
  onAgreePrivacy() {
    this.settlePrivacy("agree");
  },

  onRejectPrivacy() {
    this.settlePrivacy("disagree");
  },

  onOpenPrivacyContract() {
    if (typeof wx.openPrivacyContract === "function") {
      wx.openPrivacyContract({ fail: () => {} });
    }
  },

  noop() {},

  onNicknameInput(event) {
    const value = event && event.detail && typeof event.detail.value === "string"
      ? event.detail.value
      : "";
    this.updateNickname(value);
  },

  updateNickname(value) {
    const feedback = lengthFeedback(value);
    this.setData({
      nickname: value,
      overflow: feedback.overflow,
      lengthText: feedback.lengthText,
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
    const count = graphemeCount(nickname);
    if (count !== null && count > NICKNAME_MAX_CHARS) {
      this.setData({ errorMessage: `昵称最多 ${NICKNAME_MAX_CHARS} 个字符` });
      return;
    }
    this.setData({ loading: true, errorMessage: "", canSkip: false, canRetry: false });
    let pending;
    try {
      pending = Promise.resolve(initSession(nickname));
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then((result) => {
      if (!result || typeof result !== "object") {
        this.setData({
          loading: false,
          errorMessage: "网络异常，请稍后重试",
          canSkip: false,
          canRetry: true,
        });
        return;
      }
      const ok = result.statusCode === 200 || result.statusCode === 201;
      if (ok) {
        // 昵称取服务端校验并 trim 后的值（MVP §24.1 Response data 含 nickname），
        // 写入本地缓存，供首页第一行展示。
        const payload = result.data && typeof result.data === "object" ? result.data : {};
        storeNickname(payload.nickname);
        const onNavFail = () => {
          this.setData({ loading: false, canRetry: true });
        };
        if (RETURN_TARGETS.indexOf(this.data.returnTo) !== -1) {
          wx.navigateBack({
            delta: 1,
            fail: () => {
              wx.switchTab({ url: HOME_URL, fail: onNavFail });
            },
          });
          return;
        }
        const pendingInviteCode = wx.getStorageSync("pending_group_invite_code");
        if (pendingInviteCode) {
          wx.removeStorageSync("pending_group_invite_code");
          wx.reLaunch({
            url: `/pages/groups/join?code=${encodeURIComponent(pendingInviteCode)}`,
            fail: onNavFail,
          });
          return;
        }
        wx.switchTab({ url: HOME_URL, fail: onNavFail });
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
    }).catch((error) => {
      this.setData({
        loading: false,
        errorMessage: (error && error.message) || "网络异常，请稍后重试",
        canSkip: false,
        canRetry: true,
      });
    });
  },

  onRetry() {
    this.onSubmit();
  },

  onSkip() {
    wx.removeStorageSync("pending_group_invite_code");
    wx.switchTab({ url: HOME_URL });
  },
});
