import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runInThisContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const COPY_PATH = join(ROOT, "utils", "rankings-copy.js");
const SERVICE_PATH = join(ROOT, "services", "groups.js");

const originals = {
  Page: Object.getOwnPropertyDescriptor(globalThis, "Page"),
  wx: Object.getOwnPropertyDescriptor(globalThis, "wx"),
};

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

function loadCommonJs(filePath, requireShim) {
  const module = { exports: {} };
  const source = readFileSync(filePath, "utf8");
  const factory = runInThisContext("(function(module, exports, require) {\n" + source + "\n})", {
    filename: filePath,
  });
  factory(module, module.exports, requireShim);
  return module.exports;
}

function capturePage(filePath, modules) {
  let config;
  setGlobal("Page", (pageConfig) => { config = pageConfig; });
  loadCommonJs(filePath, (id) => {
    if (Object.prototype.hasOwnProperty.call(modules, id)) return modules[id];
    throw new Error("Unexpected require: " + id);
  });
  return config;
}

function instantiate(config) {
  return Object.assign({}, config, {
    data: JSON.parse(JSON.stringify(config.data || {})),
    setData(patch) { Object.assign(this.data, patch); },
  });
}

function installWx() {
  const navs = [];
  const storage = new Map();
  const modals = [];
  const toasts = [];
  setGlobal("wx", {
    navigateTo: (options) => navs.push(["navigateTo", options.url]),
    redirectTo: (options) => navs.push(["redirectTo", options.url]),
    reLaunch: (options) => navs.push(["reLaunch", options.url]),
    switchTab: (options) => navs.push(["switchTab", options.url]),
    navigateBack: (options) => navs.push(["navigateBack", options.delta]),
    setStorageSync: (key, value) => storage.set(key, value),
    getStorageSync: (key) => storage.get(key),
    removeStorageSync: (key) => storage.delete(key),
    showModal: (options) => { modals.push(options); options.success({ confirm: true }); },
    showToast: (options) => toasts.push(options),
  });
  return { navs, storage, modals, toasts };
}

function loadPage(page, serviceOverrides = {}) {
  const COPY = loadCommonJs(COPY_PATH, () => { throw new Error("COPY has no dependencies"); });
  const services = {
    listMyGroups: vi.fn(async () => ({ statusCode: 200, data: { items: [] } })),
    createGroup: vi.fn(async () => ({ statusCode: 201, data: { group_id: "group-1", invite_code: "ABCDEFGH" } })),
    joinGroup: vi.fn(async () => ({ statusCode: 200, data: { group_id: "group-1" } })),
    getGroup: vi.fn(async () => ({ statusCode: 200, data: { group_id: "group-1", invite_code: "ABCDEFGH" } })),
    leaveGroup: vi.fn(async () => ({ statusCode: 204 })),
    dissolveGroup: vi.fn(async () => ({ statusCode: 204 })),
    isValidInviteCode: (code) => typeof code === "string" && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code),
    ...serviceOverrides,
  };
  const file = join(HERE, page + ".js");
  const config = capturePage(file, {
    "../../services/groups.js": services,
    "../../utils/rankings-copy.js": COPY,
  });
  return { config, services };
}

