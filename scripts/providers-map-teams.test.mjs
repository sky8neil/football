import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AnomalyStatus, AnomalyType, Provider, SCHEMA_VERSION, TeamStatus } from "../src/domain/enums.ts";
import { newUuid } from "../src/domain/ids.ts";
import { InMemoryRepository } from "../src/infrastructure/repositories.ts";
import { missingTeamMappingAnomalyKey } from "../src/application/provider-cross-source.ts";
import { analyzeTeamMappings, applyTeamMappings, main } from "./providers-map-teams.mjs";

const NOW = new Date("2026-07-15T12:00:00.000Z");

describe("providers-map-teams", () => {
  it("preserves read-only JSON report analysis via analyzeTeamMappings and CLI default mode", async () => {
    const sample = {
      local_teams: [
        { team_id: "t1", league_id: "premier_league", name: "Arsenal" },
        { team_id: "t2", league_id: "premier_league", name: "Leeds United" },
      ],
      provider_teams: [
        { provider: "openfoot", provider_team_id: "57", league_id: "premier_league", name: "Arsenal FC" },
        { provider: "openfoot", provider_team_id: "63", league_id: "premier_league", name: "Leeds United" },
        { provider: "openfoot", provider_team_id: "99", league_id: "premier_league", name: "Promoted New" },
      ],
      confirmed_mappings: [
        { provider: "openfoot", provider_team_id: "57", team_id: "t1" },
      ],
    };

    const report = analyzeTeamMappings(sample);
    expect(report).toMatchObject({
      confirmed: 1,
      review: 1,
      ambiguous: 0,
      unmatched: 1,
    });

    const tmpPath = join(tmpdir(), `map-teams-readonly-${Date.now()}.json`);
    await writeFile(tmpPath, JSON.stringify(sample), "utf8");
    const out = vi.fn();
    try {
      await main(["--input", tmpPath], { log: out });
    } finally {
      await rm(tmpPath, { force: true });
    }
    expect(out).toHaveBeenCalledWith(report);
  });

  it("--apply persists confirmed_mappings idempotently, updates teams.name_zh/logo_url, and resolves open team anomalies", async () => {
    const repo = new InMemoryRepository();
    const teamId = newUuid();
    await repo.teams.insert({
      schema_version: SCHEMA_VERSION,
      team_id: teamId,
      league_id: "premier_league",
      name: "Leeds United FC",
      name_zh: null,
      logo_url: null,
      short_name: null,
      primary_color: null,
      secondary_color: null,
      status: TeamStatus.Active,
      created_at: NOW,
      updated_at: NOW,
    });

    // Seed both missing_mapping anomaly (secondary source) and missing_name_zh anomaly (primary sync)
    const missingMapKey = missingTeamMappingAnomalyKey(Provider.OpenFoot, "of-leeds-63");
    await repo.anomalies.insert({
      schema_version: SCHEMA_VERSION,
      anomaly_id: newUuid(),
      anomaly_key: missingMapKey,
      match_id: missingMapKey.split(":")[0],
      type: AnomalyType.ProviderDataInvalid,
      blocking: false,
      status: AnomalyStatus.Open,
      first_seen_at: NOW,
      last_seen_at: NOW,
      occurrence_count: 1,
      details: { entity_type: "team", reason: "team_mapping_missing" },
      resolved_at: null,
      resolution: null,
    });
    await repo.anomalies.insert({
      schema_version: SCHEMA_VERSION,
      anomaly_id: newUuid(),
      anomaly_key: `${teamId}:${AnomalyType.ProviderDataInvalid}`,
      match_id: teamId,
      type: AnomalyType.ProviderDataInvalid,
      blocking: false,
      status: AnomalyStatus.Open,
      first_seen_at: NOW,
      last_seen_at: NOW,
      occurrence_count: 1,
      details: { entity_type: "team", reason: "team_name_zh_missing" },
      resolved_at: null,
      resolution: null,
    });

    const input = {
      local_teams: [],
      provider_teams: [],
      confirmed_mappings: [
        { provider: "openfoot", provider_team_id: "of-leeds-63", team_id: teamId },
      ],
      team_updates: [
        { team_id: teamId, name_zh: "利兹联", logo_url: "https://cdn.example.com/leeds.png" },
      ],
    };

    const tmpPath = join(tmpdir(), `map-teams-apply-${Date.now()}.json`);
    await writeFile(tmpPath, JSON.stringify(input), "utf8");
    const out = vi.fn();
    let res1;
    try {
      res1 = await main(["--input", tmpPath, "--apply"], { repo, now: NOW, log: out });
    } finally {
      await rm(tmpPath, { force: true });
    }

    expect(res1).toEqual({
      mode: "apply",
      mappings_inserted: 1,
      mappings_updated: 0,
      mappings_unchanged: 0,
      teams_updated: 1,
      teams_unchanged: 0,
      anomalies_resolved: 2,
    });
    expect(out).toHaveBeenCalledWith(res1);

    expect(await repo.teamProviderMappings.findByProviderAndExternalId(Provider.OpenFoot, "of-leeds-63")).toMatchObject({
      team_id: teamId,
    });
    expect(await repo.teams.findById(teamId)).toMatchObject({
      name_zh: "利兹联",
      logo_url: "https://cdn.example.com/leeds.png",
    });
    expect((await repo.anomalies.findByKey(missingMapKey))?.status).toBe(AnomalyStatus.Resolved);
    expect((await repo.anomalies.findByKey(`${teamId}:${AnomalyType.ProviderDataInvalid}`))?.status).toBe(AnomalyStatus.Resolved);

    // Idempotent second run
    const res2 = await applyTeamMappings(repo, input, { now: NOW });
    expect(res2).toEqual({
      mode: "apply",
      mappings_inserted: 0,
      mappings_updated: 0,
      mappings_unchanged: 1,
      teams_updated: 0,
      teams_unchanged: 1,
      anomalies_resolved: 0,
    });

    // Rejects conflicting mapping unless --overwrite-mappings is passed, and rejects unsafe logo_url
    const otherTeamId = newUuid();
    await repo.teams.insert({
      schema_version: SCHEMA_VERSION,
      team_id: otherTeamId,
      league_id: "premier_league",
      name: "Other Club",
      short_name: null,
      primary_color: null,
      secondary_color: null,
      status: TeamStatus.Active,
      created_at: NOW,
      updated_at: NOW,
    });
    await expect(applyTeamMappings(repo, {
      confirmed_mappings: [{ provider: "openfoot", provider_team_id: "of-leeds-63", team_id: otherTeamId }],
    }, { now: NOW })).rejects.toThrow(/Mapping conflict/);

    await expect(applyTeamMappings(repo, {
      confirmed_mappings: [{ provider: "openfoot", provider_team_id: "of-leeds-63", team_id: otherTeamId }],
    }, { now: NOW, allowOverwriteMapping: true })).resolves.toMatchObject({
      mappings_updated: 1,
    });
    expect((await repo.teamProviderMappings.findByProviderAndExternalId(Provider.OpenFoot, "of-leeds-63"))?.team_id).toBe(otherTeamId);

    await expect(applyTeamMappings(repo, {
      team_updates: [{ team_id: teamId, logo_url: "http://insecure.example/x.png" }],
    }, { now: NOW })).rejects.toThrow(/Invalid logo_url/);
  });
});
