# Cloud Function Deployment (S16/S17)

代码侧已实现云函数调用、CloudBase 仓储适配器与诊断动作。**尚未在微信开发者工具或真实 `cloud1` 环境部署验证**；SDK 行为、事务能力表与体验版登录流程仍待真环境验收。

## Build and Upload

1. Run `npm run cloudfunction:build`. The compiled entry is `cloudfunctions/api/dist/cloud-function/runtime.js`, imported application modules and `build-info.json` are emitted under the same `dist/` directory. The diagnostic action reports that build timestamp.
2. In WeChat Developer Tools, upload `cloudfunctions/api/` as the `api` cloud function and choose cloud-side dependency installation. The package pins `wx-server-sdk` to `4.0.2` in its package manifest and lockfile.
3. Set the cloud function environment variables in the CloudBase console. For the confirmed test environment, use the values recorded in the development plan; set `FOOTBALL_MATCH_CURSOR_SECRET` only in the console.
4. Set `miniprogram/config.js` to `transport: "cloud"`, the registered test `cloudEnvId`, and `cloudFunctionName: "api"` for a local cloud-function test. The committed configuration currently defaults to the local HTTP gateway for development.

The cloud entry calls `cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })`, gets the database and runtime WeChat identity from `wx-server-sdk`, then constructs the runtime. It does not accept identity from the event body or query. The runtime fails at startup for missing required configuration, a memory repository backend, or a production mock identity; it never falls back to memory storage.

## Required Environment Keys

| Key | Requirement |
| --- | --- |
| `FOOTBALL_ENVIRONMENT` | `dev`, `test`, or `prod` |
| `FOOTBALL_MATCH_CURSOR_SECRET` | Required; store only in the CloudBase console |
| `FOOTBALL_REPOSITORY_BACKEND` | `cloudbase` |
| `FOOTBALL_CLOUD_ENVIRONMENT_ID` | Must match the runtime CloudBase environment |
| `FOOTBALL_RESOURCE_NAMESPACE` | Separate namespace for each environment, such as `football_test` |
| `FOOTBALL_MOCK_TRUSTED_OPENID` | Optional for local unit tests; production startup rejects a non-empty value |

## Schema and Diagnostics

Run `npm run cloudbase:schema -- --namespace football_test` to print the business collections, diagnostic and shared rate-limit collections, and all unique/query indexes. The command does not connect to CloudBase. Create these manually in the console before deploying.

Run `{ "action": "diag" }` as a cloud-function test in `dev` or `test`. The report checks required environment keys, runtime environment ID, namespace suffix, collection availability, a read/write probe, transaction availability, identity presence, and versions. It does not reveal the OPENID or environment-variable values. It explicitly leaves index verification to the console. The action returns a generic 404 in `prod`.

The diagnostic transaction probe only proves that a simple insert/commit works. The full transaction capability table in §17.8 remains **待实测** until tested in `cloud1`.

## Smoke Test

1. Run the diagnostic action in the test cloud environment and resolve every reported failure.
2. Through `wx.cloud.callFunction`, call `GET /v1/matches`; expect `200` with `{ data, request_id }`.
3. Through a WeChat client context, call `POST /v1/session/init` with `{ nickname }`; first use returns `201`, repeat use by the same WeChat identity returns `200` and keeps the same user.
4. Call the same protected route without runtime identity; expect `401`. A client-supplied `openid` or `user_id` remains invalid.

These checks are not represented as complete until run in the actual `cloud1` environment. Do not treat fake SDK tests as cloud deployment or login acceptance.

## Provider Sync (S18-S21)

Set provider credentials in the CloudBase console only. The active-source configuration for the full six-league rollout is:

| Key | Value or requirement |
| --- | --- |
| `FOOTBALL_PROVIDER_SOURCES` | `fd,bsd,5d,of,sp` |
| `FOOTBALL_PROVIDER_KEY_FD_1` / `FOOTBALL_PROVIDER_KEY_FD_2` | Two football-data.org keys; `FOOTBALL_PROVIDER_KEY_FD` remains an alias for the first key |
| `FOOTBALL_PROVIDER_KEY_BSD` | One BSD Sports API key |
| `FOOTBALL_PROVIDER_KEY_5D` | One 5DollarFootballAPI key |
| `FOOTBALL_PROVIDER_KEY_OF` | One OpenFootAPI key |
| `FOOTBALL_PROVIDER_KEY_SP` | One sportapi.ai key |
| `FOOTBALL_SYNC_PROFILE` | `test` |
| `FOOTBALL_SYNC_LEAGUES` | `premier_league,la_liga,serie_a,bundesliga,ligue_1,chinese_super_league` |

The defaults map five European leagues to `fd` and Chinese Super League to `bsd`; `5d`, `of`, and `sp` are secondary, fallback, or reconciliation sources according to the development plan. Optional source URLs, rate caps, and provider league references are listed in §18.6 and §20.9. Never put credential values in source files, sample JSON, or logs.

Run `npm run cloudbase:schema -- --namespace football_test` after building. Create the listed collections and indexes in `cloud1`, including `provider_usage`, `provider_key_state`, and `provider_league_state`; the command prints the schema and does not apply it.

For source mapping work, `npm run providers:map-teams -- --input <file.json>` accepts exported local teams and sanitized provider team samples and prints a review report only. `npm run logos:check -- --input <file.json>` checks normalized fixture samples against packaged team logos. Neither command connects to a provider or writes database mappings.

For cloud validation, invoke `{ "action": "diag" }`, then synchronize each league separately with `{ "action": "sync", "job": "future_schedule", "league": "<league_id>" }` when using the cloud-function test panel. A schedule sync without `league` selects the least recently successful configured league. Each scheduled future/full-season sync handles one league per call. Add a CloudBase timer trigger for every minute (`Type: Timer`) and observe the league rotation. Validate the source's real response shape, quota values, per-league daily request counts, and fixture writes before accepting the deployment. `sp` reachability, 304 quota behavior, `fd` live delay, and the all-leagues `5d` live response need live or `cloud1` confirmation.

## Logging and Rollback

Startup logs contain environment name, environment ID, namespace, repository backend, required-key presence, SDK version, and Node version. Request logs contain request ID, method, path, status, code, and classified diagnostic fields for unexpected errors. Logs do not include request bodies, OPENID, or environment-variable values.

Rollback by selecting the previous cloud-function version in the CloudBase console. Keep the database schema unchanged during code rollback, then repeat the test-environment smoke test.
