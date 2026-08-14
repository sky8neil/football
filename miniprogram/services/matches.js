const { request } = require("./api.js");

function listMatches(query) {
  const nextQuery = {};
  if (query && typeof query === "object") {
    ["from", "to", "status", "limit", "cursor"].forEach((key) => {
      if (query[key] !== undefined && query[key] !== null) {
        nextQuery[key] = query[key];
      }
    });
  }
  return request({
    method: "GET",
    path: "/v1/matches",
    query: nextQuery,
  });
}

function getMatchDetail(matchId) {
  return request({
    method: "GET",
    path: "/v1/matches/" + matchId,
  });
}

module.exports = {
  listMatches,
  getMatchDetail,
};
