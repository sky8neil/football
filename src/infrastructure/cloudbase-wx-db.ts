import {
  CloudBaseDocumentNotFoundError,
  CloudBaseDuplicateKeyError,
  cloudBaseCollectionName,
  type CloudBaseDb,
  type CloudBaseDocument,
  type CloudBaseQueryOptions,
} from "./cloudbase-db.js";

type SdkResult<T> = { data?: T };
type SdkStats = {
  updated?: number;
  removed?: number;
  stats?: { updated?: number; removed?: number };
};
type SdkCommand = {
  inc(value: number): unknown;
  lt(value: number): unknown;
  lte(value: number | Date): unknown;
  gte(value: number | Date): unknown;
  in(values: readonly string[]): unknown;
};
type SdkDocument = {
  get(): Promise<SdkResult<CloudBaseDocument>>;
  create(options: { data: CloudBaseDocument }): Promise<unknown>;
  set(options: { data: Record<string, unknown> }): Promise<unknown>;
  update(options: { data: Record<string, unknown> }): Promise<SdkStats>;
  remove(): Promise<SdkStats>;
};
type SdkQuery = {
  where(filter: Record<string, unknown>): SdkQuery;
  orderBy(field: string, direction: "asc" | "desc"): SdkQuery;
  skip(count: number): SdkQuery;
  limit(count: number): SdkQuery;
  field?(projection: Record<string, boolean>): SdkQuery;
  get(): Promise<SdkResult<CloudBaseDocument[]>>;
  count(): Promise<{ total: number }>;
  doc(id: string): SdkDocument;
  add(options: { data: CloudBaseDocument }): Promise<unknown>;
  update(options: { data: Record<string, unknown> }): Promise<SdkStats>;
};
export type CloudBaseSdkDatabase = {
  collection(name: string): SdkQuery;
  command?: SdkCommand;
  startTransaction(): Promise<CloudBaseSdkTransaction>;
};
export type CloudBaseSdkTransaction = {
  collection(name: string): SdkQuery;
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

const PAGE_SIZE = 100;
const IN_FILTER_CHUNK = 100;
const HISTORY_FETCH_SIZE = PAGE_SIZE;
const HISTORY_MAX_BATCHES = 64;
const DISTINCT_MAX_ROWS = 100_000;
const MATCH_CHAIN_MAX_HOPS = 20;

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = (error as { errCode?: unknown; code?: unknown }).errCode ??
    (error as { code?: unknown }).code;
  return String(value ?? "").toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function isDuplicate(error: unknown): boolean {
  return /duplicate|already exists|e11000|11000/.test(`${errorCode(error)} ${errorMessage(error)}`.toLowerCase());
}

function isMissingDocument(error: unknown): boolean {
  const value = `${errorCode(error)} ${errorMessage(error)}`.toLowerCase();
  return /document.*(not exist|not found)|record.*not found|does not exist/.test(value);
}

function dataWithoutId(document: CloudBaseDocument): Record<string, unknown> {
  const { _id: _ignored, ...data } = document;
  return data;
}

function chunksOf(values: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size) as string[]);
  return chunks;
}

function asTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  }
  return Number.NEGATIVE_INFINITY;
}

function predictionIdOf(document: CloudBaseDocument): string {
  return String(document.prediction_id ?? document._id);
}

function matchIdOf(document: CloudBaseDocument): string {
  return String(document.match_id ?? document._id);
}

function isBeforeHistoryCursor(
  document: CloudBaseDocument,
  cursor: { submitted_at: Date; prediction_id: string } | null,
): boolean {
  if (cursor === null) return true;
  const submittedAt = asTime(document.submitted_at);
  const cursorAt = cursor.submitted_at.getTime();
  if (submittedAt > cursorAt) return false;
  if (submittedAt === cursorAt && predictionIdOf(document) >= cursor.prediction_id) return false;
  return true;
}

