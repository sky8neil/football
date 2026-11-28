import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runInThisContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const COPY_PATH = join(ROOT, "utils", "rankings-copy.js");
const DETAIL_PATH = join(HERE, "detail.js");
const DETAIL_WXML_PATH = join(HERE, "detail.wxml");

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

function installWx({ navigateBackFail = false } = {}) {
  const navs = [];
  const menus = [];
  setGlobal("wx", {
    navigateTo: (options) => navs.push(["navigateTo", options.url]),
    redirectTo: (options) => navs.push(["redirectTo", options.url]),
    navigateBack: (options) => {
      navs.push(["navigateBack", options.delta]);
      if (navigateBackFail && options && typeof options.fail === "function") {
        options.fail();
      }
    },
    getStorageSync: () => undefined,
    removeStorageSync: () => {},
    showModal: (options) => options.success({ confirm: true }),
    hideShareMenu: (options) => menus.push(["hideShareMenu", options.menus]),
    showShareMenu: (options) => menus.push(["showShareMenu", options.menus]),
    setClipboardData: (options) => options.success(),
  });
  return { navs, menus };
}

function loadDetail(serviceOverrides = {}, { getLoginGeneration } = {}) {
  const COPY = loadCommonJs(COPY_PATH, () => { throw new Error("COPY has no dependencies"); });
  const services = {
    getGroup: vi.fn(async () => ({
      statusCode: 200,
      data: { group_id: "group-1", invite_code: "ABCDEFGH", member_count: 2, role: "member" },
    })),
    leaveGroup: vi.fn(async () => ({ statusCode: 204 })),
    dissolveGroup: vi.fn(async () => ({ statusCode: 204 })),
    ...serviceOverrides,
  };
  let config;
  setGlobal("Page", (pageConfig) => { config = pageConfig; });
  loadCommonJs(DETAIL_PATH, (id) => {
    if (id === "../../services/groups.js") return services;
    if (id === "../../utils/rankings-copy.js") return COPY;
    if (id === "../../services/auth.js" && getLoginGeneration) {
      return { getLoginGeneration };
    }
    throw new Error("Unexpected require: " + id);
  });
  return { config, services };
}

