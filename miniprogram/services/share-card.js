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

function shareCardQuery({ leagueId, seasonId, roundId, shareToken }) {
  const query = {
    league_id: leagueId,
    season_id: seasonId,
    round_id: String(roundId),
  };
  if (typeof shareToken === "string" && shareToken.trim().length > 0) {
    query.share_token = shareToken.trim();
  }
  return query;
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

function getShareCardForUser(userId, { leagueId, seasonId, roundId, shareToken } = {}) {
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
    path: "/v1/share-card/" + encodeURIComponent(userId),
    query: shareCardQuery({ leagueId, seasonId, roundId, shareToken }),
    auth: "optional",
  });
}

module.exports = { getMyShareCard, getShareCardForUser };
