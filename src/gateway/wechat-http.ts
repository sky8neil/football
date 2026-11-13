import type { WechatCode2SessionHttp } from "./wechat-login.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface WechatCode2SessionHttpOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  origin?: string;
}

function requestFailed(): Error {
  return new Error("wechat http request failed");
}

export function createWechatCode2SessionHttp(
  options: WechatCode2SessionHttpOptions = {},
): WechatCode2SessionHttp {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async getJson(url, query) {
      let target: URL;
      try {
        target = new URL(url);
        for (const [key, value] of Object.entries(query)) {
          target.searchParams.set(key, value);
        }
        if (options.origin !== undefined) {
          const origin = new URL(options.origin);
          target.protocol = origin.protocol;
          target.host = origin.host;
        }
      } catch {
        throw requestFailed();
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }

      try {
        const response = await fetchImpl(target, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw requestFailed();
        }
        try {
          return await response.json();
        } catch {
          throw requestFailed();
        }
      } catch (error) {
        if (error instanceof Error && error.message === "wechat http request failed") {
          throw error;
        }
        throw requestFailed();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