function loadRankingsPage() {
  const COPY = loadCommonJs(COPY_PATH, () => { throw new Error("COPY has no dependencies"); });
  const config = capturePage(join(ROOT, "pages", "rankings", "rankings.js"), {
    "../../services/rankings.js": { listRankings: vi.fn(async () => ({ statusCode: 200, data: {} })) },
    "../../services/profile.js": { getMyProfile: vi.fn() },
    "../../services/levels.js": { getMyLevels: vi.fn() },
    "../../services/groups.js": { listMyGroups: vi.fn() },
    "../../utils/rankings-view-model.js": { buildRankingViewModel: vi.fn(() => ({})) },
    "../../utils/rankings-copy.js": COPY,
  });
  return config;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("groups services", () => {
  it("uses the group API methods and validates invite codes before sending", async () => {
    const calls = [];
    const service = loadCommonJs(SERVICE_PATH, (id) => {
      if (id !== "./api.js") throw new Error("Unexpected require: " + id);
      return { request: (request) => { calls.push(request); return Promise.resolve({ statusCode: 200 }); } };
    });
    await service.listMyGroups({ limit: 20, cursor: "next" });
    await service.createGroup();
    const invalid = await service.joinGroup("bad-code");
    await service.joinGroup("ABCDEFGH");
    await service.leaveGroup("group-1");
    await service.dissolveGroup("group-1");
    await service.getGroup("group-1");
    expect(invalid.statusCode).toBe(422);
    expect(calls).toEqual([
      { method: "GET", path: "/v1/groups/me", query: { limit: 20, cursor: "next" } },
      { method: "POST", path: "/v1/groups", data: {} },
      { method: "POST", path: "/v1/groups/join", data: { invite_code: "ABCDEFGH" } },
      { method: "POST", path: "/v1/groups/group-1/leave" },
      { method: "DELETE", path: "/v1/groups/group-1" },
      { method: "GET", path: "/v1/groups/group-1" },
    ]);
  });
});

describe("group pages", () => {
  it("hides create and join controls at their limits", async () => {
    installWx();
    const items = Array.from({ length: 20 }, (_, index) => ({
      group_id: "group-" + index,
      role: index < 5 ? "owner" : "member",
      member_count: 2,
    }));
    const { config } = loadPage("groups", {
      listMyGroups: vi.fn(async () => ({ statusCode: 200, data: { items } })),
    });
    const page = instantiate(config);
    page.onShow();
    await flush();
    expect(page.data.canJoin).toBe(false);
    expect(page.data.canCreate).toBe(false);
    expect(page.data.groups[0]).toMatchObject({ memberCountText: "2 位成员", roleText: "群主" });
  });

  it("shows create and join controls for a user without groups", async () => {
    installWx();
    const { config } = loadPage("groups");
    const page = instantiate(config);
    page.onShow();
    await flush();
    expect(page.data.state).toBe("ready");
    expect(page.data.groups).toEqual([]);
    expect(page.data.canCreate).toBe(true);
    expect(page.data.canJoin).toBe(true);
  });

  it("requires a valid code and then navigates to the explicit confirmation page", () => {
    const { navs } = installWx();
    const { config } = loadPage("groups");
    const page = instantiate(config);
    page.setData({ canJoin: true, inviteCode: "bad" });
    page.onJoinTap();
    expect(page.data.errorMessage).toContain("邀请码");
    page.setData({ inviteCode: "ABCDEFGH" });
    page.onJoinTap();
    expect(navs).toEqual([["navigateTo", "/pages/groups/join?code=ABCDEFGH"]]);
  });

  it("opens the created group detail page", async () => {
    const wxStub = installWx();
    const { config, services } = loadPage("groups");
    const page = instantiate(config);
    page.setData({ canCreate: true });
    page.onCreateTap();
    await flush();
    expect(services.createGroup).toHaveBeenCalledOnce();
    expect(wxStub.navs).toEqual([["navigateTo", "/pages/groups/detail?group_id=group-1"]]);
  });

  it("keeps an invite code across login and returns to the confirmation page", async () => {
    const wxStub = installWx();
    const { config } = loadPage("join", {
      joinGroup: vi.fn(async () => ({ statusCode: 401, code: "UNAUTHORIZED" })),
    });
    const page = instantiate(config);
    page.onLoad({ code: "ABCDEFGH" });
    page.onConfirm();
    await flush();
    expect(wxStub.storage.get("pending_group_invite_code")).toBe("ABCDEFGH");
    expect(wxStub.navs).toEqual([["redirectTo", "/pages/session/session"]]);
  });

  it("returns to the pending invite after session initialization", async () => {
    const wxStub = installWx();
    wxStub.storage.set("pending_group_invite_code", "ABCDEFGH");
    const { config } = (() => {
      const file = join(ROOT, "pages", "session", "session.js");
      const storeNickname = vi.fn();
      const config = capturePage(file, {
        "../../services/session.js": {
          initSession: vi.fn(async () => ({ statusCode: 201, data: { nickname: "Sky" } })),
        },
        "../../utils/nickname.js": { storeNickname },
      });
      return { config, storeNickname };
    })();
    const page = instantiate(config);
    page.onSubmit();
    await flush();
    expect(wxStub.storage.has("pending_group_invite_code")).toBe(false);
    expect(wxStub.navs).toEqual([[
      "reLaunch",
      "/pages/groups/join?code=ABCDEFGH",
    ]]);
  });

  it("refreshes /groups/me after a successful join before entering the group board", async () => {
    const wxStub = installWx();
    const groups = [{ group_id: "group-1" }];
    const { config, services } = loadPage("join", {
      listMyGroups: vi.fn(async () => ({ statusCode: 200, data: { items: groups } })),
    });
    const page = instantiate(config);
    page.onLoad({ code: "ABCDEFGH" });
    page.onConfirm();
    await flush();
    await flush();
    expect(services.listMyGroups).toHaveBeenCalledWith({ limit: 20 });
    expect(wxStub.storage.get("pending_ranking_group_id")).toBe("group-1");
    expect(wxStub.navs).toEqual([["switchTab", "/pages/rankings/rankings"]]);
  });

  it("resolves GROUP_ALREADY_MEMBER by reading member group details", async () => {
    const wxStub = installWx();
    const { config, services } = loadPage("join", {
      joinGroup: vi.fn(async () => ({ statusCode: 409, code: "GROUP_ALREADY_MEMBER" })),
      listMyGroups: vi.fn(async () => ({ statusCode: 200, data: { items: [{ group_id: "group-existing" }] } })),
      getGroup: vi.fn(async () => ({ statusCode: 200, data: { group_id: "group-existing", invite_code: "ABCDEFGH" } })),
    });
    const page = instantiate(config);
    page.onLoad({ code: "ABCDEFGH" });
    page.onConfirm();
    await flush();
    await flush();
    await flush();
    expect(services.getGroup).toHaveBeenCalledWith("group-existing");
    expect(wxStub.navs).toEqual([["switchTab", "/pages/rankings/rankings"]]);
  });

  it("shows bad share parameters without attempting a join", () => {
    installWx();
    const { config, services } = loadPage("join");
    const page = instantiate(config);
    page.onLoad({ code: "invalid" });
    page.onConfirm();
    expect(page.data.state).toBe("error");
    expect(services.joinGroup).not.toHaveBeenCalled();
  });

  it("shares a fixed title and invite-code path from the group detail page", async () => {
    installWx();
    const { config } = loadPage("detail");
    const page = instantiate(config);
    page.onLoad({ group_id: "group-1" });
    await flush();
    expect(page.onShareAppMessage()).toEqual({
      title: "来一起比预测成绩",
      path: "/pages/groups/join?code=ABCDEFGH",
    });
  });

  it("opens the groups page and keeps group invite sharing as a TODO toast", () => {
    const wxStub = installWx();
    const page = instantiate(loadRankingsPage());
    page.onInviteTap();
    page.setData({ scope: "group", groupId: "group-1" });
    page.onInviteTap();
    expect(wxStub.navs).toEqual([["navigateTo", "/pages/groups/groups"]]);
    expect(wxStub.toasts).toEqual([{ title: "邀请功能待开放", icon: "none" }]);
  });

  it("leaves a member group after confirmation", async () => {
    const wxStub = installWx();
    const { config, services } = loadPage("detail", {
      getGroup: vi.fn(async () => ({ statusCode: 200, data: {
        group_id: "group-1", invite_code: "ABCDEFGH", member_count: 2, role: "member",
      } })),
    });
    const page = instantiate(config);
    page.onLoad({ group_id: "group-1" });
    await flush();
    page.onLeaveTap();
    await flush();
    expect(services.leaveGroup).toHaveBeenCalledWith("group-1");
    expect(wxStub.navs).toEqual([["navigateBack", 1]]);
  });

  it("dissolves an owner group after confirmation", async () => {
    const wxStub = installWx();
    const { config, services } = loadPage("detail", {
      getGroup: vi.fn(async () => ({ statusCode: 200, data: {
        group_id: "group-1", invite_code: "ABCDEFGH", member_count: 2, role: "owner",
      } })),
    });
    const page = instantiate(config);
    page.onLoad({ group_id: "group-1" });
    await flush();
    page.onDissolveTap();
    await flush();
    expect(services.dissolveGroup).toHaveBeenCalledWith("group-1");
    expect(wxStub.navs).toEqual([["navigateBack", 1]]);
  });
});
