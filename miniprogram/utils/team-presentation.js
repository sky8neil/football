const { findTeam } = require("./team-registry.js");
const { getTeamLogo } = require("./logo-registry.js");

const MISSING_NAME = "球队资料待补全";

function presentTeam(team, leagueId) {
  const teamId = team && team.team_id;
  const found = findTeam(teamId);
  const nameZh = found && found.name_zh ? found.name_zh : MISSING_NAME;
  const missing = !found || !found.name_zh;
  const hasName = Boolean(team && team.name);
  const logoTeam = hasName || !found
    ? team
    : Object.assign({}, team, { name: found.source_name });
  const logo = getTeamLogo(leagueId, logoTeam);
  return { teamId, nameZh, logo, missing };
}

module.exports = { presentTeam };