function compareHistoryDesc(left: CloudBaseDocument, right: CloudBaseDocument): number {
  const byTime = asTime(right.submitted_at) - asTime(left.submitted_at);
  if (byTime !== 0) return byTime;
  const leftId = predictionIdOf(left);
  const rightId = predictionIdOf(right);
  if (leftId === rightId) return 0;
  return leftId < rightId ? 1 : -1;
}

function resolveEffectiveMatch(
  matchId: string,
  matchesById: ReadonlyMap<string, CloudBaseDocument | null>,
): CloudBaseDocument | null {
  let match = matchesById.get(matchId);
  if (match === undefined || match === null) return null;
  const visited = new Set<string>();
  while (match.superseded_by != null) {
    const currentId = matchIdOf(match);
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    const next = matchesById.get(String(match.superseded_by));
    if (next === undefined || next === null) return null;
    match = next;
  }
  return match;
}

function passesLeagueSeason(
  match: CloudBaseDocument | null,
  leagueId: string | null,
  seasonId: string | null,
): boolean {
  if (match === null) return false;
  if (leagueId !== null && String(match.league_id ?? "") !== leagueId) return false;
  if (seasonId !== null && String(match.season_id ?? "") !== seasonId) return false;
  return true;
}

/** wx-server-sdk adapter. SDK instance and namespace are injected by the cloud entry. */
export class CloudBaseWxDb implements CloudBaseDb {
  private readonly db: Pick<CloudBaseSdkDatabase, "collection">;
  private readonly namespace: string;
  private readonly transactionDb: boolean;
  private readonly command: SdkCommand | undefined;

  constructor(
    db: Pick<CloudBaseSdkDatabase, "collection">,
    namespace: string,
    transactionDb = false,
    command?: SdkCommand,
  ) {
    this.db = db;
    this.namespace = namespace;
    this.transactionDb = transactionDb;
    this.command = command;
  }

  async get(collection: string, id: string): Promise<CloudBaseDocument | null> {
    try {
      const result = await this.db.collection(collection).doc(id).get();
      return result.data ?? null;
    } catch (error) {
      if (isMissingDocument(error)) return null;
      throw error;
    }
  }

  async add(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    const target = this.db.collection(collection);
    try {
      await target.add({ data: { ...document, _id: id } });
    } catch (error) {
      if (isDuplicate(error)) {
        throw new CloudBaseDuplicateKeyError(collection, "pk_document", { _id: id });
      }
      throw error;
    }
  }

  async update(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    try {
      const result = await this.db.collection(collection).doc(id).update({ data: dataWithoutId(document) });
      if ((result.stats?.updated ?? result.updated) === 0 && await this.get(collection, id) === null) {
        throw new CloudBaseDocumentNotFoundError(collection, id);
      }
    } catch (error) {
      if (error instanceof CloudBaseDocumentNotFoundError) throw error;
      if (isMissingDocument(error)) throw new CloudBaseDocumentNotFoundError(collection, id);
      if (isDuplicate(error)) throw new CloudBaseDuplicateKeyError(collection, "uk_unknown", { _id: id });
      throw error;
    }
  }

