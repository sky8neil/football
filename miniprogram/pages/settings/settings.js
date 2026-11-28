const config = require("../../config.js");
const { getMyProfile, updateMyProfile } = require("../../services/profile.js");
const { listTeams, resolveFavoriteTeamRemote } = require("../../services/teams.js");
const { storeNickname, clearNickname } = require("../../utils/nickname.js");
const { presentTeam } = require("../../utils/team-presentation.js");
const { findTeam, TEAM_REGISTRY } = require("../../utils/team-registry.js");
const authService = require("../../services/auth.js");
const { clearAuth } = authService;

const TEAM_PLACEHOLDER = "/assets/logos/placeholders/team-placeholder.png";
const LEAGUES = [
  { id: "premier_league", name: "英超", logo: "/assets/logos/leagues/premier_league.png" },
  { id: "la_liga", name: "西甲", logo: "/assets/logos/leagues/la_liga.png" },
  { id: "serie_a", name: "意甲", logo: "/assets/logos/leagues/serie_a.png" },
  { id: "bundesliga", name: "德甲", logo: "/assets/logos/leagues/bundesliga.png" },
  { id: "ligue_1", name: "法甲", logo: "/assets/logos/leagues/ligue_1.png" },
  { id: "chinese_super_league", name: "中超", logo: "/assets/logos/leagues/chinese_super_league.png" },
];
const LEAGUE_ORDER = LEAGUES.map((league) => league.id);
const LEAGUE_NAMES = LEAGUES.reduce((acc, league) => {
  acc[league.id] = league.name;
  return acc;
}, {});

