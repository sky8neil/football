import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { LeagueId, SCHEMA_VERSION, TeamStatus } from "../../domain/enums.js";
import { DomainError } from "../../domain/errors.js";
import type { Team } from "../../domain/types.js";
import { InMemoryRepository } from "../../infrastructure/repositories.js";
import { InMemoryRateLimiter, RATE_LIMIT_DEFAULTS } from "./rate-limit.js";
import { getTeamById, getTeams } from "./teams.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    schema_version: SCHEMA_VERSION,
    team_id: "00000000-0000-4000-8000-000000000101",
    league_id: LeagueId.PremierLeague,
    name: "Promoted FC",
    name_zh: "升班马联",
    logo_url: "https://cdn.example.com/promoted.png",
    short_name: "PFC",
    primary_color: "#111111",
    secondary_color: "#ffffff",
    status: TeamStatus.Active,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function compileEnvelopeValidator(schemaName: "PublicTeamsEnvelope" | "PublicTeamEnvelope" = "PublicTeamsEnvelope") {
  const raw = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
  const spec = YAML.parse(raw) as { components: { schemas: Record<string, unknown> } };
  const ajv = new Ajv({ nullable: false, allErrors: true });
  ajv.addSchema({ $id: "https://football.local/openapi.json", components: spec.components });
  return ajv.compile({ $ref: `https://football.local/openapi.json#/components/schemas/${schemaName}` });
}

