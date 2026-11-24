const { getGroup, leaveGroup, dissolveGroup } = require("../../services/groups.js");
const COPY = require("../../utils/rankings-copy.js");

const SHARE_MENUS = ["shareAppMessage", "shareTimeline"];

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

  onLoad(options) {
    const groupId = options && typeof options.group_id === "string" ? options.group_id : "";
    const isCreationSuccess = options && options.created === "1";
    const ownedCount = Number(options && options.owned_count) || 1;
    this.groupId = groupId;
    this.setData({
      isCreationSuccess,
      title: isCreationSuccess ? COPY.groupCreateSuccess : COPY.groupDetailTitle,
      subtitle: isCreationSuccess ? COPY.groupCreateSubtitle : "",
      ownedCountText: `${ownedCount} / 5`,
    });
    this.loadGroup();
  },

  loadGroup() {
    if (!this.groupId) {
      setShareMenuEnabled(false);
      this.setData({ state: "error", errorMessage: COPY.groupLoadFailed });
      return;
    }
    setShareMenuEnabled(false);
    this.setData({ state: "loading", errorMessage: "" });
    return getGroup(this.groupId).then((result) => {
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
      setShareMenuEnabled(false);
      this.setData({ state: "error", errorMessage: COPY.groupLoadFailed });
    });
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
    if (this.data.loadingAction || !this.groupId) return;
    wx.showModal({
      title: this.data.title,
      content,
      success: (result) => {
        if (!result.confirm) return;
        this.setData({ loadingAction: true, errorMessage: "" });
        return action(this.groupId).then((response) => {
          if (response.statusCode === 204) {
            wx.navigateBack({ delta: 1 });
            return;
          }
          this.setData({
            loadingAction: false,
            errorMessage: response.message || COPY.groupActionFailed,
          });
        }).catch(() => {
          this.setData({
            loadingAction: false,
            errorMessage: COPY.groupActionFailed,
          });
        });
      },
    });
  },

  onRetry() {
    this.loadGroup();
  },
});
