const { listMyGroups, createGroup, isValidInviteCode } = require("../../services/groups.js");
const COPY = require("../../utils/rankings-copy.js");

const MAX_JOINED_GROUPS = 20;
const MAX_OWNED_GROUPS = 5;

Page({
  data: {
    state: "loading",
    groups: [],
    inviteCode: "",
    canJoin: false,
    canCreate: false,
    loadingAction: false,
    errorMessage: "",
    title: COPY.groupsTitle,
    emptyText: COPY.groupsEmpty,
    description: COPY.groupDescription,
    limitsText: COPY.groupLimits(MAX_JOINED_GROUPS, MAX_OWNED_GROUPS),
    createText: COPY.createGroup,
    joinText: COPY.joinGroup,
    inviteCodePlaceholder: COPY.inviteCodePlaceholder,
    loadFailedText: COPY.groupLoadFailed,
    retryText: COPY.groupRetry,
  },

  onShow() {
    this.loadGroups();
  },

  loadGroups() {
    this.setData({ state: "loading", errorMessage: "" });
    listMyGroups({ limit: MAX_JOINED_GROUPS }).then((result) => {
      if (result.statusCode !== 200) {
        this.setData({ state: "error", errorMessage: result.message || COPY.groupLoadFailed });
        return;
      }
      const groups = result.data && Array.isArray(result.data.items) ? result.data.items : [];
      const ownedCount = groups.filter((group) => group.role === "owner").length;
      this.setData({
        state: "ready",
        groups: groups.map((group) => ({
          ...group,
          memberCountText: COPY.groupMemberCount(group.member_count),
          roleText: COPY.groupRoleText(group.role),
        })),
        canJoin: groups.length < MAX_JOINED_GROUPS,
        canCreate: ownedCount < MAX_OWNED_GROUPS,
        errorMessage: "",
      });
    });
  },

  onInviteInput(event) {
    this.setData({ inviteCode: String(event.detail.value || "").toUpperCase(), errorMessage: "" });
  },

  onJoinTap() {
    const inviteCode = this.data.inviteCode;
    if (!this.data.canJoin || !isValidInviteCode(inviteCode)) {
      this.setData({ errorMessage: COPY.groupJoinErrors.INVALID_INVITE_CODE });
      return;
    }
    wx.navigateTo({ url: `/pages/groups/join?code=${encodeURIComponent(inviteCode)}` });
  },

  onCreateTap() {
    if (!this.data.canCreate || this.data.loadingAction) return;
    this.setData({ loadingAction: true, errorMessage: "" });
    createGroup().then((result) => {
      if (result.statusCode !== 201 || !result.data || !result.data.group_id) {
        this.setData({
          loadingAction: false,
          errorMessage: result.code === "GROUP_OWNED_LIMIT_REACHED"
            ? COPY.groupCreateLimitReached
            : result.message || COPY.groupActionFailed,
        });
        return;
      }
      wx.navigateTo({ url: `/pages/groups/detail?group_id=${result.data.group_id}` });
    });
  },

  onGroupTap(event) {
    const groupId = event.currentTarget.dataset.groupId;
    if (!groupId) return;
    wx.navigateTo({ url: `/pages/groups/detail?group_id=${groupId}` });
  },

  onRetry() {
    this.loadGroups();
  },
});
