import { describe, expect, it } from "vitest";
import { COLLECTION_DEFINITIONS } from "../schema/collections.js";
import { QUERY_INDEXES, UNIQUE_INDEXES } from "../schema/indexes.js";
import { cloudBaseCollectionName, COLLECTION_ALIASES } from "./cloudbase-db.js";
import {
  ADMIN_LOGIN_CONSUMED_JTIS_TABLE,
  AUTH_SESSIONS_TABLE,
  JSONB_UTC_TIMESTAMPTZ_FUNCTION,
  applyPostgresSchema,
  buildPostgresSchemaPlan,
  diffPostgresSchema,
  normalizePostgresIndexDef,
  inspectPostgresSchema,
  pendingPostgresSchemaStatements,
  postgresDocumentFieldExpr,
  postgresSchemaStatements,
  quoteIdent,
  type PostgresQueryFn,
  type PostgresQueryResult,
} from "./postgres-schema.js";

const NAMESPACE = "football_test";
const SCHEMA = "football_test";

function dateIndexFields(): Array<{ collection: string; name: string; field: string }> {
  const items: Array<{ collection: string; name: string; field: string }> = [];
  for (const index of [...UNIQUE_INDEXES, ...QUERY_INDEXES]) {
    const definition = COLLECTION_DEFINITIONS.find((item) => item.collection === index.collection);
    for (const raw of index.fields) {
      const field = raw.endsWith(":desc") ? raw.slice(0, -":desc".length) : raw;
      if (definition?.fields[field]?.type === "date") {
        items.push({ collection: index.collection, name: index.name, field });
      }
    }
  }
  return items;
}

function fakeCatalog() {
  const schemas = new Set<string>();
  const tables = new Map<string, Set<string>>();
  const indexes = new Map<string, Set<string>>();
  const indexDefs = new Map<string, Map<string, string>>();
  const functions = new Map<string, Set<string>>();
  const sqlLog: string[] = [];

  const applyStatement = (statement: string): void => {
    const schemaMatch = statement.match(/^CREATE SCHEMA IF NOT EXISTS "([^"]+)"$/);
    if (schemaMatch) {
      schemas.add(schemaMatch[1]!);
      tables.set(schemaMatch[1]!, tables.get(schemaMatch[1]!) ?? new Set());
      indexes.set(schemaMatch[1]!, indexes.get(schemaMatch[1]!) ?? new Set());
      indexDefs.set(schemaMatch[1]!, indexDefs.get(schemaMatch[1]!) ?? new Map());
      functions.set(schemaMatch[1]!, functions.get(schemaMatch[1]!) ?? new Set());
      return;
    }
    const tableMatch = statement.match(/^CREATE TABLE IF NOT EXISTS "([^"]+)"\."([^"]+)"/);
    if (tableMatch) {
      const schema = tableMatch[1]!;
      schemas.add(schema);
      const set = tables.get(schema) ?? new Set();
      set.add(tableMatch[2]!);
      tables.set(schema, set);
      return;
    }
    const dropIndexMatch = statement.match(/^DROP INDEX IF EXISTS "([^"]+)"\."([^"]+)"$/);
    if (dropIndexMatch) {
      indexes.get(dropIndexMatch[1]!)?.delete(dropIndexMatch[2]!);
      indexDefs.get(dropIndexMatch[1]!)?.delete(dropIndexMatch[2]!);
      return;
    }
    const indexMatch = statement.match(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "([^"]+)" ON "([^"]+)"/);
    if (indexMatch) {
      const schema = indexMatch[2]!;
      const set = indexes.get(schema) ?? new Set();
      set.add(indexMatch[1]!);
      indexes.set(schema, set);
      const defs = indexDefs.get(schema) ?? new Map();
      defs.set(indexMatch[1]!, statement);
      indexDefs.set(schema, defs);
      return;
    }
    const functionMatch = statement.match(/^CREATE OR REPLACE FUNCTION "([^"]+)"\."([^"]+)"/);
    if (functionMatch) {
      const schema = functionMatch[1]!;
      const set = functions.get(schema) ?? new Set();
      set.add(functionMatch[2]!);
      functions.set(schema, set);
      return;
    }
    throw new Error(`unexpected SQL: ${statement}`);
  };

  const unescapeSql = (value: string): string => value.replaceAll("''", "'");

  const applyLockedScript = (sql: string): void => {
    for (const match of sql.matchAll(/EXECUTE '((?:[^']|'')*)';/g)) {
      const statement = unescapeSql(match[1]!);
      if (statement.startsWith("CREATE SCHEMA IF NOT EXISTS")) {
        const schema = statement.match(/^CREATE SCHEMA IF NOT EXISTS "([^"]+)"$/)?.[1];
        if (schema !== undefined && !schemas.has(schema)) applyStatement(statement);
        continue;
      }
      if (statement.startsWith("CREATE TABLE IF NOT EXISTS")) {
        const tableMatch = statement.match(/^CREATE TABLE IF NOT EXISTS "([^"]+)"\."([^"]+)"/);
        if (tableMatch !== null && !tables.get(tableMatch[1]!)?.has(tableMatch[2]!)) applyStatement(statement);
        continue;
      }
      if (/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS /.test(statement)) {
        const indexMatch = statement.match(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "([^"]+)" ON "([^"]+)"/);
        if (indexMatch !== null && !indexes.get(indexMatch[2]!)?.has(indexMatch[1]!)) applyStatement(statement);
        continue;
      }
      if (statement.startsWith("CREATE OR REPLACE FUNCTION")) {
        applyStatement(statement);
        continue;
      }
      throw new Error(`unexpected locked SQL: ${statement}`);
    }
  };

  const query: PostgresQueryFn = async (sql: string, params?: unknown[]): Promise<PostgresQueryResult> => {
    sqlLog.push(sql);
    if (sql.includes("pg_advisory_xact_lock")) {
      applyLockedScript(sql);
      return { rows: [] };
    }
    if (sql.includes("pg_proc")) {
      const schema = String(params?.[0]);
      return { rows: [...(functions.get(schema) ?? [])].map((proname) => ({ proname })) };
    }
    if (sql.includes("FROM pg_catalog.pg_namespace")) {
      return { rows: schemas.has(String(params?.[0])) ? [{ ok: 1 }] : [] };
    }
    if (sql.includes("pg_tables")) {
      const schema = String(params?.[0]);
      return { rows: [...(tables.get(schema) ?? [])].map((tablename) => ({ tablename })) };
    }
    if (sql.includes("pg_indexes")) {
      const schema = String(params?.[0]);
      const defs = indexDefs.get(schema) ?? new Map();
      return {
        rows: [...(indexes.get(schema) ?? [])].map((indexname) => {
          const indexdef = defs.get(indexname);
          return indexdef === undefined ? { indexname } : { indexname, indexdef };
        }),
      };
    }
    try {
      applyStatement(sql.trim());
    } catch (error) {
      throw new Error(`unexpected SQL: ${sql}`, { cause: error });
    }
    return { rows: [] };
  };

  return { query, sqlLog, schemas, tables, indexes, indexDefs, functions };
}

