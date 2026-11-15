const DAY_MS = 24 * 60 * 60 * 1000;
const PREMIER_LEAGUE = "premier_league";
const LEAGUE_IDS = [
  PREMIER_LEAGUE,
  "la_liga",
  "serie_a",
  "bundesliga",
  "ligue_1",
  "chinese_super_league",
];

async function resolveDefaultLeague(listMatches, now = new Date()) {
  const time = now.getTime();
  const from = new Date(time - 7 * DAY_MS).toISOString();
  const to = new Date(time + 21 * DAY_MS).toISOString();
  const results = await Promise.all(LEAGUE_IDS.map(async (leagueId) => {
    try {
      const result = await listMatches({ league_id: leagueId, from, to, limit: 20 });
      const items = result && result.statusCode === 200 && result.data && Array.isArray(result.data.items)
        ? result.data.items
        : [];
      return {
        leagueId,
        items,
        hasUpcoming: items.some((item) => item.match_status === "scheduled" || item.match_status === "live"),
      };
    } catch (error) {
      return { leagueId, items: [], hasUpcoming: false };
    }
  }));
  const activeLeagueIds = results.filter((result) => result.hasUpcoming).map((result) => result.leagueId);
  const fallback = results.find((result) => result.items.length > 0);
  return {
    leagueId: activeLeagueIds[0] || (fallback && fallback.leagueId) || PREMIER_LEAGUE,
    activeLeagueIds,
  };
}

module.exports = { resolveDefaultLeague };
