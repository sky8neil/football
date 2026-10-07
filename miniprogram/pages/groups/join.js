const { joinGroup, listMyGroups, getGroup, isValidInviteCode } = require("../../services/groups.js");
const COPY = require("../../utils/rankings-copy.js");

function groupJoinError(code, fallback) {
  return COPY.groupJoinErrors[code] || fallback || COPY.groupActionFailed;
}

Page({
  data: {
    state: "ready",
    inviteCode: "",
    loading: false,
    title: COPY.joinConfirm,
    confirmText: COPY.confirmJoin,
    errorMessage: "",
    inviteCodeLabel: COPY.groupInviteCodeLabel,
  },

  onLoad(options) {
    const inviteCode = options && typeof options.code === "string" ? options.code : "";
    if (!isValidInviteCode(inviteCode)) {
      this.setData({ state: "error", errorMessage: COPY.groupInvalidInvite });
      return;
    }
    this.setData({ inviteCode, state: "ready", errorMessage: "" });
  },

  onConfirm() {
    const inviteCode = this.data.inviteCode;
    if (!isValidInviteCode(inviteCode) || this.data.loading) {
      if (!isValidInviteCode(inviteCode)) {
        this.setData({ state: "error", errorMessage: COPY.groupInvalidInvite });
      }
      return;
    }
    this.setData({ loading: true, errorMessage: "" });
    joinGroup(inviteCode).then((result) => {
      if (result.statusCode === 200 && result.data && result.data.group_id) {
        this.openGroup(result.data.group_id);
        return;
      }
      if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
        wx.setStorageSync("pending_group_invite_code", inviteCode);
        wx.redirectTo({ url: "/pages/session/session" });
        return;
      }
      if (result.code === "GROUP_ALREADY_MEMBER") {
        const groupId = result.details && result.details.group_id;
        if (groupId) {
          this.openGroup(groupId);
          return;
        }
        this.openExistingGroup(inviteCode);
        return;
      }
      this.setData({
        state: "error",
        loading: false,
        errorMessage: groupJoinError(result.code, result.message),
      });
    });
  },

  openGroup(groupId) {
    listMyGroups({ limit: 20 }).then((result) => {
      const groups = result.data && Array.isArray(result.data.items) ? result.data.items : [];
      const activeMember = result.statusCode === 200 && groups.some((group) => group.group_id === groupId);
      if (!activeMember) {
        this.setData({
          state: "error",
          loading: false,
          errorMessage: result.message || COPY.groupLoadFailed,
        });
        return;
      }
      wx.setStorageSync("pending_ranking_group_id", groupId);
      wx.switchTab({ url: "/pages/rankings/rankings" });
    });
  },

  openExistingGroup(inviteCode) {
    listMyGroups({ limit: 20 }).then((result) => {
      const groups = result.data && Array.isArray(result.data.items) ? result.data.items : [];
      if (result.statusCode !== 200) {
        this.setData({ state: "error", loading: false, errorMessage: result.message || COPY.groupLoadFailed });
        return;
      }
      Promise.all(groups.map((group) => getGroup(group.group_id))).then((details) => {
        const match = details.find((detail) =>
          detail.statusCode === 200 && detail.data && detail.data.invite_code === inviteCode
        );
        if (!match) {
          this.setData({ state: "error", loading: false, errorMessage: groupJoinError("GROUP_ALREADY_MEMBER") });
          return;
        }
        this.openGroup(match.data.group_id);
      });
    });
  },
});
