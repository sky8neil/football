const { findTeam } = require("./team-registry.js");
const { getTeamLogo } = require("./logo-registry.js");

const MISSING_NAME = "球队资料待补全";

function presentTeam(team, leagueId) {
  const teamId = team && team.team_id;
  const found = findTeam(teamId);
  const registryNameZh = found && typeof found.name_zh === "string" && found.name_zh.trim()
    ? found.name_zh.trim()
    : "";
  const serverName = team && typeof team.name === "string" ? team.name.trim() : "";
  const hasServerName = serverName.length > 0 && serverName !== MISSING_NAME;
  const nameZh = registryNameZh || (hasServerName ? serverName : MISSING_NAME);
  const missing = registryNameZh.length === 0 && !hasServerName;
  const logoTeam = (hasServerName || !found)
    ? team
    : Object.assign({}, team, { name: found.source_name });
  const logo = getTeamLogo(leagueId, logoTeam);
  return { teamId, nameZh, logo, missing };
}

module.exports = { presentTeam };