describe("postgres schema plan §6.1", () => {
  const plan = buildPostgresSchemaPlan(NAMESPACE, SCHEMA);

  it("uses the match id fallback for the canonical prediction unique index", () => {
    const index = plan.indexes.find((item) => item.name === "uk_user_canonical_match");
    expect(index?.sql).toContain("COALESCE((document ->> 'canonical_match_id'), (document ->> 'match_id'))");
  });

  it("uses the match id fallback for canonical match queries and index", () => {
    expect(postgresDocumentFieldExpr(SCHEMA, "matches", "canonical_match_id"))
      .toBe("COALESCE((document ->> 'canonical_match_id'), (document ->> 'match_id'))");
    const index = plan.indexes.find((item) => item.name === "ix_matches_canonical_match");
    expect(index?.sql).toContain("COALESCE((document ->> 'canonical_match_id'), (document ->> 'match_id'))");
  });

  it("covers every COLLECTION_DEFINITIONS table as _id + jsonb, using physical aliases", () => {
    expect(plan.tables.map((item) => item.logical)).toEqual(
      COLLECTION_DEFINITIONS.map((item) => item.collection),
    );
    for (const table of plan.tables) {
      expect(table.table).toBe(cloudBaseCollectionName(NAMESPACE, table.logical));
      expect(table.sql).toBe(
        `CREATE TABLE IF NOT EXISTS "${SCHEMA}"."${table.table}" (_id text PRIMARY KEY, document jsonb NOT NULL)`,
      );
    }
    expect(plan.tables.some((item) => item.logical === "user_season_stats")).toBe(true);
    expect(plan.tables.find((item) => item.logical === "user_season_stats")?.table).toBe(
      `${NAMESPACE}_${COLLECTION_ALIASES.user_season_stats}`,
    );
    expect(plan.tables.map((item) => item.logical)).toEqual(
      expect.arrayContaining([
        "users",
        "deleted_openid_mappings",
        "teams",
        "league_seasons",
        "season_teams",
        "team_provider_mappings",
        "match_provider_mappings",
        "matches",
        "match_results",
        "predictions",
        "settlements",
        "settlement_items",
        "user_season_stats",
        "rankings",
        "board_snapshots",
        "groups",
        "group_members",
        "unlocks",
        "level_history",
        "admins",
        "admin_audit_logs",
        "anomalies",
        "sync_logs",
        "provider_usage",
        "provider_key_state",
        "provider_league_state",
        "scheduler_state",
        "provider_snapshots",
        "job_locks",
      ]),
    );
    expect(plan.tables.some((item) => item.logical === "rate_limits")).toBe(false);
  });

  it("translates UNIQUE_INDEXES and QUERY_INDEXES with field order, unique, and desc", () => {
    expect(plan.indexes).toHaveLength(UNIQUE_INDEXES.length + QUERY_INDEXES.length);
    for (const index of [...UNIQUE_INDEXES, ...QUERY_INDEXES]) {
      const item = plan.indexes.find((entry) => entry.name === index.name);
      expect(item, index.name).toBeDefined();
      expect(item?.logical).toBe(index.collection);
      expect(item?.table).toBe(cloudBaseCollectionName(NAMESPACE, index.collection));
      expect(item?.unique).toBe(index.unique);
      expect(item?.sql.startsWith(index.unique ? "CREATE UNIQUE INDEX IF NOT EXISTS" : "CREATE INDEX IF NOT EXISTS")).toBe(
        true,
      );
      const expressions = index.fields.map((raw) => {
        const field = raw.endsWith(":desc") ? raw.slice(0, -":desc".length) : raw;
        const expr = `(${postgresDocumentFieldExpr(SCHEMA, index.collection, field)})`;
        return raw.endsWith(":desc") ? `${expr} DESC` : expr;
      });
      expect(item?.sql).toContain(`(${expressions.join(", ")})`);
    }
    const submitted = plan.indexes.find((item) => item.name === "ix_predictions_user_submitted");
    expect(submitted?.sql).toContain(" DESC");
    expect(submitted?.sql).toContain(postgresDocumentFieldExpr(SCHEMA, "predictions", "submitted_at"));
  });

  it("does not use STABLE ::timestamptz casts in date expression indexes", () => {
    const dateFields = dateIndexFields();
    expect(dateFields.length).toBeGreaterThan(0);
    expect(dateFields.map((item) => `${item.name}:${item.field}`).sort()).toEqual([
      "ix_anomalies_status_blocking:last_seen_at",
      "ix_audit_action_created:created_at",
      "ix_audit_created:created_at",
      "ix_audit_entity:created_at",
      "ix_board_snapshots_rank:snapshot_at",
      "ix_board_snapshots_season_final:snapshot_at",
      "ix_board_snapshots_user:snapshot_at",
      "ix_items_user_created:created_at",
      "ix_level_history_user_changed:changed_at",
      "ix_level_history_user_scope_season:changed_at",
      "ix_matches_league_season_kickoff:kickoff_at",
      "ix_matches_period_anchor:period_anchor_at",
      "ix_matches_season_kickoff:kickoff_at",
      "ix_matches_settlement_kickoff:kickoff_at",
      "ix_matches_settlement_status_finish:finish_detected_at",
      "ix_matches_status_kickoff:kickoff_at",
      "ix_matches_status_settlement_kickoff:kickoff_at",
      "ix_predictions_user_submitted:submitted_at",
      "ix_predictions_user_submitted_id:submitted_at",
      "ix_provider_league_state_success:last_success_at",
      "ix_provider_usage_bucket_start:bucket_start",
      "ix_provider_usage_source_bucket:bucket_start",
      "ix_reconcile_status_kickoff:kickoff_at",
      "ix_scheduler_state_updated:updated_at",
      "ix_settlements_status_updated:updated_at",
      "ix_snapshots_created_at:created_at",
      "ix_snapshots_entity:created_at",
      "ix_sync_logs_started_at:started_at",
      "ix_sync_logs_type_started:started_at",
      "uk_board_snapshot_user:snapshot_at",
    ]);
    const fn = `"${SCHEMA}"."${JSONB_UTC_TIMESTAMPTZ_FUNCTION}"`;
    for (const item of dateFields) {
      const index = plan.indexes.find((entry) => entry.name === item.name)!;
      expect(index.sql).toContain(`${fn}((document ->> '${item.field}'))`);
      expect(index.sql).not.toContain(`(document ->> '${item.field}')::timestamptz`);
    }
    const fnSql = plan.functions[0]!.sql;
    expect(fnSql).toContain("IMMUTABLE");
    expect(fnSql).toContain("SET timezone TO 'UTC'");
    expect(fnSql).toContain("$1::timestamptz");
  });

  it("types int/bool index expressions and leaves strings as jsonb text", () => {
    expect(postgresDocumentFieldExpr(SCHEMA, "match_results", "result_version")).toBe(
      "((document ->> 'result_version'))::numeric",
    );
    expect(postgresDocumentFieldExpr(SCHEMA, "anomalies", "blocking")).toBe(
      "((document ->> 'blocking'))::boolean",
    );
    expect(postgresDocumentFieldExpr(SCHEMA, "users", "openid")).toBe("(document ->> 'openid')");
    expect(plan.indexes.find((item) => item.name === "uk_match_result_version")?.sql).toContain(
      "(((document ->> 'result_version'))::numeric)",
    );
    expect(plan.indexes.find((item) => item.name === "ix_anomalies_status_blocking")?.sql).toContain(
      "(((document ->> 'blocking'))::boolean)",
    );
  });

  it("adds auth_sessions and admin_login_consumed_jtis with lookup indexes", () => {
    expect(plan.authSessions.table).toBe(AUTH_SESSIONS_TABLE);
    expect(plan.authSessions.sql).toBe(
      `CREATE TABLE IF NOT EXISTS "${SCHEMA}"."${AUTH_SESSIONS_TABLE}" (token text PRIMARY KEY, openid text NOT NULL, expires_at timestamptz NOT NULL)`,
    );
    expect(plan.authSessions.indexes.map((item) => item.name)).toEqual([
      "ix_auth_sessions_expires_at",
      "ix_auth_sessions_openid",
    ]);
    expect(plan.adminLoginConsumedJtis.table).toBe(ADMIN_LOGIN_CONSUMED_JTIS_TABLE);
    expect(plan.adminLoginConsumedJtis.sql).toBe(
      `CREATE TABLE IF NOT EXISTS "${SCHEMA}"."${ADMIN_LOGIN_CONSUMED_JTIS_TABLE}" (jti text PRIMARY KEY, expires_at timestamptz NOT NULL)`,
    );
    expect(plan.adminLoginConsumedJtis.indexes.map((item) => item.name)).toEqual([
      "ix_admin_login_consumed_jtis_expires_at",
    ]);
  });

  it("emits ordered idempotent SQL and rejects invalid identifiers", () => {
    const statements = postgresSchemaStatements(plan);
    expect(statements[0]).toBe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    expect(statements[1]).toBe(plan.functions[0]?.sql);
    expect(statements).toContain(plan.tables[0]?.sql);
    expect(statements).toContain(plan.authSessions.sql);
    expect(statements).toContain(plan.adminLoginConsumedJtis.sql);
    expect(statements.at(-3)).toBe(plan.authSessions.indexes[0]?.sql);
    expect(statements.at(-2)).toBe(plan.authSessions.indexes[1]?.sql);
    expect(statements.at(-1)).toBe(plan.adminLoginConsumedJtis.indexes[0]?.sql);
    expect(quoteIdent("football_prod")).toBe('"football_prod"');
    expect(() => quoteIdent("football prod")).toThrow("invalid SQL identifier");
  });

  it("does not erase parentheses that distinguish index expressions", () => {
    const summed = normalizePostgresIndexDef(
      `CREATE INDEX ix_expr ON ${SCHEMA}.docs ((((document ->> 'a')::numeric + (document ->> 'b')::numeric) * (document ->> 'c')::numeric))`,
      SCHEMA,
    );
    const multiplied = normalizePostgresIndexDef(
      `CREATE INDEX ix_expr ON ${SCHEMA}.docs (((document ->> 'a')::numeric + ((document ->> 'b')::numeric * (document ->> 'c')::numeric)))`,
      SCHEMA,
    );
    expect(summed).not.toBe(multiplied);
    expect(
      normalizePostgresIndexDef(
        `CREATE INDEX ix_expr ON ${SCHEMA}.docs ((COALESCE((document ->> 'a'), (document ->> 'b'))))`,
        SCHEMA,
      ),
    ).toBe(
      normalizePostgresIndexDef(
        `CREATE INDEX ix_expr ON ${SCHEMA}.docs (COALESCE((document ->> 'a'), (document ->> 'b')))`,
        SCHEMA,
      ),
    );
  });

  it("inspect/apply report expected vs existing vs created without destroying extras", async () => {
    const fake = fakeCatalog();
    const missing = await inspectPostgresSchema(fake.query, plan);
    expect(missing).toEqual({ schemaExists: false, tables: [], indexes: [], functions: [] });

    const first = await applyPostgresSchema(fake.query, plan);
    expect(first.created.schema).toBe(true);
    expect(first.created.tables).toEqual([
      ...plan.tables.map((item) => item.table),
      AUTH_SESSIONS_TABLE,
      ADMIN_LOGIN_CONSUMED_JTIS_TABLE,
    ]);
    expect(first.created.indexes).toEqual([
      ...plan.indexes.map((item) => item.name),
      ...plan.authSessions.indexes.map((item) => item.name),
      ...plan.adminLoginConsumedJtis.indexes.map((item) => item.name),
    ]);
    expect(first.created.functions).toEqual([JSONB_UTC_TIMESTAMPTZ_FUNCTION]);
    expect(first.expected.tables).toEqual(first.created.tables);
    expect(first.expected.functions).toEqual([JSONB_UTC_TIMESTAMPTZ_FUNCTION]);
    expect(first.existing.tables.sort()).toEqual([...first.expected.tables].sort());
    expect(first.existing.indexes.sort()).toEqual([...first.expected.indexes].sort());
    expect(first.existing.functions).toEqual([JSONB_UTC_TIMESTAMPTZ_FUNCTION]);
    expect(fake.sqlLog.some((sql) => sql.includes("CREATE OR REPLACE FUNCTION"))).toBe(true);

    const second = await applyPostgresSchema(fake.query, plan);
    expect(second.created).toEqual({ schema: false, tables: [], indexes: [], functions: [] });
    expect(second.existing.tables.sort()).toEqual([...second.expected.tables].sort());
    expect(second.existing.functions).toEqual([JSONB_UTC_TIMESTAMPTZ_FUNCTION]);
    expect(fake.sqlLog.filter((sql) => sql.includes("CREATE OR REPLACE FUNCTION"))).toHaveLength(2);
  });

  it("plan diff reports expected vs existing vs pending objects", async () => {
    const expectedTables = [
      ...plan.tables.map((item) => item.table),
      AUTH_SESSIONS_TABLE,
      ADMIN_LOGIN_CONSUMED_JTIS_TABLE,
    ];
    const expectedIndexes = [
      ...plan.indexes.map((item) => item.name),
      ...plan.authSessions.indexes.map((item) => item.name),
      ...plan.adminLoginConsumedJtis.indexes.map((item) => item.name),
    ];
    const expectedFunctions = [JSONB_UTC_TIMESTAMPTZ_FUNCTION];
    const uninspected = diffPostgresSchema(plan, null);
    expect(uninspected.inspected).toBe(false);
    expect(uninspected.expected.schema).toBe(true);
    expect(uninspected.expected.tables).toEqual(expectedTables);
    expect(uninspected.expected.indexes).toEqual(expectedIndexes);
    expect(uninspected.expected.functions).toEqual(expectedFunctions);
    expect(uninspected.existing).toEqual({ schema: false, tables: [], indexes: [], functions: [] });
    expect(uninspected.pending).toEqual({
      schema: true,
      tables: expectedTables,
      indexes: expectedIndexes,
      functions: expectedFunctions,
    });

    const fake = fakeCatalog();
    fake.schemas.add(SCHEMA);
    fake.tables.set(SCHEMA, new Set([plan.tables[0]!.table]));
    fake.indexes.set(SCHEMA, new Set([plan.indexes[0]!.name]));
    const partial = diffPostgresSchema(plan, await inspectPostgresSchema(fake.query, plan));
    expect(partial.inspected).toBe(true);
    expect(partial.existing.schema).toBe(true);
    expect(partial.existing.tables).toEqual([plan.tables[0]!.table]);
    expect(partial.existing.indexes).toEqual([plan.indexes[0]!.name]);
    expect(partial.existing.functions).toEqual([]);
    expect(partial.pending.schema).toBe(false);
    expect(partial.pending.tables).toEqual(expectedTables.slice(1));
    expect(partial.pending.indexes).toEqual(expectedIndexes.slice(1));
    expect(partial.pending.functions).toEqual(expectedFunctions);
    expect(partial.pending.tables).not.toContain(plan.tables[0]!.table);
    expect(partial.pending.indexes).not.toContain(plan.indexes[0]!.name);

    const applied = await applyPostgresSchema(fake.query, plan);
    expect(applied.created.functions).toEqual([JSONB_UTC_TIMESTAMPTZ_FUNCTION]);
    expect(applied.existing.functions).toEqual([JSONB_UTC_TIMESTAMPTZ_FUNCTION]);
    const complete = diffPostgresSchema(plan, {
      schemaExists: true,
      tables: applied.existing.tables,
      indexes: applied.existing.indexes,
      functions: applied.existing.functions,
    });
    expect(complete.pending).toEqual({ schema: false, tables: [], indexes: [], functions: [] });
  });

  it("emits jsonb_utc_timestamptz in pending SQL when schema exists but the function is missing", () => {
    const dateIndex = plan.indexes.find((item) => item.sql.includes(JSONB_UTC_TIMESTAMPTZ_FUNCTION))!;
    const tables = [
      ...plan.tables.map((item) => item.table),
      AUTH_SESSIONS_TABLE,
      ADMIN_LOGIN_CONSUMED_JTIS_TABLE,
    ];
    const indexes = [
      ...plan.indexes.map((item) => item.name),
      ...plan.authSessions.indexes.map((item) => item.name),
      ...plan.adminLoginConsumedJtis.indexes.map((item) => item.name),
    ];
    const missingFnOnly = diffPostgresSchema(plan, {
      schemaExists: true,
      tables,
      indexes,
      functions: [],
    });
    expect(missingFnOnly.pending).toEqual({
      schema: false,
      tables: [],
      indexes: [],
      functions: [JSONB_UTC_TIMESTAMPTZ_FUNCTION],
    });
    expect(pendingPostgresSchemaStatements(plan, missingFnOnly)).toEqual([plan.functions[0]!.sql]);

    const missingFnAndDateIndex = diffPostgresSchema(plan, {
      schemaExists: true,
      tables,
      indexes: indexes.filter((name) => name !== dateIndex.name),
      functions: [],
    });
    expect(missingFnAndDateIndex.pending.schema).toBe(false);
    expect(missingFnAndDateIndex.pending.functions).toEqual([JSONB_UTC_TIMESTAMPTZ_FUNCTION]);
    expect(missingFnAndDateIndex.pending.indexes).toEqual([dateIndex.name]);
    const sql = pendingPostgresSchemaStatements(plan, missingFnAndDateIndex);
    expect(sql[0]).toBe(plan.functions[0]!.sql);
    expect(sql).toContain(dateIndex.sql);
    expect(sql.indexOf(plan.functions[0]!.sql)).toBeLessThan(sql.indexOf(dateIndex.sql));
  });

  it("keeps pg_advisory_xact_lock and DDL in one query so the transaction stays on one connection", async () => {
    const fake = fakeCatalog();
    let active = 0;
    let maxActive = 0;
    let tail = Promise.resolve();
    const query: PostgresQueryFn = async (sql, params) => {
      const run = async () => {
        if (sql.includes("CREATE OR REPLACE FUNCTION") || sql.includes("CREATE TABLE IF NOT EXISTS")) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
        }
        return fake.query(sql, params);
      };
      if (!sql.includes("pg_advisory_xact_lock")) return run();
      const waitFor = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await waitFor;
      try {
        return await run();
      } finally {
        release();
      }
    };

    await Promise.all([applyPostgresSchema(query, plan), applyPostgresSchema(query, plan)]);

    expect(maxActive).toBe(1);
    const scripts = fake.sqlLog.filter((sql) => sql.includes("pg_advisory_xact_lock"));
    expect(scripts).toHaveLength(2);
    for (const sql of scripts) {
      const lockAt = sql.indexOf("pg_advisory_xact_lock");
      const ddlAt = sql.indexOf("CREATE ");
      expect(lockAt).toBeGreaterThanOrEqual(0);
      expect(ddlAt).toBeGreaterThan(lockAt);
      expect(sql).toContain("CREATE OR REPLACE FUNCTION");
      expect(sql).toContain("CREATE SCHEMA IF NOT EXISTS");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS");
      expect(sql).toContain("CREATE INDEX IF NOT EXISTS");
      expect(sql).toContain(`hashtext('football_postgres_schema')`);
      expect(sql).toContain(`hashtext('${SCHEMA}:${NAMESPACE}')`);
      expect(sql).not.toContain("DROP INDEX");
      expect(sql).not.toContain("football_normalize_indexdef");
      expect(sql).not.toMatch(/\bpg_advisory_lock\s*\(/);
      expect(sql.indexOf("pg_advisory_xact_lock")).toBeLessThan(sql.indexOf("CREATE SCHEMA IF NOT EXISTS"));
    }
    expect(fake.sqlLog.some((sql) => sql === "BEGIN" || sql.startsWith("SELECT pg_advisory_xact_lock"))).toBe(false);
  });

  it("reports drifted index definitions and does not drop or recreate them", async () => {
    const fake = fakeCatalog();
    await applyPostgresSchema(fake.query, plan);
    const index = plan.indexes.find((item) => item.name === "uk_openid")!;
    const stale = `CREATE UNIQUE INDEX uk_openid ON ${SCHEMA}.${index.table} USING btree (((document ->> 'stale'::text)))`;
    fake.indexDefs.get(SCHEMA)!.set(index.name, stale);

    const drifted = diffPostgresSchema(plan, await inspectPostgresSchema(fake.query, plan));
    expect(drifted.existing.indexes).toContain(index.name);
    expect(drifted.pending.indexes).not.toContain(index.name);
    expect(drifted.driftedIndexes).toEqual([
      {
        name: index.name,
        expected: normalizePostgresIndexDef(index.sql, SCHEMA),
        actual: normalizePostgresIndexDef(stale, SCHEMA),
      },
    ]);
    expect(pendingPostgresSchemaStatements(plan, drifted)).toEqual([]);

    const before = fake.sqlLog.length;
    const reported = await applyPostgresSchema(fake.query, plan);
    expect(reported.created.indexes).not.toContain(index.name);
    expect(reported.driftedIndexes).toEqual(drifted.driftedIndexes);
    const script = fake.sqlLog.slice(before).find((sql) => sql.includes("pg_advisory_xact_lock"));
    expect(script).not.toContain("DROP INDEX");
    expect(script).not.toContain("football_normalize_indexdef");
    expect(script).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    expect(script!.indexOf("pg_advisory_xact_lock")).toBeLessThan(script!.indexOf("CREATE SCHEMA IF NOT EXISTS"));
    expect(fake.indexDefs.get(SCHEMA)!.get(index.name)).toBe(stale);
  });

  it("does not report an index created with the wrong definition during the lock wait as fixed", async () => {
    const fake = fakeCatalog();
    await applyPostgresSchema(fake.query, plan);
    const index = plan.indexes.find((item) => item.name === "uk_openid")!;
    const stale = `CREATE UNIQUE INDEX uk_openid ON ${SCHEMA}.${index.table} USING btree (((document ->> 'stale'::text)))`;
    fake.indexes.get(SCHEMA)!.delete(index.name);
    fake.indexDefs.get(SCHEMA)!.delete(index.name);

    const query: PostgresQueryFn = async (sql, params) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        fake.indexes.get(SCHEMA)!.add(index.name);
        fake.indexDefs.get(SCHEMA)!.set(index.name, stale);
      }
      return fake.query(sql, params);
    };
    const reported = await applyPostgresSchema(query, plan);
    expect(reported.created.indexes).not.toContain(index.name);
    expect(reported.driftedIndexes.map((item) => item.name)).toEqual([index.name]);
    expect(reported.driftedIndexes[0]?.actual).toContain("stale");
    expect(fake.indexDefs.get(SCHEMA)!.get(index.name)).toBe(stale);
  });

  it("treats a PostgreSQL indexdef as unchanged when it normalizes to the planned statement", async () => {
    const fake = fakeCatalog();
    await applyPostgresSchema(fake.query, plan);
    const index = plan.indexes.find((item) => item.name === "uk_openid")!;
    fake.indexDefs.get(SCHEMA)!.set(
      index.name,
      `CREATE UNIQUE INDEX uk_openid ON ${SCHEMA}.${index.table} USING btree (((document ->> 'openid'::text)))`,
    );
    const submitted = plan.indexes.find((item) => item.name === "ix_predictions_user_submitted")!;
    const submittedTable = submitted.table;
    fake.indexDefs.get(SCHEMA)!.set(
      submitted.name,
      `CREATE INDEX ${submitted.name} ON ${SCHEMA}.${submittedTable} USING btree (((document ->> 'user_id'::text)), ${SCHEMA}.${JSONB_UTC_TIMESTAMPTZ_FUNCTION}((document ->> 'submitted_at'::text)) DESC)`,
    );
    const auth = plan.authSessions.indexes[0]!;
    fake.indexDefs.get(SCHEMA)!.set(
      auth.name,
      `CREATE INDEX ${auth.name} ON ${SCHEMA}.${auth.table} USING btree (expires_at)`,
    );

    const diff = diffPostgresSchema(plan, await inspectPostgresSchema(fake.query, plan));
    expect(diff.pending.indexes).not.toContain(index.name);
    expect(diff.pending.indexes).not.toContain(submitted.name);
    expect(diff.pending.indexes).not.toContain(auth.name);
    expect(diff.driftedIndexes).toEqual([]);

    const openidDef = fake.indexDefs.get(SCHEMA)!.get(index.name);
    const submittedDef = fake.indexDefs.get(SCHEMA)!.get(submitted.name);
    const authDef = fake.indexDefs.get(SCHEMA)!.get(auth.name);
    const again = await applyPostgresSchema(fake.query, plan);
    expect(again.created.indexes).not.toContain(index.name);
    expect(again.created.indexes).not.toContain(submitted.name);
    expect(again.created.indexes).not.toContain(auth.name);
    expect(fake.indexDefs.get(SCHEMA)!.get(index.name)).toBe(openidDef);
    expect(fake.indexDefs.get(SCHEMA)!.get(submitted.name)).toBe(submittedDef);
    expect(fake.indexDefs.get(SCHEMA)!.get(auth.name)).toBe(authDef);
  });

  it("[CR-02] preserves non-default NULLS FIRST/LAST ordering while normalizing PG defaults", () => {
    const descPlanned = normalizePostgresIndexDef(
      `CREATE INDEX ix_sort ON ${SCHEMA}.docs (((document ->> 'ts')) DESC)`,
      SCHEMA,
    );
    const descNullsFirst = normalizePostgresIndexDef(
      `CREATE INDEX ix_sort ON ${SCHEMA}.docs (((document ->> 'ts')) DESC NULLS FIRST)`,
      SCHEMA,
    );
    const descNullsLast = normalizePostgresIndexDef(
      `CREATE INDEX ix_sort ON ${SCHEMA}.docs (((document ->> 'ts')) DESC NULLS LAST)`,
      SCHEMA,
    );
    expect(descNullsFirst).toBe(descPlanned);
    expect(descNullsLast).not.toBe(descPlanned);
    expect(descNullsLast).toContain("desc nulls last");

    const ascPlanned = normalizePostgresIndexDef(
      `CREATE INDEX ix_sort ON ${SCHEMA}.docs (((document ->> 'ts')))`,
      SCHEMA,
    );
    const ascNullsLast = normalizePostgresIndexDef(
      `CREATE INDEX ix_sort ON ${SCHEMA}.docs (((document ->> 'ts')) ASC NULLS LAST)`,
      SCHEMA,
    );
    const implicitNullsLast = normalizePostgresIndexDef(
      `CREATE INDEX ix_sort ON ${SCHEMA}.docs (((document ->> 'ts')) NULLS LAST)`,
      SCHEMA,
    );
    const ascNullsFirst = normalizePostgresIndexDef(
      `CREATE INDEX ix_sort ON ${SCHEMA}.docs (((document ->> 'ts')) ASC NULLS FIRST)`,
      SCHEMA,
    );
    expect(ascNullsLast).toBe(ascPlanned);
    expect(implicitNullsLast).toBe(ascPlanned);
    expect(ascNullsFirst).not.toBe(ascPlanned);
    expect(ascNullsFirst).toContain("nulls first");
  });

  it("[CR-13] attributes created objects only to the lock-winning applyPostgresSchema session", async () => {
    const fake = fakeCatalog();
    let lockChain = Promise.resolve();
    const sessionQuery: PostgresQueryFn = Object.assign(
      async (sql: string, params?: unknown[]) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        return fake.query(sql, params);
      },
      {
        withSession: async <T>(fn: (query: PostgresQueryFn) => Promise<T>): Promise<T> => {
          const prev = lockChain;
          let release = () => {};
          lockChain = new Promise<void>((resolve) => {
            release = resolve;
          });
          await prev;
          try {
            return await fn(sessionQuery);
          } finally {
            release();
          }
        },
      },
    );

    const [first, second] = await Promise.all([
      applyPostgresSchema(sessionQuery, plan),
      applyPostgresSchema(sessionQuery, plan),
    ]);
    expect(first.created.schema).toBe(true);
    expect(first.created.tables).toEqual([
      ...plan.tables.map((t) => t.table),
      AUTH_SESSIONS_TABLE,
      ADMIN_LOGIN_CONSUMED_JTIS_TABLE,
    ]);
    expect(second.created).toEqual({ schema: false, tables: [], indexes: [], functions: [] });
  });
});
