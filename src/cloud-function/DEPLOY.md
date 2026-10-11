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

## Logging and Rollback

Startup logs contain environment name, environment ID, namespace, repository backend, required-key presence, SDK version, and Node version. Request logs contain request ID, method, path, status, code, and classified diagnostic fields for unexpected errors. Logs do not include request bodies, OPENID, or environment-variable values.

Rollback by selecting the previous cloud-function version in the CloudBase console. Keep the database schema unchanged during code rollback, then repeat the test-environment smoke test.
