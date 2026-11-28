import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it, expect, vi } from "vitest";

const TEAM_REGISTRY = {
  "arsenal-id": { league_id: "premier_league", source_name: "Arsenal FC", name_zh: "阿森纳" },
  "chelsea-id": { league_id: "premier_league", source_name: "Chelsea FC", name_zh: "切尔西" },
  "bayern-id": { league_id: "bundesliga", source_name: "FC Bayern München", name_zh: "拜仁慕尼黑" },
};

function load({ transport = "http", profile, getLoginGeneration, listTeams: listTeamsOverride, resolveFavoriteTeamRemote } = {}) {
  let definition;
  const findTeam = vi.fn((id) => (id && TEAM_REGISTRY[id]) || null);
  const presentTeam = vi.fn((team) => {
    const found = findTeam(team && team.team_id);
    const serverNameZh = team && typeof team.name_zh === "string" && team.name_zh.trim() ? team.name_zh.trim() : "";
    const registryNameZh = found && found.name_zh ? found.name_zh : "";
    const serverName = team && typeof team.name === "string" && team.name.trim() ? team.name.trim() : "";
    const nameZh = serverNameZh || registryNameZh || serverName || "球队资料待补全";
    const serverLogo = team && typeof team.logo_url === "string" && team.logo_url.trim() ? team.logo_url.trim() : "";
    return {
      teamId: team && team.team_id,
      nameZh,
      logo: found ? `logo:${team && team.team_id}` : (serverLogo || `logo:${team && team.team_id}`),
      missing: !serverNameZh && !registryNameZh && !serverName,
    };
  });
  const getMyProfile = vi.fn(async () => ({
    statusCode: 200,
    data: profile || { nickname: "球友", favorite_team_id: null },
  }));
  const updateMyProfile = vi.fn(async () => ({ statusCode: 200, data: { nickname: "新昵称" } }));
  const deleteMyProfile = vi.fn(async () => ({ statusCode: 204 }));
  const listMatches = vi.fn(async () => ({ statusCode: 200, data: { items: [], page: {} } }));
  const listTeams = listTeamsOverride || vi.fn(async () => ({
    statusCode: 200,
    data: {
      items: Object.entries(TEAM_REGISTRY).map(([team_id, item]) => ({
        team_id,
        league_id: item.league_id,
        name: item.source_name,
        name_zh: item.name_zh,
        logo_url: null,
      })),
    },
  }));
  const storeNickname = vi.fn();
  const clearNickname = vi.fn();
  const clearAuth = vi.fn();
  const required = [];
  const wx = { getStorageSync: vi.fn(), setStorageSync: vi.fn(), removeStorageSync: vi.fn(), navigateTo: vi.fn(), navigateBack: vi.fn(), switchTab: vi.fn(), showToast: vi.fn(), showModal: vi.fn(), reLaunch: vi.fn() };
  runInNewContext(readFileSync(new URL("./settings.js", import.meta.url), "utf8"), {
    Page: value => { definition = value; }, wx,
    require: (name) => {
      required.push(name);
      if (name.includes("profile")) return { getMyProfile, updateMyProfile, deleteMyProfile };
      if (name.includes("services/teams")) return { listTeams, ...(resolveFavoriteTeamRemote ? { resolveFavoriteTeamRemote } : {}) };
      if (name.includes("matches")) return { listMatches };
      if (name.includes("nickname")) return { storeNickname, clearNickname };
      if (name.includes("auth")) return { clearAuth, ...(getLoginGeneration ? { getLoginGeneration } : {}) };
      if (name.includes("config")) return { transport };
      if (name.includes("team-presentation")) return { presentTeam };
      if (name.includes("team-registry")) return { findTeam, TEAM_REGISTRY };
      if (name.includes("logo-registry")) return { getTeamLogo: () => "logo.png" };
      throw new Error("Unexpected require: " + name);
    },
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value); } };
  return { page, getMyProfile, updateMyProfile, deleteMyProfile, listMatches, listTeams, storeNickname, clearNickname, clearAuth, wx, required, findTeam, presentTeam };
}

