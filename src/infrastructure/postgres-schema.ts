import { COLLECTION_DEFINITIONS, type FieldType } from "../schema/collections.js";
import { QUERY_INDEXES, UNIQUE_INDEXES } from "../schema/indexes.js";
import { cloudBaseCollectionName } from "./cloudbase-db.js";

export const AUTH_SESSIONS_TABLE = "auth_sessions" as const;
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

function jsonText(field: string): string {
  return `(document ->> ${literal(field)})`;
}

function utcTimestamptzCall(schema: string, text: string): string {
  return `${qualifiedTable(schema, JSONB_UTC_TIMESTAMPTZ_FUNCTION)}(${text})`;
}

export function postgresDocumentFieldExpr(schema: string, collection: string, field: string): string {
  const type = fieldType(collection, field);
  const text = jsonText(field);
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
  };
}

export function postgresSchemaStatements(plan: PostgresSchemaPlan): string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(plan.schema)}`,
    ...plan.functions.map((item) => item.sql),
    ...plan.tables.map((item) => item.sql),
    plan.authSessions.sql,
    ...plan.indexes.map((item) => item.sql),
    ...plan.authSessions.indexes.map((item) => item.sql),
  ];
}

export interface PostgresQueryResult {
  rows: Array<Record<string, unknown>>;
}

export type PostgresQueryFn = (sql: string, params?: unknown[]) => Promise<PostgresQueryResult>;

export interface PostgresSchemaInspection {
  schemaExists: boolean;
  tables: string[];
  indexes: string[];
  functions: string[];
}

export interface PostgresSchemaObjects {
  schema: boolean;
  tables: string[];
  indexes: string[];
  functions: string[];
}

export interface PostgresSchemaDiff {
  schema: string;
  namespace: string;
  inspected: boolean;
  expected: PostgresSchemaObjects;
  existing: PostgresSchemaObjects;
  pending: PostgresSchemaObjects;
}

export function expectedPostgresSchemaObjects(plan: PostgresSchemaPlan): PostgresSchemaObjects {
  return {
    schema: true,
    tables: [...plan.tables.map((item) => item.table), plan.authSessions.table],
    indexes: [...plan.indexes.map((item) => item.name), ...plan.authSessions.indexes.map((item) => item.name)],
    functions: plan.functions.map((item) => item.name),
  };
}

function subtract(expected: string[], existing: string[]): string[] {
  const have = new Set(existing);
  return expected.filter((item) => !have.has(item));
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
  for (const index of [...plan.indexes, ...plan.authSessions.indexes]) {
    if (diff.pending.indexes.includes(index.name)) statements.push(index.sql);
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
    "SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname = $1",
    [plan.schema],
  );
  const functionRows = await query(
    "SELECT p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1",
    [plan.schema],
  );
  return {
    schemaExists: true,
    tables: tableRows.rows.map((row) => String(row.tablename)),
    indexes: indexRows.rows.map((row) => String(row.indexname)),
    functions: functionRows.rows.map((row) => String(row.proname)),
  };
}

export interface PostgresApplyReport {
  schema: string;
  expected: { tables: string[]; indexes: string[]; functions: string[] };
  existing: { tables: string[]; indexes: string[]; functions: string[] };
  created: { schema: boolean; tables: string[]; indexes: string[]; functions: string[] };
}

export async function applyPostgresSchema(
  query: PostgresQueryFn,
  plan: PostgresSchemaPlan,
): Promise<PostgresApplyReport> {
  const expected = expectedPostgresSchemaObjects(plan);
  const before = await inspectPostgresSchema(query, plan);
  const created = { schema: false, tables: [] as string[], indexes: [] as string[], functions: [] as string[] };
  if (!before.schemaExists) {
    await query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(plan.schema)}`);
    created.schema = true;
  }
  for (const fn of plan.functions) {
    if (!before.functions.includes(fn.name)) created.functions.push(fn.name);
    await query(fn.sql);
  }
  for (const table of plan.tables) {
    if (!before.tables.includes(table.table)) {
      await query(table.sql);
      created.tables.push(table.table);
    }
  }
  if (!before.tables.includes(plan.authSessions.table)) {
    await query(plan.authSessions.sql);
    created.tables.push(plan.authSessions.table);
  }
  for (const index of [...plan.indexes, ...plan.authSessions.indexes]) {
    if (!before.indexes.includes(index.name)) {
      await query(index.sql);
      created.indexes.push(index.name);
    }
  }
  const after = await inspectPostgresSchema(query, plan);
  return {
    schema: plan.schema,
    expected: { tables: expected.tables, indexes: expected.indexes, functions: expected.functions },
    existing: { tables: after.tables, indexes: after.indexes, functions: after.functions },
    created,
  };
}
