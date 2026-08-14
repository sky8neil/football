# 云函数入口部署与回滚（B3-7）

薄网关：`src/cloud-function/index.ts`。业务 handler / `src/gateway/assemble.ts` **零改动**。

实际部署需用户提供微信云开发环境（**待配置项**）。本仓库无云开发环境，生产路径 `cloud.getWXContext().OPENID` **尚未在真环境验证**；本地只注入 fake `context` 做单元测试。

## 前置

- 微信小程序 **appid**（只存在部署平台；仓库不写真实 appid）。
- 云开发环境 id，**dev / test / prod 必须隔离**（与 `assertEnvironmentIsolation` 语义一致：三套 `cloud_environment_id` / `resource_namespace` 不得共用）。
- 云函数名（与小程序 `wx.cloud.callFunction({ name })` 一致）。

### 环境键清单（仅键名，无密钥值）

| 键 | 用途 | 约束 |
| --- | --- | --- |
| `FOOTBALL_ENVIRONMENT` | `dev` / `test` / `prod` | 缺失或非法则 Fail Closed，不启动 |
| `FOOTBALL_MATCH_CURSOR_SECRET` | 比赛列表 cursor HMAC | 必填非空；**只存部署平台** |
| `FOOTBALL_MOCK_TRUSTED_OPENID` | 本地/测试 mock 身份 | **仅** `environment ∈ {dev,test}` 生效；prod 忽略 |
| `FOOTBALL_CLOUD_ENVIRONMENT_ID` | 云开发环境 id | 三环境唯一；本入口不解析密钥 |
| `FOOTBALL_RESOURCE_NAMESPACE` | 资源命名空间 | 三环境唯一 |

凭证、appid、云环境密钥、Provider key **只存部署平台**。仓库只保留键名，不提交 `.env`。

`prod` **禁止** mock：即使误配 `FOOTBALL_MOCK_TRUSTED_OPENID`，`resolveCloudFunctionOpenid` 也只认运行时 `context.OPENID`。

## 部署

1. 在目标云开发环境绑定上表键（值在控制台填写，不入库）。
2. 上传本仓库构建产物中的云函数入口，组装方式与本地 `src/gateway/http.ts` 相同，例如：

   ```ts
   import { handleGatewayRequest } from "../gateway/assemble.js";
   import { loadGatewayRuntimeConfig } from "../gateway/config.js";
   import { createCloudFunctionHandler } from "./index.js";
   // services / repo / rate_limiter 由部署侧组装（B1 未接时可用内存实现；生产需真实仓储）

   const config = loadGatewayRuntimeConfig(process.env);
   export const main = createCloudFunctionHandler({
     assemble: handleGatewayRequest,
     config,
     services,
     repo,
     rate_limiter,
   });
   ```

   小程序调用：`wx.cloud.callFunction({ name, data: { method, path, query, body } })`。
   入口返回 `{ result: { status, body } }`。若平台把函数返回值再包一层 `result`，部署侧可改为直接返回 `GatewayResponse`，**不要**改冻结 assemble / handler。

3. 生产身份：云函数运行时把 `cloud.getWXContext().OPENID` 填进 `context.OPENID` 再调 `main`。本文件不 import 微信 SDK。
4. 日志只允许 `request_id` / `method` / `path` / `status` / `code`。禁止打印完整 OPENID、body、凭证、授权头。

## 烟测

同一云函数版本上最少跑两条：

1. **公开读：** `GET /v1/matches`（可无 OPENID）→ HTTP **200** + `{ data, request_id }`。
2. **运行时身份：** 带 `context.OPENID` 的 `POST /v1/session/init`（body 仅 `{ nickname }`）→ **201** 或 **200**。缺 OPENID → **401 `UNAUTHORIZED`**。body 带 `openid` / `user_id` 不得冒充身份（合同 **422**）。

失败即停，不继续灌数。B1 未接时数据在内存/夹具中，重启即丢失——烟测通过不代表持久化已就绪。

## 回滚

- 在云开发控制台回滚到**上一云函数版本**（同包回滚）。
- **不改库 schema**。B1 未接线时无 migration，禁止为回滚改集合或手改文档。
- 回滚后再跑一遍烟测。
- 不要用改 OpenAPI / handler / 身份合同的方式“热修”。

## 待配置项（需要用户环境）

- 真实云开发环境 id 与三套隔离确认。
- 云函数上传、`getWXContext().OPENID` 生产路径验证。
- 环境键在控制台绑定（值不入库）。
- 生产 `repo` / 共享限流（B1 / B5）替换内存实现。
- 小程序端从本地 HTTP mock 切到 `wx.cloud.callFunction`（C2 调用层，不在本切片改合同）。

不提交 `.env`、云开发密钥或其它凭证。
