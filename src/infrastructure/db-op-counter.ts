/**
 * 这是本地调用次数计数，不等于平台账单口径，不能直接换算资源点。
 */
import type { CloudBaseDb, CloudBaseDocument, CloudBaseQueryOptions } from "./cloudbase-db.js";

export interface DbOpCounter {
  begin(): void;
  end(): { read: number; write: number };
  readonly active: boolean;
}

export function createCountingDb(db: CloudBaseDb): { db: CloudBaseDb; counter: DbOpCounter } {
  const state = { active: false, read: 0, write: 0 };
  const counter: DbOpCounter = {
    begin() {
      state.active = true;
      state.read = 0;
      state.write = 0;
    },
    end() {
      const snapshot = { read: state.read, write: state.write };
      state.active = false;
      return snapshot;
    },
    get active() {
      return state.active;
    },
  };

  function bump(kind: "read" | "write"): void {
    if (!state.active) return;
    state[kind] += 1;
  }

  function wrap(inner: CloudBaseDb): CloudBaseDb {
    const wrapped: CloudBaseDb = {
      async get(collection: string, id: string) {
        bump("read");
        return inner.get(collection, id);
      },
      async add(collection: string, id: string, document: CloudBaseDocument) {
        bump("write");
        return inner.add(collection, id, document);
      },
      async update(collection: string, id: string, document: CloudBaseDocument) {
        bump("write");
        return inner.update(collection, id, document);
      },
      async query(collection: string, filter?: Record<string, unknown>, options?: CloudBaseQueryOptions) {
        bump("read");
        return inner.query(collection, filter, options);
      },
      async count(collection: string, filter?: Record<string, unknown>) {
        bump("read");
        return inner.count(collection, filter);
      },
      transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>) {
        return inner.transaction((transactionDb) => work(wrap(transactionDb)));
      },
    };
    if (inner.getCounter) {
      wrapped.getCounter = async (collection, id, field) => {
        bump("read");
        return inner.getCounter!(collection, id, field);
      };
    }
    if (inner.adjustCounter) {
      wrapped.adjustCounter = async (collection, id, field, delta) => {
        bump("write");
        return inner.adjustCounter!(collection, id, field, delta);
      };
    }
    if (inner.reserveCounter) {
      wrapped.reserveCounter = async (collection, id, field, limit, initial) => {
        bump("write");
        return inner.reserveCounter!(collection, id, field, limit, initial);
      };
    }
    return wrapped;
  }

  return { db: wrap(db), counter };
}
