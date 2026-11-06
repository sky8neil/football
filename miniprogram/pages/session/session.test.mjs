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
function loadSessionPage({ result, stored = {}, nickname } = {}) {
  const storage = new Map(Object.entries(stored));
  const writes = [];
  const navs = [];
  const calls = [];

  setGlobal("wx", {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => {
      storage.set(key, value);
      writes.push([key, value]);
    },
    removeStorageSync: (key) => storage.delete(key),
    switchTab: ({ url }) => navs.push(["switchTab", url]),
    reLaunch: ({ url }) => navs.push(["reLaunch", url]),
    navigateBack: ({ delta }) => navs.push(["navigateBack", delta]),
  });

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
  return { page, calls, navs, writes, storage };
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
    // 🏆 是单个 code point、两个 UTF-16 单元；按 code point 计数应为 3。
    page.onNicknameInput({ detail: { value: "🏆".repeat(3) } });
    expect(page.data.overflow).toBe(false);
    expect(page.data.lengthText).toBe(`3/${NICKNAME_MAX_CHARS}`);
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
});
