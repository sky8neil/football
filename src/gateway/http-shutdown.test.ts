import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGatewayEntrypoint, shutdownGatewayServer, startGatewayServer } from "./http.js";

const MEMORY_ENV = {
  FOOTBALL_ENVIRONMENT: "dev",
  FOOTBALL_MATCH_CURSOR_SECRET: "http-shutdown-test-secret",
  FOOTBALL_REPOSITORY_BACKEND: "memory",
  FOOTBALL_MOCK_TRUSTED_OPENID: "http-shutdown-test-user",
};

const POSTGRES_ENV = {
  FOOTBALL_ENVIRONMENT: "dev",
  FOOTBALL_MATCH_CURSOR_SECRET: "http-shutdown-test-secret",
  FOOTBALL_REPOSITORY_BACKEND: "postgres",
  FOOTBALL_DATABASE_URL: "postgres://football:secret@127.0.0.1:1/football",
  FOOTBALL_DATABASE_SCHEMA: "football_dev",
  FOOTBALL_RESOURCE_NAMESPACE: "football_dev",
  FOOTBALL_WECHAT_APP_ID: "wx-test-appid",
  FOOTBALL_WECHAT_APP_SECRET: "wx-test-secret",
  FOOTBALL_SESSION_TTL_SECONDS: "60",
  FOOTBALL_PG_CONNECTION_TIMEOUT_MILLIS: "250",
};

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shutdownGatewayServer", () => {
  it("drops idle keep-alive connections instead of waiting out the timeout", async () => {
    const server = await startGatewayServer({ port: 0, env: MEMORY_ENV });
    server.keepAliveTimeout = 30_000;
    const port = (server.address() as AddressInfo).port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ hostname: "127.0.0.1", port, path: "/health", agent }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        req.on("error", reject);
      });
      const started = Date.now();
      await shutdownGatewayServer(server);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(server.listening).toBe(false);
    } finally {
      agent.destroy();
      if (server.listening) {
        server.closeIdleConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("closes idle sockets, waits for the server, then awaits resource cleanup", async () => {
    const events: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalEnd = pg.Pool.prototype.end as (this: pg.Pool) => Promise<void>;
    vi.spyOn(pg.Pool.prototype, "end").mockImplementation((async function (this: pg.Pool) {
      events.push("end-start");
      await gate;
      events.push("end-done");
      return originalEnd.call(this);
    }) as typeof pg.Pool.prototype.end);

    const server = await startGatewayServer({ port: 0, env: POSTGRES_ENV });
    const originalIdle = server.closeIdleConnections.bind(server);
    vi.spyOn(server, "closeIdleConnections").mockImplementation(() => {
      events.push("idle");
      originalIdle();
    });
    server.on("close", () => {
      events.push("server-close");
    });

    let finished = false;
    const pending = shutdownGatewayServer(server).then(() => {
      finished = true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(events[0]).toBe("idle");
      expect(events).toContain("end-start");
      expect(events).toContain("server-close");
      expect(events).not.toContain("end-done");
      expect(server.listening).toBe(false);
      expect(finished).toBe(false);

      release();
      await pending;
      expect(finished).toBe(true);
      expect(events.at(-1)).toBe("end-done");
      expect(events.indexOf("server-close")).toBeLessThan(events.indexOf("end-done"));
      await expect(shutdownGatewayServer(server)).resolves.toBeUndefined();
    } finally {
      release();
      await pending.catch(() => undefined);
    }
  });

  it("logs and rejects when resource cleanup fails", async () => {
    vi.spyOn(pg.Pool.prototype, "end").mockImplementation((() => {
      throw new Error("end failed");
    }) as typeof pg.Pool.prototype.end);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await startGatewayServer({ port: 0, env: POSTGRES_ENV });
    await expect(shutdownGatewayServer(server)).rejects.toThrow("end failed");
    expect(logged).toHaveBeenCalledWith("end failed");
    expect(server.listening).toBe(false);
  });
});

describe("runGatewayEntrypoint", () => {
  function harness(overrides: {
    shutdown?: (server: http.Server) => Promise<void>;
    start?: () => Promise<http.Server>;
  } = {}) {
    const signals = new Map<NodeJS.Signals, () => void>();
    const exit = vi.fn<(code: number) => void>();
    const logError = vi.fn<(message: string) => void>();
    let resolveStart: (server: http.Server) => void = () => {};
    let rejectStart: (err: unknown) => void = () => {};
    const start = overrides.start ?? (() => new Promise<http.Server>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    }));
    const shutdown = vi.fn(overrides.shutdown ?? (async () => undefined));
    runGatewayEntrypoint({
      start,
      shutdown,
      exit,
      logError,
      shutdownTimeoutMs: 10_000,
      onceSignal: (signal, listener) => {
        signals.set(signal, listener);
      },
    });
    return {
      signals,
      exit,
      logError,
      shutdown,
      resolveStart,
      rejectStart,
      signal(signal: NodeJS.Signals) {
        const listener = signals.get(signal);
        if (listener === undefined) throw new Error(`missing ${signal}`);
        listener();
      },
    };
  }

  it("registers SIGTERM and SIGINT before listen resolves", () => {
    const entry = harness();
    expect([...entry.signals.keys()]).toEqual(["SIGTERM", "SIGINT"]);
    expect(entry.shutdown).not.toHaveBeenCalled();
  });

  it("shuts down once when a signal arrives during startup", async () => {
    const entry = harness();
    const server = {} as http.Server;
    entry.signal("SIGINT");
    expect(entry.shutdown).not.toHaveBeenCalled();
    entry.resolveStart(server);
    await settle();
    expect(entry.shutdown).toHaveBeenCalledTimes(1);
    expect(entry.shutdown).toHaveBeenCalledWith(server);
    expect(entry.exit).toHaveBeenCalledTimes(1);
    expect(entry.exit).toHaveBeenCalledWith(0);
    entry.signal("SIGTERM");
    await settle();
    expect(entry.shutdown).toHaveBeenCalledTimes(1);
    expect(entry.exit).toHaveBeenCalledTimes(1);
  });

  it("shuts down on SIGTERM after the server is listening", async () => {
    const entry = harness();
    const server = {} as http.Server;
    entry.resolveStart(server);
    await settle();
    expect(entry.shutdown).not.toHaveBeenCalled();
    entry.signal("SIGTERM");
    await settle();
    expect(entry.shutdown).toHaveBeenCalledTimes(1);
    expect(entry.exit).toHaveBeenCalledWith(0);
  });

  it("exits on startup failure without shutting down", async () => {
    const entry = harness();
    entry.rejectStart(new Error("listen failed"));
    await settle();
    expect(entry.logError).toHaveBeenCalledWith("listen failed");
    expect(entry.exit).toHaveBeenCalledWith(1);
    expect(entry.shutdown).not.toHaveBeenCalled();
  });

  it("exits when a rejected startup value is not an Error", async () => {
    const entry = harness();
    entry.rejectStart("boom");
    await settle();
    expect(entry.logError).toHaveBeenCalledWith("gateway failed to start");
    expect(entry.exit).toHaveBeenCalledWith(1);
  });

  it("logs shutdown failures and exits non-zero", async () => {
    const entry = harness({
      shutdown: async () => {
        throw new Error("pool end failed");
      },
    });
    entry.resolveStart({} as http.Server);
    await settle();
    entry.signal("SIGTERM");
    await settle();
    expect(entry.logError).toHaveBeenCalledWith("pool end failed");
    expect(entry.exit).toHaveBeenCalledWith(1);
  });

  it("force-exits when shutdown exceeds the timeout", async () => {
    vi.useFakeTimers();
    const entry = harness({
      shutdown: () => new Promise<void>(() => undefined),
    });
    entry.resolveStart({} as http.Server);
    await settle();
    entry.signal("SIGTERM");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(entry.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(entry.logError).toHaveBeenCalledWith("gateway shutdown timed out");
    expect(entry.exit).toHaveBeenCalledTimes(1);
    expect(entry.exit).toHaveBeenCalledWith(1);
  });
});
