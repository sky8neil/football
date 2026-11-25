import { AsyncLocalStorage } from "node:async_hooks";
import { MatchStatus, SettlementStatus } from "../domain/enums.js";
import { COLLECTION_DEFINITIONS, type FieldType } from "../schema/collections.js";
import { UNIQUE_INDEXES } from "../schema/indexes.js";
import {
  CloudBaseDocumentNotFoundError,
  CloudBaseDuplicateKeyError,
  logicalCollectionFromPhysical,
  type CloudBaseAnomalyPageQuery,
  type CloudBaseAuditLogPageQuery,
  type CloudBaseDb,
  type CloudBaseDocument,
  type CloudBasePredictionHistoryPage,
  type CloudBaseQueryOptions,
} from "./cloudbase-db.js";
import { decodeDocument, encodeDocument, encodeQueryValue } from "./document-codec.js";
import {
  createPostgresAuthSessionStore,
  type AuthSessionStore,
} from "./postgres-auth-sessions.js";
import {
  JSONB_UTC_TIMESTAMPTZ_FUNCTION,
  postgresDocumentFieldExpr,
  qualifiedTable,
  quoteIdent,
  type PostgresQueryFn,
  type PostgresQueryResult,
} from "./postgres-schema.js";

export const POSTGRES_IN_OP = "__in" as const;
export const POSTGRES_LT_OP = "__lt" as const;
export const POSTGRES_LTE_OP = "__lte" as const;
export const POSTGRES_GTE_OP = "__gte" as const;
export const POSTGRES_NE_OP = "__ne" as const;

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface PostgresDocumentDbConfig {
  schema: string;
  namespace: string;
}

export interface PostgresExclusiveClient {
  query: PostgresQueryFn;
  release: (err?: Error) => void | Promise<void>;
}

export type PostgresConnectFn = () => Promise<PostgresExclusiveClient>;

export interface PostgresDocumentDbOptions {
  connect?: PostgresConnectFn;
  inTransaction?: boolean;
  savepointDepth?: number;
}

interface PostgresTxState {
  originalError?: unknown;
  recoveryError?: Error;
  closed?: boolean;
  closeError?: unknown;
  inFlight: number;
  activeDbWork: number;
  idleWaiters: Array<() => void>;
  queues: Set<ScopeQueue>;
}

interface ActiveScope {
  txState: PostgresTxState;
  queue: ScopeQueue;
  parent: ActiveScope | undefined;
  active: boolean;
}

const activeScopeStorage = new AsyncLocalStorage<ActiveScope>();

function resolveWork<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error);
  }
}

class ScopeQueue {
  private busy = false;
  private closed = false;
  private closeError: unknown;
  private readonly waiters: Array<{ start: () => void; abort: (error: unknown) => void }> = [];
  private readonly children = new Set<ScopeQueue>();

  constructor(
    private readonly txState: PostgresTxState,
    private readonly parentQueue?: ScopeQueue,
  ) {
    txState.queues.add(this);
    parentQueue?.attachChild(this);
  }

  attachChild(child: ScopeQueue): void {
    this.children.add(child);
  }

  hasPending(): boolean {
    if (this.busy || this.waiters.length > 0) return true;
    for (const child of this.children) {
      if (child.hasPending()) return true;
    }
    return false;
  }

  close(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    this.abortWaiters(error);
    for (const child of this.children) child.close(error);
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.isClosed()) return Promise.reject(this.rejectReason());
    const caller = activeScopeStorage.getStore();
    if (this.wouldDeadlock(caller)) {
      return Promise.reject(new Error("nested transaction cannot wait on ancestor handle"));
    }
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        if (this.isClosed()) {
          reject(this.rejectReason());
          this.busy = false;
          this.pump();
          return;
        }
        this.busy = true;
        resolveWork(work).then(
          (value) => {
            this.busy = false;
            this.pump();
            resolve(value);
          },
          (error: unknown) => {
            this.busy = false;
            this.pump();
            reject(error);
          },
        );
      };
      if (this.isClosed()) {
        reject(this.rejectReason());
        return;
      }
      if (!this.busy && this.waiters.length === 0) {
        start();
        return;
      }
      this.waiters.push({
        start: () => {
          if (caller === undefined) activeScopeStorage.exit(start);
          else activeScopeStorage.run(caller, start);
        },
        abort: reject,
      });
    });
  }

  abortWaiters(error: unknown): void {
    const pending = this.waiters.splice(0);
    for (const waiter of pending) waiter.abort(error);
  }

  isStopped(): boolean {
    return this.closed;
  }

  private isClosed(): boolean {
    return this.closed || this.txState.closed === true;
  }

  private wouldDeadlock(scope: ActiveScope | undefined): boolean {
    if (!this.busy && this.waiters.length === 0) return false;
    let caller = scope;
    while (caller !== undefined && !caller.active) caller = caller.parent;
    for (let current = caller; current !== undefined; current = current.parent) {
      if (!current.active) continue;
      if (current !== caller && current.queue === this) return true;
      for (let queue = current.queue.parentQueue; queue !== undefined; queue = queue.parentQueue) {
        if (queue === this) return true;
      }
    }
    return false;
  }

  private rejectReason(): unknown {
    return this.closeError ?? this.txState.closeError ?? new Error("transaction closed");
  }

  private pump(): void {
    if (this.busy) return;
    const next = this.waiters.shift();
    if (next === undefined) return;
    next.start();
  }
}

