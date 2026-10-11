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
      require: () => ({ transport: "cloud", cloudEnvId: "cloud-test" }),
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
});
