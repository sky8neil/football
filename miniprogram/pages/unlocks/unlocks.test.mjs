import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNLOCKS_JS = join(HERE, "unlocks.js");
const UNLOCKS_WXML = join(HERE, "unlocks.wxml");

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
const originalLocaleString = Date.prototype.toLocaleString;
const originalLocaleDateString = Date.prototype.toLocaleDateString;

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete globalThis[name];
    }
  }
  Date.prototype.toLocaleString = originalLocaleString;
  Date.prototype.toLocaleDateString = originalLocaleDateString;
});

function disableLocaleFormatting() {
  Date.prototype.toLocaleString = () => {
    throw new RangeError("locale data missing");
  };
  Date.prototype.toLocaleDateString = () => {
    throw new RangeError("locale data missing");
  };
}

function loadCommonJs(filePath, requireShim) {
  const source = readFileSync(filePath, "utf8");
  const moduleShim = { exports: {} };
  const factory = runInThisContext(`(function (module, exports, require) {\n${source}\n})`, {
    filename: filePath,
  });
  factory(moduleShim, moduleShim.exports, requireShim);
  return moduleShim.exports;
}

function capturePageConfig(filePath, requireShim) {
  let config = null;
  setGlobal("Page", (value) => {
    config = value;
  });
  loadCommonJs(filePath, requireShim);
  if (!config) throw new Error(`${filePath} 未调用 Page()`);
  return config;
}

function instantiate(config) {
  const page = Object.assign({}, config);
  page.data = JSON.parse(JSON.stringify(config.data || {}));
  page.setData = function setData(patch) {
    Object.assign(this.data, patch);
  };
  return page;
}

