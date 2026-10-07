import { startGatewayServer } from "../dist/gateway/http.js";

process.env.FOOTBALL_ENVIRONMENT ??= "dev";
process.env.FOOTBALL_MATCH_CURSOR_SECRET ??= "local-gateway-cursor-secret";
process.env.FOOTBALL_REPOSITORY_BACKEND ??= "memory";
process.env.FOOTBALL_MOCK_TRUSTED_OPENID ??= "local-dev-openid";
process.env.FOOTBALL_SEED_SCENARIO ??= "normal";

await startGatewayServer({ env: process.env });
