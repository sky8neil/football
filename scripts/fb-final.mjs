import { loadGatewayRuntimeConfig } from "../dist/gateway/config.js";
import { createApplicationRuntime } from "../dist/runtime/application-runtime.js";
import { createVpsRuntime } from "../dist/runtime/vps-runtime.js";
const config = loadGatewayRuntimeConfig(process.env);
const vps = createVpsRuntime({ postgres: config.postgres_repository });
const rt = createApplicationRuntime({ env: process.env, db: vps.db, namespace: config.postgres_repository.resource_namespace, repo: vps.repo, matchCursorSecret: config.match_cursor_secret, log: () => {} });
const now = new Date();
try {
  for (const season of ["2024_2025", "2025_2026"]) {
    try { const s = await rt.boardSnapshot.generateSeasonFinal(season, now); console.log("final", season, s.length); }
    catch (e) { console.log("final-err", season, (e && e.message || e).slice(0, 200)); }
  }
  const s = await rt.boardSnapshot.generate("season", now);
  console.log("season-head", s.length);
} finally { await vps.close(); }
