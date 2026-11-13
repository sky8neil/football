import { COLLECTION_DEFINITIONS, type FieldType } from "../schema/collections.js";
import { UNIQUE_INDEXES } from "../schema/indexes.js";
import {
  CloudBaseDocumentNotFoundError,
  CloudBaseDuplicateKeyError,
  logicalCollectionFromPhysical,
  type CloudBaseDb,
  type CloudBaseDocument,
  type CloudBaseQueryOptions,
} from "./cloudbase-db.js";
import { decodeDocument, encodeDocument, encodeQueryValue } from "./document-codec.js";
import {
  postgresDocumentFieldExpr,
  qualifiedTable,
  quoteIdent,
  type PostgresQueryFn,
} from "./postgres-schema.js";

export const POSTGRES_IN_OP = "__in" as const;
export const POSTGRES_LTE_OP = "__lte" as const;

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface PostgresDocumentDbConfig {
  schema: string;
  namespace: string;
}

export interface PostgresExclusiveClient {
  query: PostgresQueryFn;
  release: () => void | Promise<void>;
}

export type PostgresConnectFn = () => Promise<PostgresExclusiveClient>;

export interface PostgresDocumentDbOptions {
  connect?: PostgresConnectFn;
  inTransaction?: boolean;
  savepointDepth?: number;
}

export interface CompiledSql {
  sql: string;
  params: unknown[];
}

type FilterOp =
  | { kind: "eq"; field: string; value: unknown }
  | { kind: "null"; field: string }
  | { kind: "in"; field: string; values: readonly string[] }
  | { kind: "lte"; field: string; value: unknown };

function documentFieldType(logical: string, field: string): FieldType | undefined {
  return COLLECTION_DEFINITIONS.find((item) => item.collection === logical)?.fields[field]?.type;
}

function assertField(field: string): string {
  if (!FIELD_NAME.test(field)) throw new Error(`invalid query field: ${field}`);
  return field;
}

function jsonKey(field: string): string {
  return `'${assertField(field).replaceAll("'", "''")}'`;
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

export function parseDocumentFilter(filter: Record<string, unknown>): FilterOp[] {
  return Object.entries(filter).map(([field, value]) => {
    assertField(field);
    if (isOperatorObject(value)) {
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === POSTGRES_IN_OP) {
        const values = value[POSTGRES_IN_OP];
        if (!Array.isArray(values) || values.some((item) => typeof item !== "string")) {
          throw new Error(`unsupported inFilter values on ${field}`);
        }
        return { kind: "in", field, values };
      }
      if (keys.length === 1 && keys[0] === POSTGRES_LTE_OP) {
        return { kind: "lte", field, value: value[POSTGRES_LTE_OP] };
      }
      throw new Error(`unsupported query operator on ${field}`);
    }
    if (value === null) return { kind: "null", field };
    return { kind: "eq", field, value };
  });
}

function comparisonType(logical: string, field: string, value: unknown): FieldType | "text" {
  const declared = documentFieldType(logical, field);
  if (declared === "date" || value instanceof Date) return "date";
  if (declared === "int" || typeof value === "number") return "int";
  if (declared === "bool" || typeof value === "boolean") return "bool";
  return declared ?? "text";
}

function compileOps(
  schema: string,
  logical: string,
  ops: readonly FilterOp[],
): CompiledSql {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const op of ops) {
    if (op.kind === "null") {
      clauses.push(`(document -> ${jsonKey(op.field)}) = 'null'::jsonb`);
      continue;
    }
    if (op.kind === "in") {
      params.push([...op.values]);
      clauses.push(`${postgresDocumentFieldExpr(schema, logical, op.field)} = ANY($${params.length}::text[])`);
      continue;
    }
    const value = op.value;
    const type = comparisonType(logical, op.field, value);
    const expr = postgresDocumentFieldExpr(schema, logical, op.field);
    params.push(type === "date" ? encodeQueryValue(value) : value);
    const placeholder = `$${params.length}`;
    if (op.kind === "lte") {
      if (type === "date") clauses.push(`${expr} <= ${placeholder}::timestamptz`);
      else if (type === "int") clauses.push(`${expr} <= ${placeholder}::numeric`);
      else if (type === "bool") clauses.push(`${expr} <= ${placeholder}::boolean`);
      else clauses.push(`${expr} <= ${placeholder}`);
      continue;
    }
    if (type === "date") clauses.push(`${expr} = ${placeholder}::timestamptz`);
    else if (type === "int") clauses.push(`${expr} = ${placeholder}::numeric`);
    else if (type === "bool") clauses.push(`${expr} = ${placeholder}::boolean`);
    else clauses.push(`${expr} = ${placeholder}`);
  }
  return {
    sql: clauses.length === 0 ? "TRUE" : clauses.join(" AND "),
    params,
  };
}

