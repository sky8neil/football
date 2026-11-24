function formatRound(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return "";
    return `第 ${value} 轮`;
  }
  const text = String(value).trim();
  if (!text) return "";
  if (/^\d+$/.test(text)) return `第 ${Number(text)} 轮`;
  return text;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatKickoff(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  const d = new Date(time + SHANGHAI_OFFSET_MS);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日${WEEKDAYS[d.getUTCDay()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function formatShanghaiDate(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  const d = new Date(time + SHANGHAI_OFFSET_MS);
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}`;
}

module.exports = { formatRound, formatKickoff, formatShanghaiDate };
