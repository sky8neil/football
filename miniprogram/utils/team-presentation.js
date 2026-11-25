const { findTeam } = require("./team-registry.js");
const { getTeamLogo, PLACEHOLDER } = require("./logo-registry.js");

const MISSING_NAME = "球队资料待补全";
const DEFAULT_PLACEHOLDER = typeof PLACEHOLDER === "string" && PLACEHOLDER
  ? PLACEHOLDER
  : "../../assets/logos/placeholders/team-placeholder.png";

function cleanName(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== MISSING_NAME ? trimmed : "";
}

function isLocalLogoHit(logo) {
  if (typeof logo !== "string") return false;
  const trimmed = logo.trim();
  if (!trimmed) return false;
  if (trimmed === DEFAULT_PLACEHOLDER || trimmed === "placeholder.png") return false;
  if (trimmed.endsWith("/team-placeholder.png")) return false;
  return true;
}

function sanitizeLogoUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https:\/\/[^/\s]+/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  return null;
}

function presentTeam(team, leagueId) {
  const teamId = team && team.team_id;
  const serverNameZh = cleanName(team && team.name_zh);
  const found = findTeam(teamId);
  const registryNameZh = cleanName(found && found.name_zh);
  const serverName = cleanName(team && team.name);
  const hasServerName = serverName.length > 0;
  const nameZh = serverNameZh || registryNameZh || (hasServerName ? serverName : MISSING_NAME);
  const missing = serverNameZh.length === 0 && registryNameZh.length === 0 && !hasServerName;
  const logoTeam = (hasServerName || !found)
    ? team
    : Object.assign({}, team, { name: found.source_name });
  const localLogo = getTeamLogo(leagueId, logoTeam);
  const serverLogo = sanitizeLogoUrl(team && team.logo_url);
  const logo = isLocalLogoHit(localLogo)
    ? localLogo
    : (serverLogo || localLogo || DEFAULT_PLACEHOLDER);
  return { teamId, nameZh, logo, missing };
}

module.exports = { presentTeam, sanitizeLogoUrl };