function instantiate(config) {
  return Object.assign({}, config, {
    data: JSON.parse(JSON.stringify(config.data || {})),
    setData(patch) { Object.assign(this.data, patch); },
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("group detail sharing and loading recovery", () => {
  it("falls back to the groups page and hides share menus before the group is ready", async () => {
    let finish;
    const getGroup = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { config } = loadDetail({ getGroup });
    const { menus } = installWx();
    const page = instantiate(config);
    page.onLoad({ group_id: "group-1" });

    expect(page.onShareAppMessage()).toEqual({
      title: "来一起比预测成绩",
      path: "/pages/groups/groups",
    });
    expect(menus).toContainEqual(["hideShareMenu", ["shareAppMessage", "shareTimeline"]]);

    finish({
      statusCode: 200,
      data: { group_id: "group-1", invite_code: "ABCDEFGH", member_count: 2 },
    });
    await flush();
    expect(menus).toContainEqual(["showShareMenu", ["shareAppMessage", "shareTimeline"]]);
  });

  it("recovers to the error state when the group request rejects", async () => {
    const { config } = loadDetail({
      getGroup: vi.fn(async () => { throw new Error("network"); }),
    });
    const { menus } = installWx();
    const page = instantiate(config);
    page.onLoad({ group_id: "group-1" });
    await flush();

    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe("读取群信息失败");
    expect(menus.at(-1)).toEqual(["hideShareMenu", ["shareAppMessage", "shareTimeline"]]);
  });

  it("restores loadingAction when a leave request rejects", async () => {
    const { config } = loadDetail({
      leaveGroup: vi.fn(async () => { throw new Error("network"); }),
    });
    installWx();
    const page = instantiate(config);
    page.onLoad({ group_id: "group-1" });
    await flush();
    expect(page.data.state).toBe("ready");

    page.onLeaveTap();
    await flush();
    expect(page.data.loadingAction).toBe(false);
    expect(page.data.errorMessage).toBe("操作失败，请重试");
  });

  it("resets loadingAction on 204 and falls back to redirectTo /pages/groups/groups when navigateBack fails", async () => {
    const { config } = loadDetail();
    const { navs } = installWx({ navigateBackFail: true });
    const page = instantiate(config);
    await page.onLoad({ group_id: "group-1" });
    expect(page.data.state).toBe("ready");

    page.onLeaveTap();
    await flush();
    expect(page.data.loadingAction).toBe(false);
    expect(navs).toEqual([
      ["navigateBack", 1],
      ["redirectTo", "/pages/groups/groups"],
    ]);
  });

  it("guards loadGroup against stale responses and refreshes on loginGeneration change", async () => {
    let finishFirst;
    let generation = 0;
    const getGroup = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ statusCode: 500, message: "服务端异常" })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { group_id: "group-1", invite_code: "ZYXWVUT2", member_count: 3, role: "owner" },
      });
    const { config } = loadDetail({ getGroup }, { getLoginGeneration: () => generation });
    const { menus } = installWx();
    const page = instantiate(config);

    const first = page.onLoad({ group_id: "group-1" });
    await page.onRetry();
    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe("服务端异常");

    finishFirst({
      statusCode: 200,
      data: { group_id: "group-1", invite_code: "ABCDEFGH", member_count: 2, role: "member" },
    });
    await first;
    expect(page.data.state).toBe("error");
    expect(menus.at(-1)).toEqual(["hideShareMenu", ["shareAppMessage", "shareTimeline"]]);

    generation = 1;
    await page.onShow();
    expect(page.data.state).toBe("ready");
    expect(page.data.group.invite_code).toBe("ZYXWVUT2");
    expect(menus.at(-1)).toEqual(["showShareMenu", ["shareAppMessage", "shareTimeline"]]);
  });

  it("handles 401 UNAUTHORIZED (reloading on onShow) and 409 USER_DELETED", async () => {
    const wxml = readFileSync(DETAIL_WXML_PATH, "utf8");
    expect(wxml).toContain("state === 'unauthorized'");
    expect(wxml).toContain('bindtap="onLoginTap"');
    expect(wxml).toContain("state === 'userDeleted'");

    const getGroup = vi.fn()
      .mockResolvedValueOnce({ statusCode: 401, code: "UNAUTHORIZED", message: "请先登录" })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { group_id: "group-1", invite_code: "ABCDEFGH", member_count: 2, role: "member" },
      })
      .mockResolvedValueOnce({ statusCode: 409, code: "USER_DELETED", message: "该账号已被注销" });
    const { config } = loadDetail({ getGroup });
    const { navs } = installWx();
    const page = instantiate(config);

    await page.onLoad({ group_id: "group-1" });
    expect(page.data.state).toBe("unauthorized");
    page.onLoginTap();
    expect(navs).toContainEqual(["navigateTo", "/pages/session/session?return_to=group-detail"]);

    await page.onShow();
    expect(page.data.state).toBe("ready");

    await page.onRetry();
    expect(page.data.state).toBe("userDeleted");
    expect(page.data.errorMessage).toBe("该账号已被注销");
  });

  it("[CR50-14] prevents double modal/execution while wx.showModal is pending and releases lock on cancel/fail", async () => {
    const leaveGroup = vi.fn(async () => ({ statusCode: 204 }));
    const { config } = loadDetail({ leaveGroup });
    const { navs } = installWx();
    const modalCallbacks = [];
    globalThis.wx.showModal = vi.fn((options) => { modalCallbacks.push(options); });

    const page = instantiate(config);
    await page.onLoad({ group_id: "group-1" });

    // Double tap before showModal resolves: only one modal should open
    page.onLeaveTap();
    page.onLeaveTap();
    expect(globalThis.wx.showModal).toHaveBeenCalledTimes(1);

    // Cancel releases confirmation lock
    modalCallbacks[0].success({ confirm: false });
    expect(leaveGroup).not.toHaveBeenCalled();

    // Next tap can open modal again; fail also releases lock
    page.onLeaveTap();
    expect(globalThis.wx.showModal).toHaveBeenCalledTimes(2);
    modalCallbacks[1].fail();

    // Confirm executes once and navigates back
    page.onLeaveTap();
    page.onLeaveTap();
    expect(globalThis.wx.showModal).toHaveBeenCalledTimes(3);
    modalCallbacks[2].success({ confirm: true });
    await flush();
    expect(leaveGroup).toHaveBeenCalledTimes(1);
    expect(page.data.loadingAction).toBe(false);
    expect(navs).toEqual([["navigateBack", 1]]);
  });

  it("[CR50-14] keeps account B leaveGroup lock/error/navigation untouched when stale account A resolves or rejects", async () => {
    const deferred = () => {
      let resolve;
      let reject;
      const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
      return { promise, resolve, reject };
    };
    let generation = 0;
    const reqA1 = deferred();
    const reqB1 = deferred();
    const reqA2 = deferred();
    const reqB2 = deferred();
    const leaveGroup = vi.fn()
      .mockImplementationOnce(() => reqA1.promise)
      .mockImplementationOnce(() => reqB1.promise)
      .mockImplementationOnce(() => reqA2.promise)
      .mockImplementationOnce(() => reqB2.promise);
    const { config } = loadDetail({ leaveGroup }, { getLoginGeneration: () => generation });
    const { navs } = installWx();
    const page = instantiate(config);

    // Case 1: Account A resolves while Account B has an in-flight leaveGroup
    await page.onLoad({ group_id: "group-1" });
    page.onLeaveTap();
    expect(page.data.loadingAction).toBe(true);

    generation = 1;
    await page.onShow();
    page.onLeaveTap();
    expect(page.data.loadingAction).toBe(true);

    reqA1.resolve({ statusCode: 204 });
    await flush();
    expect(page.data.loadingAction).toBe(true);
    expect(page.data.errorMessage).toBe("");
    expect(navs).toEqual([]);

    reqB1.resolve({ statusCode: 204 });
    await flush();
    expect(page.data.loadingAction).toBe(false);
    expect(navs).toEqual([["navigateBack", 1]]);

    // Case 2: Account A rejects while Account B has an in-flight leaveGroup
    page.onLeaveTap();
    expect(page.data.loadingAction).toBe(true);

    generation = 2;
    await page.onShow();
    page.onLeaveTap();
    expect(page.data.loadingAction).toBe(true);

    reqA2.reject(new Error("stale leave error"));
    await flush();
    expect(page.data.loadingAction).toBe(true);
    expect(page.data.errorMessage).toBe("");

    reqB2.resolve({ statusCode: 204 });
    await flush();
    expect(page.data.loadingAction).toBe(false);
    expect(navs).toEqual([["navigateBack", 1], ["navigateBack", 1]]);
  });
});
