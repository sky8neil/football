import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("admin user stats rebuild OpenAPI contract", () => {
  it("declares the frozen user rebuild endpoint and its limited success data", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");

    expect(specification).toMatch(
      /  \/admin\/rebuild\/users\/\{user_id\}:\n    post:/,
    );
    expect(specification).toMatch(
      /  \/admin\/rebuild\/users\/\{user_id\}:[\s\S]*?name: user_id[\s\S]*?format: uuid/,
    );
    expect(specification).toMatch(
      /  \/admin\/rebuild\/users\/\{user_id\}:[\s\S]*?['"]200['"]:[\s\S]*?AdminRebuildUserStatsEnvelope/,
    );
    expect(specification).toMatch(
      /    AdminRebuildUserStatsData:[\s\S]*?required: \[user_id, rebuilt_season_count, audit_id\]/,
    );
  });

  it("为所有管理员写入口声明 429 限流响应", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const paths = [
      "/admin/matches/{match_id}/result-corrections",
      "/admin/matches/{match_id}/retry-settlement",
      "/admin/rebuild/users/{user_id}",
      "/admin/rebuild/rankings",
    ];

    for (const path of paths) {
      const start = specification.indexOf(`  ${path}:\n`);
      const nextPath = specification.indexOf("\n  /", start + 1);
      const block = specification.slice(start, nextPath === -1 ? undefined : nextPath);
      expect(block).toContain("'429':");
      expect(block).toContain("#/components/responses/RateLimited");
    }
  });
});
