const { request } = require("./api.js");

function listLeagueSeasons({ leagueId } = {}) {
  const options = {
    method: "GET",
    path: "/v1/league-seasons",
    auth: "optional",
  };
  if (leagueId) options.query = { league_id: leagueId };
  return request(options);
}

module.exports = { listLeagueSeasons };
