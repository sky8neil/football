const { getGroup, leaveGroup, dissolveGroup } = require("../../services/groups.js");
const COPY = require("../../utils/rankings-copy.js");

let authService = null;
try {
  authService = require("../../services/auth.js");
} catch (_error) {
  authService = null;
}

const SHARE_MENUS = ["shareAppMessage", "shareTimeline"];

function currentLoginGeneration() {
  if (!authService || typeof authService.getLoginGeneration !== "function") return 0;
  const value = authService.getLoginGeneration();
  return Number.isFinite(value) ? value : 0;
}

function setShareMenuEnabled(enabled) {
  if (enabled) {
    if (typeof wx.showShareMenu === "function") {
      wx.showShareMenu({ menus: SHARE_MENUS });
    }
    return;
  }
  if (typeof wx.hideShareMenu === "function") {
    wx.hideShareMenu({ menus: SHARE_MENUS });
  }
}

Page({
  data: {
    state: "loading",
    group: null,
    subtitle: "",
    isCreationSuccess: false,
    loadingAction: false,
    errorMessage: "",
    title: COPY.groupDetailTitle,
    shareText: COPY.shareGroup,
    leaveText: COPY.leaveGroup,
    dissolveText: COPY.dissolveGroup,
    loadFailedText: COPY.groupLoadFailed,
    ownerText: COPY.groupOwnerRole,
    memberText: COPY.groupMemberRole,
    inviteCodeLabel: COPY.groupInviteCodeLabel,
    copyText: COPY.copyInviteCode,
    retryText: COPY.groupRetry,
    inviteHintText: COPY.groupInviteHint,
    membersLabel: COPY.groupMembersLabel,
    rankingLabel: COPY.groupRankingLabel,
    rankingHintText: COPY.groupRankingHint,
    ownedLabel: COPY.groupOwnedLabel,
  },

  requestSerial: 0,
  loginGeneration: null,
  confirmingAction: false,

  onLoad(options) {
    const groupId = options && typeof options.group_id === "string" ? options.group_id : "";
    const isCreationSuccess = options && options.created === "1";
    const ownedCount = Number(options && options.owned_count) || 1;
    this.groupId = groupId;
    this.loginGeneration = currentLoginGeneration();
    this.confirmingAction = false;
    this.setData({
      isCreationSuccess,
      title: isCreationSuccess ? COPY.groupCreateSuccess : COPY.groupDetailTitle,
      subtitle: isCreationSuccess ? COPY.groupCreateSubtitle : "",
      ownedCountText: `${ownedCount} / 5`,
    });
    return this.loadGroup();
  },

  onShow() {
    const generation = currentLoginGeneration();
    const generationChanged = this.loginGeneration !== null && generation !== this.loginGeneration;
    this.loginGeneration = generation;
    if (generationChanged) {
      this.confirmingAction = false;
      this.setData({ group: null, loadingAction: false, errorMessage: "" });
      return this.loadGroup();
    }
    if (this.data.state === "unauthorized") {
      return this.loadGroup();
    }
  },

  loadGroup() {
    const requestSerial = (this.requestSerial || 0) + 1;
    this.requestSerial = requestSerial;
    const generation = currentLoginGeneration();
    this.loginGeneration = generation;
    const isCurrent = () => this.requestSerial === requestSerial && currentLoginGeneration() === generation;

    if (!this.groupId) {
      setShareMenuEnabled(false);
      this.setData({ state: "error", group: null, errorMessage: COPY.groupLoadFailed });
      return Promise.resolve();
    }
    setShareMenuEnabled(false);
    this.setData({ state: "loading", errorMessage: "" });
    return getGroup(this.groupId).then((result) => {
      if (!isCurrent()) return;
      if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
        setShareMenuEnabled(false);
        this.setData({
          state: "unauthorized",
          group: null,
          loadingAction: false,
          errorMessage: result.message || "请先登录后查看群详情",
        });
        return;
      }
      if (result.statusCode === 409 && result.code === "USER_DELETED") {
        setShareMenuEnabled(false);
        this.setData({
          state: "userDeleted",
          group: null,
          loadingAction: false,
          errorMessage: result.message || "当前账号不可用",
        });
        return;
      }
      if (result.statusCode !== 200 || !result.data) {
        setShareMenuEnabled(false);
        this.setData({ state: "error", errorMessage: result.message || COPY.groupLoadFailed });
        return;
      }
      setShareMenuEnabled(true);
      this.setData({
        state: "ready",
        group: {
          ...result.data,
          memberCountText: COPY.groupMemberCount(result.data.member_count),
          formattedInviteCode: `${result.data.invite_code.slice(0, 4)} ${result.data.invite_code.slice(4)}`,
          memberCapacityText: `${result.data.member_count} / 500`,
        },
        errorMessage: "",
      });
    }).catch(() => {
      if (!isCurrent()) return;
      setShareMenuEnabled(false);
      this.setData({ state: "error", errorMessage: COPY.groupLoadFailed });
    });
  },

  onLoginTap() {
    wx.navigateTo({ url: "/pages/session/session?return_to=group-detail" });
  },

  onShareAppMessage() {
    const group = this.data.group;
    if (!group || !group.invite_code) {
      return {
        title: COPY.groupSharedTitle,
        path: "/pages/groups/groups",
      };
    }
    return {
      title: COPY.groupSharedTitle,
      path: `/pages/groups/join?code=${encodeURIComponent(group.invite_code)}`,
    };
  },

  onCopyInviteTap() {
    const inviteCode = this.data.group && this.data.group.invite_code;
    if (!inviteCode) return;
    wx.setClipboardData({
      data: inviteCode,
      success: () => wx.showToast({ title: COPY.inviteCodeCopied, icon: "none" }),
    });
  },

  onLeaveTap() {
    this.confirmAction(COPY.groupLeaveConfirm, leaveGroup);
  },

  onDissolveTap() {
    this.confirmAction(COPY.groupDissolveConfirm, dissolveGroup);
  },

  confirmAction(content, action) {
    if (this.confirmingAction || this.data.loadingAction || !this.groupId) return;
    const generation = currentLoginGeneration();
    this.confirmingAction = true;
    wx.showModal({
      title: this.data.title,
      content,
      success: (result) => {
        if (currentLoginGeneration() !== generation) return;
        if (!result || !result.confirm) {
          this.confirmingAction = false;
          return;
        }
        if (this.data.loadingAction) {
          this.confirmingAction = false;
          return;
        }
        this.setData({ loadingAction: true, errorMessage: "" });
        return action(this.groupId).then((response) => {
          if (currentLoginGeneration() !== generation) {
            return;
          }
          this.confirmingAction = false;
          if (response.statusCode === 204) {
            this.setData({ loadingAction: false });
            wx.navigateBack({
              delta: 1,
              fail: () => wx.redirectTo({ url: "/pages/groups/groups" }),
            });
            return;
          }
          if (response.statusCode === 401 && response.code === "UNAUTHORIZED") {
            setShareMenuEnabled(false);
            this.setData({
              state: "unauthorized",
              group: null,
              loadingAction: false,
              errorMessage: response.message || "请先登录后操作",
            });
            return;
          }
          if (response.statusCode === 409 && response.code === "USER_DELETED") {
            setShareMenuEnabled(false);
            this.setData({
              state: "userDeleted",
              group: null,
              loadingAction: false,
              errorMessage: response.message || "当前账号不可用",
            });
            return;
          }
          this.setData({
            loadingAction: false,
            errorMessage: response.message || COPY.groupActionFailed,
          });
        }).catch(() => {
          if (currentLoginGeneration() !== generation) {
            return;
          }
          this.confirmingAction = false;
          this.setData({
            loadingAction: false,
            errorMessage: COPY.groupActionFailed,
          });
        });
      },
      fail: () => {
        if (currentLoginGeneration() !== generation) {
          return;
        }
        this.confirmingAction = false;
      },
    });
  },

  onRetry() {
    return this.loadGroup();
  },
});
