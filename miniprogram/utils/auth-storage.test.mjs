import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "auth-storage.js"), "utf8");
const AUTH_SESSION_STORAGE_KEY = "auth_session";
const FUTURE = "2026-11-19T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

const originals = {
  wx: Object.getOwnPropertyDescriptor(globalThis, "wx"),
};

afterEach(() => {
  if (originals.wx) Object.defineProperty(globalThis, "wx", originals.wx);
  else delete globalThis.wx;
});

function loadStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = [];
  Object.defineProperty(globalThis, "wx", {
    configurable: true,
    writable: true,
    value: {
      getStorageSync: (key) => store.get(key),
      setStorageSync: (key, value) => {
        store.set(key, value);
        writes.push([key, value]);
      },
      removeStorageSync: (key) => {
        store.delete(key);
        writes.push(["remove", key]);
      },
    },
  });
  const module = { exports: {} };
  const factory = runInThisContext("(function(module, exports, require) {\n" + SOURCE + "\n})", {
    filename: "auth-storage.js",
  });
  factory(module, module.exports, () => {
    throw new Error("auth-storage.js 不应 require 其它模块");
  });
  return { storage: module.exports, store, writes };
}

describe("auth session cache", () => {
  it("writes token and UTC expiry, then reads them back", () => {
    const { storage, store, writes } = loadStorage();
    expect(storage.writeAuthSession({ access_token: " opaque-token ", expires_at: FUTURE })).toBe(true);
    expect(writes).toEqual([[AUTH_SESSION_STORAGE_KEY, { access_token: "opaque-token", expires_at: FUTURE }]]);
    expect(storage.readAuthSession()).toEqual({ access_token: "opaque-token", expires_at: FUTURE });
    expect(store.get(AUTH_SESSION_STORAGE_KEY)).toEqual({ access_token: "opaque-token", expires_at: FUTURE });
  });

  it("treats a future expiry as active and a past expiry as expired", () => {
    const { storage } = loadStorage();
    expect(storage.isAuthSessionActive({ access_token: "opaque-token", expires_at: FUTURE }, new Date("2026-11-12T00:00:00.000Z"))).toBe(true);
    expect(storage.isAuthSessionActive({ access_token: "opaque-token", expires_at: PAST }, new Date("2026-11-12T00:00:00.000Z"))).toBe(false);
    expect(storage.isAuthSessionActive({ access_token: "opaque-token", expires_at: FUTURE }, new Date(FUTURE))).toBe(false);
  });

  it("rejects blank tokens and invalid expiry", () => {
    const { storage, writes } = loadStorage();
    expect(storage.writeAuthSession({ access_token: "   ", expires_at: FUTURE })).toBe(false);
    expect(storage.writeAuthSession({ access_token: "opaque-token", expires_at: "not-a-date" })).toBe(false);
    expect(storage.writeAuthSession(null)).toBe(false);
    expect(writes).toEqual([]);
    expect(storage.readAuthSession()).toBeNull();
  });

  it("clears the cached session", () => {
    const { storage, store } = loadStorage({
      [AUTH_SESSION_STORAGE_KEY]: { access_token: "opaque-token", expires_at: FUTURE },
    });
    storage.clearAuthSession();
    expect(store.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    expect(storage.readAuthSession()).toBeNull();
  });
});
