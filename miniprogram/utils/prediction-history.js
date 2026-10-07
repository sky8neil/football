const EIGHT_WEEKS_MS = 8 * 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function hasReachedEightWeekHistory(items, nowMs) {
  const cutoff = nowMs - EIGHT_WEEKS_MS;
  return items.some((item) => {
    const kickoffMs = Date.parse(item.kickoff_at || "");
    return Number.isFinite(kickoffMs) && kickoffMs <= cutoff;
  });
}

function isoWeekKey(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "unknown";
  const date = new Date(time + SHANGHAI_OFFSET_MS);
  const calendarDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = calendarDate.getUTCDay() || 7;
  calendarDate.setUTCDate(calendarDate.getUTCDate() + 4 - weekday);
  const year = calendarDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((calendarDate.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function formatShanghaiKickoff(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function groupPredictionsByWeek(items) {
  const groups = new Map();
  for (const item of items) {
    const key = isoWeekKey(item.kickoff_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([key, entries]) => ({
    key,
    label: key === "unknown" ? "比赛周次未知" : `${key.replace("-W", " 第")}周`,
    items: entries,
  }));
}

module.exports = { formatShanghaiKickoff, groupPredictionsByWeek, hasReachedEightWeekHistory, isoWeekKey };
