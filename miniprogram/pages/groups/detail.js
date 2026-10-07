const { getGroup, leaveGroup, dissolveGroup } = require("../../services/groups.js");
const COPY = require("../../utils/rankings-copy.js");

Page({
  data: {
    state: "loading",
    group: null,
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
    retryText: COPY.groupRetry,
  },

  onLoad(options) {
    const groupId = options && typeof options.group_id === "string" ? options.group_id : "";
    this.groupId = groupId;
    this.loadGroup();
  },

  loadGroup() {
    if (!this.groupId) {
      this.setData({ state: "error", errorMessage: COPY.groupLoadFailed });
      return;
    }
    this.setData({ state: "loading", errorMessage: "" });
    getGroup(this.groupId).then((result) => {
      if (result.statusCode !== 200 || !result.data) {
        this.setData({ state: "error", errorMessage: result.message || COPY.groupLoadFailed });
        return;
      }
      this.setData({
        state: "ready",
        group: {
          ...result.data,
          memberCountText: COPY.groupMemberCount(result.data.member_count),
        },
        errorMessage: "",
      });
    });
  },

  onShareAppMessage() {
    const group = this.data.group;
    return {
      title: COPY.groupSharedTitle,
      path: `/pages/groups/join?code=${encodeURIComponent(group.invite_code)}`,
    };
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
        action(this.groupId).then((response) => {
          if (response.statusCode === 204) {
            wx.navigateBack({ delta: 1 });
            return;
          }
          this.setData({
            loadingAction: false,
            errorMessage: response.message || COPY.groupActionFailed,
          });
        });
      },
    });
  },

  onRetry() {
    this.loadGroup();
  },
});
