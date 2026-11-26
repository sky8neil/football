const config = require("../../config.js");
const { getMyProfile, updateMyProfile, deleteMyProfile } = require("../../services/profile.js");
const { listTeams, resolveFavoriteTeamRemote } = require("../../services/teams.js");
const { storeNickname, clearNickname } = require("../../utils/nickname.js");
const { presentTeam } = require("../../utils/team-presentation.js");
const { findTeam, TEAM_REGISTRY } = require("../../utils/team-registry.js");
const authService = require("../../services/auth.js");
const { clearAuth } = authService;

const LEAGUE_ORDER = ["premier_league", "la_liga", "serie_a", "bundesliga", "ligue_1", "chinese_super_league"];
const LEAGUE_NAMES = {
  premier_league: "英超",
  la_liga: "西甲",
  serie_a: "意甲",
  bundesliga: "德甲",
  ligue_1: "法甲",
  chinese_super_league: "中超",
};

function isHttpTransport() {
  return (config.transport || "http") === "http";
}

function currentLoginGeneration() {
  if (!authService || typeof authService.getLoginGeneration !== "function") return 0;
  const value = authService.getLoginGeneration();
  return Number.isFinite(value) ? value : 0;
}

function clearLocalSessionAndCache() {
  if (typeof clearAuth === "function") clearAuth();
  if (typeof clearNickname === "function") clearNickname();
  if (typeof wx !== "undefined" && typeof wx.removeStorageSync === "function") {
    for (const key of [
      "pending_ranking_group_id",
      "pending_ranking_target",
      "pending_group_invite_code",
      "my_predictions_dirty",
    ]) {
      try {
        wx.removeStorageSync(key);
      } catch (_error) {
        /* ignore storage cleanup errors */
      }
    }
  }
}

function buildRegistryTeams() {
  return Object.keys(TEAM_REGISTRY).map((teamId) => {
    const found = TEAM_REGISTRY[teamId];
    const team = { team_id: teamId, name: found.source_name, league_id: found.league_id };
    const presented = presentTeam(team, found.league_id);
    return { ...team, logo: presented.logo, nameZh: presented.nameZh };
  });
}

function mergeServerAndRegistryTeams(serverItems) {
  const merged = new Map();
  if (Array.isArray(serverItems)) {
    for (const item of serverItems) {
      if (!item || !item.team_id || !item.league_id) continue;
      if (item.status && item.status !== "active") continue;
      const fallback = findTeam(item.team_id);
      const raw = {
        team_id: item.team_id,
        league_id: item.league_id,
        name: item.name || (fallback && fallback.source_name) || "",
        name_zh: item.name_zh !== undefined ? item.name_zh : (fallback ? fallback.name_zh : null),
        logo_url: item.logo_url !== undefined ? item.logo_url : null,
      };
      const presented = presentTeam(raw, raw.league_id);
      merged.set(raw.team_id, {
        ...raw,
        logo: presented.logo,
        nameZh: presented.nameZh,
      });
    }
  }
  return [...merged.values()];
}

function groupTeams(teams) {
  const byLeague = new Map();
  for (const team of teams) {
    const list = byLeague.get(team.league_id) || [];
    list.push(team);
    byLeague.set(team.league_id, list);
  }
  const known = LEAGUE_ORDER.filter((id) => byLeague.has(id));
  const extra = [...byLeague.keys()].filter((id) => !LEAGUE_ORDER.includes(id));
  return known.concat(extra).map((league_id) => ({
    league_id,
    leagueName: LEAGUE_NAMES[league_id] || league_id,
    teams: byLeague.get(league_id),
  }));
}

