import { describe, expect, it } from "vitest";
import type { Match } from "../domain/types.js";
import type { UnitOfWork } from "../infrastructure/repositories.js";
import { resolveEffectiveMatch } from "./match-identity.js";

function repoWithLinks(links: Record<string, string | null>): UnitOfWork {
  return { matches: { findById: async (id: string) => id in links ? { match_id: id, superseded_by: links[id] } as Match : null } } as UnitOfWork;
}

describe("resolveEffectiveMatch", () => {
  it("返回没有取代的记录", async () => {
    await expect(resolveEffectiveMatch(repoWithLinks({ a: null }), "a")).resolves.toMatchObject({ match_id: "a" });
  });
  it("解析一跳和三跳取代", async () => {
    await expect(resolveEffectiveMatch(repoWithLinks({ a: "b", b: null }), "a")).resolves.toMatchObject({ match_id: "b" });
    await expect(resolveEffectiveMatch(repoWithLinks({ a: "b", b: "c", c: "d", d: null }), "a")).resolves.toMatchObject({ match_id: "d" });
  });
  it("目标不存在时返回 null", async () => {
    await expect(resolveEffectiveMatch(repoWithLinks({ a: "b" }), "a")).resolves.toBeNull();
  });
  it("环或超过三跳时抛内部错误", async () => {
    await expect(resolveEffectiveMatch(repoWithLinks({ a: "b", b: "a" }), "a")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(resolveEffectiveMatch(repoWithLinks({ a: "b", b: "c", c: "d", d: "e", e: null }), "a")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
