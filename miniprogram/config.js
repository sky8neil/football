module.exports = {
  // 自建 VPS 网关（PostgreSQL 持久化）。小程序端经 HTTPS 域名直连网关。
  // 切回 CloudBase 时把 transport 改为 "cloud"，其余键保持不变。
  transport: "http",
  gatewayOrigin: "https://football.803866.xyz",
  cloudEnvId: "footballfree-d2gzh9xzve789c41a",
  cloudFunctionName: "api",
  rankingThinBoardThreshold: 20,
  rankingWeekWindow: 4,
  // Keep aligned with src/domain/config.ts; replace before launch, then append only.
  rankingFirstPeriodKey: "2026-W31",
};
