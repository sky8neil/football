#!/usr/bin/env node
/**
 * CloudBase 数据库结构 Provisioning —— 集合与索引的可重复执行脚本。
 *
 * 事实来源：`src/schema/collections.ts` 与 `src/schema/indexes.ts`（构建产物在 dist/），
 * 集合名统一走 `cloudBaseCollectionName()`，与运行时仓储适配器完全同源，
 * 因此别名（provider_key_state → provider_keys 等）与 30 字符上限不会两处各写一份。
 *
 * 三种模式：
 *   --plan（默认）  只打印将要创建什么，不连网
 *   --verify        只读检查云端现状，缺失/定义不一致 → 退出码 1
 *   --apply         创建缺失的集合与索引；已存在的不动（幂等，可反复执行）
 *
 * 安全边界：
 *   - 永不删除集合；索引只在显式 --fix-index-drift 时才重建（先删后建）
 *   - FOOTBALL_ENVIRONMENT=prod 时拒绝 --apply，除非再加 --allow-prod
 *   - 凭据只从环境变量 / env 文件读取，日志与错误信息里不打印任何密钥
 *   - 集合权限（ADMINONLY）不在本脚本范围内：manager SDK 未暴露 ACL 接口
 *
 * 用法：
 *   node scripts/cloudbase-provision.mjs                       # 看计划（不连网）
 *   node scripts/cloudbase-provision.mjs --verify              # 只读体检
 *   node scripts/cloudbase-provision.mjs --apply               # 落库
 *   node scripts/cloudbase-provision.mjs --apply --fix-index-drift
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 只认当前在用的环境文件；旧的 .env.cloud1.local 不再被任何脚本读取。
const DEFAULT_ENV_FILE = ".env.cloudbase.local";

const EXIT_OK = 0;
const EXIT_PROBLEM = 1;
const EXIT_USAGE = 2;

const USAGE = `CloudBase 数据库结构 provisioning（集合 + 索引）

  node scripts/cloudbase-provision.mjs [--plan | --verify | --apply] [选项]

模式（默认 --plan）：
  --plan      只打印将创建的集合与索引，不连接云端
  --verify    只读检查云端现状；缺失或定义不一致 → 退出码 1
  --apply     创建缺失的集合与索引；已存在的保持不变（幂等）

选项：
  --namespace <value>     覆盖 FOOTBALL_RESOURCE_NAMESPACE
  --env-file <path>       读取环境变量的文件，默认 ${DEFAULT_ENV_FILE}
  --fix-index-drift       配合 --apply：把定义不一致的索引先删后建
  --allow-prod            允许在 FOOTBALL_ENVIRONMENT=prod 下执行 --apply
  --json                  以 JSON 输出结果
  -h, --help              显示本帮助`;

function parseArgs(argv) {
  const options = {
    mode: "plan",
    namespace: undefined,
    envFile: undefined,
    fixIndexDrift: false,
    allowProd: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan") options.mode = "plan";
    else if (arg === "--verify") options.mode = "verify";
    else if (arg === "--apply") options.mode = "apply";
    else if (arg === "--fix-index-drift") options.fixIndexDrift = true;
    else if (arg === "--allow-prod") options.allowProd = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--namespace") options.namespace = argv[++index];
    else if (arg === "--env-file") options.envFile = argv[++index];
    else if (arg === "--help" || arg === "-h") options.mode = "help";
    else {
      console.error(`未知参数: ${arg}`);
      options.mode = "usage";
    }
  }
  return options;
}

export function parseEnvFile(path) {
  const text = readFileSync(path, "utf8");
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function resolveSettings(options) {
  const envFile = options.envFile ?? DEFAULT_ENV_FILE;
  const envPath = resolve(ROOT, envFile);
  const fromFile = existsSync(envPath) ? parseEnvFile(envPath) : {};
  // 进程环境变量优先，便于临时切换环境做只读校验。
  const pick = (key) => process.env[key] ?? fromFile[key];

  return {
    envFile,
    envFileExists: existsSync(envPath),
    namespace: options.namespace ?? pick("FOOTBALL_RESOURCE_NAMESPACE"),
    environment: pick("FOOTBALL_ENVIRONMENT"),
    envId: pick("FOOTBALL_CLOUD_ENVIRONMENT_ID"),
    secretId: pick("TENCENTCLOUD_SECRET_ID"),
    secretKey: pick("TENCENTCLOUD_SECRET_KEY"),
  };
}

export async function loadSchemaPlan(namespace) {
  const distPath = join(ROOT, "dist", "schema", "collections.js");
  if (!existsSync(distPath)) {
    throw new Error("dist/ 尚未构建，请先运行 npm run build（或直接用 npm run cloudbase:provision）");
  }
  const { COLLECTION_DEFINITIONS } = await import(pathToFileURL(distPath).href);
  const { UNIQUE_INDEXES, QUERY_INDEXES } = await import(pathToFileURL(join(ROOT, "dist", "schema", "indexes.js")).href);
  const { CLOUDBASE_RUNTIME_COLLECTIONS, cloudBaseCollectionName } = await import(
    pathToFileURL(join(ROOT, "dist", "infrastructure", "cloudbase-db.js")).href
  );

  // diag / rate_limits 是运行时诊断与限流用的附属集合，不在业务 schema 里但必须存在。
  const logicalCollections = [
    ...COLLECTION_DEFINITIONS.map((definition) => definition.collection),
    ...CLOUDBASE_RUNTIME_COLLECTIONS,
  ];
  const collections = [...new Set(logicalCollections)]
    .sort()
    .map((logical) => ({ logical, name: cloudBaseCollectionName(namespace, logical) }));

  const indexes = [...UNIQUE_INDEXES, ...QUERY_INDEXES]
    .map((index) => ({
      logical: index.collection,
      collection: cloudBaseCollectionName(namespace, index.collection),
      name: index.name,
      unique: index.unique === true,
      fields: index.fields.map(toMgoField),
    }))
    .sort((left, right) =>
      left.collection.localeCompare(right.collection) || left.name.localeCompare(right.name));

  return { collections, indexes };
}

/** "field" / "field:desc" → { Name, Direction: "1" | "-1" }（CloudBase 用字符串方向）。 */
export function toMgoField(field) {
  const [name, direction] = field.split(":");
  return { Name: name, Direction: direction === "desc" ? "-1" : "1" };
}

