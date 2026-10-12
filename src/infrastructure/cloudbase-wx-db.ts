import {
  CloudBaseDocumentNotFoundError,
  CloudBaseDuplicateKeyError,
  cloudBaseCollectionName,
  type CloudBaseDb,
  type CloudBaseDocument,
  type CloudBaseQueryOptions,
} from "./cloudbase-db.js";

type SdkResult<T> = { data?: T };
type SdkStats = { updated?: number; removed?: number };
type SdkCommand = { inc(value: number): unknown; lt(value: number): unknown };
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
      if (result.updated === 0) throw new CloudBaseDocumentNotFoundError(collection, id);
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
    return (result.updated ?? 0) > 0;
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
}

export function createCloudBaseWxDb(
  db: CloudBaseSdkDatabase,
  namespace: string,
): CloudBaseWxDb {
  return new CloudBaseWxDb(db, namespace, false, db.command);
}
