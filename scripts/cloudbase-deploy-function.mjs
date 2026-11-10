#!/usr/bin/env node
/**
 * 云函数 `api` 的配置收敛与自检（不含代码上传）。
 *
 * 为什么单独一个脚本：函数代码可以在开发者工具里上传，但**超时**和**触发器**这两项
 * 经常被漏掉——超时默认只有 3 秒，同步任务必挂；触发器漏了则永远不会自动跑。
 *
 * 模式：
 *   --plan（默认）  只读：打印当前配置与期望值的差异，不写任何东西
 *   --apply        把超时收敛到 120 秒；缺 Timer 触发器就补上
 *   --diag         调用 {"action":"diag"} 并把结论摘要打出来
 *
 * 选项：
 *   --sync-env     把 .env.cloudbase.local 里的 FOOTBALL_* 变量合并进函数环境变量
 *                  （默认不动环境变量，避免覆盖控制台里已有的值）
 *   --env-file     环境变量文件，默认 .env.cloudbase.local
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ENV_FILE = ".env.cloudbase.local";
const FUNCTION_NAME = "api";
const DESIRED_TIMEOUT = 120;
const DESIRED_MEMORY = 256;
/**
 * Timer 调度声明（RP01：开发阶段临时降频 1 分钟 → 10 分钟，减少空跑读写）。
 * CloudBase cron 为 7 段：秒 分 时 日 月 周 年。
 * 触发器名称沿用历史值 everyMinuteProviderSync，避免重命名后线上新旧触发器并存。
 */
const TIMER_INTERVAL_MINUTES = 10;
const TIMER_CRON = "0 */10 * * * * *";
const TRIGGER = { name: "everyMinuteProviderSync", type: "timer", config: TIMER_CRON };

const REQUIRED_ENV_KEYS = [
  "FOOTBALL_ENVIRONMENT",
  "FOOTBALL_REPOSITORY_BACKEND",
  "FOOTBALL_CLOUD_ENVIRONMENT_ID",
  "FOOTBALL_RESOURCE_NAMESPACE",
  "FOOTBALL_MATCH_CURSOR_SECRET",
];
const SYNC_ENV_KEYS = [
  "FOOTBALL_PROVIDER_SOURCES",
  "FOOTBALL_SYNC_PROFILE",
  "FOOTBALL_SYNC_LEAGUES",
  "FOOTBALL_PROVIDER_KEY_FD_1",
  "FOOTBALL_PROVIDER_KEY_FD_2",
  "FOOTBALL_PROVIDER_KEY_BSD",
  "FOOTBALL_PROVIDER_KEY_5D",
  "FOOTBALL_PROVIDER_KEY_OF",
  "FOOTBALL_PROVIDER_KEY_SP",
];

function parseArgs(argv) {
  const options = { mode: "plan", syncEnv: false, envFile: undefined, deployCode: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plan") options.mode = "plan";
    else if (arg === "--apply") options.mode = "apply";
    else if (arg === "--diag") options.mode = "diag";
    else if (arg === "--sync-env") options.syncEnv = true;
    else if (arg === "--deploy-code") options.deployCode = true;
    else if (arg === "--env-file") options.envFile = argv[++i];
    else if (arg === "--help" || arg === "-h") options.mode = "help";
    else {
      console.error(`未知参数: ${arg}`);
      options.mode = "usage";
    }
  }
  return options;
}

function parseEnvFile(path) {
  const env = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return env;
}

function resolveSettings(options) {
  const envFile = options.envFile ?? DEFAULT_ENV_FILE;
  const envPath = resolve(ROOT, envFile);
  if (!existsSync(envPath)) throw new Error(`找不到环境文件：${envFile}`);
  const fromFile = parseEnvFile(envPath);
  const pick = (key) => process.env[key] ?? fromFile[key];
  const settings = {
    envFile,
    envId: pick("FOOTBALL_CLOUD_ENVIRONMENT_ID"),
    namespace: pick("FOOTBALL_RESOURCE_NAMESPACE"),
    secretId: pick("TENCENTCLOUD_SECRET_ID"),
    secretKey: pick("TENCENTCLOUD_SECRET_KEY"),
    local: fromFile,
  };
  for (const key of ["envId", "secretId", "secretKey"]) {
    if (!settings[key]) throw new Error(`环境文件缺少 ${{ envId: "FOOTBALL_CLOUD_ENVIRONMENT_ID", secretId: "TENCENTCLOUD_SECRET_ID", secretKey: "TENCENTCLOUD_SECRET_KEY" }[key]}`);
  }
  return settings;
}

/** DescribeFunction 返回的 Variables 是 [{Key,Value}]，统一成对象便于比对。 */
function variableMap(cfg) {
  const raw = cfg?.Environment?.Variables;
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.map((item) => [item.Key, item.Value ?? ""]));
  }
  if (raw && typeof raw === "object") return { ...raw };
  return {};
}

