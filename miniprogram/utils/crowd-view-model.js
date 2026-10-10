const { COPY, RESULT_NAMES } = require("./crowd-copy.js");

const TERMINAL_STATUSES = ["postponed", "cancelled", "abandoned"];
const RESULT_KEYS = ["home", "draw", "away"];
const RESULT_CODES = { HOME: "home", DRAW: "draw", AWAY: "away" };

function crowdPlan({ match, identityMissing }) {
  if (!match || TERMINAL_STATUSES.includes(match.match_status)) return "hidden";
  if (identityMissing) return "guest";
  if (
    match.match_status === "scheduled" &&
    (match.can_predict_reason === null || match.can_predict_reason === "ALREADY_SUBMITTED")
  ) return "locked";
  return "fetch";
}

function resultKey(result) {
  return RESULT_CODES[result] || (RESULT_KEYS.includes(result) ? result : null);
}

function crowdComparison({ distribution, myChoice, actualResult, matchStatus }) {
  if (matchStatus !== "finished" || !actualResult || !distribution) return null;
  const actualKey = resultKey(actualResult);
  if (!actualKey) return null;
  const actualName = RESULT_NAMES[actualKey];
  const choiceKey = resultKey(myChoice);
  let text;
  if (!choiceKey) {
    text = COPY.comparisonNoPrediction(actualName, distribution[actualKey]);
  } else if (choiceKey === actualKey) {
    text = COPY.comparisonSame(actualName, distribution[actualKey]);
  } else {
    text = COPY.comparisonDifferent(actualName, distribution[choiceKey]);
  }
  return { text, actualKey };
}

function crowdCard({ response, match, myPrediction }) {
  const data = response && response.data ? response.data : response;
  if (!data || data.status === "unavailable") return { kind: "hidden" };
  if (data.status === "not_closed") {
    return { kind: "locked", message: COPY.locked };
  }
  if (data.status === "insufficient") {
    return { kind: "insufficient", message: COPY.insufficient(data.min_predictions) };
  }
  if (data.status !== "available" || !data.distribution) return { kind: "hidden" };

  const choiceKey = resultKey(myPrediction && myPrediction.derived_result);
  const comparison = crowdComparison({
    distribution: data.distribution,
    myChoice: choiceKey,
    actualResult: match && match.regular_home_score !== null && match.regular_home_score !== undefined &&
      match.regular_away_score !== null && match.regular_away_score !== undefined
      ? (Number(match.regular_home_score) > Number(match.regular_away_score)
        ? "HOME"
        : Number(match.regular_home_score) < Number(match.regular_away_score) ? "AWAY" : "DRAW")
      : null,
    matchStatus: match && match.match_status,
  });
  return {
    kind: "available",
    segments: RESULT_KEYS.filter((key) => data.distribution[key] > 0).map((key) => ({
      key,
      name: RESULT_NAMES[key],
      percent: data.distribution[key],
      width: `${data.distribution[key]}%`,
      selected: choiceKey === key,
      actual: Boolean(comparison && comparison.actualKey === key),
    })),
    comparisonText: comparison ? comparison.text : "",
    footer: COPY.footer,
    granularity: data.granularity,
  };
}

module.exports = { crowdPlan, crowdCard, crowdComparison };
