const { request } = require("./api.js");

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isTwoDigitRoundId(value) {
  return /^\d{2}$/.test(String(value));
}

function validationError(message) {
  return Promise.resolve({
    statusCode: 422,
    code: "VALIDATION_ERROR",
    message,
  });
}

function shareCardQuery({ leagueId, seasonId, roundId }) {
  return {
    league_id: leagueId,
    season_id: seasonId,
    round_id: String(roundId),
  };
}

function getMyShareCard({ leagueId, seasonId, roundId } = {}) {
  if (!isNonEmptyString(leagueId)) {
    return validationError("缺少 leagueId");
  }
  if (!isNonEmptyString(seasonId)) {
    return validationError("缺少 seasonId");
  }
  if (!isTwoDigitRoundId(roundId)) {
    return validationError("roundId 必须是两位数字字符串");
  }
  return request({
    method: "GET",
    path: "/v1/share-card/me",
    query: shareCardQuery({ leagueId, seasonId, roundId }),
  });
}

function getShareCardForUser(userId, { leagueId, seasonId, roundId } = {}) {
  if (!isNonEmptyString(userId)) {
    return validationError("缺少 userId");
  }
  if (!isNonEmptyString(leagueId)) {
    return validationError("缺少 leagueId");
  }
  if (!isNonEmptyString(seasonId)) {
    return validationError("缺少 seasonId");
  }
  if (!isTwoDigitRoundId(roundId)) {
    return validationError("roundId 必须是两位数字字符串");
  }
  return request({
    method: "GET",
    path: "/v1/share-card/" + userId,
    query: shareCardQuery({ leagueId, seasonId, roundId }),
    auth: "optional",
  });
}

module.exports = { getMyShareCard, getShareCardForUser };
