function formatLevelSeasonLabel(seasonId) {
  const match = /^(\d{4})_(\d{4})$/.exec(seasonId || "");
  if (!match) return "";
  return `${match[1]}—${match[2]} 赛季`;
}

module.exports = { formatLevelSeasonLabel };
