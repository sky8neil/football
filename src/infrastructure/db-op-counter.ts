/**
 * 这是本地调用次数计数，不等于平台账单口径，不能直接换算资源点。
 */
import type { CloudBaseDb, CloudBaseDocument, CloudBaseQueryOptions } from "./cloudbase-db.js";

export interface DbOpCollectionCount {
  collection: string;
  read: number;
  write: number;
}

export interface DbOpSnapshot {
  read: number;
  write: number;
  /** 按 read+write 降序，最多 topN 条；用于定位「读写落在哪个集合」。 */
  by_collection: DbOpCollectionCount[];
}

export interface DbOpCounter {
  begin(): void;
  end(limit?: number): DbOpSnapshot;
  readonly active: boolean;
}

export function createCountingDb(db: CloudBaseDb): { db: CloudBaseDb; counter: DbOpCounter } {
  const state = {
    active: false,
    read: 0,
    write: 0,
    byCollection: new Map<string, { read: number; write: number }>(),
  };
  const counter: DbOpCounter = {
    begin() {
      state.active = true;
      state.read = 0;
      state.write = 0;
      state.byCollection.clear();
    },
    end(limit = 15) {
      const by_collection = [...state.byCollection.entries()]
        .map(([collection, counts]) => ({ collection, read: counts.read, write: counts.write }))
        .sort((a, b) => (b.read + b.write) - (a.read + a.write))
        .slice(0, limit);
      const snapshot = { read: state.read, write: state.write, by_collection };
      state.active = false;
      return snapshot;
    },
    get active() {
      return state.active;
    },
  };

  function bump(kind: "read" | "write", collection: string): void {
    if (!state.active) return;
    state[kind] += 1;
    let row = state.byCollection.get(collection);
    if (!row) {
      row = { read: 0, write: 0 };
      state.byCollection.set(collection, row);
    }
    row[kind] += 1;
  }

  function wrap(inner: CloudBaseDb): CloudBaseDb {
    const wrapped: CloudBaseDb = {
      async get(collection: string, id: string) {
        bump("read", collection);
        return inner.get(collection, id);
      },
      async add(collection: string, id: string, document: CloudBaseDocument) {
        bump("write", collection);
        return inner.add(collection, id, document);
      },
      async update(collection: string, id: string, document: CloudBaseDocument) {
        bump("write", collection);
        return inner.update(collection, id, document);
      },
      async query(collection: string, filter?: Record<string, unknown>, options?: CloudBaseQueryOptions) {
        bump("read", collection);
        return inner.query(collection, filter, options);
      },
      async count(collection: string, filter?: Record<string, unknown>) {
        bump("read", collection);
        return inner.count(collection, filter);
      },
      transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>) {
        return inner.transaction((transactionDb) => work(wrap(transactionDb)));
      },
    };
    if (inner.getCounter) {
      wrapped.getCounter = async (collection, id, field) => {
        bump("read", collection);
        return inner.getCounter!(collection, id, field);
      };
    }
    if (inner.adjustCounter) {
      wrapped.adjustCounter = async (collection, id, field, delta) => {
        bump("write", collection);
        return inner.adjustCounter!(collection, id, field, delta);
      };
    }
    if (inner.reserveCounter) {
      wrapped.reserveCounter = async (collection, id, field, limit, initial) => {
        bump("write", collection);
        return inner.reserveCounter!(collection, id, field, limit, initial);
      };
    }
    if (inner.inFilter) {
      wrapped.inFilter = (field, values) => inner.inFilter!(field, values);
    }
    if (inner.lteFilter) {
      wrapped.lteFilter = (field, value) => inner.lteFilter!(field, value);
    }
    return wrapped;
  }

  return { db: wrap(db), counter };
}
