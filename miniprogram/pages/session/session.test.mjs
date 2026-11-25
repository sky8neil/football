import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SESSION_JS = join(HERE, "session.js");
const NICKNAME_JS = join(ROOT, "utils", "nickname.js");
const NICKNAME_MAX_CHARS = 32;

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
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function loadModule(filePath, requireShim) {
  const module = { exports: {} };
  const factory = runInThisContext("(function(module, exports, require) {\n" + readFileSync(filePath, "utf8") + "\n})", {
    filename: filePath,
  });
  factory(module, module.exports, requireShim);
  return module.exports;
}

/** 会话页测试夹具：真实 nickname 工具 + 可断言的 wx / 服务桩。 */
function loadSessionPage({ result, stored = {}, nickname, privacy: privacyOptions } = {}) {
  const storage = new Map(Object.entries(stored));
  const writes = [];
  const navs = [];
  const calls = [];
  const privacy = {
    getCalls: 0,
    openCalls: 0,
    offCalls: [],
    handler: null,
    needAuthorization: privacyOptions?.needAuthorization,
    contractName: privacyOptions?.contractName,
    supported: privacyOptions?.supported !== false,
  };

  const wxStub = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => {
      storage.set(key, value);
      writes.push([key, value]);
    },
    removeStorageSync: (key) => storage.delete(key),
    switchTab: ({ url }) => navs.push(["switchTab", url]),
    reLaunch: ({ url }) => navs.push(["reLaunch", url]),
    navigateBack: ({ delta }) => navs.push(["navigateBack", delta]),
    openPrivacyContract: (options) => {
      privacy.openCalls += 1;
      if (options && typeof options.success === "function") options.success({});
    },
  };
  // 模拟低版本基础库：连隐私接口都不存在，页面不能因此报错。
  if (privacy.supported) {
    wxStub.getPrivacySetting = (options) => {
      privacy.getCalls += 1;
      const res = privacy.needAuthorization === undefined
        ? {}
        : { needAuthorization: privacy.needAuthorization, privacyContractName: privacy.contractName };
      if (options && typeof options.success === "function") options.success(res);
    };
    wxStub.onNeedPrivacyAuthorization = (handler) => {
      privacy.handler = handler;
    };
    wxStub.offNeedPrivacyAuthorization = (handler) => {
      privacy.offCalls.push(handler);
    };
  }
  setGlobal("wx", wxStub);

  const nicknameUtil = loadModule(NICKNAME_JS, () => {
    throw new Error("utils/nickname.js 不应再 require 其它模块");
  });
  const sessionService = {
    initSession: (value) => {
      calls.push(value);
      return Promise.resolve(result);
    },
  };

  let config;
  setGlobal("Page", (value) => {
    config = value;
  });
  loadModule(SESSION_JS, (id) => {
    if (id === "../../services/session.js") return sessionService;
    if (id === "../../utils/nickname.js") return nicknameUtil;
    throw new Error(`Unexpected require: ${id}`);
  });

  const page = Object.assign({}, config, {
    data: JSON.parse(JSON.stringify(config.data || {})),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  });
  if (nickname !== undefined) page.setData({ nickname });
  return { page, calls, navs, writes, storage, privacy };
}

