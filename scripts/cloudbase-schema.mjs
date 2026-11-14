import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const namespaceIndex = args.indexOf("--namespace");
const namespace = namespaceIndex >= 0 ? args[namespaceIndex + 1] : process.env.FOOTBALL_RESOURCE_NAMESPACE;
if (!namespace) throw new Error("Provide --namespace <value> or FOOTBALL_RESOURCE_NAMESPACE");

const distDirIndex = args.indexOf("--dist-dir");
const distDirArg = distDirIndex >= 0 ? args[distDirIndex + 1] : (process.env.SCHEMA_DIST_DIR ?? resolve(ROOT, "dist"));
const distDir = resolve(process.cwd(), distDirArg);

const collectionsPath = resolve(distDir, "schema", "collections.js");
const indexesPath = resolve(distDir, "schema", "indexes.js");
const dbPath = resolve(distDir, "infrastructure", "cloudbase-db.js");

if (!existsSync(collectionsPath) || !existsSync(indexesPath) || !existsSync(dbPath)) {
  throw new Error(`Schema files not found in ${distDir}. Run npm run build or pass --dist-dir <path>.`);
}

const { COLLECTION_DEFINITIONS } = await import(pathToFileURL(collectionsPath).href);
const { QUERY_INDEXES, UNIQUE_INDEXES } = await import(pathToFileURL(indexesPath).href);
const { CLOUDBASE_RUNTIME_COLLECTIONS, cloudBaseCollectionName } = await import(pathToFileURL(dbPath).href);

console.log(`CloudBase resource namespace: ${namespace}`);
console.log("Collections (create manually in CloudBase console):");
const collections = new Set([
  ...COLLECTION_DEFINITIONS.map((definition) => definition.collection),
  ...CLOUDBASE_RUNTIME_COLLECTIONS,
]);
for (const collection of collections) console.log(`- ${cloudBaseCollectionName(namespace, collection)}`);
console.log("Indexes (create manually in CloudBase console):");
for (const index of [...UNIQUE_INDEXES, ...QUERY_INDEXES]) {
  const fields = index.fields.map((field) => {
    const [name, direction] = field.split(":");
    return `${name}:${direction ?? "asc"}`;
  }).join(", ");
  console.log(`- ${cloudBaseCollectionName(namespace, index.collection)} ${index.name} unique=${index.unique} fields=[${fields}]`);
}
