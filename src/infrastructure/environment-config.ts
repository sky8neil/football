/**
 * Environment boundaries used by deployment configuration.
 * Credential values are intentionally not represented here.
 */
export const ENVIRONMENT_NAMES = ["dev", "test", "prod"] as const;
export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

export interface EnvironmentConfig {
  environment: EnvironmentName;
  cloud_environment_id: string;
  resource_namespace: string;
}

export interface EnvironmentScope {
  environment: EnvironmentName;
  cloud_environment_id: string;
  resource_namespace: string;
}

function isEnvironmentName(value: unknown): value is EnvironmentName {
  return typeof value === "string" &&
    (ENVIRONMENT_NAMES as readonly string[]).includes(value);
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  return value;
}

export function createEnvironmentScope(config: EnvironmentConfig): EnvironmentScope {
  if (!isEnvironmentName(config.environment)) {
    throw new Error("environment must be dev, test, or prod");
  }
  return {
    environment: config.environment,
    cloud_environment_id: requireNonEmpty(
      config.cloud_environment_id,
      "cloud_environment_id",
    ),
    resource_namespace: requireNonEmpty(
      config.resource_namespace,
      "resource_namespace",
    ),
  };
}

export function assertEnvironmentIsolation(
  configs: readonly EnvironmentConfig[],
): void {
  if (
    configs.length !== ENVIRONMENT_NAMES.length ||
    new Set(configs.map((config) => config.environment)).size !== ENVIRONMENT_NAMES.length ||
    ENVIRONMENT_NAMES.some(
      (environment) => !configs.some((config) => config.environment === environment),
    )
  ) {
    throw new Error("environment configuration must define dev, test, and prod");
  }

  const scopes = configs.map(createEnvironmentScope);
  if (new Set(scopes.map((scope) => scope.cloud_environment_id)).size !== scopes.length) {
    throw new Error("cloud environment ids must be unique");
  }
  if (new Set(scopes.map((scope) => scope.resource_namespace)).size !== scopes.length) {
    throw new Error("resource namespaces must be unique");
  }
}
