import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("cloud transport startup", () => {
  it("initializes WeChat cloud with the configured environment", () => {
    let app;
    const init = vi.fn();
    const source = readFileSync(join(HERE, "app.js"), "utf8");
    runInNewContext(source, {
      App: (definition) => { app = definition; },
      require: (id) => {
        if (id === "./config.js") return { transport: "cloud", cloudEnvId: "cloud-test" };
        throw new Error(`Unexpected require: ${id}`);
      },
      wx: { cloud: { init } },
    });
    app.onLaunch();
    expect(init).toHaveBeenCalledWith({ env: "cloud-test", traceUser: true });
  });

  it("fails clearly if cloud transport has no environment id", () => {
    let app;
    runInNewContext(readFileSync(join(HERE, "app.js"), "utf8"), {
      App: (definition) => { app = definition; },
      require: () => ({ transport: "cloud", cloudEnvId: "" }),
      wx: { cloud: { init: vi.fn() } },
    });
    expect(() => app.onLaunch()).toThrow("cloudEnvId is required");
  });

  it("does not initialize WeChat cloud for HTTP transport", () => {
    let app;
    const init = vi.fn();
    const restoreAuth = vi.fn(() => Promise.resolve({ statusCode: 200 }));
    runInNewContext(readFileSync(join(HERE, "app.js"), "utf8"), {
      App: (definition) => { app = definition; },
      require(id) {
        if (id === "./config.js") return { transport: "http", gatewayOrigin: "https://api.example.com", cloudEnvId: "" };
        if (id === "./services/auth.js") return { restoreAuth };
        throw new Error(`Unexpected require: ${id}`);
      },
      wx: { cloud: { init } },
    });
    app.onLaunch();
    expect(init).not.toHaveBeenCalled();
    expect(restoreAuth).toHaveBeenCalledTimes(1);
  });

  it("does not restore a self-hosted session for CloudBase transport", () => {
    let app;
    const init = vi.fn();
    const restoreAuth = vi.fn();
    const required = [];
    runInNewContext(readFileSync(join(HERE, "app.js"), "utf8"), {
      App: (definition) => { app = definition; },
      require(id) {
        required.push(id);
        if (id === "./config.js") return { transport: "cloud", cloudEnvId: "cloud-test" };
        if (id === "./services/auth.js") return { restoreAuth };
        throw new Error(`Unexpected require: ${id}`);
      },
      wx: { cloud: { init } },
    });
    app.onLaunch();
    expect(init).toHaveBeenCalledWith({ env: "cloud-test", traceUser: true });
    expect(required).toEqual(["./config.js"]);
    expect(restoreAuth).not.toHaveBeenCalled();
  });
});
