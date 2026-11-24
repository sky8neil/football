const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad2(value) {
  return String(value).padStart(2, "0");
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
  const date = new Date(time + SHANGHAI_OFFSET_MS);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日${WEEKDAYS[date.getUTCDay()]} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
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

module.exports = { formatShanghaiKickoff, groupPredictionsByWeek, isoWeekKey };