function qualifiedCollection(schema: string, collection: string): string {
  return qualifiedTable(schema, collection);
}

function logicalName(config: PostgresDocumentDbConfig, collection: string): string {
  return logicalCollectionFromPhysical(config.namespace, collection);
}

export function compilePostgresDocumentGet(
  config: PostgresDocumentDbConfig,
  collection: string,
  id: string,
): CompiledSql {
  return {
    sql: `SELECT document FROM ${qualifiedCollection(config.schema, collection)} WHERE _id = $1`,
    params: [id],
  };
}

export function compilePostgresDocumentAdd(
  config: PostgresDocumentDbConfig,
  collection: string,
  id: string,
  document: CloudBaseDocument,
): CompiledSql {
  return {
    sql: `INSERT INTO ${qualifiedCollection(config.schema, collection)} (_id, document) VALUES ($1, $2::jsonb)`,
    params: [id, encodeDocument({ ...document, _id: id })],
  };
}

export function compilePostgresDocumentUpdate(
  config: PostgresDocumentDbConfig,
  collection: string,
  id: string,
  document: CloudBaseDocument,
): CompiledSql {
  const { _id: _ignored, ...patch } = encodeDocument({ ...document, _id: id });
  return {
    sql: `UPDATE ${qualifiedCollection(config.schema, collection)} SET document = document || $2::jsonb WHERE _id = $1 RETURNING _id`,
    params: [id, patch],
  };
}

export function compilePostgresDocumentEnsure(
  config: PostgresDocumentDbConfig,
  collection: string,
  id: string,
  document: CloudBaseDocument,
): CompiledSql {
  return {
    sql: `INSERT INTO ${qualifiedCollection(config.schema, collection)} (_id, document) VALUES ($1, $2::jsonb) ON CONFLICT (_id) DO NOTHING`,
    params: [id, encodeDocument({ ...document, _id: id })],
  };
}

export function compilePostgresReserveCounter(
  config: PostgresDocumentDbConfig,
  collection: string,
  id: string,
  field: string,
  limit: number,
): CompiledSql {
  assertField(field);
  const table = qualifiedCollection(config.schema, collection);
  return {
    sql: `UPDATE ${table} SET document = jsonb_set(document, ARRAY[$2]::text[], to_jsonb(COALESCE((document ->> $2)::numeric, 0) + 1)) WHERE _id = $1 AND COALESCE((document ->> $2)::numeric, 0) < $3::numeric RETURNING _id`,
    params: [id, field, limit],
  };
}

export function compilePostgresAdjustCounter(
  config: PostgresDocumentDbConfig,
  collection: string,
  id: string,
  field: string,
  delta: number,
): CompiledSql {
  assertField(field);
  const table = qualifiedCollection(config.schema, collection);
  return {
    sql: `UPDATE ${table} SET document = jsonb_set(document, ARRAY[$2]::text[], to_jsonb(COALESCE((document ->> $2)::numeric, 0) + $3::numeric)) WHERE _id = $1 RETURNING _id`,
    params: [id, field, delta],
  };
}

