# VPS / CloudBase 双部署模板

模板与当前编译入口对齐，供安装到目标机后替换路径、域名和凭据。本目录不执行部署，也不代表生产已验收。

## 实际入口

| 角色 | 源码 | `npm run build` 产物 | systemd ExecStart |
|---|---|---|---|
| API | `src/gateway/http.ts` | `dist/gateway/http.js` | `/usr/bin/node …/dist/gateway/http.js` |
| 单轮任务 | `src/jobs/tick.ts` | `dist/jobs/tick.js` | `/usr/bin/node …/dist/jobs/tick.js` |

`npm run jobs:tick` 会先 `build` 再跑 `node dist/jobs/tick.js`。systemd 在 release 目录已构建后应直接执行编译产物，不要再走 npm script。

API 监听写死为 `127.0.0.1:8787`（`GATEWAY_LISTEN_HOST` / `GATEWAY_LISTEN_PORT`）。进程不读 `PORT`。SIGTERM 时 `server.close()`，`close` 事件里关闭 PostgreSQL 连接池。

CloudBase 入口是 `cloudfunctions/api/index.js` → `cloudfunctions/api/dist/cloud-function/runtime.js`（`npm run cloudfunction:build`）。Timer 声明在 `cloudfunctions/api/config.json`：名称 `everyMinuteProviderSync`，cron `0 */10 * * * * *`。

## 本目录文件

| 文件 | 用途 |
|---|---|
| `football-api.service` | API unit，`Type=simple` |
| `football-jobs.service` | 单轮任务，`Type=oneshot`，`TimeoutStartSec=1800` |
| `football-jobs.timer` | 每 3 分钟（VPS 实时档），`Persistent=true` |
| `Caddyfile` | 备案域名反代到 `127.0.0.1:8787` |
| `football.env.example` | VPS EnvironmentFile 占位，无真实凭据 |
| `cloudbase.env.example` | 云函数环境变量占位，无腾讯云密钥 |

`/usr/bin/node`、`User=neilxu`、`/home/neilxu/football/current` 都是建议值，安装前换成目标机实际 Node 路径、用户和发布目录。

## 调度边界

VPS 模板默认 **3 分钟**（`OnCalendar=*-*-* *:00/3:00`，`AccuracySec=10s`），保留 `Persistent=true`，
这样 `live_match` 的 3 分钟间隔可以真正生效。

CloudBase（腾讯云云函数定时器）的最小粒度是 **15 分钟**，同一份代码在云上 `live_match` 会退化为
15 分钟——不是配置写错，是平台限制。刷新频率 = `max(任务配置间隔, 调度粒度)`，
定义在 `src/sync/deploy-target.ts`（`SCHEDULER_TICK_MINUTES`）。

部署前先跑一次预检，它会按目标打印每个任务的配置间隔与实际生效间隔，云端会被降级的任务会标出来：

```bash
npm run vps:preflight            # 目标 VPS，期望 tick=3 分钟、无降级
npm run deploy:preflight         # 目标按 FOOTBALL_DEPLOY_TARGET / 仓库后端推断
npm run cloudbase:deploy         # 预检已串在部署链第一位，云端降级会在部署前打印出来
```

注：npm 的 `pre<script>` 钩子对带冒号的脚本名不生效（`precloudbase:deploy` 不会被触发，
已实测），所以预检是显式写进 `cloudbase:deploy` 命令链的，不是靠钩子。

结论：要"比赛比分 3 分钟级实时"，必须部署在 VPS；部署到 CloudBase 时接受 15 分钟延迟，
或者把实时链路单独留在 VPS。

## VPS 最小步骤（开发完成后）

完整合同见 `docs/VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md` §11。摘要：

```bash
npm ci
npm run typecheck
npm run build
npm run vps:db -- --plan
npm run vps:db -- --apply
npm run vps:admin -- --openid <wechat-openid>
npm run jobs:tick -- --dry-run
```

模板校验（本仓库可做，不启动服务）：

```bash
systemd-analyze verify ops/vps/football-api.service ops/vps/football-jobs.service ops/vps/football-jobs.timer
systemd-analyze calendar '*-*-* *:00/15:00'
caddy validate --config ops/vps/Caddyfile --adapter caddyfile
```

生产首次真实 tick 会打 Provider、耗额度并写库。不要同时让旧 CloudBase Timer 和新 VPS timer 处理同一套账本。

## CloudBase 最小步骤（不在本次执行）

```bash
npm run cloudbase:provision
npm run cloudbase:provision -- --apply
npm run cloudbase:verify
npm run cloudfunction:build
npm run cloudbase:function
npm run cloudbase:deploy
```

`FOOTBALL_ENVIRONMENT=prod` 的 `--apply` 需要再加 `--allow-prod`。集合权限、管理员文档和 Timer 仍可能要在控制台核对；字段与流程见 `src/cloud-function/DEPLOY.md`。这些命令只准备资源，不能当作真实云验收。
