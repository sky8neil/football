import { existsSync, readFileSync } from "node:fs";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = "/etc/football/gateway.env";
const PAGE_SIZE = 500;

export function parseArgs(args) {
  const options = { mode: "dry-run", backup: undefined, manifest: undefined, rollback: undefined };
  let selectedMode = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run" || arg === "--apply" || arg === "--rollback") {
      if (selectedMode) throw new Error("只能选择一种模式");
      selectedMode = true;
      options.mode = arg.slice(2);
      if (arg !== "--rollback") continue;
    } else if (arg !== "--backup" && arg !== "--manifest") {
      throw new Error(`未知参数: ${arg}`);
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} 需要路径`);
    options[arg.slice(2)] = resolve(value);
  }
  if (options.mode !== "apply" && (options.backup || options.manifest)) throw new Error("--backup 和 --manifest 仅适用于 --apply");
  if (options.backup && options.backup === options.manifest) throw new Error("备份和清单路径不能相同");
  return options;
}

export async function executePlan(plan, execute) {
  if (plan.review.length) throw new Error(JSON.stringify({ error: "存在待复核项，未执行写入", review: plan.review }, null, 2));
  return execute();
}

function settings(env) {
  const file = {};
  if (existsSync(ENV_FILE)) {
    for (const raw of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      file[key] = value;
    }
  }
  const required = (key) => {
    const value = (env[key] ?? file[key])?.trim();
    if (!value) throw new Error(`${key} is required`);
    return value;
  };
  return { database_url: required("FOOTBALL_DATABASE_URL"), database_schema: required("FOOTBALL_DATABASE_SCHEMA"), resource_namespace: required("FOOTBALL_RESOURCE_NAMESPACE") };
}

async function loadRuntime() {
  if (!existsSync(join(ROOT, "dist/application/match-identity-migration.js")) || !existsSync(join(ROOT, "dist/runtime/vps-runtime.js"))) throw new Error("dist/ 尚未构建，请先运行 npm run build");
  const [runtime, planner, schema, cloudbase, invariants] = await Promise.all([
    import("../dist/runtime/vps-runtime.js"), import("../dist/application/match-identity-migration.js"),
    import("../dist/infrastructure/postgres-schema.js"), import("../dist/infrastructure/cloudbase-db.js"),
    import("../dist/domain/invariants.js"),
  ]);
  return { ...runtime, ...planner, ...schema, ...cloudbase, ...invariants };
}

async function readPages(query, table) {
  const rows = [];
  let lastId = null;
  while (true) {
    const page = await query(`SELECT _id, document FROM ${table} WHERE ($1::text IS NULL OR _id > $1) ORDER BY _id LIMIT $2`, [lastId, PAGE_SIZE]);
    rows.push(...page.rows);
    if (page.rows.length < PAGE_SIZE) return rows;
    lastId = page.rows[page.rows.length - 1]._id;
  }
}

function report(mode, matches, predictions, plan) {
  return { mode, inspected: { matches: matches.length, predictions: predictions.length }, ...plan, summary: { match_updates: plan.match_updates.length, prediction_updates: plan.prediction_updates.length, review: plan.review.length } };
}

async function saveJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function stagePredictions(client, table, ids) {
  for (const id of ids) {
    let temporary;
    do {
      temporary = `identity-migration-${randomUUID()}`;
    } while ((await client.query(`SELECT 1 FROM ${table} WHERE COALESCE(document->>'canonical_match_id', document->>'match_id') = $1 LIMIT 1`, [temporary])).rowCount);
    const result = await client.query(`UPDATE ${table} SET document = jsonb_set(document, '{canonical_match_id}', to_jsonb($2::text)) WHERE _id = $1`, [id, temporary]);
    if (result.rowCount !== 1) throw new Error(`预测暂存失败: ${id}`);
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseArgs(args);
  const modules = await loadRuntime();
  const postgres = settings(env);
  const runtime = modules.createVpsRuntime({ postgres });
  const pg = await import("pg");
  const client = new (pg.default ?? pg).Client({ connectionString: postgres.database_url });
  const tables = Object.fromEntries(["matches", "predictions"].map((name) => [name, modules.qualifiedTable(postgres.database_schema, modules.cloudBaseCollectionName(postgres.resource_namespace, name))]));
  let connected = false;
  let transaction = false;
  let temporaryManifest;
  try {
    await client.connect();
    connected = true;
    await client.query(options.mode === "dry-run" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    transaction = true;
    if (options.mode !== "dry-run") await client.query(`LOCK TABLE ${tables.matches}, ${tables.predictions} IN SHARE ROW EXCLUSIVE MODE`);
    if (options.mode === "rollback") {
      const manifest = JSON.parse(await readFile(options.rollback, "utf8"));
      const backup = JSON.parse(await readFile(manifest.backup_path, "utf8"));
      if (backup.schema !== postgres.database_schema || backup.namespace !== postgres.resource_namespace || !Array.isArray(backup.records)) throw new Error("备份与目标库不匹配或格式无效");
      for (const record of backup.records) {
        if (!["matches", "predictions"].includes(record.collection) || typeof record._id !== "string" || !record.document || record.document._id !== record._id) throw new Error("备份记录无效");
      }
      await stagePredictions(client, tables.predictions, backup.records.filter((record) => record.collection === "predictions").map((record) => record._id));
      for (const record of backup.records) {
        const result = await client.query(`UPDATE ${tables[record.collection]} SET document = $2::jsonb WHERE _id = $1`, [record._id, JSON.stringify(record.document)]);
        if (result.rowCount !== 1) throw new Error(`回滚记录不存在: ${record.collection}/${record._id}`);
      }
      await client.query("COMMIT");
      transaction = false;
      console.log(JSON.stringify({ mode: "rollback", restored: backup.records.length, backup_path: manifest.backup_path }, null, 2));
      return;
    }
    const matches = await readPages(client.query.bind(client), tables.matches);
    const predictions = await readPages(client.query.bind(client), tables.predictions);
    const plan = modules.planIdentityMigration({ matches: matches.map((row) => row.document), predictions: predictions.map((row) => row.document) });
    if (options.mode === "dry-run") {
      await client.query("COMMIT");
      transaction = false;
      console.log(JSON.stringify(report("dry-run", matches, predictions, plan), null, 2));
      return;
    }
    await executePlan(plan, async () => {
      const timestamp = new Date().toISOString().replaceAll(":", "-");
      const backupPath = options.backup ?? `/var/backups/football/identity-migration-${timestamp}.json`;
      const manifestPath = options.manifest ?? `/var/backups/football/identity-migration-${timestamp}.manifest.json`;
      if (backupPath === manifestPath) throw new Error("备份和清单路径不能相同");
      const matchIds = new Set(plan.match_updates.map((item) => item.match_id));
      const predictionIds = new Set(plan.prediction_updates.map((item) => item.prediction_id));
      const records = [...matches.filter((row) => matchIds.has(row.document.match_id)).map((row) => ({ collection: "matches", ...row })), ...predictions.filter((row) => predictionIds.has(row.document.prediction_id)).map((row) => ({ collection: "predictions", ...row }))];
      if (records.length !== matchIds.size + predictionIds.size) throw new Error("受影响记录的身份不唯一");
      await saveJson(backupPath, { schema: postgres.database_schema, namespace: postgres.resource_namespace, records });
      const manifest = { executed_at: new Date().toISOString(), backup_path: backupPath, match_updates: plan.match_updates, prediction_updates: plan.prediction_updates };
      temporaryManifest = `${manifestPath}.pending-${process.pid}`;
      if (existsSync(manifestPath)) throw new Error("清单路径已存在");
      await saveJson(temporaryManifest, manifest);
      const current = new Map(matches.map((row) => [row.document.match_id, { ...row.document }]));
      const ids = new Map(records.map((row) => [`${row.collection}:${row.document.match_id ?? row.document.prediction_id}`, row._id]));
      const matchUpdates = [...plan.match_updates].sort((left, right) => Number(left.after.superseded_by !== null) - Number(right.after.superseded_by !== null));
      for (const update of matchUpdates) {
        const old = current.get(update.match_id);
        const next = { ...old, ...update.after };
        const target = next.superseded_by === null ? null : current.get(next.superseded_by) ?? null;
        const inbound = [...current.values()].filter((item) => item.superseded_by === next.match_id);
        modules.assertMatchSupersessionWrite(next, target, inbound, old);
        const result = await client.query(`UPDATE ${tables.matches} SET document = document || $2::jsonb WHERE _id = $1`, [ids.get(`matches:${update.match_id}`), JSON.stringify(update.after)]);
        if (result.rowCount !== 1) throw new Error(`比赛更新失败: ${update.match_id}`);
        current.set(update.match_id, next);
      }
      await stagePredictions(client, tables.predictions, plan.prediction_updates.map((update) => ids.get(`predictions:${update.prediction_id}`)));
      for (const update of plan.prediction_updates) {
        const result = await client.query(`UPDATE ${tables.predictions} SET document = document || $2::jsonb WHERE _id = $1`, [ids.get(`predictions:${update.prediction_id}`), JSON.stringify({ canonical_match_id: update.after_canonical_match_id })]);
        if (result.rowCount !== 1) throw new Error(`预测更新失败: ${update.prediction_id}`);
      }
      await client.query("COMMIT");
      transaction = false;
      try {
        await link(temporaryManifest, manifestPath);
        await unlink(temporaryManifest);
      } catch (error) { throw new Error(`事务已提交，清单位于 ${temporaryManifest}，请手动移动至 ${manifestPath}: ${error.message}`); }
      console.log(JSON.stringify({ ...report("apply", matches, predictions, plan), backup_path: backupPath, manifest_path: manifestPath }, null, 2));
    });
  } finally {
    if (transaction) {
      await client.query("ROLLBACK");
      if (temporaryManifest) await unlink(temporaryManifest).catch(() => {});
    }
    if (connected) await client.end();
    await runtime.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
