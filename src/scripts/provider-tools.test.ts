import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAP_SCRIPT = resolve(REPO_ROOT, "scripts/providers-map-teams.mjs");
const LOGO_SCRIPT = resolve(REPO_ROOT, "scripts/logos-check.mjs");

function withInput(value: unknown, run: (path: string) => void) {
  const directory = mkdtempSync(resolve(tmpdir(), "football-provider-tools-"));
  const path = resolve(directory, "fixture.json");
  const content = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, content, "utf8");
  try {
    run(path);
    expect(readFileSync(path, "utf8")).toBe(content);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("providers:map-teams command", () => {
  it("reports confirmed, review, ambiguous, and unmatched candidates without changing input", () => {
    const input = {
      local_teams: [
        { team_id: "local-arsenal", league_id: "premier_league", name: "Arsenal" },
        { team_id: "local-chelsea", league_id: "premier_league", name: "Chelsea" },
        { team_id: "local-derby-1", league_id: "premier_league", name: "Derby County" },
        { team_id: "local-derby-2", league_id: "premier_league", name: "Derby County" },
      ],
      provider_teams: [
        { provider: "football_data", provider_team_id: "57", league_id: "premier_league", name: "Arsenal FC" },
        { provider: "bsd", provider_team_id: "10", league_id: "premier_league", name: "Derby County" },
        { provider: "sportapi", provider_team_id: "999", league_id: "premier_league", name: "Unknown Team" },
        { provider: "football_data", provider_team_id: "58", league_id: "premier_league", name: "Chelsea FC" },
      ],
      confirmed_mappings: [{ provider: "football_data", provider_team_id: "58", team_id: "local-chelsea" }],
    };
    withInput(input, (path) => {
      const stdout = execFileSync(process.execPath, [MAP_SCRIPT, "--input", path], { cwd: REPO_ROOT, encoding: "utf8" });
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ confirmed: 1, review: 1, ambiguous: 1, unmatched: 1 });
      expect(report.mappings).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider_team_id: "57", status: "review", team_id: null, suggested_team_id: "local-arsenal" }),
        expect.objectContaining({ provider_team_id: "10", status: "ambiguous", team_id: null, suggested_team_id: null }),
        expect.objectContaining({ provider_team_id: "999", status: "unmatched", team_id: null }),
        expect.objectContaining({ provider_team_id: "58", status: "confirmed", team_id: "local-chelsea", name_matches: true }),
      ]));
      expect(report.mappings[0].provider_name).toBe("Arsenal FC");
    });
  });

  it("confirms mappings by external ID and reports name differences without importing", () => {
    const input = {
      local_teams: [{ team_id: "local-arsenal", league_id: "premier_league", name: "Arsenal" }],
      provider_teams: [{ provider: "football_data", provider_team_id: "57", league_id: "premier_league", name: "The Gunners" }],
      confirmed_mappings: [{ provider: "football_data", provider_team_id: "57", team_id: "local-arsenal" }],
    };
    withInput(input, (path) => {
      const stdout = execFileSync(process.execPath, [MAP_SCRIPT, "--input", path], { cwd: REPO_ROOT, encoding: "utf8" });
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ confirmed: 1, review: 0, ambiguous: 0, unmatched: 0 });
      expect(report.mappings).toEqual([expect.objectContaining({
        provider_team_id: "57", status: "confirmed", team_id: "local-arsenal", name_matches: false, suggested_team_id: null,
      })]);
    });
  });

  it("reports a confirmed mapping whose target team is missing instead of failing", () => {
    const input = {
      local_teams: [{ team_id: "test-home", league_id: "premier_league", name: "Example Home" }],
      provider_teams: [{ provider: "5dollar", provider_team_id: "99999", league_id: "premier_league", name: "Example Home" }],
      confirmed_mappings: [{ provider: "5dollar", provider_team_id: "99999", team_id: "missing-id" }],
    };
    withInput(input, (path) => {
      const stdout = execFileSync(process.execPath, [MAP_SCRIPT, "--input", path], { cwd: REPO_ROOT, encoding: "utf8" });
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ confirmed: 0, review: 0, ambiguous: 0, unmatched: 0, missing_target: 1 });
      expect(report.mappings).toEqual([expect.objectContaining({
        provider_team_id: "99999",
        status: "missing_target",
        team_id: null,
        mapping_error: "missing_target",
        mapping_team_ids: ["missing-id"],
      })]);
    });
  });

  it("reports conflicting confirmed targets instead of adopting the last one", () => {
    const input = {
      local_teams: [
        { team_id: "test-a", league_id: "premier_league", name: "Example A" },
        { team_id: "test-b", league_id: "premier_league", name: "Example B" },
      ],
      provider_teams: [{ provider: "5dollar", provider_team_id: "99999", league_id: "premier_league", name: "Example A" }],
      confirmed_mappings: [
        { provider: "5dollar", provider_team_id: "99999", team_id: "test-a" },
        { provider: "5dollar", provider_team_id: "99999", team_id: "test-b" },
      ],
    };
    withInput(input, (path) => {
      const stdout = execFileSync(process.execPath, [MAP_SCRIPT, "--input", path], { cwd: REPO_ROOT, encoding: "utf8" });
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ confirmed: 0, review: 0, ambiguous: 0, unmatched: 0, conflict: 1 });
      expect(report.mappings).toEqual([expect.objectContaining({
        provider_team_id: "99999",
        status: "conflict",
        team_id: null,
        mapping_error: "conflict",
        mapping_team_ids: ["test-a", "test-b"],
      })]);
    });
  });

  it("keeps identical repeated confirmations idempotent", () => {
    const input = {
      local_teams: [{ team_id: "local-arsenal", league_id: "premier_league", name: "Arsenal" }],
      provider_teams: [{ provider: "football_data", provider_team_id: "57", league_id: "premier_league", name: "The Gunners" }],
      confirmed_mappings: [
        { provider: "football_data", provider_team_id: "57", team_id: "local-arsenal" },
        { provider: "football_data", provider_team_id: "57", team_id: "local-arsenal" },
      ],
    };
    withInput(input, (path) => {
      const stdout = execFileSync(process.execPath, [MAP_SCRIPT, "--input", path], { cwd: REPO_ROOT, encoding: "utf8" });
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ confirmed: 1, review: 0, ambiguous: 0, unmatched: 0, conflict: 0 });
      expect(report.mappings).toEqual([expect.objectContaining({
        provider_team_id: "57", status: "confirmed", team_id: "local-arsenal", mapping_error: null,
      })]);
    });
  });

  it("merges provider team and confirmed mapping targets before deduplicating", () => {
    const localTeams = [
      { team_id: "test-a", league_id: "premier_league", name: "Example A" },
      { team_id: "test-b", league_id: "premier_league", name: "Example B" },
    ];
    const providerTeam = { provider: "5dollar", provider_team_id: "99999", league_id: "premier_league", name: "Example A" };
    withInput({
      local_teams: localTeams,
      provider_teams: [{ ...providerTeam, confirmed_team_id: "test-b" }],
      confirmed_mappings: [{ provider: "5dollar", provider_team_id: "99999", team_id: "test-a" }],
    }, (path) => {
      const stdout = execFileSync(process.execPath, [MAP_SCRIPT, "--input", path], { cwd: REPO_ROOT, encoding: "utf8" });
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ confirmed: 0, review: 0, ambiguous: 0, unmatched: 0, conflict: 1 });
      expect(report.mappings).toEqual([expect.objectContaining({
        provider_team_id: "99999",
        status: "conflict",
        team_id: null,
        mapping_error: "conflict",
        mapping_team_ids: ["test-a", "test-b"],
      })]);
    });
    withInput({
      local_teams: localTeams,
      provider_teams: [{ ...providerTeam, confirmed_team_id: "test-a" }],
      confirmed_mappings: [{ provider: "5dollar", provider_team_id: "99999", team_id: "test-a" }],
    }, (path) => {
      const stdout = execFileSync(process.execPath, [MAP_SCRIPT, "--input", path], { cwd: REPO_ROOT, encoding: "utf8" });
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ confirmed: 1, review: 0, ambiguous: 0, unmatched: 0, conflict: 0 });
      expect(report.mappings).toEqual([expect.objectContaining({
        provider_team_id: "99999",
        status: "confirmed",
        team_id: "test-a",
        mapping_error: null,
        mapping_team_ids: ["test-a"],
      })]);
    });
  });

  it("reports a confirmed target from another league without confirming it", () => {
    const input = {
      local_teams: [{ team_id: "local-arsenal", league_id: "premier_league", name: "Arsenal" }],
      provider_teams: [{ provider: "5dollar", provider_team_id: "99999", league_id: "la_liga", name: "Arsenal" }],
      confirmed_mappings: [{ provider: "5dollar", provider_team_id: "99999", team_id: "local-arsenal" }],
    };
    withInput(input, (path) => {
      const stdout = execFileSync(process.execPath, [MAP_SCRIPT, "--input", path], { cwd: REPO_ROOT, encoding: "utf8" });
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ confirmed: 0, review: 0, ambiguous: 0, unmatched: 0, league_mismatch: 1 });
      expect(report.mappings).toEqual([expect.objectContaining({
        provider_team_id: "99999",
        status: "league_mismatch",
        team_id: null,
        mapping_league_mismatch: true,
        mapping_error: "league_mismatch",
      })]);
    });
  });

  it("keeps Chinese names when suggesting matches instead of dropping them", () => {
    const input = {
      local_teams: [
        { team_id: "test-beijing", league_id: "chinese_super_league", name: "北京国安" },
        { team_id: "test-shenhua", league_id: "chinese_super_league", name: "上海申花" },
      ],
      provider_teams: [
        { provider: "bsd", provider_team_id: "99999", league_id: "chinese_super_league", name: "上海申花" },
        { provider: "bsd", provider_team_id: "99998", league_id: "chinese_super_league", name: "上海申花 FC" },
      ],
    };
    withInput(input, (path) => {
      const stdout = execFileSync(process.execPath, [MAP_SCRIPT, "--input", path], { cwd: REPO_ROOT, encoding: "utf8" });
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ confirmed: 0, review: 2, ambiguous: 0, unmatched: 0 });
      expect(report.mappings).toEqual([
        expect.objectContaining({ provider_team_id: "99999", status: "review", suggested_team_id: "test-shenhua" }),
        expect.objectContaining({ provider_team_id: "99998", status: "review", suggested_team_id: "test-shenhua" }),
      ]);
    });
  });

  it("does not suggest matches when the only available name is empty", () => {
    const input = {
      local_teams: [{ team_id: "local-empty", league_id: "premier_league", name: "  " }],
      provider_teams: [{ provider: "bsd", provider_team_id: "10", league_id: "premier_league", name: "" }],
    };
    withInput(input, (path) => {
      const stdout = execFileSync(process.execPath, [MAP_SCRIPT, "--input", path], { cwd: REPO_ROOT, encoding: "utf8" });
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ confirmed: 0, review: 0, ambiguous: 0, unmatched: 1 });
      expect(report.mappings).toEqual([expect.objectContaining({
        provider_team_id: "10", status: "unmatched", team_id: null, suggested_team_id: null,
      })]);
    });
  });
});

describe("logos:check command", () => {
  it("reports matched aliases and missing logos, without modifying the fixture", () => {
    const input = {
      fixtures: [{
        league_id: "premier_league",
        teams: [{ id: "57", name: "Arsenal FC" }, { id: "new-team", name: "Unlisted Town" }],
      }],
    };
    withInput(input, (path) => {
      const result = spawnSync(process.execPath, [LOGO_SCRIPT, "--input", path], { cwd: REPO_ROOT, encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report).toEqual({
        total: 2,
        matched: 1,
        unmatched: [{ league_id: "premier_league", provider_team_id: "new-team", name: "Unlisted Town", matched: false }],
      });
    });
  });
});

describe("cloudbase:schema command", () => {
  it("lists the provider state collections and unique indexes from the built schema", () => {
    const output = execFileSync("npm", ["run", "cloudbase:schema", "--", "--namespace", "football_test"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(output).toContain("football_test_provider_usage");
    expect(output).toContain("football_test_provider_keys uk_provider_key_state_key_id unique=true fields=[key_id:asc]");
    expect(output).toContain("football_test_provider_leagues uk_provider_league_state_source_job_league unique=true fields=[source_id:asc, job_type:asc, league_id:asc]");
  });
});
