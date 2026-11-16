import type { ProviderFixtureBatchItem, ProviderFixtureBatchLoader } from "./provider-sync-job.js";

export function singleBatch(
  load: (now: Date) => Promise<readonly ProviderFixtureBatchItem[]>,
): ProviderFixtureBatchLoader {
  return async function* (now) { yield await load(now); };
}
