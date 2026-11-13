import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function required(value, message) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(message);
  return value.trim();
}

async function loadSchema() {
  const distPath = join(ROOT, "dist", "infrastructure", "postgres-schema.js");
  if (!existsSync(distPath)) {
    throw new Error("dist/ 尚未构建，请先运行 npm run build（或直接用 npm run vps:db）");
  }
  return import("../dist/infrastructure/postgres-schema.js");
}

async function loadClient(url) {
  const mod = await import("pg");
  const Pg = mod.default ?? mod;
  const Client = Pg.Client;
  if (typeof Client !== "function") throw new Error("pg Client export is unavailable");
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

function printDiff(diff, plan, pendingStatements) {
  const pendingCount =
    (diff.pending.schema ? 1 : 0) +
    diff.pending.tables.length +
    diff.pending.indexes.length +
    diff.pending.functions.length;
  console.log(JSON.stringify({
    schema: diff.schema,
    namespace: diff.namespace,
    inspected: diff.inspected,
    expected: {
      schema: diff.expected.schema,
      tables: diff.expected.tables,
      indexes: diff.expected.indexes,
      functions: diff.expected.functions,
    },
    existing: {
      schema: diff.existing.schema,
      tables: diff.existing.tables,
      indexes: diff.existing.indexes,
      functions: diff.existing.functions,
    },
    pending: {
      schema: diff.pending.schema,
      tables: diff.pending.tables,
      indexes: diff.pending.indexes,
      functions: diff.pending.functions,
    },
    counts: {
      expected_tables: diff.expected.tables.length,
      expected_indexes: diff.expected.indexes.length,
      expected_functions: diff.expected.functions.length,
      existing_tables: diff.existing.tables.length,
      existing_indexes: diff.existing.indexes.length,
      existing_functions: diff.existing.functions.length,
      pending: pendingCount,
    },
  }, null, 2));
  const sql = pendingStatements(plan, diff);
  if (sql.length === 0) {
    console.log("pending_sql: none");
    return;
  }
  console.log("pending_sql:");
  for (const statement of sql) console.log(statement);
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const apply = hasFlag(args, "--apply");
  if (apply && (hasFlag(args, "--plan") || hasFlag(args, "--dry-run"))) {
    throw new Error("Use either --plan/--dry-run or --apply, not both");
  }
  const namespace = required(
    argValue(args, "--namespace") ?? env.FOOTBALL_RESOURCE_NAMESPACE,
    "Provide --namespace or FOOTBALL_RESOURCE_NAMESPACE",
  );
  const schema = required(
    argValue(args, "--schema") ?? env.FOOTBALL_DATABASE_SCHEMA,
    "Provide --schema or FOOTBALL_DATABASE_SCHEMA",
  );
  const {
    applyPostgresSchema,
    buildPostgresSchemaPlan,
    diffPostgresSchema,
    inspectPostgresSchema,
    pendingPostgresSchemaStatements,
  } = await loadSchema();
  const plan = buildPostgresSchemaPlan(namespace, schema);
  const url = argValue(args, "--database-url") ?? env.FOOTBALL_DATABASE_URL;
  if (!apply) {
    let inspection = null;
    if (typeof url === "string" && url.trim().length > 0) {
      const client = await loadClient(url.trim());
      try {
        inspection = await inspectPostgresSchema(async (sql, params) => client.query(sql, params), plan);
      } finally {
        await client.end();
      }
    }
    printDiff(diffPostgresSchema(plan, inspection), plan, pendingPostgresSchemaStatements);
    return;
  }
  const applyUrl = required(url, "FOOTBALL_DATABASE_URL or --database-url is required for --apply");
  const client = await loadClient(applyUrl);
  try {
    const report = await applyPostgresSchema(async (sql, params) => client.query(sql, params), plan);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.end();
  }
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
