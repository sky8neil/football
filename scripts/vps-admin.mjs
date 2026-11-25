import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const CLI_OPTIONS = {
  apply: { type: "boolean" },
  "dry-run": { type: "boolean" },
  plan: { type: "boolean" },
  "issue-login": { type: "boolean" },
  "ttl-seconds": { type: "string" },
  secret: { type: "string" },
  openid: { type: "string" },
  namespace: { type: "string" },
  schema: { type: "string" },
  "database-url": { type: "string" },
  status: { type: "string" },
};

const STRING_OPTIONS = ["openid", "namespace", "schema", "database-url", "status", "ttl-seconds", "secret"];

function parseCliArgs(args) {
  const { values } = parseArgs({
    args,
    options: CLI_OPTIONS,
    strict: true,
    allowPositionals: false,
  });
  for (const name of STRING_OPTIONS) {
    const value = values[name];
    if (typeof value === "string" && value.trimStart().startsWith("-")) {
      throw new Error(`--${name} 的值不能以 - 开头`);
    }
  }
  return values;
}

function required(value, message) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(message);
  return value.trim();
}

export function resolveIssueLoginSecret(values, env = process.env) {
  return required(
    [
      values.secret,
      env.FOOTBALL_ADMIN_LOGIN_SECRET,
      env.FOOTBALL_MATCH_CURSOR_SECRET,
    ].find((candidate) => typeof candidate === "string" && candidate.trim().length > 0),
    "Provide --secret, FOOTBALL_ADMIN_LOGIN_SECRET, or FOOTBALL_MATCH_CURSOR_SECRET",
  );
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
  const values = parseCliArgs(args);
  const apply = values.apply === true;
  const issueLogin = values["issue-login"] === true;
  if (apply && (values["dry-run"] === true || values.plan === true)) {
    throw new Error("Use either --dry-run or --apply, not both");
  }
  if (issueLogin && (apply || values["dry-run"] === true || values.plan === true)) {
    throw new Error("Use --issue-login separately from --apply/--dry-run/--plan");
  }
  const openid = required(
    values.openid ?? env.FOOTBALL_ADMIN_OPENID,
    "Provide --openid or FOOTBALL_ADMIN_OPENID",
  );
  const namespace = required(
    values.namespace ?? env.FOOTBALL_RESOURCE_NAMESPACE,
    "Provide --namespace or FOOTBALL_RESOURCE_NAMESPACE",
  );
  const schema = required(
    values.schema ?? env.FOOTBALL_DATABASE_SCHEMA,
    "Provide --schema or FOOTBALL_DATABASE_SCHEMA",
  );
  const url = required(
    values["database-url"] ?? env.FOOTBALL_DATABASE_URL,
    "FOOTBALL_DATABASE_URL or --database-url is required",
  );
  const rawStatus = values.status;
  if (!existsSync(join(ROOT, "dist", "application", "admin-grant.js"))) {
    throw new Error("dist/ 尚未构建，请先运行 npm run build（或直接用 npm run vps:admin）");
  }
  const { applyAdminGrant, planAdminGrant } = await import("../dist/application/admin-grant.js");
  const { AdminRole, AdminStatus } = await import("../dist/domain/enums.js");
  const { createPostgresAppRepository } = await import("../dist/gateway/repository-factory.js");
  const { issueAdminLoginToken, ADMIN_LOGIN_TOKEN_DEFAULT_TTL_SECONDS } = await import(
    "../dist/gateway/admin-auth.js"
  );
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
    if (issueLogin) {
      const secret = resolveIssueLoginSecret(values, env);
      const rawTtl = values["ttl-seconds"];
      const ttlSeconds = rawTtl === undefined ? ADMIN_LOGIN_TOKEN_DEFAULT_TTL_SECONDS : Number(rawTtl);
      if (!Number.isInteger(ttlSeconds)) {
        throw new Error("--ttl-seconds must be an integer");
      }
      const admin = await repo.admins.findByOpenid(openid);
      if (admin === null || admin.status !== AdminStatus.Active || admin.role !== AdminRole.Admin) {
        throw new Error(`Admin is missing or not active for openid: ${openid}`);
      }
      const issued = issueAdminLoginToken({ openid, secret, now, ttlSeconds });
      console.log(JSON.stringify({
        mode: "issue-login",
        admin_id: admin.admin_id,
        openid: admin.openid,
        ttl_seconds: issued.ttl_seconds,
        expires_at: issued.expires_at.toISOString(),
        login_token: issued.login_token,
      }, null, 2));
      return;
    }
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
