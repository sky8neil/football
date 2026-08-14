import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

/**
 * D-P0 TDD：U1–U5（开发文档 §8.2）。
 *
 * miniprogram 源码是 CommonJS，而仓库根 package.json 为 "type": "module"，
 * Node/vitest 无法直接 import 该 .js；这里用 vm 按原样加载真实文件，
 * 避免「镜像副本」失真，也无需改动小程序源码模块格式。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "predictions.js"), "utf8");

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function loadPredictions() {
  const moduleShim = { exports: {} };
  const requireShim = (id) => {
    if (id === "./api.js") {
      // createUuidV4 不依赖 request；仅满足模块顶层 require。
      return { request() {} };
    }
    throw new Error(`Unexpected require: ${id}`);
  };
  const factory = runInThisContext(
    `(function (module, exports, require) {\n${SOURCE}\n})`,
    { filename: "predictions.js" },
  );
  factory(moduleShim, moduleShim.exports, requireShim);
  return moduleShim.exports;
}

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const originalWx = Object.getOwnPropertyDescriptor(globalThis, "wx");

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

afterEach(() => {
  if (originalCrypto) {
    Object.defineProperty(globalThis, "crypto", originalCrypto);
  } else {
    delete globalThis.crypto;
  }
  if (originalWx) {
    Object.defineProperty(globalThis, "wx", originalWx);
  } else {
    delete globalThis.wx;
  }
});

describe("D-P0 createUuidV4", () => {
  it("U1: 返回 lowercase 8-4-4-4-12 且 version=4 / variant=10xx 的合法 UUID v4", () => {
    const { createUuidV4 } = loadPredictions();
    for (let i = 0; i < 100; i += 1) {
      expect(createUuidV4()).toMatch(UUID_V4_RE);
    }
  });

  it("U2: 连续 1000 次无碰撞", () => {
    const { createUuidV4 } = loadPredictions();
    const seen = new Set();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(createUuidV4());
    }
    expect(seen.size).toBe(1000);
  });

  it("U3: 存在 crypto.randomUUID 时优先并直接返回其结果", () => {
    const { createUuidV4 } = loadPredictions();
    const fixed = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let randomUuidCalls = 0;
    let getRandomValuesCalls = 0;
    setGlobal("crypto", {
      randomUUID() {
        randomUuidCalls += 1;
        return fixed;
      },
      getRandomValues() {
        getRandomValuesCalls += 1;
        throw new Error("U3: 不应走到 getRandomValues");
      },
    });
    expect(createUuidV4()).toBe(fixed);
    expect(randomUuidCalls).toBe(1);
    expect(getRandomValuesCalls).toBe(0);
  });

  it("U4: 仅存在同步形态 crypto.getRandomValues 时就地填充 Uint8Array(16)", () => {
    const { createUuidV4 } = loadPredictions();
    let seenArrays = [];
    setGlobal("crypto", {
      getRandomValues(array) {
        seenArrays.push(array);
        array.fill(0xab);
        return array;
      },
    });
    const uuid = createUuidV4();
    expect(uuid).toBe("abababab-abab-4bab-abab-abababababab");
    expect(uuid).toMatch(UUID_V4_RE);
    expect(seenArrays).toHaveLength(1);
    expect(seenArrays[0]).toBeInstanceOf(Uint8Array);
    expect(seenArrays[0]).toHaveLength(16);
  });

  it("U5: 无 crypto 且 wx.getRandomValues 为异步/抛错形态时，仍同步返回合法 UUID 且不调用错误签名", () => {
    const { createUuidV4 } = loadPredictions();
    let wxGetRandomValuesCalls = 0;
    setGlobal("crypto", undefined);
    setGlobal("wx", {
      getRandomValues() {
        wxGetRandomValuesCalls += 1;
        throw new Error("wx.getRandomValues 是异步 Object 参数形态，不可同步调用");
      },
    });
    const uuid = createUuidV4();
    expect(typeof uuid).toBe("string");
    expect(uuid).toMatch(UUID_V4_RE);
    expect(wxGetRandomValuesCalls).toBe(0);
  });

  it("U2-fallback: 无 crypto 且 wx 异步形态下，连续 1000 次仍无碰撞（混合熵兜底）", () => {
    const { createUuidV4 } = loadPredictions();
    setGlobal("crypto", undefined);
    setGlobal("wx", {
      getRandomValues() {
        throw new Error("async-only");
      },
    });
    const seen = new Set();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(createUuidV4());
    }
    expect(seen.size).toBe(1000);
  });
});
