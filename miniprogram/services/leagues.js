const { request } = require("./api.js");

function getLeagueStatus() {
  return request({ method: "GET", path: "/v1/leagues/status" });
}

module.exports = { getLeagueStatus };
