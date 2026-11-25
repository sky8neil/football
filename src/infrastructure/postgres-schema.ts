import { COLLECTION_DEFINITIONS, type FieldType } from "../schema/collections.js";
import { QUERY_INDEXES, UNIQUE_INDEXES } from "../schema/indexes.js";
import { cloudBaseCollectionName } from "./cloudbase-db.js";

export const AUTH_SESSIONS_TABLE = "auth_sessions" as const;
export const ADMIN_LOGIN_CONSUMED_JTIS_TABLE = "admin_login_consumed_jtis" as const;
export const JSONB_UTC_TIMESTAMPTZ_FUNCTION = "jsonb_utc_timestamptz" as const;

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function quoteIdent(value: string): string {
  if (!IDENT.test(value)) throw new Error(`invalid SQL identifier: ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

export function qualifiedTable(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

function fieldType(collection: string, field: string): FieldType | undefined {
  return COLLECTION_DEFINITIONS.find((item) => item.collection === collection)?.fields[field]?.type;
}

function jsonText(field: string, alias = "document"): string {
  return `(${alias} ->> ${literal(field)})`;
}

function utcTimestamptzCall(schema: string, text: string): string {
  return `${qualifiedTable(schema, JSONB_UTC_TIMESTAMPTZ_FUNCTION)}(${text})`;
}

export function postgresDocumentFieldExpr(
  schema: string,
  collection: string,
  field: string,
  alias = "document",
): string {
  if ((collection === "predictions" || collection === "matches") && field === "canonical_match_id") {
    return `COALESCE(${jsonText(field, alias)}, ${jsonText("match_id", alias)})`;
  }
  const type = fieldType(collection, field);
  const text = jsonText(field, alias);
  if (type === "date") return utcTimestamptzCall(schema, text);
  if (type === "int") return `(${text})::numeric`;
  if (type === "bool") return `(${text})::boolean`;
  return text;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseIndexField(raw: string): { field: string; desc: boolean } {
  if (raw.endsWith(":desc")) return { field: raw.slice(0, -":desc".length), desc: true };
  return { field: raw, desc: false };
}

export interface PostgresIndexPlan {
  logical: string;
  table: string;
  name: string;
  unique: boolean;
  sql: string;
}

export interface PostgresTablePlan {
  logical: string;
  table: string;
  sql: string;
}

export interface PostgresFunctionPlan {
  name: string;
  sql: string;
}

export interface PostgresSchemaPlan {
  schema: string;
  namespace: string;
  functions: PostgresFunctionPlan[];
  tables: PostgresTablePlan[];
  indexes: PostgresIndexPlan[];
  authSessions: {
    table: string;
    sql: string;
    indexes: PostgresIndexPlan[];
  };
  adminLoginConsumedJtis: {
    table: string;
    sql: string;
    indexes: PostgresIndexPlan[];
  };
}

function collectionTableSql(schema: string, table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${qualifiedTable(schema, table)} (_id text PRIMARY KEY, document jsonb NOT NULL)`;
}

function utcTimestamptzFunctionSql(schema: string): string {
  return [
    `CREATE OR REPLACE FUNCTION ${qualifiedTable(schema, JSONB_UTC_TIMESTAMPTZ_FUNCTION)}(value text)`,
    "RETURNS timestamptz",
    "LANGUAGE sql",
    "IMMUTABLE",
    "STRICT",
    "PARALLEL SAFE",
    "SET timezone TO 'UTC'",
    `AS $jsonb_utc_timestamptz$ SELECT $1::timestamptz $jsonb_utc_timestamptz$`,
  ].join(" ");
}

function indexSql(
  schema: string,
  table: string,
  collection: string,
  name: string,
  fields: readonly string[],
  unique: boolean,
): string {
  const expressions = fields.map((raw) => {
    const parsed = parseIndexField(raw);
    if (fieldType(collection, parsed.field) === undefined) {
      throw new Error(`index field not in collection schema: ${collection}.${parsed.field}`);
    }
    const expr = `(${postgresDocumentFieldExpr(schema, collection, parsed.field)})`;
    return parsed.desc ? `${expr} DESC` : expr;
  });
  const uniqueSql = unique ? "UNIQUE " : "";
  return `CREATE ${uniqueSql}INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${qualifiedTable(schema, table)} (${expressions.join(", ")})`;
}

export function buildPostgresSchemaPlan(namespace: string, schema: string): PostgresSchemaPlan {
  const tables = COLLECTION_DEFINITIONS.map((definition) => {
    const table = cloudBaseCollectionName(namespace, definition.collection);
    return {
      logical: definition.collection,
      table,
      sql: collectionTableSql(schema, table),
    };
  });
  const indexes = [...UNIQUE_INDEXES, ...QUERY_INDEXES].map((index) => {
    const table = cloudBaseCollectionName(namespace, index.collection);
    return {
      logical: index.collection,
      table,
      name: index.name,
      unique: index.unique,
      sql: indexSql(schema, table, index.collection, index.name, index.fields, index.unique),
    };
  });
  const authTable = AUTH_SESSIONS_TABLE;
  const authIndexes: PostgresIndexPlan[] = [
    {
      logical: AUTH_SESSIONS_TABLE,
      table: authTable,
      name: "ix_auth_sessions_expires_at",
      unique: false,
      sql: `CREATE INDEX IF NOT EXISTS ${quoteIdent("ix_auth_sessions_expires_at")} ON ${qualifiedTable(schema, authTable)} (expires_at)`,
    },
    {
      logical: AUTH_SESSIONS_TABLE,
      table: authTable,
      name: "ix_auth_sessions_openid",
      unique: false,
      sql: `CREATE INDEX IF NOT EXISTS ${quoteIdent("ix_auth_sessions_openid")} ON ${qualifiedTable(schema, authTable)} (openid)`,
    },
  ];
  const jtiTable = ADMIN_LOGIN_CONSUMED_JTIS_TABLE;
  const jtiIndexes: PostgresIndexPlan[] = [
    {
      logical: ADMIN_LOGIN_CONSUMED_JTIS_TABLE,
      table: jtiTable,
      name: "ix_admin_login_consumed_jtis_expires_at",
      unique: false,
      sql: `CREATE INDEX IF NOT EXISTS ${quoteIdent("ix_admin_login_consumed_jtis_expires_at")} ON ${qualifiedTable(schema, jtiTable)} (expires_at)`,
    },
  ];
  return {
    schema,
    namespace,
    functions: [
      {
        name: JSONB_UTC_TIMESTAMPTZ_FUNCTION,
        sql: utcTimestamptzFunctionSql(schema),
      },
    ],
    tables,
    indexes,
    authSessions: {
      table: authTable,
      sql: `CREATE TABLE IF NOT EXISTS ${qualifiedTable(schema, authTable)} (token text PRIMARY KEY, openid text NOT NULL, expires_at timestamptz NOT NULL)`,
      indexes: authIndexes,
    },
    adminLoginConsumedJtis: {
      table: jtiTable,
      sql: `CREATE TABLE IF NOT EXISTS ${qualifiedTable(schema, jtiTable)} (jti text PRIMARY KEY, expires_at timestamptz NOT NULL)`,
      indexes: jtiIndexes,
    },
  };
}

export function postgresSchemaStatements(plan: PostgresSchemaPlan): string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(plan.schema)}`,
    ...plan.functions.map((item) => item.sql),
    ...plan.tables.map((item) => item.sql),
    plan.authSessions.sql,
    plan.adminLoginConsumedJtis.sql,
    ...plan.indexes.map((item) => item.sql),
    ...plan.authSessions.indexes.map((item) => item.sql),
    ...plan.adminLoginConsumedJtis.indexes.map((item) => item.sql),
  ];
}

export interface PostgresQueryResult {
  rows: Array<Record<string, unknown>>;
  /** pg command 标签。自定义适配器可不提供；缺失时无法判定隐式回滚。 */
  command?: string;
  /** 受影响行数（如 DELETE / UPDATE）。 */
  rowCount?: number | null;
}

export type PostgresQueryFn = ((sql: string, params?: unknown[]) => Promise<PostgresQueryResult>) & {
  withSession?: <T>(fn: (query: PostgresQueryFn) => Promise<T>) => Promise<T>;
};

export interface PostgresSchemaInspection {
  schemaExists: boolean;
  tables: string[];
  indexes: string[];
  functions: string[];
  indexDefs?: Readonly<Record<string, string>>;
}

export interface PostgresSchemaObjects {
  schema: boolean;
  tables: string[];
  indexes: string[];
  functions: string[];
}

export interface PostgresIndexDrift {
  name: string;
  expected: string;
  actual: string;
}

export interface PostgresSchemaDiff {
  schema: string;
  namespace: string;
  inspected: boolean;
  expected: PostgresSchemaObjects;
  existing: PostgresSchemaObjects;
  pending: PostgresSchemaObjects;
  driftedIndexes: PostgresIndexDrift[];
}

export function expectedPostgresSchemaObjects(plan: PostgresSchemaPlan): PostgresSchemaObjects {
  return {
    schema: true,
    tables: [
      ...plan.tables.map((item) => item.table),
      plan.authSessions.table,
      plan.adminLoginConsumedJtis.table,
    ],
    indexes: [
      ...plan.indexes.map((item) => item.name),
      ...plan.authSessions.indexes.map((item) => item.name),
      ...plan.adminLoginConsumedJtis.indexes.map((item) => item.name),
    ],
    functions: plan.functions.map((item) => item.name),
  };
}

function subtract(expected: string[], existing: string[]): string[] {
  const have = new Set(existing);
  return expected.filter((item) => !have.has(item));
}

const POSTGRES_SCHEMA_ADVISORY_LOCK_NS = "football_postgres_schema";

function matchingParen(sql: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function isFunctionCall(expr: string): boolean {
  const match = /^[a-z_][a-z0-9_]*\s*\(/i.exec(expr);
  if (match === null) return false;
  return matchingParen(expr, match[0].length - 1) === expr.length - 1;
}

function stripFunctionCallWrappers(sql: string): string {
  let current = sql;
  let previous = "";
  while (current !== previous) {
    previous = current;
    let next = "";
    let i = 0;
    while (i < current.length) {
      if (current[i] === "(") {
        const close = matchingParen(current, i);
        const inner = close === -1 ? "" : current.slice(i + 1, close).trim();
        if (close !== -1 && isFunctionCall(inner)) {
          next += inner;
          i = close + 1;
          continue;
        }
      }
      next += current[i];
      i += 1;
    }
    current = next;
  }
  return current;
}

export function normalizePostgresIndexDef(sql: string, schema?: string): string {
  let normalized = sql.trim().toLowerCase().replace(/"/g, "");
  normalized = normalized.replace(/\s+/g, " ");
  normalized = normalized.replace(/\bif\s+not\s+exists\b/g, "");
  normalized = normalized.replace(/\busing\s+btree\b/g, "");
  normalized = normalized.replace(/::text\b/g, "");
  // PG B-tree defaults: DESC -> NULLS FIRST, ASC/default -> NULLS LAST.
  // Only strip defaults so drifted non-default NULLS FIRST/LAST ordering remains visible.
  normalized = normalized.replace(/\bdesc\s+nulls\s+first\b/g, "desc");
  normalized = normalized.replace(/\basc\s+nulls\s+last\b/g, "");
  normalized = normalized.replace(/(?<!\bdesc )\bnulls\s+last\b/g, "");
  normalized = normalized.replace(/\basc\b/g, "");
  if (schema !== undefined && schema.length > 0) {
    normalized = normalized.replaceAll(`${schema.toLowerCase()}.`, "");
  }
  normalized = stripFunctionCallWrappers(normalized);
  normalized = normalized.replace(/\s+/g, " ").trim();
  normalized = normalized.replace(/\s+\)/g, ")");
  normalized = normalized.replace(/\s*,\s*/g, ", ");
  return normalized;
}

function indexDefinitionDrifted(schema: string, expectedSql: string, actualDef: string | undefined): boolean {
  if (actualDef === undefined || actualDef.length === 0) return false;
  return normalizePostgresIndexDef(actualDef, schema) !== normalizePostgresIndexDef(expectedSql, schema);
}

function plannedIndexes(plan: PostgresSchemaPlan): PostgresIndexPlan[] {
  return [...plan.indexes, ...plan.authSessions.indexes, ...plan.adminLoginConsumedJtis.indexes];
}

function driftedPostgresIndexes(
  plan: PostgresSchemaPlan,
  inspection: PostgresSchemaInspection | null,
): PostgresIndexDrift[] {
  if (inspection?.indexDefs === undefined) return [];
  const present = new Set(inspection.indexes);
  const drifts: PostgresIndexDrift[] = [];
  for (const index of plannedIndexes(plan)) {
    if (!present.has(index.name)) continue;
    const actual = inspection.indexDefs[index.name];
    if (actual === undefined || actual.length === 0) continue;
    if (!indexDefinitionDrifted(plan.schema, index.sql, actual)) continue;
    drifts.push({
      name: index.name,
      expected: normalizePostgresIndexDef(index.sql, plan.schema),
      actual: normalizePostgresIndexDef(actual, plan.schema),
    });
  }
  return drifts;
}

function emptySchemaObjects(schema: boolean): PostgresSchemaObjects {
  return { schema, tables: [], indexes: [], functions: [] };
}

export function diffPostgresSchema(
  plan: PostgresSchemaPlan,
  inspection: PostgresSchemaInspection | null,
): PostgresSchemaDiff {
  const expected = expectedPostgresSchemaObjects(plan);
  const existing: PostgresSchemaObjects =
    inspection === null
      ? emptySchemaObjects(false)
      : {
          schema: inspection.schemaExists,
          tables: [...inspection.tables],
          indexes: [...inspection.indexes],
          functions: [...inspection.functions],
        };
  return {
    schema: plan.schema,
    namespace: plan.namespace,
    inspected: inspection !== null,
    expected,
    existing,
    pending: {
      schema: expected.schema && !existing.schema,
      tables: subtract(expected.tables, existing.tables),
      indexes: subtract(expected.indexes, existing.indexes),
      functions: subtract(expected.functions, existing.functions),
    },
    driftedIndexes: driftedPostgresIndexes(plan, inspection),
  };
}

export function pendingPostgresSchemaStatements(plan: PostgresSchemaPlan, diff: PostgresSchemaDiff): string[] {
  const statements: string[] = [];
  if (diff.pending.schema) {
    statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(plan.schema)}`);
  }
  for (const fn of plan.functions) {
    if (diff.pending.functions.includes(fn.name)) statements.push(fn.sql);
  }
  for (const table of plan.tables) {
    if (diff.pending.tables.includes(table.table)) statements.push(table.sql);
  }
  if (diff.pending.tables.includes(plan.authSessions.table)) statements.push(plan.authSessions.sql);
  if (diff.pending.tables.includes(plan.adminLoginConsumedJtis.table)) {
    statements.push(plan.adminLoginConsumedJtis.sql);
  }
  for (const index of plannedIndexes(plan)) {
    if (!diff.pending.indexes.includes(index.name)) continue;
    statements.push(index.sql);
  }
  return statements;
}

