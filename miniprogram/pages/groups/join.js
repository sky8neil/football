const { joinGroup, listMyGroups, getGroup, isValidInviteCode } = require("../../services/groups.js");
const COPY = require("../../utils/rankings-copy.js");

function inviteCells(code) {
  return Array.from({ length: 8 }, (_, index) => ({
    value: code[index] || "",
    active: index === Math.min(code.length, 7),
  }));
}

function groupJoinError(code, fallback) {
  return COPY.groupJoinErrors[code] || fallback || COPY.groupActionFailed;
}

function normalizeInviteCode(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase().slice(0, 8);
}

Page({
  data: {
    state: "ready",
    inviteCode: "",
    inviteCells: inviteCells(""),
    remainingDigits: 8,
    remainingText: COPY.groupInviteRemaining(8),
    canConfirm: false,
    loading: false,
    title: COPY.joinConfirm,
    subtitle: COPY.groupJoinSubtitle,
    confirmText: COPY.confirmJoin,
    errorMessage: "",
    inviteCodeLabel: COPY.groupInviteCodeLabel,
    inviteFormatText: COPY.groupInviteFormat,
  },

  onLoad(options) {
    const rawCode = options && typeof options.code === "string" ? options.code : "";
    const inviteCode = normalizeInviteCode(rawCode);
    this.pendingRecovery = null;
    this.setInviteCode(inviteCode, inviteCode && !isValidInviteCode(inviteCode) ? COPY.groupInvalidInvite : "");
  },

  nextRequestId() {
    this.requestId = (this.requestId || 0) + 1;
    return this.requestId;
  },

  isCurrent(requestId) {
    return requestId === this.requestId;
  },

  failRecovery(requestId, errorMessage) {
    if (!this.isCurrent(requestId)) return;
    this.setData({
      state: "error",
      loading: false,
      canConfirm: isValidInviteCode(this.data.inviteCode),
      errorMessage: errorMessage || COPY.groupLoadFailed,
    });
  },

  onInviteInput(event) {
    const inviteCode = normalizeInviteCode(event && event.detail && event.detail.value);
    const errorMessage = inviteCode.length === 8 && !isValidInviteCode(inviteCode)
      ? COPY.groupInvalidInvite
      : "";
    this.setInviteCode(inviteCode, errorMessage);
  },

  setInviteCode(inviteCode, errorMessage) {
    this.setData({
      inviteCode,
      inviteCells: inviteCells(inviteCode),
      remainingDigits: Math.max(0, 8 - inviteCode.length),
      remainingText: COPY.groupInviteRemaining(Math.max(0, 8 - inviteCode.length)),
      canConfirm: isValidInviteCode(inviteCode) && !this.data.loading,
      state: "ready",
      errorMessage: errorMessage || "",
    });
  },

  onConfirm() {
    const inviteCode = this.data.inviteCode;
    if (!isValidInviteCode(inviteCode)) {
      this.setData({ errorMessage: COPY.groupInvalidInvite });
      return;
    }
    if (this.data.loading) {
      return;
    }
    const requestId = this.nextRequestId();
    this.pendingRecovery = null;
    this.setData({ loading: true, canConfirm: false, errorMessage: "" });
    joinGroup(inviteCode).then((result) => {
      if (!this.isCurrent(requestId)) return;
      if (result.statusCode === 200 && result.data && result.data.group_id) {
        this.pendingRecovery = { type: "openGroup", groupId: result.data.group_id };
        this.openGroup(result.data.group_id);
        return;
      }
      if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
        this.setData({ loading: false, canConfirm: isValidInviteCode(this.data.inviteCode) });
        wx.setStorageSync("pending_group_invite_code", inviteCode);
        wx.redirectTo({ url: "/pages/session/session" });
        return;
      }
      if (result.code === "GROUP_ALREADY_MEMBER") {
        const groupId = result.details && result.details.group_id;
        if (groupId) {
          this.pendingRecovery = { type: "openGroup", groupId };
          this.openGroup(groupId);
          return;
        }
        this.pendingRecovery = { type: "openExisting", inviteCode };
        this.openExistingGroup(inviteCode);
        return;
      }
      this.setData({
        state: "ready",
        loading: false,
        canConfirm: isValidInviteCode(this.data.inviteCode),
        errorMessage: groupJoinError(result.code, result.message),
      });
    }).catch(() => {
      if (!this.isCurrent(requestId)) return;
      this.setData({
        state: "ready",
        loading: false,
        canConfirm: isValidInviteCode(this.data.inviteCode),
        errorMessage: COPY.groupActionFailed,
      });
    });
  },

  openGroup(groupId) {
    if (groupId) {
      this.pendingRecovery = { type: "openGroup", groupId };
      this.setData({ loading: false, canConfirm: isValidInviteCode(this.data.inviteCode) });
      wx.setStorageSync("pending_ranking_group_id", groupId);
      wx.switchTab({
        url: "/pages/rankings/rankings",
        fail: () => {
          this.setData({
            state: "error",
            loading: false,
            canConfirm: isValidInviteCode(this.data.inviteCode),
            errorMessage: COPY.groupLoadFailed,
          });
        },
      });
      return;
    }
    const requestId = this.nextRequestId();
    listMyGroups({ limit: 20 }).then((result) => {
      if (!this.isCurrent(requestId)) return;
      const groups = result.data && Array.isArray(result.data.items) ? result.data.items : [];
      const activeMember = result.statusCode === 200 && groups.some((group) => group.group_id === groupId);
      if (!activeMember) {
        this.failRecovery(requestId, result.message || COPY.groupLoadFailed);
        return;
      }
      this.setData({ loading: false, canConfirm: isValidInviteCode(this.data.inviteCode) });
      wx.setStorageSync("pending_ranking_group_id", groupId);
      wx.switchTab({ url: "/pages/rankings/rankings" });
    }).catch((error) => {
      this.failRecovery(requestId, (error && error.message) || COPY.groupLoadFailed);
    });
  },

  openExistingGroup(inviteCode) {
    const requestId = this.nextRequestId();
    listMyGroups({ limit: 20 }).then((result) => {
      if (!this.isCurrent(requestId)) return;
      const groups = result.data && Array.isArray(result.data.items) ? result.data.items : [];
      if (result.statusCode !== 200) {
        this.failRecovery(requestId, result.message || COPY.groupLoadFailed);
        return;
      }
      Promise.all(groups.map((group) => getGroup(group.group_id))).then((details) => {
        if (!this.isCurrent(requestId)) return;
        const match = details.find((detail) =>
          detail.statusCode === 200 && detail.data && detail.data.invite_code === inviteCode
        );
        if (!match) {
          this.setData({ state: "ready", loading: false, canConfirm: isValidInviteCode(this.data.inviteCode), errorMessage: groupJoinError("GROUP_ALREADY_MEMBER") });
          return;
        }
        this.pendingRecovery = { type: "openGroup", groupId: match.data.group_id };
        this.openGroup(match.data.group_id);
      }).catch((error) => {
        this.failRecovery(requestId, (error && error.message) || COPY.groupLoadFailed);
      });
    }).catch((error) => {
      this.failRecovery(requestId, (error && error.message) || COPY.groupLoadFailed);
    });
  },

  onRetry() {
    if (this.data.loading || !this.pendingRecovery) return;
    this.setData({ loading: true, canConfirm: false, errorMessage: "" });
    if (this.pendingRecovery.type === "openGroup") {
      this.openGroup(this.pendingRecovery.groupId);
      return;
    }
    this.openExistingGroup(this.pendingRecovery.inviteCode);
  },

  onReenter() {
    this.nextRequestId();
    this.pendingRecovery = null;
    this.setData({ loading: false });
    this.setInviteCode(this.data.inviteCode, "");
  },
});