function normalizeGender(value) {
  if (value === "male" || value === "female" || value === "undisclosed") {
    return value;
  }
  return "undisclosed";
}

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
  data: {
    loading: true,
    saving: false,
    saveErrorMessage: "",
    errorMessage: "",
    errorKind: "",
    nickname: "",
    originalNickname: "",
    gender: "undisclosed",
    originalGender: "undisclosed",
    favoriteTeamId: null,
    originalTeamId: null,
    favoriteTeamName: "暂未设置主队",
    favoriteTeamSub: "点击右侧选择你支持的球队",
    favoriteTeamLogo: TEAM_PLACEHOLDER,
    isFavoriteTeamInactive: false,
    showTeams: false,
    leagues: LEAGUES,
    activeLeagueId: LEAGUE_ORDER[0],
    teams: [],
    visibleGroups: [],
    filteredTeams: [],
    sheetCountText: "",
    search: "",
    teamsLoading: false,
    teamsError: "",
    showLogout: isHttpTransport(),
  },
  profileRequestSerial: 0,
  favoriteTeamNameSerial: 0,
  teamsLoaded: false,
  serverTeamsLoaded: false,
  loginGeneration: null,
  pendingInitialTeamFocus: false,

  onLoad(query) {
    this.loginGeneration = currentLoginGeneration();
    const openTeam = !!(query && query.section === "team");
    this.pendingInitialTeamFocus = openTeam;
    this.setData({ showTeams: openTeam });
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
        this.pendingInitialTeamFocus = false;
        this.setData({
          showTeams: false,
          errorKind: "unauthorized",
          errorMessage: result.message || "请先登录后编辑个人资料",
        });
        return;
      }
      if (result.statusCode === 409 && result.code === "USER_DELETED") {
        this.pendingInitialTeamFocus = false;
        clearLocalSessionAndCache();
        this.setData({
          showTeams: false,
          errorKind: "userDeleted",
          errorMessage: result.message || "当前账号不可用",
        });
        return;
      }
      if (result.statusCode !== 200) {
        this.pendingInitialTeamFocus = false;
        this.setData({
          showTeams: false,
          errorKind: "error",
          errorMessage: result.message || "个人资料加载失败，请重试",
        });
        return;
      }
      const profile = result.data || {};
      const id = profile.favorite_team_id || null;
      const gender = normalizeGender(profile.gender);
      this.setData({
        errorKind: "",
        errorMessage: "",
        nickname: profile.nickname || "",
        originalNickname: profile.nickname || "",
        gender,
        originalGender: gender,
        favoriteTeamId: id,
        originalTeamId: id,
      });
      this.refreshTeamName();
      this.applyInitialTeamFocusIfNeeded();
    } catch (_) {
      if (this.profileRequestSerial !== requestSerial || currentLoginGeneration() !== generation) return;
      this.pendingInitialTeamFocus = false;
      this.setData({
        showTeams: false,
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
      this.setData({
        favoriteTeamName: "暂未设置主队",
        favoriteTeamSub: "点击右侧选择你支持的球队",
        favoriteTeamLogo: TEAM_PLACEHOLDER,
        isFavoriteTeamInactive: false,
      });
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
    const cachedLogo = (typeof wx !== "undefined" && typeof wx.getStorageSync === "function" && wx.getStorageSync("team_logo:" + id)) || "";
    const isInactive = Boolean(this.serverTeamsLoaded && !loaded);
    let favoriteTeamLogo = TEAM_PLACEHOLDER;
    let favoriteTeamSub = "已选择主队";
    if (loaded) {
      favoriteTeamLogo = loaded.logo || TEAM_PLACEHOLDER;
      favoriteTeamSub = [LEAGUE_NAMES[loaded.league_id] || "", loaded.name || ""].filter(Boolean).join(" · ") || "已选择主队";
    } else {
      if (cachedLogo) {
        favoriteTeamLogo = cachedLogo;
      } else if (found) {
        const presented = presentTeam(
          { team_id: id, league_id: found.league_id, name: found.source_name, name_zh: found.name_zh },
          found.league_id,
        );
        favoriteTeamLogo = (presented && presented.logo) || TEAM_PLACEHOLDER;
      }
      favoriteTeamSub = isInactive
        ? "历史已选主队 · 仍正常展示"
        : ([found && LEAGUE_NAMES[found.league_id], found && found.source_name].filter(Boolean).join(" · ") || "已选择主队");
    }
    this.setData({
      favoriteTeamName: loadedName || registryName || cachedName || "已选择球队",
      favoriteTeamSub,
      favoriteTeamLogo,
      isFavoriteTeamInactive: isInactive,
    });
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
      const patch = {};
      if (resolved && resolved.favoriteTeamText) {
        patch.favoriteTeamName = resolved.favoriteTeamText;
      }
      if (resolved && resolved.favoriteTeamLogo) {
        patch.favoriteTeamLogo = resolved.favoriteTeamLogo;
      }
      if (Object.keys(patch).length) {
        this.setData(patch);
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
      const serverLoaded = serverItems !== null;
      const teams = serverLoaded ? mergeServerAndRegistryTeams(serverItems) : buildRegistryTeams();
      this.teamsLoaded = true;
      this.serverTeamsLoaded = serverLoaded;
      this.setData({ teams });
      this.filterTeams();
      this.refreshTeamName();
      this.applyInitialTeamFocusIfNeeded();
    } catch (_) {
      this.setData({ teamsError: "球队加载失败，请重试" });
    } finally {
      this.setData({ teamsLoading: false });
    }
  },

  onNicknameInput(event) {
    this.setData({ nickname: event.detail.value });
  },

  onGenderPick(event) {
    if (this.data.saving || this.data.loading) return;
    const value = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.gender;
    if (value !== "male" && value !== "female" && value !== "undisclosed") return;
    this.setData({ gender: value });
  },

  applyInitialTeamFocusIfNeeded() {
    if (!this.pendingInitialTeamFocus || !this.data.showTeams || !this.data.favoriteTeamId) {
      return;
    }
    const teams = Array.isArray(this.data.teams) ? this.data.teams : [];
    const selected = teams.find((team) => team && team.team_id === this.data.favoriteTeamId);
    if (!selected) return;
    this.pendingInitialTeamFocus = false;
    if (selected.league_id && LEAGUE_NAMES[selected.league_id]) {
      if (this.data.activeLeagueId !== selected.league_id) {
        this.setData({ activeLeagueId: selected.league_id });
      }
      this.filterTeams();
    }
  },

  onTeamToggle() {
    this.pendingInitialTeamFocus = false;
    const nextOpen = !this.data.showTeams;
    if (nextOpen && !this.data.search && this.data.favoriteTeamId && Array.isArray(this.data.teams)) {
      const selected = this.data.teams.find((team) => team && team.team_id === this.data.favoriteTeamId);
      if (selected && selected.league_id && LEAGUE_NAMES[selected.league_id]) {
        this.setData({ activeLeagueId: selected.league_id });
      }
    }
    this.setData({ showTeams: nextOpen });
    if (nextOpen) {
      this.filterTeams();
    }
  },

  onCloseTeamSheet() {
    this.pendingInitialTeamFocus = false;
    if (!this.data.showTeams) return;
    this.setData({ showTeams: false });
  },

  onStopPropagation() {},

  onLeagueTabTap(event) {
    const leagueId = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.league;
    if (!leagueId) return;
    this.pendingInitialTeamFocus = false;
    this.setData({ activeLeagueId: leagueId, search: "" });
    this.filterTeams();
  },

  onSearch(event) {
    this.pendingInitialTeamFocus = false;
    this.setData({ search: event && event.detail ? event.detail.value : "" });
    this.filterTeams();
  },

  filterTeams() {
    const query = (this.data.search || "").trim().toLowerCase();
    const allTeams = Array.isArray(this.data.teams) ? this.data.teams : [];
    const matchedAll = query
      ? allTeams.filter((team) => {
        const name = (team.name || "").toLowerCase();
        const nameZh = (team.nameZh || "").toLowerCase();
        return name.includes(query) || nameZh.includes(query);
      })
      : allTeams;
    const activeLeagueId = this.data.activeLeagueId || LEAGUE_ORDER[0];
    const filteredTeams = query
      ? matchedAll.map((team) => ({
        ...team,
        subText: [LEAGUE_NAMES[team.league_id] || "", team.name || ""].filter(Boolean).join(" · "),
      }))
      : allTeams
        .filter((team) => team.league_id === activeLeagueId)
        .map((team) => ({
          ...team,
          subText: team.name || "",
        }));
    const sheetCountText = query
      ? `搜索结果 ${filteredTeams.length} 支`
      : `${LEAGUE_NAMES[activeLeagueId] || ""}共 ${filteredTeams.length} 支球队`;
    this.setData({
      visibleGroups: groupTeams(matchedAll),
      filteredTeams,
      sheetCountText,
    });
  },

  onTeamPick(event) {
    if (this.data.saving || this.data.loading) return;
    this.pendingInitialTeamFocus = false;
    const pickedId = (event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id) || null;
    this.setData({ favoriteTeamId: pickedId, showTeams: false });
    this.refreshTeamName();
  },

  onSelectedTeamLogoError() {
    this.setData({ favoriteTeamLogo: TEAM_PLACEHOLDER });
  },

  async onSave() {
    if (this.data.saving || this.data.loading || this.data.errorMessage) return;
    const nickname = this.data.nickname.trim();
    if (!nickname) {
      wx.showToast({ title: "请输入昵称", icon: "none" });
      return;
    }
    const patch = {};
    if (nickname !== this.data.originalNickname) patch.nickname = nickname;
    if (this.data.gender !== this.data.originalGender) patch.gender = this.data.gender;
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
          errorMessage: result.message || "当前账号不可用",
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
      storeNickname((result.data && result.data.nickname) || nickname);
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
      const message = (error && (error.errMsg || error.message)) || "保存失败，请稍后重试";
      this.setData({ saveErrorMessage: message });
      console.warn("[profile-save]", message);
    } finally {
      this.setData({ saving: false });
    }
  },

  onLoginTap() {
    wx.navigateTo({ url: "/pages/session/session?return_to=settings" });
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
