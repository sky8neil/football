import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import Module from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const loaded = new Map();

function loadCommonJs(filePath) {
  const filename = resolve(filePath);
  const cached = loaded.get(filename);
  if (cached) return cached.exports;

  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(dirname(filename));
  loaded.set(filename, module);

  const nodeRequire = Module.createRequire(filename);
  module.require = (id) => {
    if (id.startsWith(".")) return loadCommonJs(nodeRequire.resolve(id));
    return nodeRequire(id);
  };
  module._compile(readFileSync(filename, "utf8"), filename);
  module.loaded = true;
  return module.exports;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const { getTeamLogo, PLACEHOLDER } = loadCommonJs(resolve(scriptDirectory, "../miniprogram/utils/logo-registry.js"));
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
