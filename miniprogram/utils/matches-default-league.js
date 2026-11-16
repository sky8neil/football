const PREMIER_LEAGUE = "premier_league";
const ACTIVE_PHASES = ["in_season", "break"];

/** 按后端联赛阶段选择默认联赛：优先直播中，其次最早待赛开球；无候选时保留英超默认。 */
function resolveDefaultLeagueFromStatus(items) {
  const list = Array.isArray(items) ? items : [];
  const activeLeagueIds = list
    .filter((item) => ACTIVE_PHASES.includes(item.phase))
    .map((item) => item.league_id);
  const live = list.find((item) => item.has_live_match === true);
  const next = list
    .filter((item) => item.next_kickoff_at)
    .sort((first, second) => new Date(first.next_kickoff_at) - new Date(second.next_kickoff_at))[0];
  return { leagueId: (live || next || {}).league_id || PREMIER_LEAGUE, activeLeagueIds };
}

module.exports = { resolveDefaultLeagueFromStatus };
