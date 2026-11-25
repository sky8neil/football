const { request } = require("./api.js");

function getLeagueStatus() {
  return request({ method: "GET", path: "/v1/leagues/status", auth: "optional" });
}

module.exports = { getLeagueStatus };