  async query(
    collection: string,
    filter: Record<string, unknown> = {},
    options: CloudBaseQueryOptions = {},
  ): Promise<CloudBaseDocument[]> {
    const all: CloudBaseDocument[] = [];
    const offset = Math.max(0, options.offset ?? 0);
    const requestedLimit = options.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.limit);
    let consumed = 0;
    while (consumed < requestedLimit) {
      const batchSize = Math.min(PAGE_SIZE, requestedLimit - consumed);
      let query = this.db.collection(collection);
      if (Object.keys(filter).length > 0) query = query.where(filter);
      if (options.order_by) query = query.orderBy(options.order_by, options.direction ?? "asc");
      const result = await query.skip(offset + consumed).limit(batchSize).get();
      const rows = result.data ?? [];
      all.push(...rows);
      consumed += rows.length;
      if (rows.length < batchSize) break;
    }
    return all;
  }

  async count(collection: string, filter: Record<string, unknown> = {}): Promise<number> {
    let query = this.db.collection(collection);
    if (Object.keys(filter).length > 0) query = query.where(filter);
    const result = await query.count();
    return result.total;
  }

  async reserveCounter(
    collection: string,
    id: string,
    field: string,
    limit: number,
    initial: CloudBaseDocument,
  ): Promise<boolean> {
    if (this.command === undefined) throw new Error("CloudBase counter commands are unavailable");
    if (await this.get(collection, id) === null) {
      try {
        await this.add(collection, id, initial);
      } catch (error) {
        if (!(error instanceof CloudBaseDuplicateKeyError)) throw error;
      }
    }
    const result = await this.db.collection(collection)
      .where({ _id: id, [field]: this.command.lt(limit) })
      .update({ data: { [field]: this.command.inc(1) } });
    return ((result.stats?.updated ?? result.updated) ?? 0) > 0;
  }

  async adjustCounter(collection: string, id: string, field: string, delta: number): Promise<void> {
    if (this.command === undefined) throw new Error("CloudBase counter commands are unavailable");
    await this.db.collection(collection).doc(id).update({
      data: { [field]: this.command.inc(delta) },
    });
  }

  async getCounter(collection: string, id: string, field: string): Promise<number> {
    const document = await this.get(collection, id);
    return typeof document?.[field] === "number" ? document[field] as number : 0;
  }

  lteFilter(field: string, value: unknown): Record<string, unknown> | undefined {
    if (this.command?.lte === undefined) return undefined;
    return { [field]: this.command.lte(value as number) };
  }

  gteFilter(field: string, value: unknown): Record<string, unknown> | undefined {
    if (this.command?.gte === undefined) return undefined;
    return { [field]: this.command.gte(value as number) };
  }

  inFilter(field: string, values: readonly string[]): Record<string, unknown> | undefined {
    if (this.command?.in === undefined) return undefined;
    if (values.length === 0) return undefined;
    return { [field]: this.command.in(values as string[]) };
  }

  /**
   * 可下推：user_id、submitted_at 游标（lte）、submitted_at 倒序、limit。
   * 不可下推：联赛/赛季与 superseded_by（Prediction 无这些字段，云数据库无 join），按批 in 查 matches 后应用层过滤。
   */
  async findPredictionHistoryPage(params: {
    predictions_collection: string;
    matches_collection: string;
    user_id: string;
    league_id: string | null;
    season_id: string | null;
    cursor: { submitted_at: Date; prediction_id: string } | null;
    limit: number;
  }): Promise<CloudBaseDocument[]> {
    if (params.limit <= 0) return [];
    const selected: CloudBaseDocument[] = [];
    const matchCache = new Map<string, CloudBaseDocument | null>();
    const considered = new Set<string>();
    let cursor = params.cursor;
    let offset = 0;
    let batches = 0;
    while (selected.length < params.limit && batches < HISTORY_MAX_BATCHES) {
      batches += 1;
      const filter: Record<string, unknown> = { user_id: params.user_id };
      if (cursor !== null) {
        const range = this.lteFilter("submitted_at", cursor.submitted_at);
        if (range !== undefined) Object.assign(filter, range);
        // 无 lteFilter 时不能下推游标范围，靠 offset + 应用层键集跳过已见行。
      }
      const batch = await this.query(params.predictions_collection, filter, {
        order_by: "submitted_at",
        direction: "desc",
        limit: HISTORY_FETCH_SIZE,
        offset,
      });
      if (batch.length === 0) break;
      batch.sort(compareHistoryDesc);
      const candidates = batch.filter((document) => {
        const id = predictionIdOf(document);
        return !considered.has(id) && isBeforeHistoryCursor(document, params.cursor);
      });
      await this.loadMatchChains(
        params.matches_collection,
        candidates.map((document) => String(document.match_id ?? "")).filter((id) => id.length > 0),
        matchCache,
      );
      for (const document of candidates) {
        considered.add(predictionIdOf(document));
        const effective = resolveEffectiveMatch(String(document.match_id ?? ""), matchCache);
        if (!passesLeagueSeason(effective, params.league_id, params.season_id)) continue;
        selected.push(document);
        if (selected.length >= params.limit) break;
      }
      const last = batch[batch.length - 1]!;
      const sameTimeCount = batch.filter((document) => asTime(document.submitted_at) === asTime(last.submitted_at)).length;
      cursor = { submitted_at: new Date(asTime(last.submitted_at)), prediction_id: predictionIdOf(last) };
      offset = sameTimeCount;
      if (batch.length < HISTORY_FETCH_SIZE) break;
    }
    return selected;
  }

  /**
   * 云数据库无 distinct/group by；field 投影 + 分页后用 Set 去重，不读整份文档。
   */
  async distinctQuery(
    collection: string,
    fields: readonly string[],
    filter: Record<string, unknown> = {},
  ): Promise<Record<string, string>[]> {
    if (fields.length === 0) return [];
    const seen = new Set<string>();
    const rows: Record<string, string>[] = [];
    const projection = Object.fromEntries(fields.map((field) => [field, true]));
    let offset = 0;
    let scanned = 0;
    while (scanned < DISTINCT_MAX_ROWS) {
      let query = this.db.collection(collection);
      if (Object.keys(filter).length > 0) query = query.where(filter);
      if (typeof query.field === "function") query = query.field(projection);
      const result = await query.skip(offset).limit(PAGE_SIZE).get();
      const batch = result.data ?? [];
      if (batch.length === 0) break;
      scanned += batch.length;
      offset += batch.length;
      for (const document of batch) {
        const dimension: Record<string, string> = {};
        for (const field of fields) {
          const value = document[field];
          dimension[field] = value == null ? "" : String(value);
        }
        const key = fields.map((field) => dimension[field]).join("\0");
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(dimension);
      }
      if (batch.length < PAGE_SIZE) break;
    }
    return rows;
  }

  async transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    if (this.transactionDb) return work(this);
    if (!("startTransaction" in this.db)) throw new Error("Cannot start a nested CloudBase transaction");
    const transaction = await (this.db as CloudBaseSdkDatabase).startTransaction();
    const txDb = new CloudBaseWxDb(transaction, this.namespace, true, this.command);
    try {
      const result = await work(txDb);
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  collectionName(collection: string): string {
    return cloudBaseCollectionName(this.namespace, collection);
  }

  private async loadMatchChains(
    collection: string,
    matchIds: readonly string[],
    cache: Map<string, CloudBaseDocument | null>,
  ): Promise<void> {
    let pending = [...new Set(matchIds.filter((id) => id.length > 0 && !cache.has(id)))];
    let hops = 0;
    while (pending.length > 0 && hops < MATCH_CHAIN_MAX_HOPS) {
      hops += 1;
      const loaded: CloudBaseDocument[] = [];
      for (const chunk of chunksOf(pending, IN_FILTER_CHUNK)) {
        const inClause = this.inFilter("match_id", chunk);
        if (inClause === undefined) {
          for (const id of chunk) {
            const document = await this.get(collection, id);
            cache.set(id, document);
            if (document !== null) loaded.push(document);
          }
          continue;
        }
        loaded.push(...await this.query(collection, inClause, { limit: chunk.length }));
      }
      for (const document of loaded) {
        const id = matchIdOf(document);
        cache.set(id, document);
        if (document._id !== id) cache.set(document._id, document);
      }
      for (const id of pending) {
        if (cache.has(id)) continue;
        const document = await this.get(collection, id);
        cache.set(id, document);
        if (document !== null) loaded.push(document);
      }
      const next: string[] = [];
      for (const document of loaded) {
        if (document.superseded_by == null) continue;
        const nextId = String(document.superseded_by);
        if (nextId.length > 0 && !cache.has(nextId)) next.push(nextId);
      }
      pending = [...new Set(next)];
    }
  }
}

export function createCloudBaseWxDb(
  db: CloudBaseSdkDatabase,
  namespace: string,
): CloudBaseWxDb {
  return new CloudBaseWxDb(db, namespace, false, db.command);
}