type PostgresDocumentDbCtorOptions = PostgresDocumentDbOptions & {
  txState?: PostgresTxState;
  scopeQueue?: ScopeQueue;
};

export interface CompiledSql {
  sql: string;
  params: unknown[];
}

type FilterOp =
  | { kind: "eq"; field: string; value: unknown }
  | { kind: "null"; field: string }
  | { kind: "in"; field: string; values: readonly string[] }
  | { kind: "ne"; field: string; value: unknown }
  | { kind: "lt" | "lte" | "gte"; field: string; value: unknown };

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
  return Object.entries(filter).flatMap<FilterOp>(([field, value]) => {
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
      if (keys.length === 1 && keys[0] === POSTGRES_NE_OP) {
        return { kind: "ne", field, value: value[POSTGRES_NE_OP] };
      }
      if (
        keys.length > 0 &&
        keys.every((key) => key === POSTGRES_LT_OP || key === POSTGRES_LTE_OP || key === POSTGRES_GTE_OP)
      ) {
        return keys.map((key) => ({
          kind: key === POSTGRES_LT_OP ? "lt" : key === POSTGRES_LTE_OP ? "lte" : "gte",
          field,
          value: value[key],
        }));
      }
      throw new Error(`unsupported query operator on ${field}`);
    }
    if (value === null) return { kind: "null", field };
    return { kind: "eq", field, value };
  });
}

function comparisonType(logical: string, field: string, value: unknown): FieldType | "text" {
  const declared = documentFieldType(logical, field);
  if (declared !== undefined) return declared;
  if (value instanceof Date) return "date";
  if (typeof value === "number") return "int";
  if (typeof value === "boolean") return "bool";
  return "text";
}

