const config = require("../../config.js");
const { getMyProfile, updateMyProfile } = require("../../services/profile.js");
const { storeNickname } = require("../../utils/nickname.js");
const { presentTeam } = require("../../utils/team-presentation.js");
const { findTeam, TEAM_REGISTRY } = require("../../utils/team-registry.js");
const { clearAuth } = require("../../services/auth.js");

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

function buildRegistryTeams() {
  return Object.keys(TEAM_REGISTRY).map((teamId) => {
    const found = TEAM_REGISTRY[teamId];
    const team = { team_id: teamId, name: found.source_name, league_id: found.league_id };
    const presented = presentTeam(team, found.league_id);
    return { ...team, logo: presented.logo, nameZh: presented.nameZh };
  });
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
  data: { loading: true, saving: false, saveErrorMessage: "", errorMessage: "", nickname: "", originalNickname: "", favoriteTeamId: null, originalTeamId: null, favoriteTeamName: "未设置", showTeams: false, teams: [], visibleGroups: [], search: "", teamsLoading: false, teamsError: "", showLogout: isHttpTransport() },
  onLoad(query) {
    this.setData({ showTeams: !!(query && query.section === "team") });
    this.loadProfile();
    this.loadTeams();
  },
  async loadProfile() {
    this.setData({ loading: true, errorMessage: "" });
    try {
      const result = await getMyProfile();
      if (result.statusCode !== 200) { this.setData({ errorMessage: result.message || "个人资料加载失败，请重试" }); return; }
      const profile = result.data || {};
      const id = profile.favorite_team_id || null;
      this.setData({ nickname: profile.nickname || "", originalNickname: profile.nickname || "", favoriteTeamId: id, originalTeamId: id });
      this.refreshTeamName();
    } catch (_) { this.setData({ errorMessage: "个人资料加载失败，请重试" }); }
    finally { this.setData({ loading: false }); }
  },
  refreshTeamName() {
    const id = this.data.favoriteTeamId;
    const found = findTeam(id);
    this.setData({ favoriteTeamName: id ? ((found && found.name_zh) || wx.getStorageSync("team_name:" + id) || "已选择球队") : "未设置" });
  },
  loadTeams() {
    if (this.data.teamsLoading) return;
    this.setData({ teamsLoading: true, teamsError: "" });
    try {
      const teams = buildRegistryTeams();
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
    if (this.data.saving || this.data.loading) return;
    this.setData({ favoriteTeamId: event.currentTarget.dataset.id || null });
    this.refreshTeamName();
  },
  async onSave() {
    if (this.data.saving || this.data.loading || this.data.errorMessage) return;
    const nickname = this.data.nickname.trim();
    if (!nickname) { wx.showToast({ title: "请输入昵称", icon: "none" }); return; }
    const patch = {};
    if (nickname !== this.data.originalNickname) patch.nickname = nickname;
    if (this.data.favoriteTeamId !== this.data.originalTeamId) patch.favorite_team_id = this.data.favoriteTeamId;
    if (!Object.keys(patch).length) { wx.navigateBack(); return; }
    this.setData({ saving: true, saveErrorMessage: "" });
    try {
      const result = await updateMyProfile(patch);
      if (result.statusCode !== 200) {
        const message = result.statusCode === 0 ? "无法连接后台，请检查服务是否启动后重试" : result.message || ("保存失败（" + (result.code || result.statusCode) + "），请重试");
        this.setData({ saveErrorMessage: message });
        console.warn("[profile-save]", { statusCode: result.statusCode, code: result.code, request_id: result.request_id });
        return;
      }
      storeNickname(result.data && result.data.nickname || nickname);
      wx.showToast({ title: "已保存", icon: "success" });
      wx.navigateBack();
    } catch (error) {
      const message = error && (error.errMsg || error.message) || "保存失败，请稍后重试";
      this.setData({ saveErrorMessage: message });
      console.warn("[profile-save]", message);
    }
    finally { this.setData({ saving: false }); }
  },
  onLogout() {
    if (!isHttpTransport()) return;
    wx.showModal({
      title: "确认退出登录？",
      content: "退出后需重新登录才能查看个人资料和预测。",
      confirmText: "确认退出",
      success(res) {
        if (!res || !res.confirm) return;
        clearAuth();
        wx.reLaunch({ url: "/pages/session/session" });
      },
    });
  },
});
