# Cloud Function Deployment (S16/S17)

代码侧已实现云函数调用、CloudBase 仓储适配器与诊断动作。**尚未在微信开发者工具或真实 `footballfree` 环境部署验证**；SDK 行为、事务能力表与体验版登录流程仍待真环境验收。本文是操作说明，执行 provision/deploy 或控制台写入不等于真实云验收。

自建 VPS 模板与入口对照见 [`ops/vps/`](../../ops/vps/) 与 [`docs/VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md`](../../docs/VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md)。云函数编译入口：`npm run cloudfunction:build` → `cloudfunctions/api/dist/cloud-function/runtime.js`，由 `cloudfunctions/api/index.js` 加载。

## Three Credential Types — Do Not Mix Them Up

| Credential | Where it lives | What it can do |
| --- | --- | --- |
| Mini Program AppID `wxc94f506820248a52` | `project.config.json` and `miniprogram/project.config.json`. It is not a secret. | Identifies the mini program in the developer tools and binds it to a CloudBase environment. |
| Mini Program AppSecret | `.env.cloudbase.local` as `WECHAT_APP_SECRET` (gitignored; never in client code, never in the repo) | Calls WeChat server APIs such as `access_token`, `code2Session`, and subscribe messages. This project does not need it: the openid comes from the cloud function runtime context. |
| Tencent Cloud SecretId (`AKID…`) / SecretKey | `.env.cloudbase.local` as `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` | Provisions CloudBase resources through `npm run cloudbase:provision`. The pair must belong to the account that owns `footballfree-d2gzh9xzve789c41a`. |

An AppSecret cannot create or inspect CloudBase collections. A SecretKey without its matching SecretId fails with a signature error.

## Function Configuration (timeout, trigger, diag)

Function code can be uploaded from the developer tools, but two settings are easy to miss and both are fatal: the default timeout is **3 seconds** (provider sync dies instantly) and a missing timer means scheduled work never runs.

`scripts/cloudbase-deploy-function.mjs` converges and checks them without touching code:

| Command | Effect |
| --- | --- |
| `npm run cloudbase:function` | Read-only diff of the live function config against the expected one |
| `npm run cloudbase:function -- --apply` | Sets timeout to 120 s and creates the 10-minute timer if absent |
| `npm run cloudbase:function -- --diag` | Invokes `{"action":"diag"}` and prints the result summary |
| `npm run cloudbase:deploy` | Builds and uploads the function code (COS path; the 1.5 MB zip cap rules out direct zip upload) |

Add `--sync-env` to merge the `FOOTBALL_*` values from `.env.cloudbase.local` into the function's environment variables (off by default so console-only values are never overwritten). Existing variables are preserved.

`diag` invoked this way comes from the Tencent Cloud API rather than a mini program call, so `identity_available` is false and `environment_match.runtime_id` is null. That is expected; judge the environment by the environment-ID value, collection visibility from the current schema plan, and the read/write plus transaction probes.

## Build and Upload

1. Run `npm run cloudfunction:build`. The compiled entry is `cloudfunctions/api/dist/cloud-function/runtime.js`, imported application modules and `build-info.json` are emitted under the same `dist/` directory. The diagnostic action reports that build timestamp.
2. In WeChat Developer Tools, upload `cloudfunctions/api/` as the `api` cloud function and choose cloud-side dependency installation. The package pins `wx-server-sdk` to `4.0.2` in its package manifest and lockfile.
3. Set the cloud function environment variables in the CloudBase console. For the confirmed test environment, use the values recorded in the development plan; set `FOOTBALL_MATCH_CURSOR_SECRET` only in the console.
4. Set `miniprogram/config.js` to `transport: "cloud"`, the registered test `cloudEnvId`, and `cloudFunctionName: "api"`. The committed file currently uses `transport: "cloud"`, `cloudEnvId: "footballfree-d2gzh9xzve789c41a"`, `cloudFunctionName: "api"`. VPS HTTP 模式改 `transport: "http"` 并把 `gatewayOrigin` 换成备案 HTTPS 域名。

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

