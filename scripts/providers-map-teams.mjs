import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function normalize(name) {
  return String(name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\b(football club|fc|afc)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function mappingKey(mapping) {
  return `${mapping.provider}:${String(mapping.provider_team_id)}`;
}

const inputArg = process.argv.indexOf("--input");
if (inputArg < 0 || !process.argv[inputArg + 1]) {
  console.error("Usage: npm run providers:map-teams -- --input <teams-and-provider-samples.json>");
  console.error('Input: { "local_teams": [{ "team_id": "...", "league_id": "premier_league", "name": "Arsenal" }], "provider_teams": [{ "provider": "football_data", "provider_team_id": "57", "league_id": "premier_league", "name": "Arsenal FC" }], "confirmed_mappings": [{ "provider": "football_data", "provider_team_id": "57", "team_id": "..." }] }');
  process.exitCode = 2;
} else {
  const input = JSON.parse(await readFile(resolve(process.argv[inputArg + 1]), "utf8"));
  if (!Array.isArray(input.local_teams) || !Array.isArray(input.provider_teams)) {
    throw new Error("Input must contain local_teams and provider_teams arrays");
  }

  const localByName = new Map();
  const localById = new Map(input.local_teams.map((team) => [String(team.team_id), team]));
  for (const team of input.local_teams) {
    const name = normalize(team.name);
    if (!name) continue;
    const key = `${team.league_id}:${name}`;
    localByName.set(key, [...(localByName.get(key) ?? []), team]);
  }
  const confirmedMappings = new Map();
  for (const mapping of input.confirmed_mappings ?? []) {
    const key = mappingKey(mapping);
    const teamId = String(mapping.team_id);
    const entry = confirmedMappings.get(key) ?? { teamIds: [] };
    if (!entry.teamIds.includes(teamId)) entry.teamIds.push(teamId);
    confirmedMappings.set(key, entry);
  }
  const report = input.provider_teams.map((team) => {
    const normalizedName = normalize(team.name);
    const candidates = normalizedName ? (localByName.get(`${team.league_id}:${normalizedName}`) ?? []) : [];
    const key = mappingKey(team);
    const mapping = confirmedMappings.get(key);
    const mappingTeamIds = [...(mapping?.teamIds ?? [])];
    if (team.confirmed_team_id !== undefined && team.confirmed_team_id !== null) {
      const teamId = String(team.confirmed_team_id);
      if (!mappingTeamIds.includes(teamId)) mappingTeamIds.push(teamId);
    }
    const mappingConflict = mappingTeamIds.length > 1;
    const mappedTeamId = mappingTeamIds.length === 1 ? mappingTeamIds[0] : null;
    const mappedTeam = mappedTeamId === null ? null : localById.get(mappedTeamId) ?? null;
    const missingTarget = mappedTeamId !== null && mappedTeam === null;
    const mappingLeagueMismatch = mappedTeam !== null && mappedTeam.league_id !== team.league_id;
    const mappingError = mappingConflict
      ? "conflict"
      : missingTarget
        ? "missing_target"
        : mappingLeagueMismatch
          ? "league_mismatch"
          : null;
    const confirmed = mappingError === null && mappedTeam !== null ? mappedTeam : null;
    const suggestion = candidates.length === 1 ? candidates[0] : null;
    const status = mappingError
      ?? (confirmed ? "confirmed" : candidates.length > 1 ? "ambiguous" : candidates.length === 1 ? "review" : "unmatched");
    return {
      provider: team.provider,
      provider_team_id: String(team.provider_team_id),
      league_id: team.league_id,
      provider_name: team.name,
      status,
      team_id: confirmed?.team_id ?? null,
      suggested_team_id: suggestion?.team_id ?? null,
      local_name: confirmed?.name ?? suggestion?.name ?? null,
      name_matches: confirmed ? normalizedName !== "" && normalize(confirmed.name) === normalizedName : null,
      mapping_league_mismatch: mappingLeagueMismatch,
      mapping_error: mappingError,
      mapping_team_ids: mappingTeamIds,
    };
  });
  console.log(JSON.stringify({
    confirmed: report.filter((row) => row.status === "confirmed").length,
    review: report.filter((row) => row.status === "review").length,
    ambiguous: report.filter((row) => row.status === "ambiguous").length,
    unmatched: report.filter((row) => row.status === "unmatched").length,
    conflict: report.filter((row) => row.status === "conflict").length,
    missing_target: report.filter((row) => row.status === "missing_target").length,
    league_mismatch: report.filter((row) => row.status === "league_mismatch").length,
    mappings: report,
  }, null, 2));
}