describe("会话页：昵称输入与本地校验", () => {
  it("空昵称不发请求，只给提示", async () => {
    const { page, calls, navs } = loadSessionPage({ result: { statusCode: 201, data: { nickname: "Sky" } } });
    page.onSubmit();
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(navs).toEqual([]);
    expect(page.data.errorMessage).toBe("先填个昵称，球友们才好认出你");
    expect(page.data.loading).toBe(false);
  });

  it("纯空白昵称按空处理", async () => {
    const { page, calls } = loadSessionPage({
      result: { statusCode: 201, data: { nickname: "Sky" } },
      nickname: "    ",
    });
    page.onSubmit();
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(page.data.errorMessage).toBe("先填个昵称，球友们才好认出你");
  });

  it("超过 32 个字符在本地拦截，不发请求", async () => {
    const { page, calls } = loadSessionPage({
      result: { statusCode: 201, data: { nickname: "Sky" } },
      nickname: "阿".repeat(NICKNAME_MAX_CHARS + 1),
    });
    page.onSubmit();
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(page.data.errorMessage).toBe(`昵称最多 ${NICKNAME_MAX_CHARS} 个字符`);
  });

  it("32 个字符是允许的上界，且提交前会 trim", async () => {
    const atLimit = "阿".repeat(NICKNAME_MAX_CHARS);
    const { page, calls } = loadSessionPage({
      result: { statusCode: 201, data: { nickname: atLimit } },
      nickname: `  ${atLimit}  `,
    });
    page.onSubmit();
    await Promise.resolve();
    expect(calls).toEqual([atLimit]);
  });

  it("emoji 按一个字符计数（不因代理对算成两个）", () => {
    const { page } = loadSessionPage({ result: undefined });
    // 🏆 是一个 grapheme、两个 UTF-16 单元。
    page.onNicknameInput({ detail: { value: "🏆".repeat(3) } });
    expect(page.data.overflow).toBe(false);
    expect(page.data.lengthText).toBe(`3/${NICKNAME_MAX_CHARS}`);
  });

  it("Intl.Segmenter 可用时按 grapheme 计数，32 个组合 emoji 放行、33 个本地拦截", async () => {
    expect(typeof Intl.Segmenter).toBe("function");
    const grapheme = "👩‍💻";
    const atLimit = grapheme.repeat(NICKNAME_MAX_CHARS);
    const { page, calls } = loadSessionPage({
      result: { statusCode: 201, data: { nickname: atLimit } },
    });
    page.onNicknameInput({ detail: { value: grapheme.repeat(3) } });
    expect(page.data.overflow).toBe(false);
    expect(page.data.lengthText).toBe(`3/${NICKNAME_MAX_CHARS}`);
    page.setData({ nickname: `  ${atLimit}  ` });
    page.onSubmit();
    await Promise.resolve();
    expect(calls).toEqual([atLimit]);

    const blocked = loadSessionPage({
      result: { statusCode: 201, data: { nickname: "Sky" } },
      nickname: grapheme.repeat(NICKNAME_MAX_CHARS + 1),
    });
    blocked.page.onSubmit();
    await Promise.resolve();
    expect(blocked.calls).toEqual([]);
    expect(blocked.page.data.errorMessage).toBe(`昵称最多 ${NICKNAME_MAX_CHARS} 个字符`);
  });

  it("没有 Intl.Segmenter 时不因长度拒绝提交，交给服务端校验", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Object.defineProperty(Intl, "Segmenter", { configurable: true, writable: true, value: undefined });
    try {
      const nickname = "阿".repeat(NICKNAME_MAX_CHARS + 1);
      const message = "nickname 长度必须为 1～32 个 Unicode grapheme";
      const { page, calls } = loadSessionPage({
        result: { statusCode: 422, code: "VALIDATION_ERROR", message },
        nickname,
      });
      page.onNicknameInput({ detail: { value: nickname } });
      expect(page.data.overflow).toBe(false);
      expect(page.data.lengthText).toBe("");
      page.onSubmit();
      await Promise.resolve();
      expect(calls).toEqual([nickname]);
      expect(page.data.errorMessage).toBe(message);
      expect(page.data.loading).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(Intl, "Segmenter", descriptor);
      else delete Intl.Segmenter;
    }
  });

  it("输入时实时更新计数，超长置 overflow 并清除旧错误", () => {
    const { page } = loadSessionPage({ result: undefined });
    page.setData({ errorMessage: "旧错误" });
    page.onNicknameInput({ detail: { value: "Sky" } });
    expect(page.data.lengthText).toBe(`3/${NICKNAME_MAX_CHARS}`);
    expect(page.data.overflow).toBe(false);
    expect(page.data.errorMessage).toBe("");
    page.onNicknameInput({ detail: { value: "阿".repeat(NICKNAME_MAX_CHARS + 1) } });
    expect(page.data.overflow).toBe(true);
  });

  it("onClear 清空输入并复位计数", () => {
    const { page } = loadSessionPage({ result: undefined, nickname: "Sky" });
    page.onClear();
    expect(page.data.nickname).toBe("");
    expect(page.data.lengthText).toBe("");
    expect(page.data.overflow).toBe(false);
  });
});

