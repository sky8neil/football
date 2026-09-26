import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

/**
 * 首页第一行（品牌行）昵称 —— 2026-09-26 需求：
 *   1) 写死的「用户ID」改为登录用户的微信昵称；
 *   2) 文案一行连写「昵称，今天看哪场？」，标点用中文全角；
 *   3) 连带修掉会话页跳首页用了 wx.redirectTo 的问题（tabBar 页面只能用 switchTab）。
 *
 * miniprogram 源码是 CommonJS，而仓库根 package.json 为 "type": "module"，
 * Node/vitest 无法直接 import 该 .js；沿用 predictions.uuid.test.mjs 的做法，
 * 用 vm 按原样加载真实文件（含被 require 的 utils/nickname.js），避免「镜像副本」失真。
 */

const HERE = dirname(fileURLToPath(import.meta.url)); // pages/matches
const SESSION_JS = join(HERE, "..", "session", "session.js");
const NICKNAME_JS = join(HERE, "..", "..", "utils", "nickname.js");

/** 规格常量：与源码及各页面约定一致，故意在测试里写死，改动会被立刻发现。 */
const NICKNAME_STORAGE_KEY = "nickname";
const FALLBACK_NICKNAME = "球友";
const HOME_URL = "/pages/matches/matches";

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

const originals = {
  Page: Object.getOwnPropertyDescriptor(globalThis, "Page"),
  wx: Object.getOwnPropertyDescriptor(globalThis, "wx"),
};

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete globalThis[name];
    }
  }
});

/** 按原样执行一个 CommonJS 源文件，返回其 module.exports。 */
function loadCommonJs(filePath, requireShim) {
  const source = readFileSync(filePath, "utf8");
  const moduleShim = { exports: {} };
  const factory = runInThisContext(`(function (module, exports, require) {\n${source}\n})`, {
    filename: filePath,
  });
  factory(moduleShim, moduleShim.exports, requireShim);
  return moduleShim.exports;
}

/** 加载真实的 utils/nickname.js（读、写两处的唯一真相）。 */
function loadNicknameUtil() {
  return loadCommonJs(NICKNAME_JS, (id) => {
    throw new Error(`utils/nickname.js 不应 require 任何模块，实际 require: ${id}`);
  });
}

/** 桩掉 wx，并记录 storage 读写与页面跳转，便于断言。 */
function installWxStub({ stored } = {}) {
  const reads = [];
  const writes = [];
  const navs = [];
  setGlobal("wx", {
    getStorageSync(key) {
      reads.push(key);
      return stored;
    },
    setStorageSync(key, value) {
      writes.push([key, value]);
    },
    switchTab(options) {
      navs.push(["switchTab", options && options.url]);
    },
    redirectTo(options) {
      navs.push(["redirectTo", options && options.url]);
    },
    navigateTo(options) {
      navs.push(["navigateTo", options && options.url]);
    },
  });
  return { reads, writes, navs };
}

/** 捕获页面文件的 Page(config) 参数。 */
function capturePageConfig(filePath, requireShim) {
  let config = null;
  setGlobal("Page", (value) => {
    config = value;
  });
  loadCommonJs(filePath, requireShim);
  if (!config) throw new Error(`${filePath} 未调用 Page()`);
  return config;
}

/** 用 config 建一个最小可用的页面实例。 */
function instantiate(config, overrides = {}) {
  const page = Object.assign({}, config);
  page.data = JSON.parse(JSON.stringify(config.data || {}));
  page.setData = function setData(patch) {
    Object.assign(this.data, patch);
  };
  return Object.assign(page, overrides);
}

/** 加载首页并执行 onLoad。 */
function loadHomePage({ stored } = {}) {
  const wxStub = installWxStub({ stored });
  const config = capturePageConfig(join(HERE, "matches.js"), (id) => {
    if (id === "../../utils/logo-registry.js") {
      return {
        getTeamLogo: () => "team-placeholder.png",
        getLeagueLogo: () => "league-placeholder.png",
      };
    }
    if (id === "../../utils/nickname.js") return loadNicknameUtil();
    throw new Error(`Unexpected require: ${id}`);
  });
  const page = instantiate(config, { loadFirstPage() {} });
  page.onLoad.call(page);
  return { page, ...wxStub };
}

