const DAY_MS = 24 * 60 * 60 * 1000;
const PREMIER_LEAGUE = "premier_league";
const CHINESE_SUPER_LEAGUE = "chinese_super_league";

async function resolveDefaultLeague(listMatches, now = new Date()) {
  const time = now.getTime();
  const pastSevenDays = new Date(time - 7 * DAY_MS).toISOString();
  const current = new Date(time).toISOString();
  const futureTwentyOneDays = new Date(time + 21 * DAY_MS).toISOString();
  const premier = await listMatches({
    league_id: PREMIER_LEAGUE,
    from: pastSevenDays,
    to: futureTwentyOneDays,
    limit: 100,
  });
  const premierItems = premier.statusCode === 200 && premier.data && Array.isArray(premier.data.items)
    ? premier.data.items
    : [];
  if (premierItems.length > 0) return PREMIER_LEAGUE;

  const chinese = await listMatches({
    league_id: CHINESE_SUPER_LEAGUE,
    from: current,
    to: futureTwentyOneDays,
    limit: 100,
  });
  const chineseItems = chinese.statusCode === 200 && chinese.data && Array.isArray(chinese.data.items)
    ? chinese.data.items
    : [];
  return chineseItems.length > 0 ? CHINESE_SUPER_LEAGUE : PREMIER_LEAGUE;
}

module.exports = { resolveDefaultLeague };