function installWxStub() {
  const navs = [];
  setGlobal("wx", {
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
  return { navs };
}

function loadUnlocksPage({ unlocksResult, profileResult, getMyUnlocks, getMyProfile, getLoginGeneration } = {}) {
  const wxStub = installWxStub();
  const unlocksFn = getMyUnlocks || (() => Promise.resolve(unlocksResult));
  const profileFn = getMyProfile || (() => Promise.resolve(profileResult));
  const config = capturePageConfig(UNLOCKS_JS, (id) => {
    if (id === "../../services/unlocks.js") {
      return { getMyUnlocks: unlocksFn };
    }
    if (id === "../../services/profile.js") {
      return { getMyProfile: profileFn };
    }
    if (id === "../../services/auth.js" && getLoginGeneration) {
      return { getLoginGeneration };
    }
    throw new Error(`Unexpected require: ${id}`);
  });
  const page = instantiate(config);
  return { page, ...wxStub };
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("unlocks empty state (UI-02)", () => {
  it("sets data.state to empty when unlocked is empty", async () => {
    const { page } = loadUnlocksPage({
      unlocksResult: { statusCode: 200, data: { unlocked: [] } },
      profileResult: { statusCode: 200, data: { career_points: 0 } },
    });
    page.onLoad();
    await flushMicrotasks();
    expect(page.data.state).toBe("empty");
  });

  it("recovers to the error state when loading rejects", async () => {
    const { page } = loadUnlocksPage({
      unlocksResult: Promise.reject(new Error("network")),
      profileResult: { statusCode: 200, data: { career_points: 0 } },
    });
    page.onLoad();
    await flushMicrotasks();
    expect(page.data.state).toBe("error");
    expect(page.data.errorMessage).toBe("网络异常，请重试");
  });

  it("onGoPredict calls wx.switchTab to /pages/matches/matches", () => {
    const { page, navs } = loadUnlocksPage({
      unlocksResult: { statusCode: 200, data: { unlocked: [] } },
      profileResult: { statusCode: 200, data: { career_points: 0 } },
    });
    page.onGoPredict();
    expect(navs).toContainEqual(["switchTab", "/pages/matches/matches"]);
    expect(navs.some(([kind]) => kind === "redirectTo" || kind === "navigateTo")).toBe(false);
  });

  it("keeps original label, threshold_points and progressText when records exist", async () => {
    const { page } = loadUnlocksPage({
      unlocksResult: {
        statusCode: 200,
        data: {
          unlocked: [
            {
              unlock_code: "profile_card_style_1",
              threshold_points: 30,
              unlocked_at: "2026-11-06T19:50:00.000Z",
            },
          ],
        },
      },
      profileResult: { statusCode: 200, data: { career_points: 50 } },
    });
    page.onLoad();
    await flushMicrotasks();
    expect(page.data.state).toBe("list");
    expect(page.data.items).toHaveLength(1);
    expect(page.data.items[0].label).toBe("资料卡样式 1");
    expect(page.data.items[0].threshold_points).toBe(30);
    expect(page.data.items[0].progressText).toBe("50/30");
  });

  it("formats unlocked_at as the Beijing date without locale APIs", async () => {
    disableLocaleFormatting();
    const { page } = loadUnlocksPage({
      unlocksResult: {
        statusCode: 200,
        data: {
          unlocked: [
            {
              unlock_code: "profile_card_style_1",
              threshold_points: 30,
              unlocked_at: "2026-11-06T19:50:00.000Z",
            },
          ],
        },
      },
      profileResult: { statusCode: 200, data: { career_points: 50 } },
    });
    page.onLoad();
    await flushMicrotasks();
    expect(page.data.items[0].unlockedText).toBe("2026/11/07");
  });

  it("empty wxml has title, copy and 去预测 button without changing list fields", () => {
    const wxml = readFileSync(UNLOCKS_WXML, "utf8");
    const emptyBlock = wxml.match(/state === 'empty'[\s\S]*?(?=<view wx:elif)/)[0];
    expect(emptyBlock).toContain("暂无解锁记录");
    expect(emptyBlock).toContain("解锁按生涯积分达标后自动记录；已解锁记录不会因赛果修正而回收。");
    expect(emptyBlock).toContain('bindtap="onGoPredict"');
    expect(emptyBlock).toContain("去预测");
    expect(wxml).not.toContain('class="page-header"');
    expect(wxml).not.toContain("已解锁</text>");
    expect(wxml).not.toMatch(/\{\{item\.progressText\}\}/);
    expect(wxml).toMatch(/\{\{item\.label\}\}/);
    expect(wxml).toMatch(/\{\{item\.threshold_points\}\}/);
    expect(wxml).toMatch(/解锁日期 \{\{item\.unlockedText\}\}/);
  });

  it("[A-S6-06][A-S6-08] uses Chinese 重试, adds 去登录 for unauthorized, guards requestSerial, and refreshes on onShow", async () => {
    const wxml = readFileSync(UNLOCKS_WXML, "utf8");
    expect(wxml).not.toMatch(/>\s*retry\s*</);
    expect(wxml.match(/bindtap="onRetry">重试<\/button>/g)).toHaveLength(3);
    const unauthBlock = wxml.match(/state === 'unauthorized'[\s\S]*?(?=<view wx:elif)/)[0];
    expect(unauthBlock).toContain('bindtap="onLoginTap"');
    expect(unauthBlock).toContain("去登录");

    let finishFirst;
    let generation = 0;
    let calls = 0;
    const getMyUnlocks = () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => { finishFirst = resolve; });
      }
      if (calls === 2) {
        return Promise.resolve({ statusCode: 401, code: "UNAUTHORIZED", message: "请先登录" });
      }
      return Promise.resolve({ statusCode: 200, data: { unlocked: [] } });
    };
    const getMyProfile = () => Promise.resolve({ statusCode: 200, data: { career_points: 0 } });
    const { page, navs } = loadUnlocksPage({
      getMyUnlocks,
      getMyProfile,
      getLoginGeneration: () => generation,
    });

    const first = page.onLoad();
    await page.onRetry();
    expect(page.data.state).toBe("unauthorized");

    finishFirst({
      statusCode: 200,
      data: { unlocked: [{ unlock_code: "profile_card_style_1", threshold_points: 30, unlocked_at: "2026-11-06T19:50:00.000Z" }] },
    });
    await first;
    expect(page.data.state).toBe("unauthorized");

    page.onLoginTap();
    expect(navs).toContainEqual(["navigateTo", "/pages/session/session?return_to=unlocks"]);

    await page.onShow();
    expect(page.data.state).toBe("empty");
    expect(calls).toBe(3);

    await page.onShow();
    expect(calls).toBe(3);

    generation = 1;
    await page.onShow();
    expect(calls).toBe(4);
  });

  it("[CR50-02] renders stadium background and unlocked milestone summary without locked checklist or raw svg", async () => {
    const wxml = readFileSync(UNLOCKS_WXML, "utf8");
    expect(wxml).toContain("/assets/images/baseline-pitch.webp");
    expect(wxml).toContain("dark-hero");
    expect(wxml).toContain("unlock-card");
    expect(wxml).toContain("已记录");
    expect(wxml).toContain("{{unlockedCount}}");
    expect(wxml).toContain("项里程碑");
    expect(wxml).not.toContain("is-locked");
    expect(wxml).not.toContain("lockedItems");
    expect(wxml).not.toContain("totalCount");
    expect(wxml).not.toContain("未达成");
    expect(wxml).not.toMatch(/<svg[\s>]/i);

    const { page } = loadUnlocksPage({
      unlocksResult: {
        statusCode: 200,
        data: {
          unlocked: [
            {
              unlock_code: "profile_card_style_1",
              threshold_points: 30,
              unlocked_at: "2026-11-06T19:50:00.000Z",
            },
          ],
        },
      },
      profileResult: { statusCode: 200, data: { career_points: 50 } },
    });
    await page.onLoad();
    expect(page.data.state).toBe("list");
    expect(page.data.unlockedCount).toBe(1);
    expect(page.data.items).toHaveLength(1);
    expect(page.data).not.toHaveProperty("lockedItems");
    expect(page.data).not.toHaveProperty("totalCount");
  });

  it("[CR50-02] displays non-hardcoded unlock_code verbatim and falls back to 0 when career_points is missing", async () => {
    const { page } = loadUnlocksPage({
      unlocksResult: {
        statusCode: 200,
        data: {
          unlocked: [
            {
              unlock_code: "profile_card_style_1",
              threshold_points: 30,
              unlocked_at: "2026-11-06T19:50:00.000Z",
            },
            {
              unlock_code: "season_honor_2027",
              threshold_points: 500,
              unlocked_at: "2026-11-07T02:00:00.000Z",
            },
          ],
        },
      },
      profileResult: { statusCode: 200, data: {} },
    });
    await page.onLoad();
    expect(page.data.state).toBe("list");
    expect(page.data.unlockedCount).toBe(2);
    expect(page.data.items[0].progressText).toBe("0/30");
    expect(page.data.items[0].progressText).not.toContain("undefined");
    expect(page.data.items[1]).toMatchObject({
      unlock_code: "season_honor_2027",
      label: "season_honor_2027",
      mapped: false,
      threshold_points: 500,
      progressText: "0/500",
    });
  });
});