describe("GET /v1/teams", () => {
  it("returns only active teams with public fields and passes OpenAPI schema", async () => {
    const repo = new InMemoryRepository();
    await repo.teams.insert(makeTeam({
      team_id: "00000000-0000-4000-8000-000000000102",
      league_id: LeagueId.LaLiga,
      name: "Real Oviedo",
      name_zh: null,
      logo_url: null,
      status: TeamStatus.Active,
    }));
    await repo.teams.insert(makeTeam({
      team_id: "00000000-0000-4000-8000-000000000101",
      league_id: LeagueId.PremierLeague,
      name: "Burnley FC",
      name_zh: "伯恩利",
      logo_url: "https://cdn.example.com/burnley.png",
      status: TeamStatus.Active,
    }));
    await repo.teams.insert(makeTeam({
      team_id: "00000000-0000-4000-8000-000000000103",
      league_id: LeagueId.PremierLeague,
      name: "Relegated Old FC",
      name_zh: "已降级队",
      status: TeamStatus.Inactive,
    }));

    const response = await getTeams(repo, {
      public_source: "ip:203.0.113.10",
      query: {},
      server_now: NOW,
      request_id: "00000000-0000-4000-8000-000000000901",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        items: [
          {
            team_id: "00000000-0000-4000-8000-000000000102",
            league_id: "la_liga",
            name: "Real Oviedo",
            name_zh: null,
            logo_url: null,
          },
          {
            team_id: "00000000-0000-4000-8000-000000000101",
            league_id: "premier_league",
            name: "Burnley FC",
            name_zh: "伯恩利",
            logo_url: "https://cdn.example.com/burnley.png",
          },
        ],
      },
      request_id: "00000000-0000-4000-8000-000000000901",
    });

    const validate = await compileEnvelopeValidator();
    expect(validate(response.body), JSON.stringify(validate.errors)).toBe(true);
  });

  it("filters active teams by optional league_id", async () => {
    const repo = new InMemoryRepository();
    await repo.teams.insert(makeTeam({
      team_id: "00000000-0000-4000-8000-000000000101",
      league_id: LeagueId.PremierLeague,
      name: "Burnley FC",
      name_zh: "伯恩利",
    }));
    await repo.teams.insert(makeTeam({
      team_id: "00000000-0000-4000-8000-000000000102",
      league_id: LeagueId.LaLiga,
      name: "Elche CF",
      name_zh: "埃尔切",
    }));

    const response = await getTeams(repo, {
      public_source: "ip:203.0.113.11",
      query: { league_id: "premier_league" },
      server_now: NOW,
      request_id: "req-pl",
    });

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]?.team_id).toBe("00000000-0000-4000-8000-000000000101");
  });

  it("rejects unknown query params, invalid league_id, and missing public_source", async () => {
    const repo = new InMemoryRepository();
    await expect(getTeams(repo, {
      public_source: "ip:203.0.113.12",
      query: { q: "Arsenal" },
      server_now: NOW,
      request_id: "req-unknown",
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { field: "q" } });

    await expect(getTeams(repo, {
      public_source: "ip:203.0.113.12",
      query: { league_id: "nba" },
      server_now: NOW,
      request_id: "req-bad-league",
    })).rejects.toBeInstanceOf(DomainError);

    await expect(getTeams(repo, {
      public_source: "",
      query: {},
      server_now: NOW,
      request_id: "req-no-src",
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { field: "public_source" } });
  });

  it("applies public_reads rate limit", async () => {
    const repo = new InMemoryRepository();
    const limiter = new InMemoryRateLimiter();
    const checkSpy = vi.spyOn(limiter, "check");

    for (let i = 0; i < RATE_LIMIT_DEFAULTS.public_reads.max_requests; i += 1) {
      await getTeams(repo, {
        public_source: "ip:203.0.113.13",
        query: {},
        server_now: NOW,
        request_id: `req-${i}`,
        rate_limiter: limiter,
      });
    }
    expect(checkSpy).toHaveBeenCalledWith("public_reads", "ip:203.0.113.13", NOW);
    await expect(getTeams(repo, {
      public_source: "ip:203.0.113.13",
      query: {},
      server_now: NOW,
      request_id: "req-over",
      rate_limiter: limiter,
    })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("GET /v1/teams/:team_id", () => {
  it("[CR44-03] returns public display fields for an inactive team while GET /v1/teams excludes it", async () => {
    const repo = new InMemoryRepository();
    const inactiveId = "00000000-0000-4000-8000-000000000203";
    await repo.teams.insert(makeTeam({
      team_id: inactiveId,
      league_id: LeagueId.PremierLeague,
      name: "Relegated Old FC",
      name_zh: "已降级老牌队",
      logo_url: "https://cdn.example.com/relegated.png",
      status: TeamStatus.Inactive,
    }));

    const listRes = await getTeams(repo, {
      public_source: "ip:203.0.113.20",
      query: {},
      server_now: NOW,
      request_id: "req-list-active-only",
    });
    expect(listRes.body.data.items).toEqual([]);

    const detailRes = await getTeamById(repo, {
      team_id: inactiveId,
      public_source: "ip:203.0.113.20",
      query: {},
      server_now: NOW,
      request_id: "req-detail-inactive",
    });
    expect(detailRes.status).toBe(200);
    expect(detailRes.body).toEqual({
      data: {
        team_id: inactiveId,
        league_id: "premier_league",
        name: "Relegated Old FC",
        name_zh: "已降级老牌队",
        logo_url: "https://cdn.example.com/relegated.png",
      },
      request_id: "req-detail-inactive",
    });

    const validate = await compileEnvelopeValidator("PublicTeamEnvelope");
    expect(validate(detailRes.body), JSON.stringify(validate.errors)).toBe(true);
  });

  it("validates team_id, rejects unknown query params, returns 404 when missing, and rate-limits", async () => {
    const repo = new InMemoryRepository();
    const missingId = "00000000-0000-4000-8000-000000000299";

    await expect(getTeamById(repo, {
      team_id: "not-a-uuid",
      public_source: "ip:203.0.113.21",
      query: {},
      server_now: NOW,
      request_id: "req-bad-id",
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { field: "team_id" } });

    await expect(getTeamById(repo, {
      team_id: missingId,
      public_source: "ip:203.0.113.21",
      query: { extra: "1" },
      server_now: NOW,
      request_id: "req-bad-query",
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { field: "extra" } });

    await expect(getTeamById(repo, {
      team_id: missingId,
      public_source: "ip:203.0.113.21",
      query: {},
      server_now: NOW,
      request_id: "req-not-found",
    })).rejects.toMatchObject({ code: "TEAM_NOT_FOUND" });

    const limiter = new InMemoryRateLimiter();
    await repo.teams.insert(makeTeam({ team_id: missingId }));
    for (let i = 0; i < RATE_LIMIT_DEFAULTS.public_reads.max_requests; i += 1) {
      await getTeamById(repo, {
        team_id: missingId,
        public_source: "ip:203.0.113.22",
        query: {},
        server_now: NOW,
        request_id: `req-limit-${i}`,
        rate_limiter: limiter,
      });
    }
    await expect(getTeamById(repo, {
      team_id: missingId,
      public_source: "ip:203.0.113.22",
      query: {},
      server_now: NOW,
      request_id: "req-limit-over",
      rate_limiter: limiter,
    })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