function showDetail(cfg) {
  const vars = variableMap(cfg);
  console.log(`函数 ${FUNCTION_NAME}：runtime=${cfg.Runtime} status=${cfg.Status} memory=${cfg.MemorySize}MB 超时=${cfg.Timeout}s`);
  console.log(`代码更新时间：${cfg.ModTime}`);
  console.log(`环境变量：${Object.keys(vars).length} 个`);
  const missing = REQUIRED_ENV_KEYS.filter((key) => !vars[key]);
  const missingSync = SYNC_ENV_KEYS.filter((key) => !vars[key]);
  if (missing.length > 0) console.log(`  ✗ 缺必填：${missing.join(", ")}`);
  if (missingSync.length > 0) console.log(`  ! 缺同步相关：${missingSync.join(", ")}`);
  const triggers = cfg.Triggers ?? [];
  console.log(`触发器：${triggers.length === 0 ? "（无）" : triggers.map((t) => `${t.TriggerName ?? t.Name} ${t.TriggerDesc ?? ""}`).join("; ")}`);
  return { vars, triggers };
}

function printDifferences(cfg) {
  const { triggers } = showDetail(cfg);
  const diff = [];
  if (cfg.Timeout !== DESIRED_TIMEOUT) diff.push(`超时 ${cfg.Timeout}s → ${DESIRED_TIMEOUT}s`);
  if (cfg.MemorySize !== DESIRED_MEMORY) diff.push(`内存 ${cfg.MemorySize}MB → ${DESIRED_MEMORY}MB（仅提示，脚本不改）`);
  if (triggers.length === 0) diff.push(`缺每十分钟 Timer 触发器 ${TRIGGER.name}`);
  else {
    const timer = triggers.find((t) => (t.Type ?? t.type) === "timer") ?? triggers[0];
    const onlineCron = timer.Config ?? timer.config ?? timer.TriggerDesc ?? "";
    if (onlineCron !== TIMER_CRON) diff.push(`Timer cron ${onlineCron} → ${TIMER_CRON}`);
  }
  console.log("");
  if (diff.length === 0) console.log("配置已符合预期。");
  else {
    console.log("待收敛：");
    for (const item of diff) console.log(`  - ${item}`);
    console.log("\n执行 npm run cloudbase:function -- --apply 收敛。");
  }
}

async function applyConfig(app, cfg, settings, options) {
  const changes = [];
  const payload = { name: FUNCTION_NAME };

  if (cfg.Timeout !== DESIRED_TIMEOUT) {
    payload.timeout = DESIRED_TIMEOUT;
    changes.push(`超时 ${cfg.Timeout}s → ${DESIRED_TIMEOUT}s`);
  }

  if (options.syncEnv) {
    const current = variableMap(cfg);
    const merged = { ...current };
    let added = 0;
    for (const key of [...REQUIRED_ENV_KEYS, ...SYNC_ENV_KEYS]) {
      const value = settings.local[key];
      if (value && merged[key] !== value) {
        if (!merged[key]) added += 1;
        merged[key] = value;
      }
    }
    payload.envVariables = merged;
    changes.push(`环境变量同步（新增 ${added} 个，其余保留）`);
  }

  if (Object.keys(payload).length > 1) {
    await app.functions.updateFunctionConfig(payload);
    console.log("已更新配置：");
    for (const change of changes) console.log(`  + ${change}`);
  } else {
    console.log("超时与内存已符合预期，无需更新配置。");
  }

  const triggers = cfg.Triggers ?? [];
  if (triggers.length === 0) {
    try {
      await app.functions.createFunctionTriggers(FUNCTION_NAME, [TRIGGER]);
      console.log(`  + 已创建触发器 ${TRIGGER.name}（${TRIGGER.config}）`);
    } catch (error) {
      console.error(`  ✗ 触发器创建失败：${sanitize(error)}`);
      console.error("    若环境是 CBF（云开发云函数），SDK 不支持定时触发器，需要在开发者工具或控制台手工添加：");
      console.error(`    类型 Timer，名称 ${TRIGGER.name}，cron ${TRIGGER.config}`);
      return false;
    }
  } else {
    console.log(`  触发器已存在（${triggers.length} 个），不重复创建。`);
  }
  return true;
}