describe("会话页：缓存回填", () => {
  it("缓存有昵称时回填，并显示计数", () => {
    const { page } = loadSessionPage({ result: undefined, stored: { nickname: "  Sky  " } });
    page.onLoad({});
    expect(page.data.nickname).toBe("Sky");
    expect(page.data.lengthText).toBe(`3/${NICKNAME_MAX_CHARS}`);
  });

  it("缓存为空时不回填，也不覆盖已输入内容", () => {
    const { page } = loadSessionPage({ result: undefined, nickname: "手输的" });
    page.onLoad({});
    expect(page.data.nickname).toBe("手输的");
    expect(page.data.lengthText).toBe("");
  });

  it("带 return_to=match-detail 时记录返回目标", () => {
    const { page } = loadSessionPage({ result: undefined });
    page.onLoad({ return_to: "match-detail" });
    expect(page.data.returnTo).toBe("match-detail");
    page.onLoad({ return_to: "other" });
    expect(page.data.returnTo).toBe("");
  });

  it("带 return_to=share-card 时记录返回目标", () => {
    const { page } = loadSessionPage({ result: undefined });
    page.onLoad({ return_to: "share-card" });
    expect(page.data.returnTo).toBe("share-card");
  });

  it("带 return_to=my-predictions 时记录返回目标", () => {
    const { page } = loadSessionPage({ result: undefined });
    page.onLoad({ return_to: "my-predictions" });
    expect(page.data.returnTo).toBe("my-predictions");
  });

  it.each(["groups", "group-detail", "settings", "unlocks"])("[CR-26] 支持 return_to=%s 记录返回目标", (target) => {
    const { page } = loadSessionPage({ result: undefined });
    page.onLoad({ return_to: target });
    expect(page.data.returnTo).toBe(target);
  });
});

describe("会话页：登录成功后的返回", () => {
  it("return_to=share-card 登录成功后 navigateBack，不 switchTab 回首页", async () => {
    const { page, navs } = loadSessionPage({
      result: { statusCode: 201, data: { nickname: "Sky" } },
      nickname: "Sky",
    });
    page.onLoad({ return_to: "share-card" });
    page.onSubmit();
    await Promise.resolve();
    expect(navs).toContainEqual(["navigateBack", 1]);
    expect(navs.some(([kind]) => kind === "switchTab")).toBe(false);
  });

  it("return_to=my-predictions 登录成功后 navigateBack，不 switchTab 回首页", async () => {
    const { page, navs } = loadSessionPage({
      result: { statusCode: 201, data: { nickname: "Sky" } },
      nickname: "Sky",
    });
    page.onLoad({ return_to: "my-predictions" });
    page.onSubmit();
    await Promise.resolve();
    expect(navs).toEqual([["navigateBack", 1]]);
  });

  it("存在残留 pending_group_invite_code 时 return_to=share-card 仍优先 navigateBack 且不消费邀请码", async () => {
    const { page, navs, storage } = loadSessionPage({
      result: { statusCode: 201, data: { nickname: "Sky" } },
      stored: { pending_group_invite_code: "INVITE123" },
      nickname: "Sky",
    });
    page.onLoad({ return_to: "share-card" });
    page.onSubmit();
    await Promise.resolve();
    expect(navs).toEqual([["navigateBack", 1]]);
    expect(storage.get("pending_group_invite_code")).toBe("INVITE123");
  });

  it("[CR-26] return_to 触发 navigateBack 失败（无上游栈）时兜底 switchTab 回首页", async () => {
    const { page, navs } = loadSessionPage({
      result: { statusCode: 201, data: { nickname: "Sky" } },
      nickname: "Sky",
    });
    const origNavBack = wx.navigateBack;
    wx.navigateBack = (opts) => {
      navs.push(["navigateBack", opts.delta]);
      opts.fail && opts.fail();
    };
    try {
      page.onLoad({ return_to: "settings" });
      await page.onSubmit();
      expect(navs).toEqual([
        ["navigateBack", 1],
        ["switchTab", "/pages/matches/matches"],
      ]);
    } finally {
      wx.navigateBack = origNavBack;
    }
  });

  it("onSkip 清除残留 pending_group_invite_code 并回到首页", () => {
    const { page, navs, storage } = loadSessionPage({
      result: undefined,
      stored: { pending_group_invite_code: "INVITE123" },
    });
    page.onLoad({});
    page.onSkip();
    expect(storage.has("pending_group_invite_code")).toBe(false);
    expect(navs).toEqual([["switchTab", "/pages/matches/matches"]]);
  });
});

