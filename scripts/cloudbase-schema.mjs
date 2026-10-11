import { COLLECTION_DEFINITIONS } from "../dist/schema/collections.js";
import { QUERY_INDEXES, UNIQUE_INDEXES } from "../dist/schema/indexes.js";

const args = process.argv.slice(2);
const namespaceIndex = args.indexOf("--namespace");
const namespace = namespaceIndex >= 0 ? args[namespaceIndex + 1] : process.env.FOOTBALL_RESOURCE_NAMESPACE;
if (!namespace) throw new Error("Provide --namespace <value> or FOOTBALL_RESOURCE_NAMESPACE");

console.log(`CloudBase resource namespace: ${namespace}`);
console.log("Collections (create manually in CloudBase console):");
const collections = new Set([
  ...COLLECTION_DEFINITIONS.map((definition) => definition.collection),
  "diag",
  "rate_limits",
]);
for (const collection of collections) console.log(`- ${namespace}_${collection}`);
console.log("Indexes (create manually in CloudBase console):");
for (const index of [...UNIQUE_INDEXES, ...QUERY_INDEXES]) {
  const fields = index.fields.map((field) => {
    const [name, direction] = field.split(":");
    return `${name}:${direction ?? "asc"}`;
  }).join(", ");
  console.log(`- ${namespace}_${index.collection} ${index.name} unique=${index.unique} fields=[${fields}]`);
}
