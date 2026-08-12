import { describe, expect, it } from "vitest";
import { Provider } from "../domain/enums.js";
import type { MatchProviderMapping, TeamProviderMapping } from "../domain/types.js";
import { InMemoryRepository, UniqueConstraintError } from "./repositories.js";

const TEAM_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_TEAM_ID = "00000000-0000-4000-8000-000000000002";
const MATCH_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_MATCH_ID = "00000000-0000-4000-8000-000000000004";
const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeTeamMapping(overrides: Partial<TeamProviderMapping> = {}): TeamProviderMapping {
  return {
    schema_version: 1,
    team_id: TEAM_ID,
    provider: Provider.ApiFootball,
    provider_team_id: "40",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeMatchMapping(overrides: Partial<MatchProviderMapping> = {}): MatchProviderMapping {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    provider: Provider.ApiFootball,
    provider_match_id: "1100001",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("InMemoryRepository - provider mappings", () => {
  it("按 provider 外部 ID 和内部实体 ID读取 team/match mapping", async () => {
    const repo = new InMemoryRepository();
    const teamMapping = makeTeamMapping();
    const matchMapping = makeMatchMapping();
    await repo.teamProviderMappings.insert(teamMapping);
    await repo.matchProviderMappings.insert(matchMapping);

    await expect(
      repo.teamProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        "40",
      ),
    ).resolves.toEqual(teamMapping);
    await expect(repo.teamProviderMappings.findByTeamId(TEAM_ID)).resolves.toEqual([
      teamMapping,
    ]);
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        "1100001",
      ),
    ).resolves.toEqual(matchMapping);
    await expect(repo.matchProviderMappings.findByMatchId(MATCH_ID)).resolves.toEqual([
      matchMapping,
    ]);
  });

  it("按冻结唯一索引拒绝同一 provider 外部 ID的第二个绑定", async () => {
    const repo = new InMemoryRepository();
    await repo.teamProviderMappings.insert(makeTeamMapping());
    await repo.matchProviderMappings.insert(makeMatchMapping());

    await expect(
      repo.teamProviderMappings.insert(
        makeTeamMapping({ team_id: OTHER_TEAM_ID }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<UniqueConstraintError>>({
        collection: "team_provider_mappings",
        indexName: "uk_provider_team",
      }),
    );
    await expect(
      repo.matchProviderMappings.insert(
        makeMatchMapping({ match_id: OTHER_MATCH_ID }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<UniqueConstraintError>>({
        collection: "match_provider_mappings",
        indexName: "uk_provider_match",
      }),
    );
  });

  it("mapping 插入参与事务回滚，不留下内部或外部索引", async () => {
    const repo = new InMemoryRepository();
    const teamMapping = makeTeamMapping({ provider_team_id: "41" });
    const matchMapping = makeMatchMapping({ provider_match_id: "1100002" });

    await expect(
      repo.withTransaction(async (tx) => {
        await tx.teamProviderMappings?.insert(teamMapping);
        await tx.matchProviderMappings?.insert(matchMapping);
        throw new Error("rollback mappings");
      }),
    ).rejects.toThrow("rollback mappings");

    await expect(
      repo.teamProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        "41",
      ),
    ).resolves.toBeNull();
    await expect(repo.teamProviderMappings.findByTeamId(TEAM_ID)).resolves.toEqual([]);
    await expect(
      repo.matchProviderMappings.findByProviderAndExternalId(
        Provider.ApiFootball,
        "1100002",
      ),
    ).resolves.toBeNull();
    await expect(repo.matchProviderMappings.findByMatchId(MATCH_ID)).resolves.toEqual([]);
  });
});
