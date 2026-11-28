const { listMyGroups, createGroup } = require("../../services/groups.js");
const COPY = require("../../utils/rankings-copy.js");

let authService = null;
try {
  authService = require("../../services/auth.js");
} catch (_error) {
  authService = null;
}

const MAX_JOINED_GROUPS = 20;
const MAX_OWNED_GROUPS = 5;

function currentLoginGeneration() {
  if (!authService || typeof authService.getLoginGeneration !== "function") return 0;
  const value = authService.getLoginGeneration();
  return Number.isFinite(value) ? value : 0;
}

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

  groupsRequestSerial: 0,
  loginGeneration: null,

  onShow() {
    const generation = currentLoginGeneration();
    if (this.loginGeneration !== null && generation !== this.loginGeneration) {
      this.setData({
        groups: [],
        ownedCount: 0,
        canJoin: false,
        canCreate: false,
        loadingAction: false,
        errorMessage: "",
      });
    }
    this.loginGeneration = generation;
    return this.loadGroups();
  },

  loadGroups() {
    const requestSerial = (this.groupsRequestSerial || 0) + 1;
    this.groupsRequestSerial = requestSerial;
    const generation = currentLoginGeneration();
    this.loginGeneration = generation;
    const isCurrent = () => this.groupsRequestSerial === requestSerial && currentLoginGeneration() === generation;
    this.setData({ state: "loading", errorMessage: "" });
    return listMyGroups({ limit: MAX_JOINED_GROUPS }).then((result) => {
      if (!isCurrent()) return;
      if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
        this.setData({
          state: "unauthorized",
          groups: [],
          ownedCount: 0,
          canJoin: false,
          canCreate: false,
          loadingAction: false,
          errorMessage: result.message || "请先登录后查看预言群",
        });
        return;
      }
      if (result.statusCode === 409 && result.code === "USER_DELETED") {
        this.setData({
          state: "userDeleted",
          groups: [],
          ownedCount: 0,
          canJoin: false,
          canCreate: false,
          loadingAction: false,
          errorMessage: result.message || "当前账号不可用",
        });
        return;
      }
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
        canCreate: ownedCount < MAX_OWNED_GROUPS && groups.length < MAX_JOINED_GROUPS,
        ownedCount,
        joinedCountText: `${groups.length} / ${MAX_JOINED_GROUPS}`,
        ownedCountText: `${ownedCount} / ${MAX_OWNED_GROUPS}`,
        usageText: COPY.groupUsage(`${groups.length} / ${MAX_JOINED_GROUPS}`, `${ownedCount} / ${MAX_OWNED_GROUPS}`),
        errorMessage: "",
      });
    }).catch(() => {
      if (!isCurrent()) return;
      this.setData({
        state: "error",
        errorMessage: COPY.groupLoadFailed,
      });
    });
  },

  onLoginTap() {
    wx.navigateTo({ url: "/pages/session/session?return_to=groups" });
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
    const generation = currentLoginGeneration();
    this.setData({ loadingAction: true, errorMessage: "" });
    return createGroup().then((result) => {
      if (currentLoginGeneration() !== generation) {
        return;
      }
      if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
        this.setData({
          state: "unauthorized",
          groups: [],
          ownedCount: 0,
          canJoin: false,
          canCreate: false,
          loadingAction: false,
          errorMessage: result.message || "请先登录后查看预言群",
        });
        return;
      }
      if (result.statusCode === 409 && result.code === "USER_DELETED") {
        this.setData({
          state: "userDeleted",
          groups: [],
          ownedCount: 0,
          canJoin: false,
          canCreate: false,
          loadingAction: false,
          errorMessage: result.message || "当前账号不可用",
        });
        return;
      }
      if (result.statusCode !== 201 || !result.data || !result.data.group_id) {
        this.setData({
          loadingAction: false,
          errorMessage: result.code === "GROUP_OWNED_LIMIT_REACHED"
            ? COPY.groupCreateLimitReached
            : result.code === "GROUP_JOIN_LIMIT_REACHED"
              ? COPY.groupJoinErrors.GROUP_JOIN_LIMIT_REACHED
              : result.message || COPY.groupActionFailed,
        });
        return;
      }
      this.setData({ loadingAction: false });
      wx.navigateTo({ url: `/pages/groups/detail?group_id=${encodeURIComponent(result.data.group_id)}&created=1&owned_count=${this.data.ownedCount + 1}` });
    }).catch(() => {
      if (currentLoginGeneration() !== generation) return;
      this.setData({
        loadingAction: false,
        errorMessage: COPY.groupActionFailed,
      });
    });
  },

  onGroupTap(event) {
    const groupId = event.currentTarget.dataset.groupId;
    if (!groupId) return;
    wx.navigateTo({ url: `/pages/groups/detail?group_id=${encodeURIComponent(groupId)}` });
  },

  onRetry() {
    return this.loadGroups();
  },
});
