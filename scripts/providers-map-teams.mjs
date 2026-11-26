import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_VERSION = 1;
const ANOMALY_TYPE_PROVIDER_DATA_INVALID = "PROVIDER_DATA_INVALID";

const CLI_OPTIONS = {
  input: { type: "string" },
  apply: { type: "boolean" },
  "dry-run": { type: "boolean" },
  "overwrite-mappings": { type: "boolean" },
  namespace: { type: "string" },
  schema: { type: "string" },
  "database-url": { type: "string" },
  help: { type: "boolean" },
};

const STRING_OPTIONS = ["input", "namespace", "schema", "database-url"];

function normalize(name) {
  return String(name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\b(football club|fc|afc)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function deterministicUuid(seed) {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function missingTeamMappingAnomalyKey(provider, providerTeamId) {
  const syntheticMatchId = deterministicUuid(`team_mapping_missing:${provider}:${providerTeamId}`);
  return `${syntheticMatchId}:${ANOMALY_TYPE_PROVIDER_DATA_INVALID}`;
}

export function normalizeLogoUrl(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error("logo_url must be a string or null");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^https:\/\/[^/\s]+/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  throw new Error(`Invalid logo_url (must start with https:// or /): ${trimmed}`);
}

export function normalizeNameZh(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error("name_zh must be a string or null");
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeOptionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeProviderTeamId(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve confirmed team mappings from both `confirmed_mappings[]` and
 * `provider_teams[].confirmed_team_id`, rejecting conflicting targets/leagues
 * and deduplicating identical pairs.
 */
function resolveConfirmedMappings(input) {
  if (
    input.confirmed_mappings !== undefined &&
    input.confirmed_mappings !== null &&
    !Array.isArray(input.confirmed_mappings)
  ) {
    throw new Error("confirmed_mappings must be an array");
  }
  if (
    input.provider_teams !== undefined &&
    input.provider_teams !== null &&
    !Array.isArray(input.provider_teams)
  ) {
    throw new Error("provider_teams must be an array");
  }

  const byKey = new Map();
  const providerLeagues = new Map();

  const recordLeague = (provider, providerTeamId, leagueId) => {
    if (!provider || !providerTeamId || !leagueId) return;
    const key = `${provider}:${providerTeamId}`;
    const leagues = providerLeagues.get(key) ?? new Set();
    leagues.add(leagueId);
    providerLeagues.set(key, leagues);
  };

  const addMapping = (provider, providerTeamId, teamId, leagueId, source) => {
    const key = `${provider}:${providerTeamId}`;
    recordLeague(provider, providerTeamId, leagueId);
    const existing = byKey.get(key);
    if (existing) {
      if (existing.team_id !== teamId) {
        throw new Error(
          `Conflicting confirmed mapping for ${key}: ${existing.team_id} (${existing.source}) vs ${teamId} (${source})`,
        );
      }
      if (!existing.league_id && leagueId) {
        existing.league_id = leagueId;
      }
      return;
    }
    byKey.set(key, {
      provider,
      provider_team_id: providerTeamId,
      team_id: teamId,
      league_id: leagueId || null,
      source,
    });
  };

  for (const entry of input.confirmed_mappings ?? []) {
    const provider = normalizeOptionalString(entry?.provider);
    const providerTeamId = normalizeProviderTeamId(entry?.provider_team_id);
    const teamId = normalizeOptionalString(entry?.team_id);
    const leagueId = normalizeOptionalString(entry?.league_id);
    if (!provider || !providerTeamId || !teamId) {
      throw new Error(`Invalid confirmed_mappings entry: ${JSON.stringify(entry)}`);
    }
    addMapping(provider, providerTeamId, teamId, leagueId, "confirmed_mappings");
  }

  for (const team of input.provider_teams ?? []) {
    const provider = normalizeOptionalString(team?.provider);
    const providerTeamId = normalizeProviderTeamId(team?.provider_team_id);
    const leagueId = normalizeOptionalString(team?.league_id);
    recordLeague(provider, providerTeamId, leagueId);

    const rawConfirmed = team?.confirmed_team_id;
    if (rawConfirmed === undefined || rawConfirmed === null) continue;
    if (typeof rawConfirmed !== "string") {
      throw new Error(`Invalid provider_teams confirmed_team_id: ${JSON.stringify(team)}`);
    }
    const confirmedTeamId = rawConfirmed.trim();
    if (!confirmedTeamId) continue;
    if (!provider || !providerTeamId) {
      throw new Error(`Invalid provider_teams entry with confirmed_team_id: ${JSON.stringify(team)}`);
    }
    addMapping(provider, providerTeamId, confirmedTeamId, leagueId, "provider_teams");
  }

  for (const [key, entry] of byKey.entries()) {
    const leagues = providerLeagues.get(key);
    if (!leagues || leagues.size === 0) continue;
    if (leagues.size > 1) {
      throw new Error(`Conflicting league_id for ${key}: ${[...leagues].join(" vs ")}`);
    }
    entry.league_id = [...leagues][0];
  }

  return {
    byKey,
    entries: [...byKey.values()],
  };
}

export function analyzeTeamMappings(input) {
  if (!input || !Array.isArray(input.local_teams) || !Array.isArray(input.provider_teams)) {
    throw new Error("Input must contain local_teams and provider_teams arrays");
  }

  const localByName = new Map();
  const localById = new Map(input.local_teams.map((team) => [team.team_id, team]));
  for (const team of input.local_teams) {
    const key = `${team.league_id}:${normalize(team.name)}`;
    localByName.set(key, [...(localByName.get(key) ?? []), team]);
  }
  const { byKey: confirmedMappings } = resolveConfirmedMappings(input);
  const report = input.provider_teams.map((team) => {
    const candidates = localByName.get(`${team.league_id}:${normalize(team.name)}`) ?? [];
    const provider = normalizeOptionalString(team.provider);
    const providerTeamId = normalizeProviderTeamId(team.provider_team_id);
    const mappedTeamId = confirmedMappings.get(`${provider}:${providerTeamId}`)?.team_id ?? null;
    const mappedTeam = mappedTeamId ? (localById.get(mappedTeamId) ?? null) : null;
    const confirmed = mappedTeam?.league_id === team.league_id ? mappedTeam : null;
    const suggestion = candidates.length === 1 ? candidates[0] : null;
    const status = confirmed ? "confirmed" : candidates.length > 1 ? "ambiguous" : candidates.length === 1 ? "review" : "unmatched";
    return {
      provider: team.provider,
      provider_team_id: String(team.provider_team_id),
      league_id: team.league_id,
      provider_name: team.name,
      status,
      team_id: confirmed?.team_id ?? null,
      suggested_team_id: suggestion?.team_id ?? null,
      local_name: confirmed?.name ?? suggestion?.name ?? null,
      name_matches: confirmed ? normalize(confirmed.name) === normalize(team.name) : null,
      mapping_league_mismatch: mappedTeam !== null && mappedTeam.league_id !== team.league_id,
    };
  });

  return {
    confirmed: report.filter((row) => row.status === "confirmed").length,
    review: report.filter((row) => row.status === "review").length,
    ambiguous: report.filter((row) => row.status === "ambiguous").length,
    unmatched: report.filter((row) => row.status === "unmatched").length,
    mappings: report,
  };
}

function collectTeamUpdates(input) {
  const byTeamId = new Map();
  const mergeRecord = (teamId, raw) => {
    if (typeof teamId !== "string" || teamId.trim().length === 0 || !raw || typeof raw !== "object") {
      return;
    }
    const hasNameZh = Object.prototype.hasOwnProperty.call(raw, "name_zh");
    const hasLogoUrl = Object.prototype.hasOwnProperty.call(raw, "logo_url");
    if (!hasNameZh && !hasLogoUrl) return;
    const current = byTeamId.get(teamId) ?? { team_id: teamId };
    if (hasNameZh) current.name_zh = normalizeNameZh(raw.name_zh);
    if (hasLogoUrl) current.logo_url = normalizeLogoUrl(raw.logo_url);
    byTeamId.set(teamId, current);
  };

  if (Array.isArray(input.local_teams)) {
    for (const item of input.local_teams) mergeRecord(item?.team_id, item);
  }
  if (Array.isArray(input.confirmed_mappings)) {
    for (const item of input.confirmed_mappings) mergeRecord(item?.team_id, item);
  }
  if (Array.isArray(input.team_updates)) {
    for (const item of input.team_updates) {
      if (typeof item?.team_id !== "string" || item.team_id.trim().length === 0) {
        throw new Error("team_updates entry missing valid team_id");
      }
      mergeRecord(item.team_id, item);
    }
  }
  return [...byTeamId.values()];
}

async function resolveTeamAnomalyIfOpen(tx, anomalyKey, resolution, now) {
  if (!tx.anomalies) return 0;
  const existing = await tx.anomalies.findByKey(anomalyKey);
  if (existing === null || existing.status === "resolved") return 0;
  await tx.anomalies.update({
    ...existing,
    status: "resolved",
    resolved_at: now,
    resolution,
  });
  return 1;
}

export async function applyTeamMappings(repo, input, options = {}) {
  if (!input || typeof input !== "object") {
    throw new Error("Input must be a JSON object");
  }
  const { entries: confirmedMappings } = resolveConfirmedMappings(input);
  const teamUpdates = collectTeamUpdates(input);
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime())
    ? options.now
    : new Date();
  const overwriteMappings = options.allowOverwriteMapping === true;

  return repo.withTransaction(async (tx) => {
    if (!tx.teams || !tx.teamProviderMappings) {
      throw new Error("Repository missing teams or teamProviderMappings port");
    }
    let mappingsInserted = 0;
    let mappingsUpdated = 0;
    let mappingsUnchanged = 0;
    let teamsUpdated = 0;
    let teamsUnchanged = 0;
    let anomaliesResolved = 0;

    for (const entry of confirmedMappings) {
      const { provider, provider_team_id: providerTeamId, team_id: teamId, league_id: providerLeagueId } = entry;
      const team = await tx.teams.findById(teamId);
      if (team === null) {
        throw new Error(`Confirmed mapping points to unknown team_id: ${teamId}`);
      }
      if (providerLeagueId && team.league_id !== providerLeagueId) {
        throw new Error(
          `Confirmed mapping league mismatch for ${provider}:${providerTeamId} (provider=${providerLeagueId}, team=${team.league_id})`,
        );
      }
      const existing = await tx.teamProviderMappings.findByProviderAndExternalId(provider, providerTeamId);
      if (existing === null) {
        await tx.teamProviderMappings.insert({
          schema_version: SCHEMA_VERSION,
          team_id: teamId,
          provider,
          provider_team_id: providerTeamId,
          created_at: now,
          updated_at: now,
        });
        mappingsInserted += 1;
      } else if (existing.team_id === teamId) {
        mappingsUnchanged += 1;
      } else if (overwriteMappings && typeof tx.teamProviderMappings.update === "function") {
        await tx.teamProviderMappings.update({
          ...existing,
          team_id: teamId,
          updated_at: now,
        });
        mappingsUpdated += 1;
      } else {
        throw new Error(
          `Mapping conflict for ${provider}:${providerTeamId} (existing=${existing.team_id}, target=${teamId}); pass --overwrite-mappings to reassign`,
        );
      }

      anomaliesResolved += await resolveTeamAnomalyIfOpen(
        tx,
        missingTeamMappingAnomalyKey(provider, providerTeamId),
        "team_mapping_applied",
        now,
      );
    }

    for (const update of teamUpdates) {
      const team = await tx.teams.findById(update.team_id);
      if (team === null) {
        throw new Error(`Team update points to unknown team_id: ${update.team_id}`);
      }
      const patch = {};
      let changed = false;
      if (Object.prototype.hasOwnProperty.call(update, "name_zh") && (team.name_zh ?? null) !== update.name_zh) {
        patch.name_zh = update.name_zh;
        changed = true;
      }
      if (Object.prototype.hasOwnProperty.call(update, "logo_url") && (team.logo_url ?? null) !== update.logo_url) {
        patch.logo_url = update.logo_url;
        changed = true;
      }
      if (!changed) {
        teamsUnchanged += 1;
        continue;
      }
      patch.updated_at = now;
      if (typeof tx.teams.patchFields === "function") {
        await tx.teams.patchFields(team.team_id, patch);
      } else if (typeof tx.teams.update === "function") {
        await tx.teams.update({ ...team, ...patch });
      } else {
        throw new Error("teams repository does not support update or patchFields");
      }
      teamsUpdated += 1;
      if (typeof patch.name_zh === "string" && patch.name_zh.length > 0) {
        anomaliesResolved += await resolveTeamAnomalyIfOpen(
          tx,
          `${team.team_id}:${ANOMALY_TYPE_PROVIDER_DATA_INVALID}`,
          "team_name_zh_updated",
          now,
        );
      }
    }

    return {
      mode: "apply",
      mappings_inserted: mappingsInserted,
      mappings_updated: mappingsUpdated,
      mappings_unchanged: mappingsUnchanged,
      teams_updated: teamsUpdated,
      teams_unchanged: teamsUnchanged,
      anomalies_resolved: anomaliesResolved,
    };
  });
}

function parseCliArgs(args) {
  const { values } = parseArgs({
    args,
    options: CLI_OPTIONS,
    strict: true,
    allowPositionals: false,
  });
  for (const name of STRING_OPTIONS) {
    const value = values[name];
    if (typeof value === "string" && value.trimStart().startsWith("-")) {
      throw new Error(`--${name} value must not start with -`);
    }
  }
  return values;
}

function requiredEnv(value, message) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(message);
  return value.trim();
}

function printUsage() {
  console.error("Usage: npm run providers:map-teams -- --input <teams-and-provider-samples.json> [--apply] [--overwrite-mappings] [--namespace ...] [--schema ...] [--database-url ...]");
  console.error('Input: { "local_teams": [{ "team_id": "...", "league_id": "premier_league", "name": "Arsenal" }], "provider_teams": [{ "provider": "football_data", "provider_team_id": "57", "league_id": "premier_league", "name": "Arsenal FC" }], "confirmed_mappings": [{ "provider": "football_data", "provider_team_id": "57", "team_id": "..." }], "team_updates": [{ "team_id": "...", "name_zh": "...", "logo_url": "https://..." }] }');
}

export async function main(args = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.log ?? ((payload) => console.log(JSON.stringify(payload, null, 2)));
  const values = parseCliArgs(args);

  if (values.help || !values.input) {
    printUsage();
    process.exitCode = 2;
    return null;
  }

  const apply = values.apply === true;
  if (apply && values["dry-run"] === true) {
    throw new Error("Use either --dry-run or --apply, not both");
  }

  const input = JSON.parse(await readFile(resolve(values.input), "utf8"));
  if (!apply) {
    const report = analyzeTeamMappings(input);
    out(report);
    return report;
  }

  if (deps.repo) {
    const applied = await applyTeamMappings(deps.repo, input, {
      now: deps.now,
      allowOverwriteMapping: values["overwrite-mappings"] === true,
    });
    out(applied);
    return applied;
  }

  const namespace = requiredEnv(
    values.namespace ?? env.FOOTBALL_RESOURCE_NAMESPACE,
    "Provide --namespace or FOOTBALL_RESOURCE_NAMESPACE",
  );
  const schema = requiredEnv(
    values.schema ?? env.FOOTBALL_DATABASE_SCHEMA,
    "Provide --schema or FOOTBALL_DATABASE_SCHEMA",
  );
  const url = requiredEnv(
    values["database-url"] ?? env.FOOTBALL_DATABASE_URL,
    "FOOTBALL_DATABASE_URL or --database-url is required",
  );
  if (!existsSync(join(ROOT, "dist", "gateway", "repository-factory.js"))) {
    throw new Error("dist/ is not built yet; run npm run build first");
  }
  const { createPostgresAppRepository } = await import("../dist/gateway/repository-factory.js");
  const pg = await import("pg");
  const Pg = pg.default ?? pg;
  const pool = new Pg.Pool({ connectionString: url });
  try {
    const repo = createPostgresAppRepository(pool, {
      database_url: url,
      database_schema: schema,
      resource_namespace: namespace,
    });
    const applied = await applyTeamMappings(repo, input, {
      now: deps.now,
      allowOverwriteMapping: values["overwrite-mappings"] === true,
    });
    out(applied);
    return applied;
  } finally {
    await pool.end();
  }
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