describe("会话页：隐私授权", () => {
  it("需要授权时主动弹卡，并用后台配置的协议名", () => {
    const { page, privacy } = loadSessionPage({
      result: undefined,
      privacy: { needAuthorization: true, contractName: "《赛事预言家隐私保护指引》" },
    });
    page.onLoad({});
    expect(privacy.getCalls).toBe(1);
    expect(page.data.showPrivacy).toBe(true);
    expect(page.data.privacyContractName).toBe("《赛事预言家隐私保护指引》");
  });

  it("已同意过就不再打扰", () => {
    const { page } = loadSessionPage({ result: undefined, privacy: { needAuthorization: false } });
    page.onLoad({});
    expect(page.data.showPrivacy).toBe(false);
  });

  it("协议名缺失时回落到兜底名称，不出现空书名号", () => {
    const { page } = loadSessionPage({ result: undefined, privacy: { needAuthorization: true } });
    page.onLoad({});
    expect(page.data.privacyContractName).toBe("《小程序用户隐私保护指引》");
  });

  it("低版本基础库没有隐私接口时不报错、不弹卡", () => {
    const { page } = loadSessionPage({ result: undefined, privacy: { supported: false } });
    expect(() => page.onLoad({})).not.toThrow();
    expect(page.data.showPrivacy).toBe(false);
  });

  it("同意后关闭弹卡，并把 resolve 交还给微信", () => {
    const { page, privacy } = loadSessionPage({ result: undefined, privacy: { needAuthorization: true } });
    page.onLoad({});
    const resolved = [];
    privacy.handler((payload) => resolved.push(payload), { referrer: "input" });
    page.onAgreePrivacy();
    expect(page.data.showPrivacy).toBe(false);
    expect(page.data.privacyRejected).toBe(false);
    expect(resolved).toEqual([{ buttonId: "privacy-agree-btn", event: "agree" }]);
  });

  it("拒绝后关闭弹卡并记录状态，仍然允许手动输入昵称", () => {
    const { page, privacy } = loadSessionPage({ result: undefined, privacy: { needAuthorization: true } });
    page.onLoad({});
    const resolved = [];
    privacy.handler((payload) => resolved.push(payload), { referrer: "input" });
    page.onRejectPrivacy();
    expect(page.data.showPrivacy).toBe(false);
    expect(page.data.privacyRejected).toBe(true);
    expect(resolved[0].event).toBe("disagree");
    page.onSubmit();
    expect(page.data.errorMessage).toBe("先填个昵称，球友们才好认出你");
  });

  it("其它隐私接口触发时改用同一张卡承接", () => {
    const { page, privacy } = loadSessionPage({ result: undefined, privacy: { needAuthorization: false } });
    page.onLoad({});
    expect(privacy.handler).toBeTypeOf("function");
    privacy.handler(() => {}, { referrer: "getUserProfile" });
    expect(page.data.showPrivacy).toBe(true);
  });

  it("页面卸载时注销监听，避免残留旧的 resolve", () => {
    const { page, privacy } = loadSessionPage({ result: undefined, privacy: { needAuthorization: true } });
    page.onLoad({});
    page.onUnload();
    expect(privacy.offCalls).toHaveLength(1);
    expect(page._privacyResolve).toBeNull();
  });

  it("点协议链接走官方 openPrivacyContract", () => {
    const { page, privacy } = loadSessionPage({ result: undefined, privacy: { needAuthorization: true } });
    page.onLoad({});
    page.onOpenPrivacyContract();
    expect(privacy.openCalls).toBe(1);
  });

  it("[A-S1-07] initSession 抛错或 reject 时必须复位 loading=false 并开放重试", async () => {
    const originalPage = globalThis.Page;
    const originalWx = globalThis.wx;
    for (const impl of [
      () => Promise.reject(new Error("request timeout")),
      () => { throw new Error("sync failure"); },
    ]) {
      let config;
      setGlobal("wx", {
        getStorageSync: () => undefined,
        setStorageSync: () => {},
        removeStorageSync: () => {},
        switchTab: () => {},
        reLaunch: () => {},
        navigateBack: () => {},
      });
      setGlobal("Page", (value) => { config = value; });
      const nicknameUtil = loadModule(NICKNAME_JS, () => { throw new Error("unexpected"); });
      loadModule(SESSION_JS, (id) => {
        if (id === "../../services/session.js") return { initSession: impl };
        if (id === "../../utils/nickname.js") return nicknameUtil;
        throw new Error(`Unexpected require: ${id}`);
      });
      const page = Object.assign({}, config, {
        data: JSON.parse(JSON.stringify(config.data || {})),
        setData(patch) { Object.assign(this.data, patch); },
      });
      page.setData({ nickname: "Sky" });
      await page.onSubmit();
      expect(page.data.loading).toBe(false);
      expect(page.data.canRetry).toBe(true);
      expect(page.data.errorMessage).toBeTruthy();
    }
    if (originalPage) setGlobal("Page", originalPage.value);
    if (originalWx) setGlobal("wx", originalWx.value);
  });
});