function formatIndexFields(fields) {
  return fields.map((field) => `${field.Name}:${field.Direction === "-1" ? "desc" : "asc"}`).join(",");
}

/**
 * DescribeTable 的 Indexes 元素在不同版本里出现过几种写法，
 * 这里做保守归一化：认得就逐字段比对，认不得就标为「无法核对」而不是假装通过。
 */
export function normalizeRemoteIndexes(describeResult) {
  const raw = describeResult?.Indexes ?? describeResult?.indexes;
  if (!Array.isArray(raw)) return null;
  const normalized = [];
  for (const item of raw) {
    const name = item?.Name ?? item?.IndexName ?? item?.name;
    if (typeof name !== "string") continue;
    const schema = item?.MgoKeySchema ?? item?.keySchema ?? {};
    const keys = schema?.MgoIndexKeys ?? item?.Keys ?? item?.keys ?? [];
    const unique = schema?.MgoIsUnique ?? item?.Unique ?? item?.unique;
    const fields = Array.isArray(keys)
      ? keys.map((key) => ({
        Name: key?.Name ?? key?.name,
        Direction: String(key?.Direction ?? key?.direction ?? "1"),
      }))
      : null;
    normalized.push({
      name,
      fields: fields && fields.every((field) => typeof field.Name === "string") ? fields : null,
      unique: typeof unique === "boolean" ? unique : null,
    });
  }
  return normalized;
}

function sameFields(left, right) {
  return left.length === right.length &&
    left.every((field, position) =>
      field.Name === right[position].Name && field.Direction === right[position].Direction);
}

function sameDefinition(remote, expected) {
  if (!remote.fields) return null; // 无法核对
  if (!sameFields(remote.fields, expected.fields)) return false;
  if (remote.unique === null) return null;
  return remote.unique === expected.unique;
}

function printPlan(plan, settings) {
  console.log(`命名空间: ${settings.namespace}`);
  console.log(`环境 ID : ${settings.envId ?? "(未配置 FOOTBALL_CLOUD_ENVIRONMENT_ID)"}`);
  console.log(`环境类型: ${settings.environment ?? "(未配置 FOOTBALL_ENVIRONMENT)"}`);
  console.log("");
  console.log(`集合 ${plan.collections.length} 个:`);
  for (const collection of plan.collections) console.log(`  - ${collection.name}`);
  console.log("");
  console.log(`索引 ${plan.indexes.length} 个:`);
  for (const index of plan.indexes) {
    console.log(`  - ${index.collection} ${index.name} unique=${index.unique} fields=[${formatIndexFields(index.fields)}]`);
  }
  console.log("");
  console.log("以上只是计划，未连接云端。落库请执行：npm run cloudbase:provision -- --apply");
  console.log("集合权限（仅管理端可读写 / ADMINONLY）需在控制台逐集合设置，SDK 未暴露该接口。");
}