export function compilePostgresDocumentQuery(
  config: PostgresDocumentDbConfig,
  collection: string,
  filter: Record<string, unknown> = {},
  options: CloudBaseQueryOptions = {},
  mode: "query" | "count" = "query",
): CompiledSql {
  const logical = logicalName(config, collection);
  const where = compileOps(config.schema, logical, parseDocumentFilter(filter));
  const table = qualifiedCollection(config.schema, collection);
  if (mode === "count") {
    return {
      sql: `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where.sql}`,
      params: where.params,
    };
  }
  const params = [...where.params];
  let sql = `SELECT document FROM ${table} WHERE ${where.sql}`;
  if (options.order_by) {
    const direction = options.direction === "desc" ? "DESC" : "ASC";
    sql += ` ORDER BY ${postgresDocumentFieldExpr(config.schema, logical, assertField(options.order_by))} ${direction}`;
  }
  if (options.limit !== undefined) {
    params.push(Math.max(0, options.limit));
    sql += ` LIMIT $${params.length}`;
  }
  const offset = options.offset ?? 0;
  if (offset > 0) {
    params.push(offset);
    sql += ` OFFSET $${params.length}`;
  }
  return { sql, params };
}

function pgConstraint(error: unknown): string {
  if (typeof error === "object" && error !== null && "constraint" in error) {
    const value = (error as { constraint?: unknown }).constraint;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return String((error as { code?: unknown }).code ?? "") === "23505";
}

function uniqueKey(constraint: string, document: CloudBaseDocument, id: string): Record<string, unknown> {
  const index = UNIQUE_INDEXES.find((item) => item.name === constraint);
  if (index === undefined) return { _id: id };
  return Object.fromEntries(index.fields.map((field) => [field, document[field]]));
}

function mapWriteError(
  error: unknown,
  collection: string,
  id: string,
  document: CloudBaseDocument,
): never {
  if (error instanceof CloudBaseDuplicateKeyError) throw error;
  if (isUniqueViolation(error)) {
    const constraint = pgConstraint(error);
    if (constraint.endsWith("_pkey") || constraint.startsWith("pk_")) {
      throw new CloudBaseDuplicateKeyError(collection, "pk_document", { _id: id });
    }
    throw new CloudBaseDuplicateKeyError(
      collection,
      constraint.length > 0 ? constraint : "uk_unknown",
      uniqueKey(constraint, document, id),
    );
  }
  throw error;
}

function asDocument(value: unknown): CloudBaseDocument | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as CloudBaseDocument;
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as CloudBaseDocument;
  return null;
}

const SAVEPOINT_PREFIX = "vps_sp_";

function savepointName(depth: number): string {
  return `${SAVEPOINT_PREFIX}${depth}`;
}

export class PostgresDocumentDb implements CloudBaseDb {
  private readonly connect: PostgresConnectFn | undefined;
  private readonly inTransaction: boolean;
  private readonly savepointDepth: number;

  constructor(
    private readonly queryFn: PostgresQueryFn,
    private readonly config: PostgresDocumentDbConfig,
    options: PostgresDocumentDbOptions = {},
  ) {
    this.connect = options.connect;
    this.inTransaction = options.inTransaction === true;
    this.savepointDepth = options.savepointDepth ?? 0;
  }

  inFilter(field: string, values: readonly string[]): Record<string, unknown> | undefined {
    if (values.length === 0) return undefined;
    return { [field]: { [POSTGRES_IN_OP]: [...values] } };
  }

