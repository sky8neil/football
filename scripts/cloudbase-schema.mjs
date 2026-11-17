import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const distIndex = args.indexOf("--dist");
const distValue = distIndex >= 0 ? args[distIndex + 1] : undefined;
if (distIndex >= 0 && (!distValue || distValue.startsWith("--"))) throw new Error("Provide --dist <dir>");
const distDir = distValue === undefined
  ? resolve(dirname(fileURLToPath(import.meta.url)), "../dist")
  : resolve(distValue);
if (!existsSync(distDir) || !statSync(distDir).isDirectory()) throw new Error(`Dist directory does not exist or is not a directory: ${distDir}`);

const namespaceIndex = args.indexOf("--namespace");
const namespace = namespaceIndex >= 0 ? args[namespaceIndex + 1] : process.env.FOOTBALL_RESOURCE_NAMESPACE;
if (!namespace) throw new Error("Provide --namespace <value> or FOOTBALL_RESOURCE_NAMESPACE");

const { COLLECTION_DEFINITIONS } = await import(pathToFileURL(resolve(distDir, "schema/collections.js")).href);
const { QUERY_INDEXES, UNIQUE_INDEXES } = await import(pathToFileURL(resolve(distDir, "schema/indexes.js")).href);
const { CLOUDBASE_RUNTIME_COLLECTIONS, cloudBaseCollectionName } = await import(pathToFileURL(resolve(distDir, "infrastructure/cloudbase-db.js")).href);

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
