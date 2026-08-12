import { describe, expect, it } from "vitest";
import {
  assertEnvironmentIsolation,
  createEnvironmentScope,
  type EnvironmentConfig,
} from "./environment-config.js";

const configs: EnvironmentConfig[] = [
  {
    environment: "dev",
    cloud_environment_id: "cloud-dev",
    resource_namespace: "football-dev",
  },
  {
    environment: "test",
    cloud_environment_id: "cloud-test",
    resource_namespace: "football-test",
  },
  {
    environment: "prod",
    cloud_environment_id: "cloud-prod",
    resource_namespace: "football-prod",
  },
];

describe("environment isolation", () => {
  it("accepts exactly dev, test, and prod with distinct scopes", () => {
    expect(() => assertEnvironmentIsolation(configs)).not.toThrow();
    expect(createEnvironmentScope(configs[0]!)).toEqual({
      environment: "dev",
      cloud_environment_id: "cloud-dev",
      resource_namespace: "football-dev",
    });
  });

  it("rejects missing environments and reused cloud or resource scopes", () => {
    expect(() => assertEnvironmentIsolation(configs.slice(0, 2))).toThrow(
      "environment configuration must define dev, test, and prod",
    );
    expect(() => assertEnvironmentIsolation([
      configs[0]!,
      configs[1]!,
      { ...configs[2]!, cloud_environment_id: configs[0]!.cloud_environment_id },
    ])).toThrow("cloud environment ids must be unique");
    expect(() => assertEnvironmentIsolation([
      configs[0]!,
      configs[1]!,
      { ...configs[2]!, resource_namespace: configs[0]!.resource_namespace },
    ])).toThrow("resource namespaces must be unique");
  });

  it("rejects invalid environment config fields", () => {
    expect(() => createEnvironmentScope({
      environment: "sandbox" as EnvironmentConfig["environment"],
      cloud_environment_id: "cloud-sandbox",
      resource_namespace: "football-sandbox",
    })).toThrow("environment must be dev, test, or prod");
    expect(() => createEnvironmentScope({
      environment: "dev",
      cloud_environment_id: "",
      resource_namespace: "football-dev",
    })).toThrow("cloud_environment_id must not be empty");
    expect(() => createEnvironmentScope({
      environment: "dev",
      cloud_environment_id: "cloud-dev",
      resource_namespace: "",
    })).toThrow("resource_namespace must not be empty");
  });
});