describe("personal profile settings", () => {
  it("routes both profile entry points to settings instead of session initialization", () => {
    let profile;
    const navigateTo = vi.fn();
    runInNewContext(readFileSync(new URL("../profile/profile.js", import.meta.url), "utf8"), {
      Page: value => { profile = value; }, require: () => ({ headerHeight: () => 88 }), wx: { navigateTo },
    });
    profile.onSessionTap(); profile.onFavoriteTeamTap();
    expect(navigateTo.mock.calls.map(call => call[0].url)).toEqual(["/pages/settings/settings", "/pages/settings/settings?section=team"]);
  });
  it("routes the unauthorized login button to session, not settings", () => {
    let profile;
    const navigateTo = vi.fn();
    const wxml = readFileSync(new URL("../profile/profile.wxml", import.meta.url), "utf8");
    expect(wxml).toMatch(/wx:if="\{\{state === 'unauthorized'\}\}"[^>]*bindtap="onLoginTap"/);
    expect(wxml).not.toMatch(/wx:if="\{\{state === 'unauthorized'\}\}"[^>]*bindtap="onSessionTap"/);
    expect(wxml).toContain('bindtap="onSessionTap" aria-label="编辑个人资料"');
    expect(wxml).toContain("设置与账户");
    expect(wxml).toMatch(/bindtap="onSessionTap"><image class="icon" src="\/assets\/icons\/ui-settings.png" \/><text>设置与账户<\/text>/);
    runInNewContext(readFileSync(new URL("../profile/profile.js", import.meta.url), "utf8"), {
      Page: value => { profile = value; }, require: () => ({ headerHeight: () => 88 }), wx: { navigateTo },
    });
    profile.onLoginTap();
    profile.onSessionTap();
    expect(navigateTo.mock.calls.map(call => call[0].url)).toEqual(["/pages/session/session", "/pages/settings/settings"]);
  });
  it("loads favorite teams from the registry grouped by league without recent matches", async () => {
    const { page, listMatches, required, presentTeam } = load();
    await page.loadProfile();
    await page.loadTeams();
    expect(required.some((name) => name.includes("matches"))).toBe(false);
    expect(listMatches).not.toHaveBeenCalled();
    expect(presentTeam).toHaveBeenCalled();
    expect(page.data.visibleGroups.map((group) => group.league_id)).toEqual(["premier_league", "bundesliga"]);
    expect(page.data.visibleGroups.map((group) => group.leagueName)).toEqual(["英超", "德甲"]);
    expect(page.data.visibleGroups[0].teams.map((team) => team.team_id)).toEqual(["arsenal-id", "chelsea-id"]);
    expect(page.data.visibleGroups[0].teams[0]).toMatchObject({
      team_id: "arsenal-id",
      name: "Arsenal FC",
      nameZh: "阿森纳",
      logo: "logo:arsenal-id",
      league_id: "premier_league",
    });
    expect(page.data.visibleGroups[1].teams).toEqual([
      expect.objectContaining({ team_id: "bayern-id", name: "FC Bayern München", nameZh: "拜仁慕尼黑" }),
    ]);
    page.onSearch({ detail: { value: "阿森" } });
    expect(page.data.visibleGroups).toEqual([
      expect.objectContaining({
        league_id: "premier_league",
        teams: [expect.objectContaining({ team_id: "arsenal-id", nameZh: "阿森纳" })],
      }),
    ]);
    page.onSearch({ detail: { value: "Bayern" } });
    expect(page.data.visibleGroups.map((group) => group.teams.map((team) => team.team_id))).toEqual([["bayern-id"]]);
  });
  it("lets the user pick a registry team when there is no recent schedule", async () => {
    const { page, listMatches } = load();
    await page.loadProfile();
    await page.loadTeams();
    expect(listMatches).not.toHaveBeenCalled();
    expect(page.data.favoriteTeamId).toBe(null);
    page.onTeamPick({ currentTarget: { dataset: { id: "bayern-id" } } });
    expect(page.data.favoriteTeamId).toBe("bayern-id");
    expect(page.data.favoriteTeamName).toBe("拜仁慕尼黑");
  });
  it("keeps an existing favorite team selected from the registry", async () => {
    const { page } = load({ profile: { nickname: "球友", favorite_team_id: "arsenal-id" } });
    await page.loadProfile();
    await page.loadTeams();
    expect(page.data.favoriteTeamId).toBe("arsenal-id");
    expect(page.data.originalTeamId).toBe("arsenal-id");
    expect(page.data.favoriteTeamName).toBe("阿森纳");
    expect(page.data.visibleGroups.some((group) => group.teams.some((team) => team.team_id === "arsenal-id"))).toBe(true);
  });
  it("renders personal profile layout with gender selector, compact team trigger, and bottom drawer without account deletion or raw svg", () => {
    const wxml = readFileSync(new URL("./settings.wxml", import.meta.url), "utf8");
    expect(wxml).toContain("个人资料");
    expect(wxml).not.toContain("让球友认识你，也为你的主队助威。");
    expect(wxml).not.toContain("注销账号");
    expect(wxml).not.toContain("onDeleteAccount");
    expect(wxml).not.toMatch(/<svg[\s>]/i);
    expect(wxml).toContain("支持五大联赛和中超全部球队");
    expect(wxml).toContain("更换 ›");
    expect(wxml).toContain('data-gender="male"');
    expect(wxml).toContain('data-gender="female"');
    expect(wxml).toContain('data-gender="undisclosed"');
    expect(wxml).toContain("不想透露");
    expect(wxml).toContain('wx:for="{{leagues}}"');
    expect(wxml).toContain('wx:for="{{filteredTeams}}"');
    expect(wxml).toContain('wx:for-item="team"');
    expect(wxml).toContain('wx:key="team_id"');
    expect(wxml).toContain('data-id="{{team.team_id}}"');
    expect(wxml).toContain("{{team.nameZh}}");
    expect(wxml).toContain("{{team.subText}}");
    expect(wxml).toContain("暂不设置主队");
    expect(wxml).not.toContain("加载更多球队");
    expect(wxml).not.toContain("球队来自当前赛事");
  });
  it("styles gender options and team drawer with existing design tokens in rpx", () => {
    const wxss = readFileSync(new URL("./settings.wxss", import.meta.url), "utf8");
    expect(wxss).toMatch(/\.gender-option\s*\{[^}]*var\(--/);
    expect(wxss).toMatch(/\.team-tile\s*\{[^}]*var\(--/);
    expect(wxss).toMatch(/\.secret-icon\s*\{/);
    expect(wxss).toMatch(/\.secret-slash\s*\{/);
  });
  it("saves only changed fields and returns to the profile after success", async () => {
    const { page, updateMyProfile, storeNickname, wx } = load();
    await page.loadProfile(); await page.loadTeams();
    page.onNicknameInput({ detail: { value: " 新昵称 " } });
    page.onTeamPick({ currentTarget: { dataset: { id: "arsenal-id" } } });
    await page.onSave();
    expect(updateMyProfile).toHaveBeenCalledWith({ nickname: "新昵称", favorite_team_id: "arsenal-id" });
    expect(storeNickname).toHaveBeenCalledWith("新昵称");
    expect(wx.navigateBack).toHaveBeenCalledOnce();
  });
  it("keeps edits on a failed save and allows retry", async () => {
    const { page, updateMyProfile, wx } = load();
    await page.loadProfile(); page.onNicknameInput({ detail: { value: "修改" } });
    updateMyProfile.mockResolvedValueOnce({ statusCode: 429, message: "请稍后重试" });
    await page.onSave();
    expect(wx.navigateBack).not.toHaveBeenCalled(); expect(page.data.saving).toBe(false);
    expect(page.data.nickname).toBe("修改");
    expect(page.data.saveErrorMessage).toBe("请稍后重试");
    await page.onSave(); expect(wx.navigateBack).toHaveBeenCalledOnce();
  });
  it("shows request exceptions and keeps the form available for retry", async () => {
    const { page, updateMyProfile, wx } = load();
    await page.loadProfile(); page.onNicknameInput({ detail: { value: "修改" } });
    updateMyProfile.mockRejectedValueOnce(new Error("request:fail connection refused"));
    await page.onSave();
    expect(page.data.saveErrorMessage).toBe("request:fail connection refused");
    expect(page.data.saving).toBe(false);
    expect(wx.navigateBack).not.toHaveBeenCalled();
  });
  it("clears a selected team with an explicit null update", async () => {
    const { page, updateMyProfile } = load();
    await page.loadProfile(); page.setData({ originalTeamId: "arsenal-id", favoriteTeamId: "arsenal-id" });
    page.onTeamPick({ currentTarget: { dataset: {} } }); await page.onSave();
    expect(updateMyProfile).toHaveBeenCalledWith({ favorite_team_id: null });
  });
  it("shows the self-hosted logout action only for HTTP transport", () => {
    expect(load().page.data.showLogout).toBe(true);
    expect(load({ transport: "cloud" }).page.data.showLogout).toBe(false);
  });
  it("clears the local session and nickname cache and returns to login after confirmed logout", () => {
    const { page, clearAuth, clearNickname, wx } = load();
    wx.showModal.mockImplementation((options) => options.success({ confirm: true }));
    page.onLogout();
    expect(wx.showModal).toHaveBeenCalledWith(expect.objectContaining({ title: "确认退出登录？" }));
    expect(clearAuth).toHaveBeenCalledTimes(1);
    expect(clearNickname).toHaveBeenCalledTimes(1);
    expect(wx.reLaunch).toHaveBeenCalledWith({ url: "/pages/session/session" });

    // Also verify real nickname.js clearNickname removes NICKNAME_STORAGE_KEY
    const storage = new Map([["nickname", "Sky"]]);
    const nicknameModule = { exports: {} };
    runInNewContext(readFileSync(new URL("../../utils/nickname.js", import.meta.url), "utf8"), {
      module: nicknameModule,
      exports: nicknameModule.exports,
      wx: {
        getStorageSync: (k) => storage.get(k),
        setStorageSync: (k, v) => storage.set(k, v),
        removeStorageSync: (k) => storage.delete(k),
      },
    });
    nicknameModule.exports.clearNickname();
    expect(storage.has(nicknameModule.exports.NICKNAME_STORAGE_KEY)).toBe(false);
  });
  it("does not clear the session when logout is cancelled", () => {
    const { page, clearAuth, clearNickname, wx } = load();
    wx.showModal.mockImplementation((options) => options.success({ confirm: false }));
    page.onLogout();
    expect(clearAuth).not.toHaveBeenCalled();
    expect(clearNickname).not.toHaveBeenCalled();
    expect(wx.reLaunch).not.toHaveBeenCalled();
  });
  it("keeps CloudBase identity unchanged when logout is invoked", () => {
    const { page, clearAuth, wx } = load({ transport: "cloud" });
    page.onLogout();
    expect(wx.showModal).not.toHaveBeenCalled();
    expect(clearAuth).not.toHaveBeenCalled();
    expect(wx.reLaunch).not.toHaveBeenCalled();
  });

  it("initializes gender from GET /v1/profile/me and saves gender changes to updateMyProfile", async () => {
    const { page, updateMyProfile, wx } = load({
      profile: { nickname: "球友", favorite_team_id: null, gender: "male" },
    });
    await page.loadProfile();
    expect(page.data.gender).toBe("male");
    expect(page.data.originalGender).toBe("male");

    page.onGenderPick({ currentTarget: { dataset: { gender: "female" } } });
    expect(page.data.gender).toBe("female");
    await page.onSave();
    expect(updateMyProfile).toHaveBeenCalledWith({ gender: "female" });
    expect(wx.navigateBack).toHaveBeenCalledOnce();

    // Unset gender defaults to undisclosed and does not trigger patch if unchanged
    const unset = load({ profile: { nickname: "球友", favorite_team_id: null } });
    await unset.page.loadProfile();
    expect(unset.page.data.gender).toBe("undisclosed");
    unset.page.onGenderPick({ currentTarget: { dataset: { gender: "undisclosed" } } });
    await unset.page.onSave();
    expect(unset.updateMyProfile).not.toHaveBeenCalled();

    // Switching from female to undisclosed sends explicit undisclosed
    const clearGender = load({ profile: { nickname: "球友", favorite_team_id: null, gender: "female" } });
    await clearGender.page.loadProfile();
    clearGender.page.onGenderPick({ currentTarget: { dataset: { gender: "undisclosed" } } });
    await clearGender.page.onSave();
    expect(clearGender.updateMyProfile).toHaveBeenCalledWith({ gender: "undisclosed" });
  });

  it("supports bottom drawer league tab switching, cross-league search, and closing on pick or clear", async () => {
    const { page } = load();
    await page.loadProfile();
    await page.loadTeams();

    expect(page.data.showTeams).toBe(false);
    page.onTeamToggle();
    expect(page.data.showTeams).toBe(true);
    expect(page.data.activeLeagueId).toBe("premier_league");
    expect(page.data.filteredTeams.map((t) => t.team_id)).toEqual(["arsenal-id", "chelsea-id"]);
    expect(page.data.sheetCountText).toBe("英超共 2 支球队");

    // Switch to Bundesliga tab
    page.onLeagueTabTap({ currentTarget: { dataset: { league: "bundesliga" } } });
    expect(page.data.activeLeagueId).toBe("bundesliga");
    expect(page.data.filteredTeams.map((t) => t.team_id)).toEqual(["bayern-id"]);
    expect(page.data.sheetCountText).toBe("德甲共 1 支球队");

    // Cross-league search finds Premier League team while Bundesliga tab was active
    page.onSearch({ detail: { value: "阿森" } });
    expect(page.data.filteredTeams.map((t) => t.team_id)).toEqual(["arsenal-id"]);
    expect(page.data.filteredTeams[0].subText).toBe("英超 · Arsenal FC");
    expect(page.data.sheetCountText).toBe("搜索结果 1 支");

    // Switching league tab clears search
    page.onLeagueTabTap({ currentTarget: { dataset: { league: "premier_league" } } });
    expect(page.data.search).toBe("");
    expect(page.data.filteredTeams.map((t) => t.team_id)).toEqual(["arsenal-id", "chelsea-id"]);

    // Picking a team selects it and closes drawer
    page.onTeamPick({ currentTarget: { dataset: { id: "arsenal-id" } } });
    expect(page.data.favoriteTeamId).toBe("arsenal-id");
    expect(page.data.favoriteTeamName).toBe("阿森纳");
    expect(page.data.showTeams).toBe(false);

    // Clearing team resets to placeholder and closes drawer
    page.onTeamToggle();
    expect(page.data.showTeams).toBe(true);
    page.onTeamPick({ currentTarget: { dataset: {} } });
    expect(page.data.favoriteTeamId).toBe(null);
    expect(page.data.favoriteTeamName).toBe("暂未设置主队");
    expect(page.data.showTeams).toBe(false);
  });

  it("[A-S6-05][A-S6-08] distinguishes 401 vs 409 USER_DELETED in loadProfile/onSave and guards loadProfile with requestSerial", async () => {
    const wxml = readFileSync(new URL("./settings.wxml", import.meta.url), "utf8");
    expect(wxml).toContain("errorKind === 'unauthorized'");
    expect(wxml).toContain('bindtap="onLoginTap"');
    expect(wxml).toContain("去登录");
    expect(wxml).toContain("errorKind === 'userDeleted'");
    const deletedBlock = wxml.match(/errorKind === 'userDeleted'[\s\S]*?<\/view>/)[0];
    expect(deletedBlock).not.toContain("重新加载");

    let finishFirst;
    const { page, getMyProfile, updateMyProfile, clearAuth, wx } = load();
    getMyProfile
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ statusCode: 401, code: "UNAUTHORIZED", message: "请先登录" })
      .mockResolvedValueOnce({ statusCode: 200, data: { nickname: "新登录用户", favorite_team_id: null } })
      .mockResolvedValueOnce({ statusCode: 409, code: "USER_DELETED", message: "账号已注销" });

    const first = page.loadProfile();
    await page.loadProfile();
    expect(page.data.errorKind).toBe("unauthorized");
    expect(page.data.loading).toBe(false);

    finishFirst({ statusCode: 200, data: { nickname: "陈旧用户", favorite_team_id: null } });
    await first;
    expect(page.data.errorKind).toBe("unauthorized");
    expect(page.data.nickname).toBe("");

    page.onLoginTap();
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: "/pages/session/session?return_to=settings" });

    await page.onShow();
    expect(page.data.errorKind).toBe("");
    expect(page.data.nickname).toBe("新登录用户");

    page.onNicknameInput({ detail: { value: "修改" } });
    updateMyProfile.mockResolvedValueOnce({ statusCode: 401, code: "UNAUTHORIZED", message: "登录失效" });
    await page.onSave();
    expect(page.data.errorKind).toBe("unauthorized");
    expect(page.data.errorMessage).toBe("登录失效");

    await page.loadProfile();
    expect(page.data.errorKind).toBe("userDeleted");
    expect(page.data.errorMessage).toBe("账号已注销");
    expect(clearAuth).toHaveBeenCalled();

    page.setData({ errorKind: "", errorMessage: "", nickname: "修改2", originalNickname: "新登录用户" });
    updateMyProfile.mockResolvedValueOnce({ statusCode: 409, code: "USER_DELETED", message: "已注销" });
    await page.onSave();
    expect(page.data.errorKind).toBe("userDeleted");
  });

  it("[CR-24][CR-27] onLogout 清理跨页缓存，onSave 单页栈 navigateBack 失败兜底回 profile tab", async () => {
    const { page, clearAuth, clearNickname, wx } = load();
    wx.showModal.mockImplementationOnce((options) => options.success({ confirm: true }));
    page.onLogout();
    expect(clearAuth).toHaveBeenCalledTimes(1);
    expect(clearNickname).toHaveBeenCalledTimes(1);
    expect(wx.removeStorageSync).toHaveBeenCalledWith("pending_ranking_group_id");
    expect(wx.removeStorageSync).toHaveBeenCalledWith("pending_ranking_target");
    expect(wx.removeStorageSync).toHaveBeenCalledWith("pending_group_invite_code");
    expect(wx.removeStorageSync).toHaveBeenCalledWith("my_predictions_dirty");

    await page.loadProfile();
    wx.navigateBack.mockImplementationOnce((opts) => opts?.fail?.());
    await page.onSave();
    expect(wx.switchTab).toHaveBeenCalledWith({ url: "/pages/profile/profile" });
  });

  it("[CR42-09] merges server active promoted teams with static registry, searches, selects, displays name, and saves", async () => {
    const promotedId = "00000000-0000-4000-8000-000000000999";
    const listTeams = vi.fn(async () => ({
      statusCode: 200,
      data: {
        items: [
          {
            team_id: promotedId,
            league_id: "premier_league",
            name: "Promoted Athletic",
            name_zh: "升班马竞技",
            logo_url: "https://cdn.example.com/promoted-athletic.png",
          },
          {
            team_id: "arsenal-id",
            league_id: "premier_league",
            name: "Arsenal FC",
            name_zh: "阿森纳（服务端）",
            logo_url: null,
          },
        ],
      },
    }));
    const { page, updateMyProfile, wx } = load({
      profile: { nickname: "球友", favorite_team_id: promotedId },
      listTeams,
    });

    await page.loadProfile();
    expect(page.data.favoriteTeamName).toBe("已选择球队");

    await page.loadTeams();
    expect(listTeams).toHaveBeenCalledTimes(1);
    expect(page.data.teamsError).toBe("");
    expect(page.data.teamsLoading).toBe(false);
    expect(page.data.favoriteTeamName).toBe("升班马竞技");

    const premierGroup = page.data.visibleGroups.find((g) => g.league_id === "premier_league");
    expect(premierGroup.teams.map((t) => t.team_id)).toEqual([promotedId, "arsenal-id"]);
    expect(premierGroup.teams[0]).toMatchObject({
      team_id: promotedId,
      name: "Promoted Athletic",
      nameZh: "升班马竞技",
      logo: "https://cdn.example.com/promoted-athletic.png",
    });
    expect(premierGroup.teams[1].nameZh).toBe("阿森纳（服务端）");

    page.onSearch({ detail: { value: "升班马" } });
    expect(page.data.visibleGroups.map((g) => g.teams.map((t) => t.team_id))).toEqual([[promotedId]]);

    page.onSearch({ detail: { value: "Promoted" } });
    expect(page.data.visibleGroups.map((g) => g.teams.map((t) => t.team_id))).toEqual([[promotedId]]);

    page.setData({ originalTeamId: null, favoriteTeamId: null, favoriteTeamName: "未设置" });
    page.onTeamPick({ currentTarget: { dataset: { id: promotedId } } });
    expect(page.data.favoriteTeamId).toBe(promotedId);
    expect(page.data.favoriteTeamName).toBe("升班马竞技");

    await page.onSave();
    expect(updateMyProfile).toHaveBeenCalledWith({ favorite_team_id: promotedId });
    expect(wx.setStorageSync).toHaveBeenCalledWith(`team_name:${promotedId}`, "升班马竞技");
    expect(wx.navigateBack).toHaveBeenCalledOnce();
  });

  it("[CR42-09] falls back to static registry when GET /v1/teams fails without blocking", async () => {
    const listTeams = vi.fn().mockRejectedValueOnce(new Error("network down"));
    const { page } = load({ listTeams });

    await page.loadProfile();
    await page.loadTeams();

    expect(page.data.teamsError).toBe("");
    expect(page.data.teamsLoading).toBe(false);
    expect(page.data.visibleGroups.map((g) => g.league_id)).toEqual(["premier_league", "bundesliga"]);
    expect(page.data.visibleGroups[0].teams.map((t) => t.team_id)).toEqual(["arsenal-id", "chelsea-id"]);
  });

  it("[CR43-05] excludes inactive registry teams omitted by 200 GET /v1/teams while preserving local fallback presentation and non-200 fallback", async () => {
    const promotedId = "00000000-0000-4000-8000-000000000888";
    const listTeams = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        data: {
          items: [
            {
              team_id: promotedId,
              league_id: "premier_league",
              name: "Promoted Town",
              name_zh: "升班马镇",
              logo_url: "https://cdn.example.com/promoted-town.png",
            },
            {
              team_id: "arsenal-id",
              league_id: "premier_league",
              name: "Arsenal FC",
              name_zh: null,
              logo_url: null,
            },
          ],
        },
      })
      .mockResolvedValueOnce({ statusCode: 200, data: { items: [] } })
      .mockResolvedValueOnce({ statusCode: 503, code: "UNAVAILABLE" });

    const { page } = load({ listTeams });
    await page.loadProfile();
    await page.loadTeams();

    const teamIds = page.data.teams.map((t) => t.team_id);
    expect(teamIds).toEqual([promotedId, "arsenal-id"]);
    expect(teamIds).not.toContain("chelsea-id");
    expect(teamIds).not.toContain("bayern-id");
    expect(page.data.visibleGroups.map((g) => g.league_id)).toEqual(["premier_league"]);
    expect(page.data.teams.find((t) => t.team_id === "arsenal-id")).toMatchObject({
      nameZh: "阿森纳",
      logo: "logo:arsenal-id",
    });

    // 200 返回空数组时也不得回填静态停用球队
    await page.loadTeams();
    expect(page.data.teams).toEqual([]);
    expect(page.data.visibleGroups).toEqual([]);

    // 非 200 才整体降级静态表
    await page.loadTeams();
    expect(page.data.visibleGroups.map((g) => g.league_id)).toEqual(["premier_league", "bundesliga"]);
    expect(page.data.teams.map((t) => t.team_id)).toEqual(["arsenal-id", "chelsea-id", "bayern-id"]);
  });

  it("[CR44-03] displays selected inactive out-of-bundle favorite team name without adding it to selectable candidates", async () => {
    const inactiveId = "00000000-0000-4000-8000-000000000889";
    const listTeams = vi.fn(async () => ({
      statusCode: 200,
      data: {
        items: [
          {
            team_id: "arsenal-id",
            league_id: "premier_league",
            name: "Arsenal FC",
            name_zh: "阿森纳",
            logo_url: null,
          },
        ],
      },
    }));
    const resolveFavoriteTeamRemote = vi.fn(async (teamId) => (
      teamId === inactiveId
        ? {
          favoriteTeamId: inactiveId,
          favoriteTeamText: "已停用老牌队",
          favoriteTeamLogo: "https://cdn.example.com/relegated.png",
        }
        : null
    ));
    const { page } = load({
      profile: { nickname: "球友", favorite_team_id: inactiveId },
      listTeams,
      resolveFavoriteTeamRemote,
    });

    await page.loadProfile();
    await page.loadTeams();
    await Promise.resolve();
    await Promise.resolve();

    expect(resolveFavoriteTeamRemote).toHaveBeenCalledWith(inactiveId, expect.any(Object));
    expect(page.data.favoriteTeamId).toBe(inactiveId);
    expect(page.data.favoriteTeamName).toBe("已停用老牌队");
    expect(page.data.favoriteTeamLogo).toBe("https://cdn.example.com/relegated.png");
    expect(page.data.isFavoriteTeamInactive).toBe(true);
    expect(page.data.teams.map((t) => t.team_id)).toEqual(["arsenal-id"]);
    expect(page.data.teams.some((t) => t.team_id === inactiveId)).toBe(false);
    expect(page.data.filteredTeams.map((t) => t.team_id)).toEqual(["arsenal-id"]);
    expect(page.data.visibleGroups.flatMap((g) => g.teams.map((t) => t.team_id))).toEqual(["arsenal-id"]);
  });

  it("[CR50-03] guards team drawer during loading/error states and resets showTeams on 401, 409, non-200, and reject", async () => {
    const wxml = readFileSync(new URL("./settings.wxml", import.meta.url), "utf8");
    expect(wxml).toContain('wx:if="{{showTeams && !loading && !errorKind && !errorMessage}}"');

    const scenarios = [
      { kind: "unauthorized", result: { statusCode: 401, code: "UNAUTHORIZED", message: "请先登录" } },
      { kind: "userDeleted", result: { statusCode: 409, code: "USER_DELETED", message: "账号已注销" } },
      { kind: "error", result: { statusCode: 500, code: "INTERNAL", message: "服务异常" } },
      { kind: "reject", reject: new Error("network down") },
    ];

    for (const scenario of scenarios) {
      let finishProfile;
      let rejectProfile;
      const { page, getMyProfile } = load();
      getMyProfile.mockImplementationOnce(() => new Promise((resolve, reject) => {
        finishProfile = resolve;
        rejectProfile = reject;
      }));

      page.onLoad({ section: "team" });
      expect(page.data.showTeams).toBe(true);
      expect(page.data.loading).toBe(true);

      if (scenario.reject) {
        rejectProfile(scenario.reject);
      } else {
        finishProfile(scenario.result);
      }
      await vi.waitFor(() => expect(page.data.loading).toBe(false));
      expect(page.data.showTeams).toBe(false);
      expect(page.pendingInitialTeamFocus).toBe(false);
      expect(page.data.errorKind).toBe(scenario.kind === "reject" ? "error" : scenario.kind);
    }
  });

  it("[CR50-03] focuses favorite team league once for ?section=team regardless of profile/teams arrival order and never overrides user tab choice", async () => {
    const laLigaId = "real-madrid-id";
    const teamPayload = {
      statusCode: 200,
      data: {
        items: [
          { team_id: "arsenal-id", league_id: "premier_league", name: "Arsenal FC", name_zh: "阿森纳", logo_url: null },
          { team_id: laLigaId, league_id: "la_liga", name: "Real Madrid CF", name_zh: "皇家马德里", logo_url: null },
          { team_id: "bayern-id", league_id: "bundesliga", name: "FC Bayern München", name_zh: "拜仁慕尼黑", logo_url: null },
        ],
      },
    };

    // Order 1: loadProfile resolves first, loadTeams resolves second
    {
      let finishProfile;
      let finishTeams;
      const listTeams = vi.fn(() => new Promise((resolve) => { finishTeams = resolve; }));
      const { page, getMyProfile } = load({ listTeams });
      getMyProfile.mockImplementationOnce(() => new Promise((resolve) => { finishProfile = resolve; }));

      page.onLoad({ section: "team" });
      finishProfile({ statusCode: 200, data: { nickname: "球友", favorite_team_id: laLigaId } });
      await vi.waitFor(() => expect(page.data.loading).toBe(false));
      expect(page.data.showTeams).toBe(true);
      expect(page.data.activeLeagueId).toBe("premier_league");

      finishTeams(teamPayload);
      await vi.waitFor(() => expect(page.data.teamsLoading).toBe(false));
      expect(page.data.activeLeagueId).toBe("la_liga");
      expect(page.data.filteredTeams.map((t) => t.team_id)).toEqual([laLigaId]);
      expect(page.pendingInitialTeamFocus).toBe(false);
    }

    // Order 2: loadTeams resolves first, loadProfile resolves second
    {
      let finishProfile;
      let finishTeams;
      const listTeams = vi.fn(() => new Promise((resolve) => { finishTeams = resolve; }));
      const { page, getMyProfile } = load({ listTeams });
      getMyProfile.mockImplementationOnce(() => new Promise((resolve) => { finishProfile = resolve; }));

      page.onLoad({ section: "team" });
      finishTeams(teamPayload);
      await vi.waitFor(() => expect(page.data.teamsLoading).toBe(false));
      expect(page.data.activeLeagueId).toBe("premier_league");

      finishProfile({ statusCode: 200, data: { nickname: "球友", favorite_team_id: laLigaId } });
      await vi.waitFor(() => expect(page.data.loading).toBe(false));
      expect(page.data.activeLeagueId).toBe("la_liga");
      expect(page.data.filteredTeams.map((t) => t.team_id)).toEqual([laLigaId]);
      expect(page.pendingInitialTeamFocus).toBe(false);
    }

    // User switches to Bundesliga while loadTeams is still in flight -> late loadTeams must NOT overwrite back to la_liga
    {
      let finishProfile;
      let finishTeams;
      const listTeams = vi.fn(() => new Promise((resolve) => { finishTeams = resolve; }));
      const { page, getMyProfile } = load({ listTeams });
      getMyProfile.mockImplementationOnce(() => new Promise((resolve) => { finishProfile = resolve; }));

      page.onLoad({ section: "team" });
      finishProfile({ statusCode: 200, data: { nickname: "球友", favorite_team_id: laLigaId } });
      await vi.waitFor(() => expect(page.data.loading).toBe(false));
      expect(page.data.showTeams).toBe(true);

      page.onLeagueTabTap({ currentTarget: { dataset: { league: "bundesliga" } } });
      expect(page.data.activeLeagueId).toBe("bundesliga");
      expect(page.pendingInitialTeamFocus).toBe(false);

      finishTeams(teamPayload);
      await vi.waitFor(() => expect(page.data.teamsLoading).toBe(false));
      expect(page.data.activeLeagueId).toBe("bundesliga");
      expect(page.data.filteredTeams.map((t) => t.team_id)).toEqual(["bayern-id"]);
    }
  });

  it("[CR50-06] does not mark out-of-bundle active favorite team inactive on static fallback, and treats 200 [] as authoritative empty", async () => {
    const promotedId = "00000000-0000-4000-8000-000000000777";

    // Network rejection / non-200 / invalid items -> fallback to static registry, serverTeamsLoaded stays false
    for (const setup of [
      () => vi.fn().mockRejectedValueOnce(new Error("network down")),
      () => vi.fn().mockResolvedValueOnce({ statusCode: 503, code: "UNAVAILABLE" }),
      () => vi.fn().mockResolvedValueOnce({ statusCode: 200, data: { items: null } }),
    ]) {
      const listTeams = setup();
      const { page } = load({
        profile: { nickname: "球友", favorite_team_id: promotedId },
        listTeams,
      });

      await page.loadProfile();
      await page.loadTeams();

      expect(page.serverTeamsLoaded).toBe(false);
      expect(page.data.isFavoriteTeamInactive).toBe(false);
      expect(page.data.favoriteTeamSub).toBe("已选择主队");
      expect(page.data.teams.map((t) => t.team_id)).toEqual(["arsenal-id", "chelsea-id", "bayern-id"]);
    }

    // 200 [] -> authoritative empty server result, no static backfill, favorite team marked inactive
    const emptyListTeams = vi.fn().mockResolvedValueOnce({ statusCode: 200, data: { items: [] } });
    const { page: emptyPage } = load({
      profile: { nickname: "球友", favorite_team_id: promotedId },
      listTeams: emptyListTeams,
    });

    await emptyPage.loadProfile();
    await emptyPage.loadTeams();

    expect(emptyPage.serverTeamsLoaded).toBe(true);
    expect(emptyPage.data.teams).toEqual([]);
    expect(emptyPage.data.visibleGroups).toEqual([]);
    expect(emptyPage.data.isFavoriteTeamInactive).toBe(true);
    expect(emptyPage.data.favoriteTeamSub).toBe("历史已选主队 · 仍正常展示");
  });

  it("[CR50-07] aligns nickname maxlength and hint to 1-32 chars, saves 1/13/32-char names, and surfaces server rejection", async () => {
    // Note: WeChat native <input maxlength="32"> counting for combined Emoji must be verified on real device/DevTools.
    const wxml = readFileSync(new URL("./settings.wxml", import.meta.url), "utf8");
    expect(wxml).toContain("1–32 字，展示于榜单与分享卡");
    expect(wxml).toContain('maxlength="32"');
    expect(wxml).not.toContain("2–12 字");
    expect(wxml).not.toContain('maxlength="12"');

    for (const validName of ["A", "十三字昵称测试一二三四五六", "a".repeat(32)]) {
      const { page, updateMyProfile, storeNickname, wx } = load();
      updateMyProfile.mockResolvedValueOnce({ statusCode: 200, data: { nickname: validName } });
      await page.loadProfile();
      page.onNicknameInput({ detail: { value: validName } });
      await page.onSave();
      expect(updateMyProfile).toHaveBeenCalledWith({ nickname: validName });
      expect(storeNickname).toHaveBeenCalledWith(validName);
      expect(wx.navigateBack).toHaveBeenCalledOnce();
    }

    const overlongName = "a".repeat(33);
    const { page, updateMyProfile, wx } = load();
    updateMyProfile.mockResolvedValueOnce({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      message: "昵称长度需在 1–32 字之间",
    });
    await page.loadProfile();
    page.onNicknameInput({ detail: { value: overlongName } });
    await page.onSave();
    expect(updateMyProfile).toHaveBeenCalledWith({ nickname: overlongName });
    expect(page.data.saveErrorMessage).toBe("昵称长度需在 1–32 字之间");
    expect(page.data.saving).toBe(false);
    expect(page.data.nickname).toBe(overlongName);
    expect(wx.navigateBack).not.toHaveBeenCalled();
  });
});
