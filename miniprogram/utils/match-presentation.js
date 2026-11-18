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

function formatKickoff(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

module.exports = { formatRound, formatKickoff };
