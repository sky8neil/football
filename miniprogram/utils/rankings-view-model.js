const { rankingThinBoardThreshold, rankingWeekWindow, rankingFirstPeriodKey } =
  require("../config.js");
const COPY = require("./rankings-copy.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const VALID_BOARDS = ["week", "career", "strength", "season"];

function mondayOfIsoWeek(key) {
  const match = /^(\d{4})-W(\d{2})$/.exec(key || "");
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const mondayOffset = (jan4.getUTCDay() + 6) % 7;
  return Date.UTC(year, 0, 4) - mondayOffset * DAY_MS + (week - 1) * WEEK_MS;
}

function isoWeekKeyForMonday(mondayMs) {
  const thursday = new Date(mondayMs + 3 * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const firstMonday = Date.UTC(isoYear, 0, 4) - ((jan4.getUTCDay() + 6) % 7) * DAY_MS;
  const week = Math.floor((mondayMs - firstMonday) / WEEK_MS) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function formatWeekRange(mondayMs) {
  const start = new Date(mondayMs);
  const end = new Date(mondayMs + 6 * DAY_MS);
  return `${start.getUTCMonth() + 1}.${start.getUTCDate()}-${end.getUTCMonth() + 1}.${end.getUTCDate()}`;
}

function buildWeekOptions(currentPeriodKey, firstPeriodKey) {
  const monday = mondayOfIsoWeek(currentPeriodKey);
  const firstMonday = mondayOfIsoWeek(firstPeriodKey || rankingFirstPeriodKey);
  if (monday === null || firstMonday === null) return [];
  const options = [];
  for (let offset = 0; offset < rankingWeekWindow; offset += 1) {
    const key = isoWeekKeyForMonday(monday - offset * WEEK_MS);
    if (mondayOfIsoWeek(key) < firstMonday) break;
    options.push({
      key,
      label: key === currentPeriodKey ? COPY.currentWeek : formatWeekRange(monday - offset * WEEK_MS),
      current: key === currentPeriodKey,
    });
  }
  return options;
}

function formatUpdatedAt(updatedAt, serverNow) {
  const updatedMs = Date.parse(updatedAt || "");
  const nowMs = Date.parse(serverNow || "");
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) return "";
  const minutes = Math.max(0, Math.floor((nowMs - updatedMs) / 60_000));
  if (minutes < 1) return COPY.updatedNow;
  if (minutes < 60) return COPY.updatedMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return COPY.updatedHours(hours);
  return COPY.updatedDays(Math.floor(hours / 24));
}

function seasonStartAt(levelSeasonId) {
  const match = /^(\d{4})_(\d{4})$/.exec(levelSeasonId || "");
  if (!match || Number(match[2]) !== Number(match[1]) + 1) return null;
  return Date.UTC(Number(match[1]), 6, 1) - 8 * 60 * 60 * 1000;
}

function currentSeasonId(serverNow) {
  const time = Date.parse(serverNow || "");
  if (!Number.isFinite(time)) return null;
  const beijing = new Date(time + 8 * 60 * 60 * 1000);
  const year = beijing.getUTCMonth() >= 6 ? beijing.getUTCFullYear() : beijing.getUTCFullYear() - 1;
  return `${year}_${year + 1}`;
}

function isInSeasonOpeningWindow(levelSeasonId, serverNow) {
  const start = seasonStartAt(levelSeasonId);
  const now = Date.parse(serverNow || "");
  return start !== null && Number.isFinite(now) && now >= start && now < start + 28 * DAY_MS;
}

function buildStandingStatus(input = {}) {
  const me = input.me;
  const scope = input.scope || "global";
  if (me == null || typeof me !== "object") {
    return COPY.standingNeutral;
  }
  if (me.status === "ranked") {
    const place = scope === "group" ? "群内" : "全站";
    if (Number.isSafeInteger(me.rank) && me.rank <= 20) {
      return `你位于${place}第 ${me.rank} 名。`;
    }
    if (me.top_percent != null) {
      return `你位于${place}前 ${me.top_percent}%。`;
    }
    return "已入榜。";
  }
  if (me.status === "below_threshold") {
    return `还差 ${me.remaining_valid_predictions} 场有效预测参与排名。`;
  }
  if (me.status === "not_eligible") {
    return "参与满 2 个等级赛季后开放。";
  }
  return COPY.standingNeutral;
}

function buildRankingViewModel(input = {}) {
  const payload = input.payload || {};
  const board = input.board || payload.board || "week";
  const scope = input.scope || payload.scope || "global";
  const count = Number.isSafeInteger(payload.entry_count) && payload.entry_count >= 0
    ? payload.entry_count
    : Array.isArray(payload.items) ? payload.items.length : 0;
  const availableBoards = Array.isArray(payload.available_boards)
    ? payload.available_boards.filter((item) => VALID_BOARDS.includes(item))
    : ["week", "career", "strength"];
  const notices = [];
  if (board === "career" && (payload.seasons_participated || 0) < 2) {
    notices.push({ kind: "first-season", text: COPY.firstSeasonCareer });
  }
  if (board === "season" && payload.is_provisional === true) {
    notices.push({ kind: "provisional", text: COPY.awaitingFinal });
  } else if (
    board === "season" &&
    payload.level_season_id === currentSeasonId(input.serverNow) &&
    isInSeasonOpeningWindow(payload.level_season_id, input.serverNow)
  ) {
    notices.push({ kind: "season-start", text: COPY.seasonStarting });
  }
  if ((scope === "global" && count < rankingThinBoardThreshold) ||
      (scope === "group" && count <= 1)) {
    notices.push({
      kind: "invite",
      text: scope === "group" ? COPY.inviteGroup : COPY.inviteGlobal,
    });
  }
  const previousSeason = input.previousSeason;
  const recapStart = seasonStartAt(currentSeasonId(input.serverNow));
  const now = Date.parse(input.serverNow || "");
  const showRecap = previousSeason !== null && previousSeason !== undefined &&
    recapStart !== null && Number.isFinite(now) && now >= recapStart && now < recapStart + 28 * DAY_MS &&
    input.currentSeasonRanked !== true;
  const emptyKind = count > 0
    ? "none"
    : board === "week" && scope === "global"
      ? "week_global"
      : board === "week" && scope === "group"
        ? "week_group"
        : "generic";
  const titleKind = count >= rankingThinBoardThreshold
    ? "top20"
    : count > 0 ? "all_n" : "none";
  const boardName = COPY.boardNames[board] || COPY.pageTitle;
  const emptyText = emptyKind === "week_global"
    ? COPY.emptyGlobal(boardName)
    : emptyKind === "week_group"
      ? COPY.emptyGroup(boardName)
      : emptyKind === "generic"
        ? (board === "strength" ? COPY.emptyStrength(boardName) : COPY.emptyBoard(boardName))
        : "";
  return {
    currentLevelSeasonId: currentSeasonId(input.serverNow),
    tabs: availableBoards,
    weekOptions: buildWeekOptions(
      payload.current_period_key,
      input.firstPeriodKey || payload.first_period_key || rankingFirstPeriodKey,
    ),
    showPodium: count >= 3,
    listTitleKind: titleKind,
    listTitle: titleKind === "top20"
      ? scope === "group" ? COPY.groupTop : COPY.globalTop
      : titleKind === "all_n" ? COPY.allPeople(count) : "",
    emptyKind,
    emptyText,
    standingStatus: buildStandingStatus({ me: payload.me, scope }),
    notices,
    updatedText: formatUpdatedAt(payload.updated_at, input.serverNow),
    guestPlaceholder: input.guest === true,
    showGroupLocked: input.hasGroups === false,
    showRecap,
    recapText: showRecap ? COPY.recap(previousSeason.points, previousSeason.best_level) : "",
  };
}

module.exports = {
  buildWeekOptions,
  buildRankingViewModel,
  buildStandingStatus,
  currentSeasonId,
  formatUpdatedAt,
  isInSeasonOpeningWindow,
};
