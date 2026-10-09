const { listMyGroups, createGroup } = require("../../services/groups.js");
const COPY = require("../../utils/rankings-copy.js");

const MAX_JOINED_GROUPS = 20;
const MAX_OWNED_GROUPS = 5;

Page({
  data: {
    state: "loading",
    groups: [],
    ownedCount: 0,
    canJoin: false,
    canCreate: false,
    loadingAction: false,
    errorMessage: "",
    title: COPY.groupsTitle,
    emptyText: COPY.groupsEmpty,
    createText: COPY.createGroup,
    joinText: COPY.joinGroup,
    loadFailedText: COPY.groupLoadFailed,
    retryText: COPY.groupRetry,
    subtitleText: COPY.groupSubtitle,
    groupMarkText: COPY.groupMark,
    codeMarkText: COPY.groupCodeMark,
    descriptionText: COPY.groupDescription,
    createHintText: COPY.groupCreateHint,
    joinHintText: COPY.groupJoinHint,
    rules: COPY.groupRules,
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
        ownedCount,
        joinedCountText: `${groups.length} / ${MAX_JOINED_GROUPS}`,
        ownedCountText: `${ownedCount} / ${MAX_OWNED_GROUPS}`,
        usageText: COPY.groupUsage(`${groups.length} / ${MAX_JOINED_GROUPS}`, `${ownedCount} / ${MAX_OWNED_GROUPS}`),
        errorMessage: "",
      });
    });
  },

  onJoinTap() {
    if (!this.data.canJoin) {
      this.setData({ errorMessage: COPY.groupJoinErrors.GROUP_JOIN_LIMIT_REACHED });
      return;
    }
    wx.navigateTo({ url: "/pages/groups/join" });
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
      wx.navigateTo({ url: `/pages/groups/detail?group_id=${result.data.group_id}&created=1&owned_count=${this.data.ownedCount + 1}` });
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