/** 加载会话页，initSession 固定返回给定结果。 */
function loadSessionPage({ result } = {}) {
  const wxStub = installWxStub();
  const config = capturePageConfig(SESSION_JS, (id) => {
    if (id === "../../services/session.js") {
      return { initSession: () => Promise.resolve(result) };
    }
    if (id === "../../utils/nickname.js") return loadNicknameUtil();
    throw new Error(`Unexpected require: ${id}`);
  });
  return { page: instantiate(config), ...wxStub };
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("utils/nickname.js 昵称读写", () => {
  it("N1: normalizeNickname 去掉首尾空白", () => {
    const { normalizeNickname } = loadNicknameUtil();
    expect(normalizeNickname("  Sky  ")).toBe("Sky");
  });

  it("N2: normalizeNickname 对非字符串与纯空白返回 null", () => {
    const { normalizeNickname } = loadNicknameUtil();
    for (const value of ["", "   ", "\n\t", undefined, null, 42, {}, []]) {
      expect(normalizeNickname(value)).toBeNull();
    }
  });

  it("N3: resolveNickname 读 nickname key，缺失时回落兜底文案", () => {
    const { resolveNickname } = loadNicknameUtil();
    const { reads } = installWxStub({ stored: undefined });
    expect(resolveNickname()).toBe(FALLBACK_NICKNAME);
    expect(reads).toContain(NICKNAME_STORAGE_KEY);
  });

  it("N4: storeNickname 归一化后写入 nickname key", () => {
    const { storeNickname } = loadNicknameUtil();
    const { writes } = installWxStub({});
    expect(storeNickname("  Sky  ")).toBe(true);
    expect(writes).toEqual([[NICKNAME_STORAGE_KEY, "Sky"]]);
  });

  it("N5: storeNickname 拒绝空值，不污染缓存（首页会回落兜底文案）", () => {
    const { storeNickname } = loadNicknameUtil();
    const { writes } = installWxStub({});
    expect(storeNickname("   ")).toBe(false);
    expect(storeNickname(undefined)).toBe(false);
    expect(writes).toEqual([]);
  });

  it("N6: 首页读与会话页写用的是同一个 key（防两处各写一份而漂移）", () => {
    const { NICKNAME_STORAGE_KEY: key } = loadNicknameUtil();
    expect(key).toBe(NICKNAME_STORAGE_KEY);
    const sessionSource = readFileSync(SESSION_JS, "utf8");
    const matchesSource = readFileSync(join(HERE, "matches.js"), "utf8");
    expect(sessionSource).toContain("utils/nickname.js");
    expect(matchesSource).toContain("utils/nickname.js");
  });
});

describe("首页品牌行昵称", () => {
  it("B1: data 里有 nickname 字段，用于渲染第一行", () => {
    const { page } = loadHomePage({ stored: "Sky" });
    expect(Object.prototype.hasOwnProperty.call(page.data, "nickname")).toBe(true);
  });

  it("B2: 本地缓存有昵称时取缓存值", () => {
    const { page } = loadHomePage({ stored: "Sky" });
    expect(page.data.nickname).toBe("Sky");
  });

  it("B3: 读取缓存用的 key 是 nickname", () => {
    const { reads } = loadHomePage({ stored: "Sky" });
    expect(reads).toContain(NICKNAME_STORAGE_KEY);
  });

  it("B4: 缓存缺失时用兜底文案", () => {
    const { page } = loadHomePage({ stored: undefined });
    expect(page.data.nickname).toBe(FALLBACK_NICKNAME);
  });

  it("B5: 缓存为空字符串时用兜底文案", () => {
    const { page } = loadHomePage({ stored: "" });
    expect(page.data.nickname).toBe(FALLBACK_NICKNAME);
  });

  it("B6: 缓存为纯空白时用兜底文案（服务端也不接受空白昵称）", () => {
    const { page } = loadHomePage({ stored: "   " });
    expect(page.data.nickname).toBe(FALLBACK_NICKNAME);
  });

  it("B7: 缓存值首尾空白会被 trim 后再展示", () => {
    const { page } = loadHomePage({ stored: "  Sky  " });
    expect(page.data.nickname).toBe("Sky");
  });

  it("B8: 缓存值是脏数据时用兜底文案，不得渲染成 [object Object]", () => {
    const { page } = loadHomePage({ stored: { name: "Sky" } });
    expect(page.data.nickname).toBe(FALLBACK_NICKNAME);
  });

  it("B9: 昵称不再写死为「用户ID」", () => {
    const { page } = loadHomePage({ stored: "Sky" });
    expect(page.data.nickname).toBe("Sky");
    const { page: fallbackPage } = loadHomePage({ stored: "" });
    expect(fallbackPage.data.nickname).not.toBe("用户ID");
  });
});

describe("会话页：昵称落库 + 跳首页改用 switchTab", () => {
  it("S1: initSession 201 成功时，把服务端返回的昵称（trim 后）写入缓存", async () => {
    const { page, writes } = loadSessionPage({
      result: { statusCode: 201, data: { nickname: "  Sky  " } },
    });
    page.onSubmit();
    await flushMicrotasks();
    expect(writes).toEqual([[NICKNAME_STORAGE_KEY, "Sky"]]);
  });

  it("S2: 200（老用户）同样写入昵称", async () => {
    const { page, writes } = loadSessionPage({
      result: { statusCode: 200, data: { nickname: "Sky" } },
    });
    page.onSubmit();
    await flushMicrotasks();
    expect(writes).toEqual([[NICKNAME_STORAGE_KEY, "Sky"]]);
  });

  it("S3: 成功但响应没带昵称时不写缓存，首页保持兜底文案", async () => {
    const { page, writes } = loadSessionPage({ result: { statusCode: 201, data: {} } });
    page.onSubmit();
    await flushMicrotasks();
    expect(writes).toEqual([]);
  });

  it("S4: 用 switchTab 跳首页（tabBar 页面），不能用 redirectTo/navigateTo", async () => {
    const { page, navs } = loadSessionPage({
      result: { statusCode: 201, data: { nickname: "Sky" } },
    });
    page.onSubmit();
    await flushMicrotasks();
    expect(navs).toContainEqual(["switchTab", HOME_URL]);
    expect(navs.some(([kind]) => kind === "redirectTo" || kind === "navigateTo")).toBe(false);
  });

  it("S5: 跳过登录同样走 switchTab", () => {
    const { page, navs } = loadSessionPage({ result: undefined });
    page.onSkip();
    expect(navs).toContainEqual(["switchTab", HOME_URL]);
  });

  it("S6: 会话页源码里不应再出现 redirectTo / navigateTo 的调用（注释提及不算）", () => {
    const source = readFileSync(SESSION_JS, "utf8");
    expect(source).not.toMatch(/wx\.(redirectTo|navigateTo)\s*\(/);
  });

  it("S7: 失败响应（429）不写缓存也不跳转", async () => {
    const { page, writes, navs } = loadSessionPage({
      result: { statusCode: 429, code: "RATE_LIMITED" },
    });
    page.onSubmit();
    await flushMicrotasks();
    expect(writes).toEqual([]);
    expect(navs).toEqual([]);
    expect(page.data.errorMessage).toBe("请稍后重试");
  });
});
