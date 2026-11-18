const REASON_TEXT = {
  AUTH_REQUIRED: "需登录后预测",
  USER_DELETED: "账号已注销",
  KICKOFF_UNCONFIRMED: "开球未确认",
  NOT_SCHEDULED: "非可预测赛程",
  CLOSED: "预测已关闭",
};

const CLOSED_STATUSES = {
  postponed: "延期",
  cancelled: "取消",
  abandoned: "腰斩",
};

function predPair(submitted) {
  const home = submitted.pred_home_score !== undefined ? submitted.pred_home_score : submitted.home;
  const away = submitted.pred_away_score !== undefined ? submitted.pred_away_score : submitted.away;
  return `${home} : ${away}`;
}

function hasCompleteScore(item) {
  return item.regular_home_score != null && item.regular_away_score != null;
}

function buildPredText(submitted, showPredict) {
  if (submitted) {
    const pair = predPair(submitted);
    if (submitted.match_score != null) return `我的预测 ${pair} · 得分 +${submitted.match_score}`;
    return `已提交 ${pair} · 不可修改`;
  }
  if (showPredict) return "";
  return "未预测";
}

function buildCardState(item, submitted) {
  const match = item || {};
  const reason = match.can_predict_reason;
  const displayTime = match.display_time || "";
  const hasSubmitted = submitted != null;
  let cardClass = "is-closed";
  let stateClass = "closed";
  let stateText = "未开赛";
  let scoreSub = displayTime;
  let chipText = "";
  let chipClass = "";
  let showPredict = false;

  if (match.match_status === "live") {
    cardClass = "is-live";
    stateClass = "live";
    stateText = "进行中";
    scoreSub = "LIVE";
  } else if (match.match_status === "finished") {
    cardClass = "is-done";
    stateClass = "done";
    stateText = "已结束";
    scoreSub = hasCompleteScore(match) && hasSubmitted ? "FT" : "待结算";
  } else if (CLOSED_STATUSES[match.match_status]) {
    cardClass = "is-closed";
    stateClass = "closed";
    stateText = CLOSED_STATUSES[match.match_status];
    scoreSub = displayTime;
  } else if (match.match_status === "scheduled" && match.can_predict && reason === null && !hasSubmitted) {
    cardClass = "is-open";
    stateClass = "";
    stateText = "未开赛";
    scoreSub = displayTime;
    showPredict = true;
  } else if (match.match_status === "scheduled" && (reason === "ALREADY_SUBMITTED" || hasSubmitted)) {
    cardClass = "is-submitted";
    stateClass = "lock";
    stateText = "未开赛";
    scoreSub = displayTime;
  } else {
    cardClass = "is-closed";
    stateClass = "closed";
    stateText = "未开赛";
    scoreSub = displayTime;
    if (reason && REASON_TEXT[reason]) {
      chipText = REASON_TEXT[reason];
      chipClass = "closed";
    }
  }

  return {
    cardClass,
    stateClass,
    stateText,
    scoreSub,
    predText: buildPredText(hasSubmitted ? submitted : null, showPredict),
    chipText,
    chipClass,
    showPredict,
  };
}

module.exports = { buildCardState, REASON_TEXT };
