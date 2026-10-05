const { request } = require("./api.js");

function listRankings(query) {
  const nextQuery = { board: query && query.board ? query.board : "week" };
  if (query && typeof query === "object") {
    if (query.periodKey !== undefined && query.periodKey !== null) {
      nextQuery.period_key = query.periodKey;
    }
    if (query.limit !== undefined && query.limit !== null) {
      nextQuery.limit = query.limit;
    }
    if (query.cursor !== undefined && query.cursor !== null) {
      nextQuery.cursor = query.cursor;
    }
  }
  return request({
    method: "GET",
    path: "/v1/rankings",
    query: nextQuery,
  });
}

module.exports = {
  listRankings,
};