  lteFilter(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { [POSTGRES_LTE_OP]: value } };
  }

  async get(collection: string, id: string): Promise<CloudBaseDocument | null> {
    const compiled = compilePostgresDocumentGet(this.config, collection, id);
    const result = await this.queryFn(compiled.sql, compiled.params);
    const document = asDocument(result.rows[0]?.document);
    if (document === null) return null;
    return decodeDocument(collection, document._id === undefined ? { ...document, _id: id } : document);
  }

  async add(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    const compiled = compilePostgresDocumentAdd(this.config, collection, id, document);
    try {
      await this.queryFn(compiled.sql, compiled.params);
    } catch (error) {
      mapWriteError(error, collection, id, { ...document, _id: id });
    }
  }

  async update(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    const compiled = compilePostgresDocumentUpdate(this.config, collection, id, document);
    try {
      const result = await this.queryFn(compiled.sql, compiled.params);
      if (result.rows.length === 0) throw new CloudBaseDocumentNotFoundError(collection, id);
    } catch (error) {
      if (error instanceof CloudBaseDocumentNotFoundError) throw error;
      mapWriteError(error, collection, id, { ...document, _id: id });
    }
  }

  async query(
    collection: string,
    filter: Record<string, unknown> = {},
    options: CloudBaseQueryOptions = {},
  ): Promise<CloudBaseDocument[]> {
    const compiled = compilePostgresDocumentQuery(this.config, collection, filter, options, "query");
    const result = await this.queryFn(compiled.sql, compiled.params);
    return result.rows.flatMap((row) => {
      const document = asDocument(row.document);
      return document === null ? [] : [decodeDocument(collection, document)];
    });
  }

  async count(collection: string, filter: Record<string, unknown> = {}): Promise<number> {
    const compiled = compilePostgresDocumentQuery(this.config, collection, filter, {}, "count");
    const result = await this.queryFn(compiled.sql, compiled.params);
    return Number(result.rows[0]?.count ?? 0);
  }

  async reserveCounter(
    collection: string,
    id: string,
    field: string,
    limit: number,
    initial: CloudBaseDocument,
  ): Promise<boolean> {
    if (this.inTransaction) return this.runReserveCounter(collection, id, field, limit, initial);
    return this.transaction((tx) => tx.reserveCounter!(collection, id, field, limit, initial));
  }

  async adjustCounter(collection: string, id: string, field: string, delta: number): Promise<void> {
    const compiled = compilePostgresAdjustCounter(this.config, collection, id, field, delta);
    await this.queryFn(compiled.sql, compiled.params);
  }

  async getCounter(collection: string, id: string, field: string): Promise<number> {
    const document = await this.get(collection, id);
    return typeof document?.[field] === "number" ? document[field] as number : 0;
  }

  private async runReserveCounter(
    collection: string,
    id: string,
    field: string,
    limit: number,
    initial: CloudBaseDocument,
  ): Promise<boolean> {
    const ensured = compilePostgresDocumentEnsure(this.config, collection, id, initial);
    await this.queryFn(ensured.sql, ensured.params);
    const compiled = compilePostgresReserveCounter(this.config, collection, id, field, limit);
    const result = await this.queryFn(compiled.sql, compiled.params);
    return result.rows.length > 0;
  }

  async transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    if (this.inTransaction) return this.runSavepoint(work);
    return this.runOuterTransaction(work);
  }

  private scoped(queryFn: PostgresQueryFn, savepointDepth: number): PostgresDocumentDb {
    const options: PostgresDocumentDbOptions = {
      inTransaction: true,
      savepointDepth,
    };
    if (this.connect !== undefined) options.connect = this.connect;
    return new PostgresDocumentDb(queryFn, this.config, options);
  }

  private async runSavepoint<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    const name = savepointName(this.savepointDepth + 1);
    await this.queryFn(`SAVEPOINT ${quoteIdent(name)}`);
    try {
      const result = await work(this.scoped(this.queryFn, this.savepointDepth + 1));
      await this.queryFn(`RELEASE SAVEPOINT ${quoteIdent(name)}`);
      return result;
    } catch (error) {
      await this.queryFn(`ROLLBACK TO SAVEPOINT ${quoteIdent(name)}`);
      await this.queryFn(`RELEASE SAVEPOINT ${quoteIdent(name)}`);
      throw error;
    }
  }

  private async runOuterTransaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    if (this.connect === undefined) {
      throw new Error("PostgresDocumentDb.transaction requires an exclusive connection factory");
    }
    const client = await this.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await work(this.scoped(client.query, 0));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      await client.release();
    }
  }
}

export function createPostgresQueryFn(client: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): PostgresQueryFn {
  return async (sql, params) => {
    const result = await client.query(sql, params);
    return { rows: result.rows };
  };
}

export function createPostgresDocumentDb(
  queryFn: PostgresQueryFn,
  config: PostgresDocumentDbConfig,
  options: PostgresDocumentDbOptions = {},
): PostgresDocumentDb {
  return new PostgresDocumentDb(queryFn, config, options);
}