Page({
  data: { loading: true, saving: false, deleting: false, saveErrorMessage: "", errorMessage: "", errorKind: "", nickname: "", originalNickname: "", favoriteTeamId: null, originalTeamId: null, favoriteTeamName: "未设置", showTeams: false, teams: [], visibleGroups: [], search: "", teamsLoading: false, teamsError: "", showLogout: isHttpTransport() },
  profileRequestSerial: 0,
  favoriteTeamNameSerial: 0,
  teamsLoaded: false,
  loginGeneration: null,
  onLoad(query) {
    this.loginGeneration = currentLoginGeneration();
    this.setData({ showTeams: !!(query && query.section === "team") });
    this.loadProfile();
    this.loadTeams();
  },
  onShow() {
    const generation = currentLoginGeneration();
    const generationChanged = this.loginGeneration !== null && generation !== this.loginGeneration;
    this.loginGeneration = generation;
    if (generationChanged || this.data.errorKind === "unauthorized") {
      return this.loadProfile();
    }
  },
  async loadProfile() {
    const requestSerial = (this.profileRequestSerial || 0) + 1;
    this.profileRequestSerial = requestSerial;
    const generation = currentLoginGeneration();
    this.loginGeneration = generation;
    this.setData({ loading: true, errorMessage: "", errorKind: "" });
    try {
      const result = await getMyProfile();
      if (this.profileRequestSerial !== requestSerial || currentLoginGeneration() !== generation) return;
      if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
        this.setData({
          errorKind: "unauthorized",
          errorMessage: result.message || "请先登录后编辑个人资料",
        });
        return;
      }
      if (result.statusCode === 409 && result.code === "USER_DELETED") {
        clearLocalSessionAndCache();
        this.setData({
          errorKind: "userDeleted",
          errorMessage: result.message || "该账号已被注销",
        });
        return;
      }
      if (result.statusCode !== 200) {
        this.setData({
          errorKind: "error",
          errorMessage: result.message || "个人资料加载失败，请重试",
        });
        return;
      }
      const profile = result.data || {};
      const id = profile.favorite_team_id || null;
      this.setData({
        errorKind: "",
        errorMessage: "",
        nickname: profile.nickname || "",
        originalNickname: profile.nickname || "",
        favoriteTeamId: id,
        originalTeamId: id,
      });
      this.refreshTeamName();
    } catch (_) {
      if (this.profileRequestSerial !== requestSerial || currentLoginGeneration() !== generation) return;
      this.setData({
        errorKind: "error",
        errorMessage: "个人资料加载失败，请重试",
      });
    } finally {
      if (this.profileRequestSerial === requestSerial) {
        this.setData({ loading: false });
      }
    }
  },
  refreshTeamName() {
    const id = this.data.favoriteTeamId;
    if (!id) {
      this.setData({ favoriteTeamName: "未设置" });
      return;
    }
    const loaded = Array.isArray(this.data.teams)
      ? this.data.teams.find((team) => team && team.team_id === id)
      : null;
    const found = findTeam(id);
    const loadedName = loaded
      ? ((loaded.nameZh && loaded.nameZh !== "球队资料待补全" ? loaded.nameZh : "") || loaded.name_zh || loaded.name || "")
      : "";
    const registryName = (found && (found.name_zh || found.source_name)) || "";
    const cachedName = (typeof wx !== "undefined" && typeof wx.getStorageSync === "function" && wx.getStorageSync("team_name:" + id)) || "";
    this.setData({ favoriteTeamName: loadedName || registryName || cachedName || "已选择球队" });
    if (!loadedName && !registryName && this.teamsLoaded && typeof resolveFavoriteTeamRemote === "function") {
      this.hydrateFavoriteTeamName(id);
    }
  },
  async hydrateFavoriteTeamName(teamId) {
    const serial = (this.favoriteTeamNameSerial || 0) + 1;
    this.favoriteTeamNameSerial = serial;
    try {
      const resolved = await resolveFavoriteTeamRemote(teamId, { presentTeam });
      if (this.favoriteTeamNameSerial !== serial || this.data.favoriteTeamId !== teamId) return;
      if (resolved && resolved.favoriteTeamText) {
        this.setData({ favoriteTeamName: resolved.favoriteTeamText });
      }
    } catch (_error) {
      /* 远端解析失败时保留兜底名称 */
    }
  },
  async loadTeams() {
    if (this.data.teamsLoading) return;
    this.setData({ teamsLoading: true, teamsError: "" });
    try {
      let serverItems = null;
      if (typeof listTeams === "function") {
        try {
          const result = await listTeams();
          if (result && result.statusCode === 200 && result.data && Array.isArray(result.data.items)) {
            serverItems = result.data.items;
          }
        } catch (_) {
          /* 服务端拉取失败时静默降级到包内静态注册表，不阻塞页面 */
        }
      }
      const teams = serverItems !== null ? mergeServerAndRegistryTeams(serverItems) : buildRegistryTeams();
      this.teamsLoaded = true;
      this.setData({ teams });
      this.filterTeams();
      this.refreshTeamName();
    } catch (_) { this.setData({ teamsError: "球队加载失败，请重试" }); }
    finally { this.setData({ teamsLoading: false }); }
  },
  onNicknameInput(event) { this.setData({ nickname: event.detail.value }); },
  onTeamToggle() { this.setData({ showTeams: !this.data.showTeams }); },
  onSearch(event) { this.setData({ search: event.detail.value }); this.filterTeams(); },
  filterTeams() {
    const query = this.data.search.trim().toLowerCase();
    const teams = this.data.teams.filter((team) => {
      const name = (team.name || "").toLowerCase();
      const nameZh = (team.nameZh || "").toLowerCase();
      return name.includes(query) || nameZh.includes(query);
    });
    this.setData({ visibleGroups: groupTeams(teams) });
  },
  onTeamPick(event) {
    if (this.data.saving || this.data.deleting || this.data.loading) return;
    this.setData({ favoriteTeamId: event.currentTarget.dataset.id || null });
    this.refreshTeamName();
  },
  async onSave() {
    if (this.data.saving || this.data.deleting || this.data.loading || this.data.errorMessage) return;
    const nickname = this.data.nickname.trim();
    if (!nickname) { wx.showToast({ title: "请输入昵称", icon: "none" }); return; }
    const patch = {};
    if (nickname !== this.data.originalNickname) patch.nickname = nickname;
    if (this.data.favoriteTeamId !== this.data.originalTeamId) patch.favorite_team_id = this.data.favoriteTeamId;
    if (!Object.keys(patch).length) {
      wx.navigateBack({ fail: () => { wx.switchTab({ url: "/pages/profile/profile" }); } });
      return;
    }
    this.setData({ saving: true, saveErrorMessage: "" });
    try {
      const result = await updateMyProfile(patch);
      if (result.statusCode === 401 && result.code === "UNAUTHORIZED") {
        this.setData({
          errorKind: "unauthorized",
          errorMessage: result.message || "登录已失效，请重新登录",
          saveErrorMessage: "",
        });
        return;
      }
      if (result.statusCode === 409 && result.code === "USER_DELETED") {
        clearLocalSessionAndCache();
        this.setData({
          errorKind: "userDeleted",
          errorMessage: result.message || "该账号已被注销",
          saveErrorMessage: "",
        });
        return;
      }
      if (result.statusCode !== 200) {
        const message = result.statusCode === 0 ? "无法连接后台，请检查服务是否启动后重试" : result.message || ("保存失败（" + (result.code || result.statusCode) + "），请重试");
        this.setData({ saveErrorMessage: message });
        console.warn("[profile-save]", { statusCode: result.statusCode, code: result.code, request_id: result.request_id });
        return;
      }
      storeNickname(result.data && result.data.nickname || nickname);
      if (this.data.favoriteTeamId && typeof wx !== "undefined" && typeof wx.setStorageSync === "function") {
        const picked = Array.isArray(this.data.teams)
          ? this.data.teams.find((team) => team && team.team_id === this.data.favoriteTeamId)
          : null;
        const teamName = picked && ((picked.nameZh && picked.nameZh !== "球队资料待补全" ? picked.nameZh : "") || picked.name_zh || picked.name);
        if (teamName) wx.setStorageSync("team_name:" + this.data.favoriteTeamId, teamName);
        if (picked && picked.logo && !String(picked.logo).endsWith("/team-placeholder.png")) {
          wx.setStorageSync("team_logo:" + this.data.favoriteTeamId, picked.logo);
        }
      }
      wx.showToast({ title: "已保存", icon: "success" });
      wx.navigateBack({ fail: () => { wx.switchTab({ url: "/pages/profile/profile" }); } });
    } catch (error) {
      const message = error && (error.errMsg || error.message) || "保存失败，请稍后重试";
      this.setData({ saveErrorMessage: message });
      console.warn("[profile-save]", message);
    }
    finally { this.setData({ saving: false }); }
  },
  onLoginTap() {
    wx.navigateTo({ url: "/pages/session/session?return_to=settings" });
  },
  onDeleteAccount() {
    if (this.data.deleting || this.data.saving) return;
    wx.showModal({
      title: "确认注销账号？",
      content: "账号注销后不可恢复，将退出你加入和创建的所有群组，并使当前登录立即失效。确定继续注销吗？",
      confirmText: "确认注销",
      cancelText: "取消",
      confirmColor: "#9b392c",
      success: (res) => {
        if (!res || !res.confirm) return;
        return this.performDeleteAccount();
      },
    });
  },
  async performDeleteAccount() {
    if (this.data.deleting) return;
    this.setData({ deleting: true, saveErrorMessage: "" });
    try {
      const result = await deleteMyProfile();
      if (result && result.statusCode === 204) {
        clearLocalSessionAndCache();
        this.setData({ deleting: false });
        wx.reLaunch({
          url: "/pages/session/session",
          fail: () => {
            this.setData({ deleting: false, saveErrorMessage: "页面跳转失败，请重新打开小程序" });
          },
        });
        return;
      }
      if (result && result.statusCode === 401 && result.code === "UNAUTHORIZED") {
        clearLocalSessionAndCache();
        this.setData({
          deleting: false,
          errorKind: "unauthorized",
          errorMessage: result.message || "登录已失效，请重新登录",
          saveErrorMessage: "",
        });
        return;
      }
      if (result && result.statusCode === 409 && result.code === "USER_DELETED") {
        clearLocalSessionAndCache();
        this.setData({
          deleting: false,
          errorKind: "userDeleted",
          errorMessage: result.message || "该账号已被注销",
          saveErrorMessage: "",
        });
        return;
      }
      this.setData({
        deleting: false,
        saveErrorMessage: (result && result.message) || "注销失败，请稍后重试",
      });
    } catch (error) {
      const message = (error && (error.errMsg || error.message)) || "注销失败，请稍后重试";
      this.setData({ deleting: false, saveErrorMessage: message });
    }
  },
  onLogout() {
    if (!isHttpTransport()) return;
    wx.showModal({
      title: "确认退出登录？",
      content: "退出后需重新登录才能查看个人资料和预测。",
      confirmText: "确认退出",
      success(res) {
        if (!res || !res.confirm) return;
        clearLocalSessionAndCache();
        wx.reLaunch({ url: "/pages/session/session" });
      },
    });
  },
});
