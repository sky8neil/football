module.exports = {
  // develop defaults to the local gateway; switch to cloud for cloud-function testing.
  transport: "http",
  gatewayOrigin: "http://127.0.0.1:8787",
  cloudEnvId: "cloud1-d4ga6fvm0c6d4ec01",
  cloudFunctionName: "api",
  rankingThinBoardThreshold: 20,
  rankingWeekWindow: 4,
  // Keep aligned with src/domain/config.ts; replace before launch, then append only.
  rankingFirstPeriodKey: "2026-W31",
};
