const { findTeam } = require("./team-registry.js");
const { getTeamLogo } = require("./logo-registry.js");

const MISSING_NAME = "球队资料待补全";

function presentTeam(team, leagueId) {
  const teamId = team && team.team_id;
  const found = findTeam(teamId);
  const nameZh = found && found.name_zh ? found.name_zh : MISSING_NAME;
  const missing = !found || !found.name_zh;
  const logo = getTeamLogo(leagueId, team);
  return { teamId, nameZh, logo, missing };
}

module.exports = { presentTeam };