function assertReadyForRemote(settings, options) {
  const missing = [];
  if (!settings.namespace) missing.push("FOOTBALL_RESOURCE_NAMESPACE（或 --namespace）");
  if (!settings.envId) missing.push("FOOTBALL_CLOUD_ENVIRONMENT_ID");
  if (missing.length > 0) throw new Error(`缺少环境配置：${missing.join("、")}`);
  if (!/^[a-z0-9_]+$/.test(settings.namespace)) {
    throw new Error(`命名空间只能包含小写字母、数字与下划线：${settings.namespace}`);
  }
  if (settings.environment && !settings.namespace.endsWith(`_${settings.environment}`)) {
    throw new Error(
      `命名空间后缀应与 FOOTBALL_ENVIRONMENT 一致：${settings.namespace} 不以 _${settings.environment} 结尾`,
    );
  }
  if (!settings.secretId || !settings.secretKey) {
    throw new Error("缺少 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY，无法连接云端");
  }
  if (options.mode === "apply" && settings.environment === "prod" && !options.allowProd) {
    throw new Error("拒绝在 prod 环境执行 --apply（如确需执行请加 --allow-prod）");
  }
}

/** 错误信息脱敏：SDK 报错可能回显请求参数。只针对 `key=value` / `key: value` 形态，避免误伤正文。 */
export function sanitize(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(secretId|secretKey|secret|token|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 300);
}

function isMissingTableError(error) {
  return /not exist|does not exist|没有找到|不存在/i.test(sanitize(error));
}

/**
 * 核心流程：集合 → 索引，纯依赖注入的 `database`，便于用假实现做离线测试。
 * 返回结构化报告，不做任何打印决策（日志走 log）。
 */
