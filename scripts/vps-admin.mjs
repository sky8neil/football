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

function printPlan(plan, { applied }) {
  console.log(JSON.stringify({
    mode: applied ? "apply" : "dry-run",
    action: plan.action,
    openid: plan.openid,
    admin_id: plan.admin_id,
    status: plan.status,
    role: plan.role,
    existing: plan.existing,
  }, null, 2));
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const apply = hasFlag(args, "--apply");
  if (apply && (hasFlag(args, "--dry-run") || hasFlag(args, "--plan"))) {
    throw new Error("Use either --dry-run or --apply, not both");
  }
  const openid = required(
    argValue(args, "--openid") ?? env.FOOTBALL_ADMIN_OPENID,
    "Provide --openid or FOOTBALL_ADMIN_OPENID",
  );
  const namespace = required(
    argValue(args, "--namespace") ?? env.FOOTBALL_RESOURCE_NAMESPACE,
    "Provide --namespace or FOOTBALL_RESOURCE_NAMESPACE",
  );
  const schema = required(
    argValue(args, "--schema") ?? env.FOOTBALL_DATABASE_SCHEMA,
    "Provide --schema or FOOTBALL_DATABASE_SCHEMA",
  );
  const url = required(
    argValue(args, "--database-url") ?? env.FOOTBALL_DATABASE_URL,
    "FOOTBALL_DATABASE_URL or --database-url is required",
  );
  const rawStatus = argValue(args, "--status");
  if (!existsSync(join(ROOT, "dist", "application", "admin-grant.js"))) {
    throw new Error("dist/ 尚未构建，请先运行 npm run build（或直接用 npm run vps:admin）");
  }
  const { applyAdminGrant, planAdminGrant } = await import("../dist/application/admin-grant.js");
  const { AdminStatus } = await import("../dist/domain/enums.js");
  const { createPostgresAppRepository } = await import("../dist/gateway/repository-factory.js");
  const pg = await import("pg");
  const Pg = pg.default ?? pg;
  if (rawStatus !== undefined && rawStatus !== AdminStatus.Active && rawStatus !== AdminStatus.Disabled) {
    throw new Error("status must be active or disabled");
  }
  const status = rawStatus ?? AdminStatus.Active;
  const now = new Date();
  const pool = new Pg.Pool({ connectionString: url });
  try {
    const repo = createPostgresAppRepository(pool, {
      database_url: url,
      database_schema: schema,
      resource_namespace: namespace,
    });
    const plan = apply
      ? await applyAdminGrant(repo, { openid, now, status })
      : await planAdminGrant(repo, { openid, now, status });
    printPlan(plan, { applied: apply });
  } finally {
    await pool.end();
  }
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
