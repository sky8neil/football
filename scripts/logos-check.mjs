import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const registryPath = resolve(scriptDirectory, "../miniprogram/utils/logo-registry.js");
const registrySource = await readFile(registryPath, "utf8");
const registryModule = { exports: {} };
runInNewContext(registrySource, { module: registryModule, exports: registryModule.exports });
const { getTeamLogo, PLACEHOLDER } = registryModule.exports;
const inputArg = process.argv.indexOf("--input");

if (inputArg < 0 || !process.argv[inputArg + 1]) {
  console.error("Usage: npm run logos:check -- --input <normalized-provider-sample.json>");
  console.error('Input: { "fixtures": [{ "league_id": "premier_league", "teams": [{ "id": "57", "name": "Arsenal FC" }] }] }');
  process.exitCode = 2;
} else {
  const input = JSON.parse(await readFile(resolve(process.argv[inputArg + 1]), "utf8"));
  const fixtures = Array.isArray(input) ? input : input.fixtures;
  if (!Array.isArray(fixtures)) throw new Error("Input must contain a fixtures array");

  const teams = new Map();
  for (const row of fixtures) {
    if (!row || typeof row.league_id !== "string" || !Array.isArray(row.teams)) continue;
    for (const team of row.teams) {
      if (!team || typeof team.name !== "string") continue;
      teams.set(`${row.league_id}:${team.id ?? team.name}`, {
        league_id: row.league_id,
        provider_team_id: team.id == null ? null : String(team.id),
        name: team.name,
        matched: getTeamLogo(row.league_id, team.name) !== PLACEHOLDER,
      });
    }
  }

  const rows = [...teams.values()];
  const unmatched = rows.filter((row) => !row.matched);
  console.log(JSON.stringify({ total: rows.length, matched: rows.length - unmatched.length, unmatched }, null, 2));
  if (unmatched.length > 0) process.exitCode = 1;
}
