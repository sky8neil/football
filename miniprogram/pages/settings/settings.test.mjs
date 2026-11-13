import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it, expect, vi } from "vitest";
function load({ transport = "http" } = {}) {
  let definition;
  const getMyProfile = vi.fn(async () => ({ statusCode: 200, data: { nickname: "球友", favorite_team_id: null } }));
  const updateMyProfile = vi.fn(async () => ({ statusCode: 200, data: { nickname: "新昵称" } }));
  const listMatches = vi.fn(async () => ({ statusCode: 200, data: { items: [{ league_id: "premier_league", home_team: { team_id: "a", name: "Arsenal" }, away_team: { team_id: "b", name: "Chelsea" } }], page: { next_cursor: "next" } } }));
  const storeNickname = vi.fn();
  const clearAuth = vi.fn();
  const wx = { getStorageSync: vi.fn(), setStorageSync: vi.fn(), navigateBack: vi.fn(), showToast: vi.fn(), showModal: vi.fn(), reLaunch: vi.fn() };
  runInNewContext(readFileSync(new URL("./settings.js", import.meta.url), "utf8"), {
    Page: value => { definition = value; }, wx,
    require: name => name.includes("profile") ? { getMyProfile, updateMyProfile } : name.includes("matches") ? { listMatches } : name.includes("nickname") ? { storeNickname } : name.includes("auth") ? { clearAuth } : name.includes("config") ? { transport } : { getTeamLogo: () => "logo.png" },
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value); } };
  return { page, getMyProfile, updateMyProfile, listMatches, storeNickname, clearAuth, wx };
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
  it("loads and deduplicates real teams across pages and searches by name", async () => {
    const { page, listMatches } = load();
    await page.loadProfile(); await page.loadTeams(); await page.loadTeams();
    expect(page.data.teams.map(team => team.name)).toEqual(["Arsenal", "Chelsea"]);
    expect(listMatches).toHaveBeenLastCalledWith({ limit: 100, cursor: "next" });
    page.onSearch({ detail: { value: "ars" } });
    expect(page.data.visibleTeams.map(team => team.name)).toEqual(["Arsenal"]);
  });
  it("saves only changed fields and returns to the profile after success", async () => {
    const { page, updateMyProfile, storeNickname, wx } = load();
    await page.loadProfile(); await page.loadTeams();
    page.onNicknameInput({ detail: { value: " 新昵称 " } });
    page.onTeamPick({ currentTarget: { dataset: { id: "a" } } });
    await page.onSave();
    expect(updateMyProfile).toHaveBeenCalledWith({ nickname: "新昵称", favorite_team_id: "a" });
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
    await page.loadProfile(); page.setData({ originalTeamId: "a", favoriteTeamId: "a" });
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
