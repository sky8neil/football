import type { CloudBaseDb } from "../infrastructure/cloudbase-db.js";
import { CloudBaseAppRepository } from "../infrastructure/cloudbase-app-repository.js";
import { InMemoryRepository, type AppRepository } from "../infrastructure/repositories.js";
import type { GatewayRuntimeConfig } from "./config.js";

export function createGatewayRepository(
  config: GatewayRuntimeConfig,
  cloudbaseDb?: CloudBaseDb,
): AppRepository {
  if (config.repository_backend === "memory") return new InMemoryRepository();
  if (config.cloudbase_repository === null) {
    throw new Error("CloudBase repository configuration is required");
  }
  if (cloudbaseDb === undefined) {
    throw new Error("CloudBaseDb adapter is not configured; the SDK adapter is a B-stage requirement");
  }
  return new CloudBaseAppRepository(config.cloudbase_repository, cloudbaseDb);
}