export async function provisionDatabase(plan, { apply, fixIndexDrift = false, log = console.log }, database) {
  const report = {
    mode: apply ? "apply" : "verify",
    collections: { total: plan.collections.length, existing: 0, created: 0, failed: [] },
    indexes: {
      total: plan.indexes.length,
      existing: 0,
      created: 0,
      recreated: 0,
      mismatched: [],
      conflicts: [],
      unverified: 0,
      skipped: 0,
      failed: [],
    },
  };

  // 1) 集合
  const unavailable = new Set();
  for (const collection of plan.collections) {
    let exists = false;
    try {
      exists = (await database.checkCollectionExists(collection.name))?.Exists === true;
    } catch (error) {
      const message = sanitize(error);
      if (!isMissingTableError(error)) {
        report.collections.failed.push({ name: collection.name, error: message });
        unavailable.add(collection.name);
        continue;
      }
    }
    if (exists) {
      report.collections.existing += 1;
      continue;
    }
    if (!apply) {
      report.collections.failed.push({ name: collection.name, error: "缺少集合（verify 模式不写入）" });
      unavailable.add(collection.name);
      continue;
    }
    try {
      await database.createCollection(collection.name);
      report.collections.created += 1;
      log(`  + 建集合 ${collection.name}`);
    } catch (error) {
      report.collections.failed.push({ name: collection.name, error: sanitize(error) });
      unavailable.add(collection.name);
    }
  }

  // 2) 索引：按集合聚合，一个集合只取一次结构
  const byCollection = new Map();
  for (const index of plan.indexes) {
    if (!byCollection.has(index.collection)) byCollection.set(index.collection, []);
    byCollection.get(index.collection).push(index);
  }

  for (const [collectionName, expectedIndexes] of byCollection) {
    if (unavailable.has(collectionName)) {
      report.indexes.skipped += expectedIndexes.length;
      continue;
    }

    let remoteIndexes;
    try {
      remoteIndexes = normalizeRemoteIndexes(await database.describeCollection(collectionName));
    } catch (error) {
      for (const index of expectedIndexes) {
        report.indexes.failed.push({ collection: collectionName, name: index.name, error: sanitize(error) });
      }
      continue;
    }
    if (remoteIndexes === null) {
      report.indexes.unverified += expectedIndexes.length;
      continue;
    }

    const createIndexes = [];
    const dropIndexes = [];
    const recreateNames = new Set();
    for (const index of expectedIndexes) {
      const remote = remoteIndexes.find((item) => item.name === index.name);
      if (!remote) {
        createIndexes.push(index);
        continue;
      }
      const same = sameDefinition(remote, index);
      if (same === true) {
        report.indexes.existing += 1;
        continue;
      }
      if (same === null) {
        report.indexes.unverified += 1;
        log(`  ? 索引定义无法核对 ${collectionName} ${index.name}`);
        continue;
      }
      const mismatch = {
        collection: collectionName,
        name: index.name,
        expected: `unique=${index.unique} fields=[${formatIndexFields(index.fields)}]`,
        actual: `unique=${remote.unique} fields=[${formatIndexFields(remote.fields ?? [])}]`,
        resolved: false,
      };
      log(`  ! 索引定义不一致 ${collectionName} ${index.name}`);
      if (apply && fixIndexDrift) {
        mismatch.resolved = true;
        dropIndexes.push({ name: index.name });
        recreateNames.add(index.name);
        createIndexes.push(index);
      }
      report.indexes.mismatched.push(mismatch);
    }

    // 同一组字段上已存在别的名字的索引（典型是控制台手工建的 xxx_v2）：
    // MongoDB 不允许键相同的两个索引，必须先删才能建规范名。只在 --fix-index-drift 下清理。
    const expectedNames = new Set(expectedIndexes.map((index) => index.name));
    for (const remote of remoteIndexes) {
      if (expectedNames.has(remote.name) || remote.fields === null) continue;
      const canonical = expectedIndexes.find((index) => sameFields(remote.fields, index.fields));
      if (canonical === undefined) continue;
      const conflict = { collection: collectionName, name: remote.name, canonical: canonical.name, resolved: false };
      log(`  ! 同字段重复索引 ${collectionName} ${remote.name}（规范名 ${canonical.name}）`);
      if (apply && fixIndexDrift) {
        conflict.resolved = true;
        dropIndexes.push({ name: remote.name });
      }
      report.indexes.conflicts.push(conflict);
    }

    if (createIndexes.length === 0 && dropIndexes.length === 0) continue;
    if (!apply) {
      for (const index of createIndexes) {
        report.indexes.failed.push({
          collection: collectionName,
          name: index.name,
          error: "缺少索引（verify 模式不写入）",
        });
      }
      continue;
    }
    try {
      // 先删后建分两次调用，避免依赖服务端对同一次请求里 Drop/Create 的处理顺序。
      if (dropIndexes.length > 0) {
        await database.updateCollection(collectionName, {
          DropIndexes: dropIndexes.map((item) => ({ IndexName: item.name })),
        });
      }
      if (createIndexes.length > 0) {
        await database.updateCollection(collectionName, {
          CreateIndexes: createIndexes.map((index) => ({
            IndexName: index.name,
            MgoKeySchema: { MgoIndexKeys: index.fields, MgoIsUnique: index.unique },
          })),
        });
      }
      for (const index of createIndexes) {
        if (recreateNames.has(index.name)) {
          report.indexes.recreated += 1;
          log(`  ~ 重建索引 ${collectionName} ${index.name}`);
        } else {
          report.indexes.created += 1;
          log(`  + 建索引 ${collectionName} ${index.name}`);
        }
      }
    } catch (error) {
      const message = sanitize(error);
      for (const index of createIndexes) {
        report.indexes.failed.push({ collection: collectionName, name: index.name, error: message });
      }
    }
  }

  return report;
}

function printReport(report) {
  const { collections, indexes } = report;
  console.log("");
  console.log(`集合：共 ${collections.total}，已存在 ${collections.existing}，本次创建 ${collections.created}，失败 ${collections.failed.length}`);
  console.log(
    `索引：共 ${indexes.total}，已存在 ${indexes.existing}，本次创建 ${indexes.created}，重建 ${indexes.recreated}，` +
    `定义不一致 ${indexes.mismatched.length}，同字段重名 ${indexes.conflicts.length}，无法核对 ${indexes.unverified}，跳过 ${indexes.skipped}，失败 ${indexes.failed.length}`,
  );
  for (const item of collections.failed) console.log(`  ✗ 集合 ${item.name}: ${item.error}`);
  for (const item of indexes.failed) console.log(`  ✗ 索引 ${item.collection} ${item.name}: ${item.error}`);
  for (const item of indexes.mismatched) {
    console.log(`  ${item.resolved ? "~" : "!"} ${item.collection} ${item.name} 期望 ${item.expected}，实际 ${item.actual}` +
      `${item.resolved ? "（本次已重建）" : ""}`);
  }
  for (const item of indexes.conflicts) {
    console.log(`  ${item.resolved ? "~" : "!"} ${item.collection} 已存在同字段索引 ${item.name}，规范名应为 ${item.canonical}` +
      `${item.resolved ? "（本次已删除并改建规范名）" : ""}`);
  }
  const unresolved = indexes.mismatched.filter((item) => !item.resolved).length +
    indexes.conflicts.filter((item) => !item.resolved).length;
  if (unresolved > 0) {
    console.log(`  （还有 ${unresolved} 项未处理；确认后可用 --apply --fix-index-drift 收敛）`);
  }
}

