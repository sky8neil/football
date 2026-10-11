const { getMyProfile, updateMyProfile } = require("../../services/profile.js");
const { listMatches } = require("../../services/matches.js");
const { storeNickname } = require("../../utils/nickname.js");
const { getTeamLogo } = require("../../utils/logo-registry.js");

Page({
  data: { loading: true, saving: false, saveErrorMessage: "", errorMessage: "", nickname: "", originalNickname: "", favoriteTeamId: null, originalTeamId: null, favoriteTeamName: "未设置", showTeams: false, teams: [], visibleTeams: [], search: "", teamsLoading: false, teamsError: "", nextCursor: null, hasMore: false },
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
    const team = this.data.teams.find(item => item.team_id === id);
    this.setData({ favoriteTeamName: id ? (team && team.name || wx.getStorageSync("team_name:" + id) || "已选择球队") : "未设置" });
  },
  async loadTeams() {
    if (this.data.teamsLoading) return;
    this.setData({ teamsLoading: true, teamsError: "" });
    try {
      const result = await listMatches({ limit: 100, cursor: this.data.nextCursor });
      if (result.statusCode !== 200) { this.setData({ teamsError: result.message || "球队加载失败，请重试" }); return; }
      const payload = result.data || {};
      const teams = this.data.teams.slice();
      for (const match of payload.items || []) {
        for (const team of [match.home_team, match.away_team]) {
          if (!team || !team.team_id || teams.some(item => item.team_id === team.team_id)) continue;
          teams.push({ ...team, logo: getTeamLogo(match.league_id, team) });
          wx.setStorageSync("team_name:" + team.team_id, team.name);
          wx.setStorageSync("team_logo:" + team.team_id, getTeamLogo(match.league_id, team));
        }
      }
      this.setData({ teams, nextCursor: payload.next_cursor || null, hasMore: !!payload.next_cursor });
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
    this.setData({ visibleTeams: this.data.teams.filter(team => team.name.toLowerCase().includes(query)) });
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
});