Collection and index names are derived from `src/schema/` through `cloudBaseCollectionName()`, which also applies the 30-character collection-name aliases (`provider_key_state` → `provider_keys`, `user_season_stats` → `stats`, and so on). Never create collections from hand-written names: they will not match what the runtime reads.

Three commands, all in `scripts/cloudbase-provision.mjs`:

| Command | Effect |
| --- | --- |
| `npm run cloudbase:provision` | Prints the current collection and index plan from `src/schema/` (names via `cloudBaseCollectionName()`). No network access. |
| `npm run cloudbase:verify` | Read-only check of the live environment; exits 1 on missing or drifted structure. |
| `npm run cloudbase:provision -- --apply` | Creates missing collections and indexes. Idempotent: existing objects are never touched, nothing is ever dropped. |

`--apply` reads `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` plus `FOOTBALL_CLOUD_ENVIRONMENT_ID`, `FOOTBALL_RESOURCE_NAMESPACE`, and `FOOTBALL_ENVIRONMENT` from `.env.cloudbase.local` (override with `--env-file`) or from the process environment. It refuses to run against `FOOTBALL_ENVIRONMENT=prod` unless `--allow-prod` is passed. Index drift is reported but never rebuilt implicitly; add `--fix-index-drift` to drop and recreate a mismatched index.

Collection permissions cannot be set by the manager SDK. After provisioning, set every collection to **仅管理端可读写 (ADMINONLY)** in the console.

环境变量占位见 `ops/vps/cloudbase.env.example`。必填键与 `missingCloudEnvironmentKeys()` / `cloudbase-deploy-function.mjs` 的 `REQUIRED_ENV_KEYS` 一致：`FOOTBALL_ENVIRONMENT`、`FOOTBALL_REPOSITORY_BACKEND=cloudbase`、`FOOTBALL_CLOUD_ENVIRONMENT_ID`、`FOOTBALL_RESOURCE_NAMESPACE`、`FOOTBALL_MATCH_CURSOR_SECRET`。Provider 键按已启用数据源另配。不要在云函数上配置 `FOOTBALL_DATABASE_URL` / `FOOTBALL_WECHAT_APP_SECRET`。

## 控制台初始化管理员（现有模型）

仓库没有 CloudBase 版 `vps-admin`。管理员无创建 API（`src/schema/collections.ts`：`admins`「由部署配置显式 provision」）。运行时用 `admins.findByOpenid(trusted_openid)`，CloudBase `_id = admin_id`。

在**当前** `FOOTBALL_RESOURCE_NAMESPACE` 下操作集合全名：

```text
${FOOTBALL_RESOURCE_NAMESPACE}_admins
```

`admins` 无 30 字符别名。例：`football_test_admins`。索引 `uk_admin_openid`，字段 `openid`，唯一。provision 会按 schema 创建集合和该索引；若只在控制台建库，必须用 `npm run cloudbase:schema -- --namespace <ns>` 打印的全名，不要手写短名 `admins`。

新增一条文档，字段必须与 `Admin` / `COLLECTION_DEFINITIONS.admins` 一致：

| 控制台字段 | 类型 | 值 | 说明 |
|---|---|---|---|
| `_id` | 字符串 | 与 `admin_id` 相同的 UUID v4 | 仓储 `add("admins", admin.admin_id, admin)` |
| `admin_id` | 字符串 | 同一 UUID v4 | 不可变业务主键 |
| `openid` | 字符串 | 该小程序 AppID 下的真实微信 openid | 与 `context.OPENID` 一致；不是 `user_id` |
| `status` | 字符串 | `active` 或 `disabled` | 管理接口只接受 `active` |
| `role` | 字符串 | `admin` | 枚举仅此值 |
| `created_at` | **Date** | 授权时间 | 不要存 ISO 字符串 |
| `updated_at` | **Date** | 与创建相同或其后 | 不要存 ISO 字符串 |
| `schema_version` | Number | `1` | 固定 |