function hasProblem(report) {
  return report.collections.failed.length > 0 ||
    report.indexes.failed.length > 0 ||
    report.indexes.mismatched.length > 0 ||
    report.indexes.unverified > 0;
}

/**
 * 预检：SecretId 所属账号能否看到目标环境。
 * 看不到时逐个集合调用只会刷一屏同样的错误，这里一次说清。
 */
export async function preflightEnv(app, settings) {
  let visibleEnvIds;
  try {
    const listed = await app.env.listEnvs();
    visibleEnvIds = (listed?.EnvList ?? [])
      .map((item) => item?.EnvId)
      .filter((value) => typeof value === "string" && value.length > 0);
  } catch (error) {
    return { skipped: true, reason: sanitize(error) };
  }
  if (visibleEnvIds.length === 0) {
    throw new Error("当前 SecretId 所属账号下没有任何云开发环境。请确认云开发已开通，且凭据属于该小程序所在账号。");
  }
  if (!visibleEnvIds.includes(settings.envId)) {
    const preview = visibleEnvIds.slice(0, 5).join("、");
    throw new Error(
      `当前凭据所属账号看不到环境 ${settings.envId}（该账号可见 ${visibleEnvIds.length} 个环境：${preview}` +
      `${visibleEnvIds.length > 5 ? " …" : ""}）。请核对环境 ID 拼写、云开发是否已开通，以及凭据是否属于该环境所在账号。`,
    );
  }
  return { skipped: false, visible: visibleEnvIds.length };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "help") {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (options.mode === "usage") return EXIT_USAGE;

  const settings = resolveSettings(options);
  if (!settings.namespace) {
    console.error("缺少命名空间：请设置 FOOTBALL_RESOURCE_NAMESPACE 或传 --namespace <value>");
    return EXIT_USAGE;
  }

  const plan = await loadSchemaPlan(settings.namespace);
  if (options.mode === "plan") {
    if (options.json) {
      console.log(JSON.stringify({ settings: redactSettings(settings), plan }, null, 2));
    } else {
      printPlan(plan, settings);
    }
    return EXIT_OK;
  }

  assertReadyForRemote(settings, options);

  const { default: CloudBase } = await import("@cloudbase/manager-node");
  const app = CloudBase.init({
    secretId: settings.secretId,
    secretKey: settings.secretKey,
    envId: settings.envId,
  });

  const preflight = await preflightEnv(app, settings);
  if (preflight.skipped) console.warn(`  (环境预检跳过：${preflight.reason})`);

  const report = await provisionDatabase(
    plan,
    { apply: options.mode === "apply", fixIndexDrift: options.fixIndexDrift },
    app.database,
  );
  report.mode = options.mode;
  report.namespace = settings.namespace;
  report.envId = settings.envId;

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);

  if (options.mode === "verify") {
    if (hasProblem(report)) {
      console.error("\n体检未通过：存在缺失或定义不一致。执行 npm run cloudbase:provision -- --apply 补齐。");
      return EXIT_PROBLEM;
    }
    console.log("\n体检通过：集合与索引均与 src/schema 一致。");
    return EXIT_OK;
  }
  if (report.collections.failed.length > 0 || report.indexes.failed.length > 0) {
    console.error("\n有失败项，请按上面的 ✗ 行处理。");
    return EXIT_PROBLEM;
  }
  console.log("\n完成。集合权限（ADMINONLY）仍需在控制台确认。");
  return EXIT_OK;
}

function redactSettings(settings) {
  return {
    envFile: settings.envFile,
    namespace: settings.namespace,
    environment: settings.environment,
    envId: settings.envId,
  };
}

// 只有被直接执行时才跑 main；被测试 import 时保持静默。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`失败：${sanitize(error)}`);
      process.exit(EXIT_PROBLEM);
    });
}
