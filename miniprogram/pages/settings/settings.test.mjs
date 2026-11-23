import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it, expect, vi } from "vitest";

const TEAM_REGISTRY = {
  "arsenal-id": { league_id: "premier_league", source_name: "Arsenal FC", name_zh: "阿森纳" },
  "chelsea-id": { league_id: "premier_league", source_name: "Chelsea FC", name_zh: "切尔西" },
  "bayern-id": { league_id: "bundesliga", source_name: "FC Bayern München", name_zh: "拜仁慕尼黑" },
};

function load({ transport = "http", profile } = {}) {
  let definition;
  const findTeam = vi.fn((id) => (id && TEAM_REGISTRY[id]) || null);
  const presentTeam = vi.fn((team) => {
    const found = findTeam(team && team.team_id);
    return {
      teamId: team && team.team_id,
      nameZh: (found && found.name_zh) || "球队资料待补全",
      logo: `logo:${team && team.team_id}`,
      missing: !found,
    };
  });
  const getMyProfile = vi.fn(async () => ({
    statusCode: 200,
    data: profile || { nickname: "球友", favorite_team_id: null },
  }));
  const updateMyProfile = vi.fn(async () => ({ statusCode: 200, data: { nickname: "新昵称" } }));
  const listMatches = vi.fn(async () => ({ statusCode: 200, data: { items: [], page: {} } }));
  const storeNickname = vi.fn();
  const clearAuth = vi.fn();
  const required = [];
  const wx = { getStorageSync: vi.fn(), setStorageSync: vi.fn(), navigateBack: vi.fn(), showToast: vi.fn(), showModal: vi.fn(), reLaunch: vi.fn() };
  runInNewContext(readFileSync(new URL("./settings.js", import.meta.url), "utf8"), {
    Page: value => { definition = value; }, wx,
    require: (name) => {
      required.push(name);
      if (name.includes("profile")) return { getMyProfile, updateMyProfile };
      if (name.includes("matches")) return { listMatches };
      if (name.includes("nickname")) return { storeNickname };
      if (name.includes("auth")) return { clearAuth };
      if (name.includes("config")) return { transport };
      if (name.includes("team-presentation")) return { presentTeam };
      if (name.includes("team-registry")) return { findTeam, TEAM_REGISTRY };
      if (name.includes("logo-registry")) return { getTeamLogo: () => "logo.png" };
      throw new Error("Unexpected require: " + name);
    },
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value); } };
  return { page, getMyProfile, updateMyProfile, listMatches, storeNickname, clearAuth, wx, required, findTeam, presentTeam };
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
  it("renders grouped bilingual team rows keyed by team_id", () => {
    const wxml = readFileSync(new URL("./settings.wxml", import.meta.url), "utf8");
    expect(wxml).toContain('wx:for="{{visibleGroups}}"');
    expect(wxml).toContain('wx:key="league_id"');
    expect(wxml).toContain("{{item.leagueName}}");
    expect(wxml).toContain('wx:for="{{item.teams}}"');
    expect(wxml).toContain('wx:for-item="team"');
    expect(wxml).toContain('wx:key="team_id"');
    expect(wxml).toContain('data-id="{{team.team_id}}"');
    expect(wxml).toContain("{{team.nameZh}}");
    expect(wxml).toContain("{{team.name}}");
    expect(wxml).not.toContain("加载更多球队");
    expect(wxml).not.toContain("球队来自当前赛事");
  });
  it("styles league groups with existing design tokens", () => {
    const wxss = readFileSync(new URL("./settings.wxss", import.meta.url), "utf8");
    expect(wxss).toMatch(/\.league-heading\s*\{[^}]*var\(--/);
    expect(wxss).toMatch(/\.team-en\s*\{[^}]*var\(--/);
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
  it("clears the local session and returns to login after confirmed logout", () => {
    const { page, clearAuth, wx } = load();
    wx.showModal.mockImplementation((options) => options.success({ confirm: true }));
    page.onLogout();
    expect(wx.showModal).toHaveBeenCalledWith(expect.objectContaining({ title: "确认退出登录？" }));
    expect(clearAuth).toHaveBeenCalledTimes(1);
    expect(wx.reLaunch).toHaveBeenCalledWith({ url: "/pages/session/session" });
  });
  it("does not clear the session when logout is cancelled", () => {
    const { page, clearAuth, wx } = load();
    wx.showModal.mockImplementation((options) => options.success({ confirm: false }));
    page.onLogout();
    expect(clearAuth).not.toHaveBeenCalled();
    expect(wx.reLaunch).not.toHaveBeenCalled();
  });
  it("keeps CloudBase identity unchanged when logout is invoked", () => {
    const { page, clearAuth, wx } = load({ transport: "cloud" });
    page.onLogout();
    expect(wx.showModal).not.toHaveBeenCalled();
    expect(clearAuth).not.toHaveBeenCalled();
    expect(wx.reLaunch).not.toHaveBeenCalled();
  });
});
