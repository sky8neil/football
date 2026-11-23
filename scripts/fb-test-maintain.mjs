import { loadGatewayRuntimeConfig } from "../dist/gateway/config.js";
import { createApplicationRuntime } from "../dist/runtime/application-runtime.js";
import { createVpsRuntime } from "../dist/runtime/vps-runtime.js";

const config = loadGatewayRuntimeConfig(process.env);
if (!config.postgres_repository) throw new Error("需要 PostgreSQL 配置");
const vps = createVpsRuntime({ postgres: config.postgres_repository });
const rt = createApplicationRuntime({
  env: process.env,
  db: vps.db,
  namespace: config.postgres_repository.resource_namespace,
  repo: vps.repo,
  matchCursorSecret: config.match_cursor_secret,
  log: () => {},
});
const now = new Date();
try {
  const out = await rt.weeklyLevelEval.run(now);
  console.log("levelEval", JSON.stringify(out));
  for (const board of ["career", "strength", "season"]) {
    try {
      const snaps = await rt.boardSnapshot.generate(board, now);
      console.log("snapshot", board, snaps.length);
    } catch (e) {
      console.log("snapshot-error", board, String(e && e.message || e).slice(0, 160));
    }
  }
} finally {
  await vps.close();
}
