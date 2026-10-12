import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function normalize(name) {
  return String(name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\b(football club|fc|afc)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
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
  const localById = new Map(input.local_teams.map((team) => [team.team_id, team]));
  for (const team of input.local_teams) {
    const key = `${team.league_id}:${normalize(team.name)}`;
    localByName.set(key, [...(localByName.get(key) ?? []), team]);
  }
  const confirmedMappings = new Map((input.confirmed_mappings ?? []).map((mapping) => [
    `${mapping.provider}:${String(mapping.provider_team_id)}`,
    mapping.team_id,
  ]));
  const report = input.provider_teams.map((team) => {
    const candidates = localByName.get(`${team.league_id}:${normalize(team.name)}`) ?? [];
    const mappedTeamId = confirmedMappings.get(`${team.provider}:${String(team.provider_team_id)}`) ?? team.confirmed_team_id;
    const mappedTeam = mappedTeamId ? localById.get(mappedTeamId) : null;
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
  console.log(JSON.stringify({
    confirmed: report.filter((row) => row.status === "confirmed").length,
    review: report.filter((row) => row.status === "review").length,
    ambiguous: report.filter((row) => row.status === "ambiguous").length,
    unmatched: report.filter((row) => row.status === "unmatched").length,
    mappings: report,
  }, null, 2));
}
