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

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete globalThis[name];
    }
  }
});

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

function loadUnlocksPage({ unlocksResult, profileResult } = {}) {
  const wxStub = installWxStub();
  const config = capturePageConfig(UNLOCKS_JS, (id) => {
    if (id === "../../services/unlocks.js") {
      return { getMyUnlocks: () => Promise.resolve(unlocksResult) };
    }
    if (id === "../../services/profile.js") {
      return { getMyProfile: () => Promise.resolve(profileResult) };
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

  it("empty wxml has title, copy and 去预测 button without changing list fields", () => {
    const wxml = readFileSync(UNLOCKS_WXML, "utf8");
    const emptyBlock = wxml.match(/state === 'empty'[\s\S]*?(?=<view wx:elif)/)[0];
    expect(emptyBlock).toContain("暂无解锁记录");
    expect(emptyBlock).toContain("解锁按生涯积分达标后自动记录；已解锁记录不会因赛果修正而回收。");
    expect(emptyBlock).toContain('bindtap="onGoPredict"');
    expect(emptyBlock).toContain("去预测");
    expect(wxml).toMatch(/\{\{item\.label\}\}/);
    expect(wxml).toMatch(/\{\{item\.threshold_points\}\}/);
    expect(wxml).toMatch(/\{\{item\.unlockedText\}\}/);
    expect(wxml).toMatch(/\{\{item\.progressText\}\}/);
  });
});