async function runDiag(app) {
  console.log("调用 {\"action\":\"diag\"} …（服务端直连调用没有 OPENID 与环境上下文，identity_available=false / runtime_id=null 属正常）");
  const result = await app.functions.invokeFunction(FUNCTION_NAME, { action: "diag" });
  // SCF 把函数返回值放在 RetMsg（字符串）里；兼容直接返回对象的情况。
  const raw = result?.RetMsg ?? result?.Result ?? result;
  const parsed = typeof raw === "string" ? safeJson(raw) : raw;
  if (!parsed) {
    console.log("返回（非 JSON）：", String(raw).slice(0, 800));
    return 1;
  }
  const envelope = parsed.result ?? parsed;
  const status = envelope.status;
  const body = envelope.body ?? envelope;
  const data = body.data ?? {};
  console.log(`HTTP 状态：${status}  request_id=${body.request_id ?? "-"}`);
  if (data.environment) {
    console.log(`环境变量：${data.environment.ok ? "齐全" : `缺 ${(data.environment.missing_keys ?? []).join(", ")}`}`);
  }
  if (data.environment_match) {
    const match = data.environment_match;
    if (match.ok) console.log("环境 ID 匹配：是");
    else if (match.runtime_id === null) {
      console.log(`环境 ID 匹配：跳过（服务端直连无 runtime ENV；配置值 ${match.configured_id} 与 .env 一致即可）`);
    } else {
      console.log(`环境 ID 匹配：否（配置 ${match.configured_id} / 运行 ${match.runtime_id}）`);
    }
  }
  if (data.namespace_match) {
    console.log(`命名空间后缀：${data.namespace_match.ok ? "匹配" : `不匹配（${data.namespace_match.resource_namespace}）`}`);
  }
  let collectionsOk = true;
  if (data.collections) {
    const rows = Object.entries(data.collections);
    const ok = rows.filter(([, row]) => row.exists).length;
    collectionsOk = ok === rows.length;
    console.log(`集合可见：${ok}/${rows.length}`);
    for (const [name, row] of rows) {
      if (!row.exists) console.log(`  ✗ ${name}: ${row.diag_code ?? "不存在"}`);
    }
  }
  const probeOk = (probe) => probe?.ok === true;
  if (data.read_write_probe) console.log(`读写探针：${probeOk(data.read_write_probe) ? "通过" : `失败（${data.read_write_probe.diag_code}）`}`);
  if (data.transaction_probe) console.log(`事务探针：${probeOk(data.transaction_probe) ? "通过" : `失败（${data.transaction_probe.diag_code}）`}`);
  if (data.versions) console.log(`版本：${JSON.stringify(data.versions)}`);
  if (data.identity_available !== undefined) console.log(`运行时身份：${data.identity_available ? "有 OPENID" : "无 OPENID（服务端直连，正常）"}`);
  if (Array.isArray(data.provider_sources)) {
    console.log(`Provider 源：${data.provider_sources.map((source) => `${source.source_id}(${source.key_count}key)`).join(", ")}`);
  }
  const healthy = collectionsOk && probeOk(data.read_write_probe) && probeOk(data.transaction_probe);
  console.log(healthy
    ? "\n结构自检通过。身份相关能力需要在真机 / 开发者工具里经云函数调用验证。"
    : "\n存在失败项，按上面 ✗ 行处理。");
  return healthy ? 0 : 1;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function sanitize(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\b(secretId|secretKey|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 300);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "help") {
    console.log("用法：node scripts/cloudbase-deploy-function.mjs [--plan|--apply|--diag] [--sync-env] [--env-file <path>]");
    return 0;
  }
  if (options.mode === "usage") return 2;

  const settings = resolveSettings(options);
  const { default: CloudBase } = await import("@cloudbase/manager-node");
  const app = CloudBase.init({
    secretId: settings.secretId,
    secretKey: settings.secretKey,
    envId: settings.envId,
  });

  if (options.mode === "diag") return runDiag(app);

  const detail = await app.functions.getFunctionDetail(FUNCTION_NAME);
  const cfg = detail?.FunctionConfig ?? detail;
  if (!cfg || !cfg.Runtime) throw new Error(`环境 ${settings.envId} 里没有找到函数 ${FUNCTION_NAME}`);

  if (options.mode === "plan") {
    console.log(`环境：${settings.envId}`);
    printDifferences(cfg);
    return 0;
  }

  console.log(`环境：${settings.envId}`);
  showDetail(cfg);
  console.log("");

  if (options.deployCode) {
    console.log("上传云函数代码（cloudfunctions/api/，含本地 node_modules）…");
    // zip 直传上限 1.5MB，本包 40MB+（dist 与 wx-server-sdk），必须走 COS。
    await app.functions.updateFunctionCode({
      func: { name: FUNCTION_NAME },
      functionRootPath: "cloudfunctions",
      deployMode: "cos",
    });
    await app.functions.waitFunctionActive(FUNCTION_NAME);
    console.log("  代码已更新，函数恢复 Active。");
  }

  const ok = await applyConfig(app, cfg, settings, options);
  console.log("");
  const after = await app.functions.getFunctionDetail(FUNCTION_NAME);
  printDifferences(after?.FunctionConfig ?? after);
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`失败：${sanitize(error)}`);
    process.exit(1);
  });
