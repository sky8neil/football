import { COLLECTION_DEFINITIONS, type FieldDef } from "../schema/collections.js";
import { COLLECTION_ALIASES, type CloudBaseDocument } from "./cloudbase-db.js";

function collectDatePaths(fields: Record<string, FieldDef>, prefix: string[] = []): string[][] {
  const paths: string[][] = [];
  for (const [name, def] of Object.entries(fields)) {
    const path = [...prefix, name];
    if (def.type === "date") paths.push(path);
    if (def.fields !== undefined) paths.push(...collectDatePaths(def.fields, path));
  }
  return paths;
}

const DATE_PATHS_BY_COLLECTION: ReadonlyMap<string, readonly (readonly string[])[]> = new Map(
  COLLECTION_DEFINITIONS.map((definition) => [
    definition.collection,
    collectDatePaths(definition.fields),
  ]),
);

const ALIAS_TO_LOGICAL: ReadonlyMap<string, string> = new Map(
  Object.entries(COLLECTION_ALIASES).map(([logical, alias]) => [alias, logical]),
);

function resolveLogicalCollection(collection: string): string | undefined {
  if (DATE_PATHS_BY_COLLECTION.has(collection)) return collection;
  const fromAlias = ALIAS_TO_LOGICAL.get(collection);
  if (fromAlias !== undefined) return fromAlias;
  for (const [alias, logical] of ALIAS_TO_LOGICAL) {
    if (collection.endsWith(`_${alias}`)) return logical;
  }
  for (const logical of DATE_PATHS_BY_COLLECTION.keys()) {
    if (collection.endsWith(`_${logical}`)) return logical;
  }
  return undefined;
}

function encodeValue(value: unknown): unknown {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("invalid Date");
    return value.toISOString();
  }
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, encodeValue(item)]),
    );
  }
  return value;
}

function getAt(target: unknown, path: readonly string[]): unknown {
  let current: unknown = target;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setAt(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i]!;
    const next = current[key];
    if (next === null || next === undefined || typeof next !== "object" || Array.isArray(next)) return;
    current = next as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (last === undefined) return;
  current[last] = value;
}

function reviveDate(value: unknown): unknown {
  if (value === null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : value;
  }
  return value;
}

export function encodeQueryValue(value: unknown): unknown {
  return encodeValue(value);
}

export function encodeDocument(document: CloudBaseDocument): CloudBaseDocument {
  return encodeValue(document) as CloudBaseDocument;
}

export function decodeDocument(collection: string, document: CloudBaseDocument): CloudBaseDocument {
  const logical = resolveLogicalCollection(collection);
  const paths = logical === undefined ? undefined : DATE_PATHS_BY_COLLECTION.get(logical);
  if (paths === undefined || paths.length === 0) return document;
  const decoded = structuredClone(document) as CloudBaseDocument;
  for (const path of paths) {
    const current = getAt(decoded, path);
    if (current === undefined) continue;
    setAt(decoded, path, reviveDate(current));
  }
  return decoded;
}
