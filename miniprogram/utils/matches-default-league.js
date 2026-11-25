const PREMIER_LEAGUE = "premier_league";
const ACTIVE_PHASES = ["in_season", "break"];

/** 按后端联赛阶段选择默认联赛：仅在活跃阶段内优先直播中，其次最早待赛开球；兜底首个活跃联赛或英超。 */
function resolveDefaultLeagueFromStatus(items) {
  const list = Array.isArray(items) ? items : [];
  const activeItems = list.filter((item) => ACTIVE_PHASES.includes(item.phase));
  const activeLeagueIds = activeItems.map((item) => item.league_id);
  const live = activeItems.find((item) => item.has_live_match === true);
  const next = activeItems
    .filter((item) => item.next_kickoff_at)
    .sort((first, second) => new Date(first.next_kickoff_at) - new Date(second.next_kickoff_at))[0];
  return {
    leagueId: (live || next || {}).league_id || activeLeagueIds[0] || PREMIER_LEAGUE,
    activeLeagueIds,
  };
}

module.exports = { resolveDefaultLeagueFromStatus };