export async function inspectPostgresSchema(
  query: PostgresQueryFn,
  plan: PostgresSchemaPlan,
): Promise<PostgresSchemaInspection> {
  const schemaRows = await query(
    "SELECT 1 AS ok FROM pg_catalog.pg_namespace WHERE nspname = $1",
    [plan.schema],
  );
  if (schemaRows.rows.length === 0) {
    return { schemaExists: false, tables: [], indexes: [], functions: [] };
  }
  const tableRows = await query(
    "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1",
    [plan.schema],
  );
  const indexRows = await query(
    "SELECT indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname = $1",
    [plan.schema],
  );
  const functionRows = await query(
    "SELECT p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1",
    [plan.schema],
  );
  const indexDefs: Record<string, string> = {};
  for (const row of indexRows.rows) {
    if (typeof row.indexdef === "string" && row.indexdef.length > 0) {
      indexDefs[String(row.indexname)] = row.indexdef;
    }
  }
  return {
    schemaExists: true,
    tables: tableRows.rows.map((row) => String(row.tablename)),
    indexes: indexRows.rows.map((row) => String(row.indexname)),
    functions: functionRows.rows.map((row) => String(row.proname)),
    indexDefs,
  };
}

function postgresSchemaApplyStatements(plan: PostgresSchemaPlan): string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(plan.schema)}`,
    ...plan.functions.map((fn) => fn.sql),
    ...plan.tables.map((table) => table.sql),
    plan.authSessions.sql,
    plan.adminLoginConsumedJtis.sql,
    ...plannedIndexes(plan).map((index) => index.sql),
  ];
}

function postgresSchemaApplyScript(plan: PostgresSchemaPlan): string {
  const lockKey = `${plan.schema}:${plan.namespace}`;
  const statements = postgresSchemaApplyStatements(plan);
  return [
    "DO $football_schema_apply$",
    "BEGIN",
    `  PERFORM pg_advisory_xact_lock(hashtext(${literal(POSTGRES_SCHEMA_ADVISORY_LOCK_NS)}), hashtext(${literal(lockKey)}));`,
    ...statements.map((statement) => `  EXECUTE ${literal(statement)};`),
    "END",
    "$football_schema_apply$",
  ].join("\n");
}

export interface PostgresApplyReport {
  schema: string;
  expected: { tables: string[]; indexes: string[]; functions: string[] };
  existing: { tables: string[]; indexes: string[]; functions: string[] };
  created: { schema: boolean; tables: string[]; indexes: string[]; functions: string[] };
  driftedIndexes: PostgresIndexDrift[];
}

export async function applyPostgresSchema(
  query: PostgresQueryFn,
  plan: PostgresSchemaPlan,
): Promise<PostgresApplyReport> {
  const expected = expectedPostgresSchemaObjects(plan);
  let before: PostgresSchemaInspection;
  let after: PostgresSchemaInspection;
  if (typeof query.withSession === "function") {
    const lockKey = `${plan.schema}:${plan.namespace}`;
    const statements = postgresSchemaApplyStatements(plan);
    const snapshot = await query.withSession(async (sessionQuery) => {
      await sessionQuery("BEGIN");
      try {
        await sessionQuery(
          `SELECT pg_advisory_xact_lock(hashtext(${literal(POSTGRES_SCHEMA_ADVISORY_LOCK_NS)}), hashtext(${literal(lockKey)}))`,
        );
        const lockedBefore = await inspectPostgresSchema(sessionQuery, plan);
        for (const statement of statements) {
          await sessionQuery(statement);
        }
        const lockedAfter = await inspectPostgresSchema(sessionQuery, plan);
        await sessionQuery("COMMIT");
        return { before: lockedBefore, after: lockedAfter };
      } catch (err) {
        await sessionQuery("ROLLBACK").catch(() => undefined);
        throw err;
      }
    });
    before = snapshot.before;
    after = snapshot.after;
  } else {
    before = await inspectPostgresSchema(query, plan);
    await query(postgresSchemaApplyScript(plan));
    after = await inspectPostgresSchema(query, plan);
  }
  const created = { schema: false, tables: [] as string[], indexes: [] as string[], functions: [] as string[] };
  if (!before.schemaExists && after.schemaExists) created.schema = true;
  for (const name of expected.functions) {
    if (!before.functions.includes(name) && after.functions.includes(name)) created.functions.push(name);
  }
  for (const name of expected.tables) {
    if (!before.tables.includes(name) && after.tables.includes(name)) created.tables.push(name);
  }
  for (const index of plannedIndexes(plan)) {
    if (before.indexes.includes(index.name) || !after.indexes.includes(index.name)) continue;
    if (indexDefinitionDrifted(plan.schema, index.sql, after.indexDefs?.[index.name])) continue;
    created.indexes.push(index.name);
  }
  return {
    schema: plan.schema,
    expected: { tables: expected.tables, indexes: expected.indexes, functions: expected.functions },
    existing: { tables: after.tables, indexes: after.indexes, functions: after.functions },
    created,
    driftedIndexes: driftedPostgresIndexes(plan, after),
  };
}