function comparisonExpr(
  schema: string,
  logical: string,
  field: string,
  type: FieldType | "text",
): string {
  if (field === "_id") return "_id";
  const expr = postgresDocumentFieldExpr(schema, logical, field);
  if (documentFieldType(logical, field) !== undefined) return expr;
  if (type === "date") return `${qualifiedTable(schema, JSONB_UTC_TIMESTAMPTZ_FUNCTION)}(${expr})`;
  if (type === "int") return `(${expr})::numeric`;
  if (type === "bool") return `(${expr})::boolean`;
  return expr;
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
      const expr = op.field === "_id" ? "_id" : postgresDocumentFieldExpr(schema, logical, op.field);
      clauses.push(`(${expr}) IS NULL`);
      continue;
    }
    if (op.kind === "in") {
      params.push([...op.values]);
      const expr = op.field === "_id" ? "_id" : postgresDocumentFieldExpr(schema, logical, op.field);
      clauses.push(`${expr} = ANY($${params.length}::text[])`);
      continue;
    }
    const value = op.value;
    const type = comparisonType(logical, op.field, value);
    const expr = comparisonExpr(schema, logical, op.field, type);
    params.push(type === "date" ? encodeQueryValue(value) : value);
    const placeholder = `$${params.length}`;
    if (op.kind === "ne") {
      if (type === "date") clauses.push(`${expr} IS DISTINCT FROM ${placeholder}::timestamptz`);
      else if (type === "int") clauses.push(`${expr} IS DISTINCT FROM ${placeholder}::numeric`);
      else if (type === "bool") clauses.push(`${expr} IS DISTINCT FROM ${placeholder}::boolean`);
      else clauses.push(`${expr} IS DISTINCT FROM ${placeholder}`);
      continue;
    }
    if (op.kind === "lt" || op.kind === "lte" || op.kind === "gte") {
      const operator = op.kind === "lt" ? "<" : op.kind === "lte" ? "<=" : ">=";
      if (type === "date") clauses.push(`${expr} ${operator} ${placeholder}::timestamptz`);
      else if (type === "int") clauses.push(`${expr} ${operator} ${placeholder}::numeric`);
      else if (type === "bool") clauses.push(`${expr} ${operator} ${placeholder}::boolean`);
      else clauses.push(`${expr} ${operator} ${placeholder}`);
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

export function compilePostgresDocumentGetForUpdate(
  config: PostgresDocumentDbConfig,
  collection: string,
  id: string,
): CompiledSql {
  const compiled = compilePostgresDocumentGet(config, collection, id);
  return { sql: `${compiled.sql} FOR UPDATE`, params: compiled.params };
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

export function compilePostgresDocumentPatch(
  config: PostgresDocumentDbConfig,
  collection: string,
  id: string,
  fields: Record<string, unknown>,
): CompiledSql {
  const encoded = encodeDocument(fields as CloudBaseDocument);
  const entries = Object.entries(encoded);
  const params: unknown[] = [id];
  let expression = "document";
  for (const [field, value] of entries) {
    assertField(field);
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error(`invalid patch value for ${field}`);
    params.push(field, json);
    expression = `jsonb_set(${expression}, ARRAY[$${params.length - 1}]::text[], $${params.length}::jsonb, true)`;
  }
  return {
    sql: `UPDATE ${qualifiedCollection(config.schema, collection)} SET document = ${expression} WHERE _id = $1 RETURNING _id`,
    params,
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

export function compilePostgresAcquireJobLock(
  config: PostgresDocumentDbConfig,
  collection: string,
  lockKey: string,
  document: CloudBaseDocument,
  now: Date,
): CompiledSql {
  const table = qualifiedCollection(config.schema, collection);
  const leaseExpr = postgresDocumentFieldExpr(config.schema, "job_locks", "lease_until")
    .replace(/\bdocument\b/g, `${table}.document`);
  return {
    sql: `INSERT INTO ${table} (_id, document) VALUES ($1, $2::jsonb) ON CONFLICT (_id) DO UPDATE SET document = EXCLUDED.document WHERE ${leaseExpr} <= $3::timestamptz RETURNING _id`,
    params: [lockKey, encodeDocument({ ...document, _id: lockKey }), now.toISOString()],
  };
}

export function compilePostgresRenewJobLock(
  config: PostgresDocumentDbConfig,
  collection: string,
  lockKey: string,
  ownerId: string,
  leaseUntil: Date,
  now: Date,
): CompiledSql {
  const table = qualifiedCollection(config.schema, collection);
  const leaseExpr = postgresDocumentFieldExpr(config.schema, "job_locks", "lease_until")
    .replace(/\bdocument\b/g, `${table}.document`);
  const { _id: _ignored, ...patch } = encodeDocument({
    _id: lockKey,
    lease_until: leaseUntil,
    updated_at: now,
  });
  return {
    sql: `UPDATE ${table} SET document = document || $4::jsonb WHERE _id = $1 AND (document ->> 'owner_id') = $2 AND ${leaseExpr} > $3::timestamptz RETURNING _id`,
    params: [lockKey, ownerId, now.toISOString(), patch],
  };
}

export function compilePostgresReleaseJobLock(
  config: PostgresDocumentDbConfig,
  collection: string,
  lockKey: string,
  ownerId: string,
  now: Date = new Date(),
): CompiledSql {
  const table = qualifiedCollection(config.schema, collection);
  const { _id: _ignored, ...patch } = encodeDocument({
    _id: lockKey,
    lease_until: new Date(0),
    updated_at: now,
  });
  return {
    sql: `UPDATE ${table} SET document = document || $3::jsonb WHERE _id = $1 AND (document ->> 'owner_id') = $2`,
    params: [lockKey, ownerId, patch],
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

export function compilePredictionHistoryPage(
  config: PostgresDocumentDbConfig,
  params: {
    predictions_collection: string;
    matches_collection: string;
    user_id: string;
    league_id: string | null;
    season_id: string | null;
    cursor: { submitted_at: Date; prediction_id: string } | null;
    limit: number;
  },
): CompiledSql {
  const predictionsTable = qualifiedCollection(config.schema, params.predictions_collection);
  const matchesTable = qualifiedCollection(config.schema, params.matches_collection);
  const ts = postgresDocumentFieldExpr(config.schema, "predictions", "submitted_at", "p.document");
  const predCanonical = postgresDocumentFieldExpr(config.schema, "predictions", "canonical_match_id", "p.document");
  const matchCanonical = postgresDocumentFieldExpr(config.schema, "matches", "canonical_match_id", "m.document");
  const queryParams: unknown[] = [params.user_id, params.league_id, params.season_id];
  let cursorSql = "";
  if (params.cursor !== null) {
    queryParams.push(encodeQueryValue(params.cursor.submitted_at), params.cursor.prediction_id);
    const tsPlaceholder = `$${queryParams.length - 1}`;
    const idPlaceholder = `$${queryParams.length}`;
    cursorSql = ` AND (${ts}, (p.document ->> 'prediction_id')) < (${tsPlaceholder}::timestamptz, ${idPlaceholder})`;
  }
  queryParams.push(params.limit);
  return {
    sql: `SELECT p.document FROM ${predictionsTable} p WHERE (p.document ->> 'user_id') = $1 AND EXISTS (SELECT 1 FROM ${matchesTable} m WHERE (m.document ->> 'superseded_by') IS NULL AND ${matchCanonical} = ${predCanonical} AND ($2::text IS NULL OR m.document ->> 'league_id' = $2) AND ($3::text IS NULL OR m.document ->> 'season_id' = $3))${cursorSql} ORDER BY ${ts} DESC, (p.document ->> 'prediction_id') DESC LIMIT $${queryParams.length}`,
    params: queryParams,
  };
}

export function compileLatestRegularBoardSnapshot(
  config: PostgresDocumentDbConfig,
  params: {
    collection: string;
    board: string;
    level_season_id?: string | null;
  },
): CompiledSql {
  const table = qualifiedCollection(config.schema, params.collection);
  const ts = postgresDocumentFieldExpr(config.schema, "board_snapshots", "snapshot_at");
  const isFinal = postgresDocumentFieldExpr(config.schema, "board_snapshots", "is_final");
  const rank = postgresDocumentFieldExpr(config.schema, "board_snapshots", "rank");
  const queryParams: unknown[] = [params.board];
  let seasonSql = "";
  if (params.level_season_id != null) {
    queryParams.push(params.level_season_id);
    seasonSql = ` AND (document ->> 'level_season_id') = $${queryParams.length}`;
  }
  const regularWhere = `(document ->> 'board') = $1 AND ${isFinal} = false${seasonSql}`;
  return {
    sql: `SELECT document FROM ${table} WHERE ${regularWhere} AND ${ts} = (SELECT ${ts} FROM ${table} WHERE ${regularWhere} ORDER BY ${ts} DESC LIMIT 1) ORDER BY ${rank} ASC`,
    params: queryParams,
  };
}

export function compileSettlementFallbackPage(
  config: PostgresDocumentDbConfig,
  params: {
    collection: string;
    limit: number;
    after?: { kickoff_at: Date; match_id: string } | null;
  },
): CompiledSql {
  const table = qualifiedCollection(config.schema, params.collection);
  const statusExpr = postgresDocumentFieldExpr(config.schema, "matches", "match_status");
  const settlementExpr = postgresDocumentFieldExpr(config.schema, "matches", "settlement_status");
  const kickoffExpr = postgresDocumentFieldExpr(config.schema, "matches", "kickoff_at");
  const matchIdExpr = postgresDocumentFieldExpr(config.schema, "matches", "match_id");
  const queryParams: unknown[] = [MatchStatus.Finished, SettlementStatus.Voided];
  let afterSql = "";
  if (params.after != null) {
    queryParams.push(encodeQueryValue(params.after.kickoff_at), params.after.match_id);
    const tsPlaceholder = `$${queryParams.length - 1}`;
    const idPlaceholder = `$${queryParams.length}`;
    afterSql = ` AND (${kickoffExpr}, ${matchIdExpr}) > (${tsPlaceholder}::timestamptz, ${idPlaceholder})`;
  }
  queryParams.push(Math.max(0, params.limit));
  return {
    sql: `SELECT document FROM ${table} WHERE ${statusExpr} = $1 AND COALESCE(${settlementExpr}, '') <> $2${afterSql} ORDER BY ${kickoffExpr} ASC, ${matchIdExpr} ASC LIMIT $${queryParams.length}`,
    params: queryParams,
  };
}

export function compileAnomalyPage(
  config: PostgresDocumentDbConfig,
  params: CloudBaseAnomalyPageQuery,
): CompiledSql {
  const table = qualifiedCollection(config.schema, params.collection);
  const statusExpr = postgresDocumentFieldExpr(config.schema, "anomalies", "status");
  const blockingExpr = postgresDocumentFieldExpr(config.schema, "anomalies", "blocking");
  const lastSeenExpr = postgresDocumentFieldExpr(config.schema, "anomalies", "last_seen_at");
  const anomalyIdExpr = postgresDocumentFieldExpr(config.schema, "anomalies", "anomaly_id");
  const queryParams: unknown[] = [];
  const clauses: string[] = [];
  if (params.status !== null) {
    queryParams.push(params.status);
    clauses.push(`${statusExpr} = $${queryParams.length}`);
  }
  if (params.blocking !== null) {
    queryParams.push(params.blocking);
    clauses.push(`${blockingExpr} = $${queryParams.length}`);
  }
  if (params.after != null) {
    queryParams.push(encodeQueryValue(params.after.last_seen_at), params.after.anomaly_id);
    clauses.push(
      `(${lastSeenExpr}, ${anomalyIdExpr}) < ($${queryParams.length - 1}::timestamptz, $${queryParams.length})`,
    );
  }
  queryParams.push(Math.max(0, params.limit));
  const where = clauses.length === 0 ? "TRUE" : clauses.join(" AND ");
  return {
    sql: `SELECT document FROM ${table} WHERE ${where} ORDER BY ${lastSeenExpr} DESC, ${anomalyIdExpr} DESC LIMIT $${queryParams.length}`,
    params: queryParams,
  };
}

export function compileAuditLogPage(
  config: PostgresDocumentDbConfig,
  params: CloudBaseAuditLogPageQuery,
): CompiledSql {
  const table = qualifiedCollection(config.schema, params.collection);
  const actionExpr = postgresDocumentFieldExpr(config.schema, "admin_audit_logs", "action");
  const entityTypeExpr = postgresDocumentFieldExpr(config.schema, "admin_audit_logs", "entity_type");
  const entityIdExpr = postgresDocumentFieldExpr(config.schema, "admin_audit_logs", "entity_id");
  const createdAtExpr = postgresDocumentFieldExpr(config.schema, "admin_audit_logs", "created_at");
  const auditIdExpr = postgresDocumentFieldExpr(config.schema, "admin_audit_logs", "audit_id");
  const queryParams: unknown[] = [];
  const clauses: string[] = [];
  if (params.action !== null) {
    queryParams.push(params.action);
    clauses.push(`${actionExpr} = $${queryParams.length}`);
  }
  if (params.entity_type !== null) {
    queryParams.push(params.entity_type);
    clauses.push(`${entityTypeExpr} = $${queryParams.length}`);
  }
  if (params.entity_id !== null) {
    queryParams.push(params.entity_id);
    clauses.push(`${entityIdExpr} = $${queryParams.length}`);
  }
  if (params.after != null) {
    queryParams.push(encodeQueryValue(params.after.created_at), params.after.audit_id);
    clauses.push(
      `(${createdAtExpr}, ${auditIdExpr}) < ($${queryParams.length - 1}::timestamptz, $${queryParams.length})`,
    );
  }
  queryParams.push(Math.max(0, params.limit));
  const where = clauses.length === 0 ? "TRUE" : clauses.join(" AND ");
  return {
    sql: `SELECT document FROM ${table} WHERE ${where} ORDER BY ${createdAtExpr} DESC, ${auditIdExpr} DESC LIMIT $${queryParams.length}`,
    params: queryParams,
  };
}

export function compileCountPredictionsByMatchGroupedByResult(
  config: PostgresDocumentDbConfig,
  params: {
    collection: string;
    canonical_match_id: string;
  },
): CompiledSql {
  const table = qualifiedCollection(config.schema, params.collection);
  const canonicalExpr = postgresDocumentFieldExpr(config.schema, "predictions", "canonical_match_id");
  const resultExpr = postgresDocumentFieldExpr(config.schema, "predictions", "derived_result");
  return {
    sql: `SELECT ${resultExpr} AS derived_result, COUNT(*)::int AS count FROM ${table} WHERE ${canonicalExpr} = $1 GROUP BY ${resultExpr}`,
    params: [params.canonical_match_id],
  };
}

export function compilePostgresDistinctQuery(
  config: PostgresDocumentDbConfig,
  collection: string,
  fields: readonly string[],
  filter: Record<string, unknown> = {},
): CompiledSql {
  const logical = logicalName(config, collection);
  const where = compileOps(config.schema, logical, parseDocumentFilter(filter));
  const table = qualifiedCollection(config.schema, collection);
  const columns = fields.map((field) => {
    const name = assertField(field);
    return `document->>${jsonKey(name)} AS ${quoteIdent(name)}`;
  });
  return {
    sql: `SELECT DISTINCT ${columns.join(", ")} FROM ${table} WHERE ${where.sql}`,
    params: where.params,
  };
}

export function compilePostgresDocumentDelete(
  config: PostgresDocumentDbConfig,
  collection: string,
  filter: Record<string, unknown>,
  options?: { limit?: number },
): CompiledSql {
  if (Object.keys(filter).length === 0) {
    throw new Error("deleteWhere requires a non-empty filter");
  }
  const logical = logicalName(config, collection);
  const where = compileOps(config.schema, logical, parseDocumentFilter(filter));
  const table = qualifiedCollection(config.schema, collection);
  const rawLimit = options?.limit;
  if (rawLimit !== undefined) {
    if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
      throw new Error(`deleteWhere limit must be a positive integer: ${String(rawLimit)}`);
    }
    const params = [...where.params, rawLimit];
    const limitPlaceholder = `$${params.length}`;
    return {
      sql: `DELETE FROM ${table} WHERE _id IN (SELECT _id FROM ${table} WHERE ${where.sql} LIMIT ${limitPlaceholder})`,
      params,
    };
  }
  return {
    sql: `DELETE FROM ${table} WHERE ${where.sql}`,
    params: where.params,
  };
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

function queryCommand(result: { rows: Array<Record<string, unknown>>; command?: unknown }): string | undefined {
  return typeof result.command === "string" && result.command.length > 0 ? result.command : undefined;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

const SAVEPOINT_PREFIX = "vps_sp_";

function savepointName(depth: number): string {
  return `${SAVEPOINT_PREFIX}${depth}`;
}

export class PostgresDocumentDb implements CloudBaseDb {
  private readonly connect: PostgresConnectFn | undefined;
  private readonly inTransaction: boolean;
  private readonly savepointDepth: number;
  private readonly txState: PostgresTxState | undefined;
  private readonly scopeQueue: ScopeQueue | undefined;
  private readonly rawQueryFn: PostgresQueryFn;
  private readonly queryFn: PostgresQueryFn;
  readonly authSessions: AuthSessionStore;

  constructor(
    queryFn: PostgresQueryFn,
    private readonly config: PostgresDocumentDbConfig,
    options: PostgresDocumentDbCtorOptions = {},
  ) {
    this.connect = options.connect;
    this.inTransaction = options.inTransaction === true;
    this.savepointDepth = options.savepointDepth ?? 0;
    this.txState = options.txState;
    this.scopeQueue = options.scopeQueue;
    this.rawQueryFn = queryFn;
    this.queryFn = this.bindQuery(queryFn);
    this.authSessions = createPostgresAuthSessionStore(this.queryFn, config.schema);
  }

  inFilter(field: string, values: readonly string[]): Record<string, unknown> | undefined {
    if (values.length === 0) return undefined;
    return { [field]: { [POSTGRES_IN_OP]: [...values] } };
  }

  ltFilter(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { [POSTGRES_LT_OP]: value } };
  }

  lteFilter(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { [POSTGRES_LTE_OP]: value } };
  }

  gteFilter(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { [POSTGRES_GTE_OP]: value } };
  }

  neFilter(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { [POSTGRES_NE_OP]: value } };
  }

  async get(collection: string, id: string): Promise<CloudBaseDocument | null> {
    const compiled = compilePostgresDocumentGet(this.config, collection, id);
    const result = await this.queryFn(compiled.sql, compiled.params);
    return this.decodeRow(collection, id, result.rows[0]?.document);
  }

  async getForUpdate(collection: string, id: string): Promise<CloudBaseDocument | null> {
    if (!this.inTransaction) {
      throw new Error("getForUpdate requires an active transaction");
    }
    const compiled = compilePostgresDocumentGetForUpdate(this.config, collection, id);
    const work = async (): Promise<CloudBaseDocument | null> => {
      const result = await this.execTracked(this.rawQueryFn, compiled.sql, compiled.params);
      return this.decodeRow(collection, id, result.rows[0]?.document);
    };
    const queue = this.scopeQueue;
    if (queue === undefined) return work();
    return queue.run(work);
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

  async patch(
    collection: string,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const compiled = compilePostgresDocumentPatch(this.config, collection, id, fields);
    try {
      const result = await this.queryFn(compiled.sql, compiled.params);
      if (result.rows.length === 0) throw new CloudBaseDocumentNotFoundError(collection, id);
    } catch (error) {
      if (error instanceof CloudBaseDocumentNotFoundError) throw error;
      mapWriteError(error, collection, id, { ...fields, _id: id });
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

  async findPredictionHistoryPage(params: {
    predictions_collection: string;
    matches_collection: string;
    user_id: string;
    league_id: string | null;
    season_id: string | null;
    cursor: { submitted_at: Date; prediction_id: string } | null;
    limit: number;
  }): Promise<CloudBasePredictionHistoryPage> {
    const compiled = compilePredictionHistoryPage(this.config, params);
    const result = await this.queryFn(compiled.sql, compiled.params);
    const documents = result.rows.flatMap((row) => {
      const document = asDocument(row.document);
      return document === null ? [] : [decodeDocument(params.predictions_collection, document)];
    });
    return {
      documents,
      exhausted: documents.length < Math.max(0, params.limit),
      resumeCursor: null,
    };
  }

  async findLatestRegularBoardSnapshot(params: {
    collection: string;
    board: string;
    level_season_id?: string | null;
  }): Promise<CloudBaseDocument[]> {
    const compiled = compileLatestRegularBoardSnapshot(this.config, params);
    const result = await this.queryFn(compiled.sql, compiled.params);
    return result.rows.flatMap((row) => {
      const document = asDocument(row.document);
      return document === null ? [] : [decodeDocument(params.collection, document)];
    });
  }

  async findSettlementFallbackPage(params: {
    collection: string;
    limit: number;
    after?: { kickoff_at: Date; match_id: string } | null;
  }): Promise<CloudBaseDocument[]> {
    const compiled = compileSettlementFallbackPage(this.config, params);
    const result = await this.queryFn(compiled.sql, compiled.params);
    return result.rows.flatMap((row) => {
      const document = asDocument(row.document);
      return document === null ? [] : [decodeDocument(params.collection, document)];
    });
  }

  async findAnomalyPage(params: CloudBaseAnomalyPageQuery): Promise<CloudBaseDocument[]> {
    const compiled = compileAnomalyPage(this.config, params);
    const result = await this.queryFn(compiled.sql, compiled.params);
    return result.rows.flatMap((row) => {
      const document = asDocument(row.document);
      return document === null ? [] : [decodeDocument(params.collection, document)];
    });
  }

  async findAuditLogPage(params: CloudBaseAuditLogPageQuery): Promise<CloudBaseDocument[]> {
    const compiled = compileAuditLogPage(this.config, params);
    const result = await this.queryFn(compiled.sql, compiled.params);
    return result.rows.flatMap((row) => {
      const document = asDocument(row.document);
      return document === null ? [] : [decodeDocument(params.collection, document)];
    });
  }

  async countPredictionsByMatchGroupedByResult(params: {
    collection: string;
    canonical_match_id: string;
  }): Promise<{ HOME: number; DRAW: number; AWAY: number }> {
    const compiled = compileCountPredictionsByMatchGroupedByResult(this.config, params);
    const result = await this.queryFn(compiled.sql, compiled.params);
    const counts = { HOME: 0, DRAW: 0, AWAY: 0 };
    for (const row of result.rows) {
      const derived = row.derived_result;
      if (derived === "HOME" || derived === "DRAW" || derived === "AWAY") {
        counts[derived] = Number(row.count ?? 0);
      }
    }
    return counts;
  }

  async count(collection: string, filter: Record<string, unknown> = {}): Promise<number> {
    const compiled = compilePostgresDocumentQuery(this.config, collection, filter, {}, "count");
    const result = await this.queryFn(compiled.sql, compiled.params);
    return Number(result.rows[0]?.count ?? 0);
  }

  async deleteWhere(
    collection: string,
    filter: Record<string, unknown>,
    options?: { limit?: number },
  ): Promise<number> {
    const compiled = compilePostgresDocumentDelete(this.config, collection, filter, options);
    const result = await this.queryFn(compiled.sql, compiled.params);
    return typeof result.rowCount === "number" ? result.rowCount : result.rows.length;
  }

  async distinctQuery(
    collection: string,
    fields: readonly string[],
    filter: Record<string, unknown> = {},
  ): Promise<Record<string, string>[]> {
    const compiled = compilePostgresDistinctQuery(this.config, collection, fields, filter);
    const result = await this.queryFn(compiled.sql, compiled.params);
    return result.rows.map((row) => {
      const document: Record<string, string> = {};
      for (const field of fields) {
        const value = row[field];
        document[field] = value == null ? "" : String(value);
      }
      return document;
    });
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

  async acquireJobLock(
    collection: string,
    lockKey: string,
    document: CloudBaseDocument,
    now: Date,
  ): Promise<boolean> {
    const compiled = compilePostgresAcquireJobLock(this.config, collection, lockKey, document, now);
    const result = await this.queryFn(compiled.sql, compiled.params);
    return result.rows.length > 0;
  }

  async renewJobLock(
    collection: string,
    lockKey: string,
    ownerId: string,
    leaseUntil: Date,
    now: Date,
  ): Promise<boolean> {
    const compiled = compilePostgresRenewJobLock(
      this.config,
      collection,
      lockKey,
      ownerId,
      leaseUntil,
      now,
    );
    const result = await this.queryFn(compiled.sql, compiled.params);
    return result.rows.length > 0;
  }

  async releaseJobLock(
    collection: string,
    lockKey: string,
    ownerId: string,
  ): Promise<void> {
    const compiled = compilePostgresReleaseJobLock(
      this.config,
      collection,
      lockKey,
      ownerId,
      new Date(),
    );
    await this.queryFn(compiled.sql, compiled.params);
  }

  private runReserveCounter(
    collection: string,
    id: string,
    field: string,
    limit: number,
    initial: CloudBaseDocument,
  ): Promise<boolean> {
    const work = (): Promise<boolean> => this.trackDbWork(async () => {
      const ensured = compilePostgresDocumentEnsure(this.config, collection, id, initial);
      await this.execTracked(this.rawQueryFn, ensured.sql, ensured.params);
      const compiled = compilePostgresReserveCounter(this.config, collection, id, field, limit);
      const result = await this.execTracked(this.rawQueryFn, compiled.sql, compiled.params);
      return result.rows.length > 0;
    });
    const queue = this.scopeQueue;
    if (queue === undefined) return work();
    return queue.run(work);
  }

  async transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      const queue = this.scopeQueue;
      if (queue === undefined) return this.runSavepoint(work);
      return queue.run(() => this.runSavepoint(work));
    }
    return this.runOuterTransaction(work);
  }

  private decodeRow(collection: string, id: string, value: unknown): CloudBaseDocument | null {
    const document = asDocument(value);
    if (document === null) return null;
    return decodeDocument(collection, document._id === undefined ? { ...document, _id: id } : document);
  }

  private bindQuery(queryFn: PostgresQueryFn): PostgresQueryFn {
    const queue = this.scopeQueue;
    if (queue === undefined) return queryFn;
    return (sql, params) => queue.run(() => this.execTracked(queryFn, sql, params));
  }

  private execTracked(
    queryFn: PostgresQueryFn,
    sql: string,
    params?: unknown[],
  ): Promise<PostgresQueryResult> {
    const txState = this.txState;
    if (txState !== undefined) {
      if (txState.closed) {
        return Promise.reject(txState.closeError ?? new Error("transaction closed"));
      }
      txState.inFlight += 1;
    }
    const done = (): void => {
      if (txState === undefined) return;
      txState.inFlight -= 1;
      this.notifyIdle(txState);
    };
    return resolveWork(() => queryFn(sql, params)).then(
      (result) => {
        done();
        return result;
      },
      (error: unknown) => {
        done();
        throw error;
      },
    );
  }

  private trackDbWork<T>(work: () => Promise<T>): Promise<T> {
    const txState = this.txState;
    if (txState === undefined) return work();
    txState.activeDbWork += 1;
    return resolveWork(work).finally(() => {
      txState.activeDbWork -= 1;
      this.notifyIdle(txState);
    });
  }

  private notifyIdle(txState: PostgresTxState): void {
    if (txState.inFlight !== 0 || txState.activeDbWork !== 0) return;
    const waiters = txState.idleWaiters.splice(0);
    for (const wake of waiters) wake();
  }

  private waitUntilIdle(txState: PostgresTxState): Promise<void> {
    if (txState.inFlight === 0 && txState.activeDbWork === 0) return Promise.resolve();
    return new Promise((resolve) => {
      txState.idleWaiters.push(resolve);
    });
  }

  private closeScope(txState: PostgresTxState, error: unknown): void {
    if (txState.closed) return;
    txState.closed = true;
    txState.closeError = error;
    for (const queue of txState.queues) queue.close(error);
  }

  private scoped(
    queryFn: PostgresQueryFn,
    savepointDepth: number,
    txState = this.txState,
  ): PostgresDocumentDb {
    const options: PostgresDocumentDbCtorOptions = {
      inTransaction: true,
      savepointDepth,
    };
    if (this.connect !== undefined) options.connect = this.connect;
    if (txState !== undefined) {
      options.txState = txState;
      options.scopeQueue = new ScopeQueue(txState, this.scopeQueue);
    }
    return new PostgresDocumentDb(queryFn, this.config, options);
  }

  private markUncommittable(recoveryError: Error, originalError?: unknown): void {
    const state = this.txState;
    if (state !== undefined) {
      if (state.originalError === undefined && originalError !== undefined) {
        state.originalError = originalError;
      }
      if (state.recoveryError !== undefined) return;
      state.recoveryError = recoveryError;
    }
    console.error(JSON.stringify({
      event: "pg_savepoint_recovery_failed",
      message: recoveryError.message,
    }));
  }

  private closeHandle(db: PostgresDocumentDb, error?: unknown): void {
    db.scopeQueue?.close(error ?? new Error("transaction closed"));
  }

  private isAborting(): boolean {
    return this.txState?.closed === true
      || this.txState?.recoveryError !== undefined
      || this.scopeQueue?.isStopped() === true;
  }

  private async afterUserCallback(): Promise<void> {
    await Promise.resolve();
  }

  private invokeCallback<T>(
    db: PostgresDocumentDb,
    txState: PostgresTxState | undefined,
    work: (transactionDb: CloudBaseDb) => Promise<T>,
  ): Promise<T> {
    const queue = db.scopeQueue;
    if (queue === undefined || txState === undefined) return work(db);
    const parent = activeScopeStorage.getStore();
    const scope: ActiveScope = { txState, queue, parent, active: true };
    return activeScopeStorage.run(scope, () =>
      resolveWork(() => work(db)).finally(() => {
        scope.active = false;
      }),
    );
  }

  private async runSavepoint<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    const name = savepointName(this.savepointDepth + 1);
    await this.execTracked(this.rawQueryFn, `SAVEPOINT ${quoteIdent(name)}`);
    const child = this.scoped(this.rawQueryFn, this.savepointDepth + 1);
    try {
      const result = await this.invokeCallback(child, this.txState, work);
      await this.afterUserCallback();
      if (this.isAborting()) {
        throw this.txState?.closeError ?? new Error("transaction closed");
      }
      if (child.scopeQueue?.hasPending()) {
        throw new Error("unawaited nested transaction");
      }
      this.closeHandle(child);
      try {
        await this.execTracked(this.rawQueryFn, `RELEASE SAVEPOINT ${quoteIdent(name)}`);
      } catch (caught) {
        this.markUncommittable(asError(caught));
        throw caught;
      }
      return result;
    } catch (error) {
      this.closeHandle(child);
      if (this.isAborting()) throw error;
      if (this.txState !== undefined) await this.waitUntilIdle(this.txState);
      if (this.isAborting()) throw error;
      try {
        await this.execTracked(this.rawQueryFn, `ROLLBACK TO SAVEPOINT ${quoteIdent(name)}`);
        await this.execTracked(this.rawQueryFn, `RELEASE SAVEPOINT ${quoteIdent(name)}`);
      } catch (caught) {
        if (this.isAborting()) throw error;
        this.markUncommittable(asError(caught), error);
        throw error;
      }
      throw error;
    }
  }

  private async runOuterTransaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    if (this.connect === undefined) {
      throw new Error("PostgresDocumentDb.transaction requires an exclusive connection factory");
    }
    const client = await this.connect();
    const txState: PostgresTxState = { inFlight: 0, activeDbWork: 0, idleWaiters: [], queues: new Set() };
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
    let rollbackError: Error | undefined;
    try {
      await client.query("BEGIN");
      try {
        const txDb = this.scoped(client.query, 0, txState);
        const value = await this.invokeCallback(txDb, txState, work);
        await this.afterUserCallback();
        if (txDb.scopeQueue?.hasPending()) {
          throw new Error("unawaited nested transaction");
        }
        this.closeScope(txState, new Error("transaction closed"));
        await this.waitUntilIdle(txState);
        if (txState.recoveryError !== undefined) {
          throw txState.originalError ?? txState.recoveryError;
        }
        const committed = await client.query("COMMIT");
        const command = queryCommand(committed);
        if (command !== undefined && command !== "COMMIT") {
          throw new Error(`COMMIT returned ${command}`);
        }
        outcome = { ok: true, value };
      } catch (error) {
        this.closeScope(txState, error);
        await this.waitUntilIdle(txState);
        try {
          await client.query("ROLLBACK");
        } catch (caught) {
          rollbackError = asError(caught);
          console.error(JSON.stringify({
            event: "pg_rollback_failed",
            message: rollbackError.message,
          }));
        }
        outcome = { ok: false, error };
      }
    } catch (error) {
      this.closeScope(txState, error);
      await this.waitUntilIdle(txState);
      outcome = { ok: false, error };
      rollbackError = asError(error);
    } finally {
      this.closeScope(txState, rollbackError ?? new Error("transaction closed"));
      try {
        await client.release(rollbackError);
      } catch (releaseError) {
        if (outcome === undefined || outcome.ok) {
          outcome = { ok: false, error: releaseError };
        }
      }
    }
    if (outcome === undefined) {
      throw new Error("PostgresDocumentDb.transaction ended without a result");
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}

type PostgresClientQuery = {
  query: (sql: string, params?: unknown[]) => Promise<{
    rows: Array<Record<string, unknown>>;
    command?: string;
    rowCount?: number | null;
  }>;
  release?: () => unknown;
  connect?: (() => Promise<unknown>) | ((callback: (err: Error) => void) => void);
};

export function createPostgresQueryFn(client: PostgresClientQuery): PostgresQueryFn {
  const queryFn: PostgresQueryFn = async (sql, params) => {
    const result = await client.query(sql, params);
    const mapped: PostgresQueryResult = { rows: result.rows };
    const command = queryCommand(result);
    if (command !== undefined) Object.assign(mapped, { command });
    if (typeof result.rowCount === "number") Object.assign(mapped, { rowCount: result.rowCount });
    return mapped;
  };
  if (typeof client.connect === "function" && typeof client.release !== "function") {
    const poolConnect = (client as { connect: () => Promise<PostgresClientQuery> }).connect.bind(client);
    queryFn.withSession = async <T>(fn: (query: PostgresQueryFn) => Promise<T>): Promise<T> => {
      const sessionClient = await poolConnect();
      try {
        return await fn(createPostgresQueryFn(sessionClient));
      } finally {
        await sessionClient.release?.();
      }
    };
  }
  return queryFn;
}

export function createPostgresDocumentDb(
  queryFn: PostgresQueryFn,
  config: PostgresDocumentDbConfig,
  options: PostgresDocumentDbOptions = {},
): PostgresDocumentDb {
  return new PostgresDocumentDb(queryFn, config, options);
}
