import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadService(request) {
  const file = join(HERE, "matches.js");
  const module = { exports: {} };
  const factory = runInThisContext(`(function(module, exports, require) {\n${readFileSync(file, "utf8")}\n})`, { filename: file });
  factory(module, module.exports, (id) => {
    if (id === "./api.js") return { request };
    throw new Error(`Unexpected require: ${id}`);
  });
  return module.exports;
}

describe("matches crowd service", () => {
  it("requests the crowd endpoint and returns the request result unchanged", async () => {
    const response = { statusCode: 401, code: "UNAUTHORIZED" };
    const request = vi.fn(async () => response);
    const service = loadService(request);
    await expect(service.getMatchCrowd("match-id")).resolves.toBe(response);
    expect(request).toHaveBeenCalledWith({ method: "GET", path: "/v1/matches/match-id/crowd" });
  });
});
