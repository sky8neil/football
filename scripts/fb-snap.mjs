import { loadGatewayRuntimeConfig } from "../dist/gateway/config.js";
import { createApplicationRuntime } from "../dist/runtime/application-runtime.js";
import { createVpsRuntime } from "../dist/runtime/vps-runtime.js";
const config = loadGatewayRuntimeConfig(process.env);
const vps = createVpsRuntime({ postgres: config.postgres_repository });
const rt = createApplicationRuntime({ env: process.env, db: vps.db, namespace: config.postgres_repository.resource_namespace, repo: vps.repo, matchCursorSecret: config.match_cursor_secret, log: () => {} });
const now = new Date();
try {
  for (const board of ["career", "strength", "season"]) {
    try { const s = await rt.boardSnapshot.generate(board, now); console.log("ok", board, s.length); }
    catch (e) { console.log("err", board, (e && e.message || e).slice(0, 200)); }
  }
} finally { await vps.close(); }