openid 来源（控制台可操作、以现有模型为准）：

1. 目标微信用户先用体验版走一次 `POST /v1/session/init`（身份来自云函数 `context.OPENID`，body 只有 nickname）。
2. 在 `${namespace}_users` 中按该用户找到 `openid` 字段，复制到 admins。
3. 不要用 `FOOTBALL_MOCK_TRUSTED_OPENID`、自造字符串或另一 AppID 的 openid。

VPS 对应命令是 `npm run vps:admin -- --openid <openid>`（不带 `--apply` 只打印计划；`--apply` 才写入 PostgreSQL），不写 CloudBase。重复授权同一 openid 应为 unchanged/update，openid 唯一。

本流程只说明控制台字段；**未在真实云环境执行，不能当作管理员验收通过**。

Run `{ "action": "diag" }` as a cloud-function test in `dev` or `test`. The report checks required environment keys, runtime environment ID, namespace suffix, collection availability, a read/write probe, transaction availability, identity presence, and versions. It does not reveal the OPENID or environment-variable values. Index verification stays with `npm run cloudbase:verify`; the diagnostic action does not check indexes. The action returns a generic 404 in `prod`.

The diagnostic transaction probe only proves that a simple insert/commit works. The full transaction capability table in §17.8 remains **待实测** until tested in `footballfree`.

## Smoke Test

1. Run the diagnostic action in the test cloud environment and resolve every reported failure.
2. Through `wx.cloud.callFunction`, call `GET /v1/matches`; expect `200` with `{ data, request_id }`.
3. Through a WeChat client context, call `POST /v1/session/init` with `{ nickname }`; first use returns `201`, repeat use by the same WeChat identity returns `200` and keeps the same user.
4. Call the same protected route without runtime identity; expect `401`. A client-supplied `openid` or `user_id` remains invalid.

These checks are not represented as complete until run in the actual `footballfree` environment. Do not treat fake SDK tests as cloud deployment or login acceptance.

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

Run `npm run cloudbase:provision -- --apply` after building to create every collection and index, including `provider_usage`, `provider_keys`, and `provider_leagues`. Verify with `npm run cloudbase:verify`.

For source mapping work, `npm run providers:map-teams -- --input <file.json>` accepts exported local teams and sanitized provider team samples and prints a review report only. `npm run logos:check -- --input <file.json>` checks normalized fixture samples against packaged team logos. Neither command connects to a provider or writes database mappings.

For cloud validation, invoke `{ "action": "diag" }`, then synchronize each league separately with `{ "action": "sync", "job": "future_schedule", "league": "<league_id>" }` when using the cloud-function test panel. A schedule sync without `league` selects the least recently successful configured league. Each scheduled future/full-season sync handles one league per call. `cloudfunctions/api/config.json` declares the timer trigger (`name: everyMinuteProviderSync`, `type: "timer"`, cron `0 */10 * * * * *`, seven fields: second minute hour day month weekday year; 历史名称未改，间隔已是 10 分钟). It is applied when the function is uploaded through the developer tools or CLI, and must be confirmed in the console afterwards. The runtime dispatches on `event.Type === "Timer"`. Observe the league rotation. Validate the source's real response shape, quota values, per-league daily request counts, and fixture writes before accepting the deployment. `sp` reachability, 304 quota behavior, `fd` live delay, and the all-leagues `5d` live response need live or `footballfree` confirmation. 上述云端步骤本次文档任务不执行。

## Logging and Rollback

Startup logs contain environment name, environment ID, namespace, repository backend, required-key presence, SDK version, and Node version. Request logs contain request ID, method, path, status, code, and classified diagnostic fields for unexpected errors. Logs do not include request bodies, OPENID, or environment-variable values.

Rollback by selecting the previous cloud-function version in the CloudBase console. Keep the database schema unchanged during code rollback, then repeat the test-environment smoke test.
