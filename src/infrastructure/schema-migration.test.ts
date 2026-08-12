import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../domain/enums.js";
import {
  CURRENT_SCHEMA_VERSION,
  assertSupportedSchemaVersion,
  listPendingMigrations,
  resolveMigrationPath,
  SCHEMA_MIGRATIONS,
} from "./schema-migration.js";

describe("schema migration/version 基础设施（规范 2.5 / 43.21）", () => {
  it("当前版本固定为 schema_version=1，且与领域常量一致", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
    expect(CURRENT_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  });

  it("MVP 无已登记 migration；不猜测旧结构", () => {
    expect(SCHEMA_MIGRATIONS).toEqual([]);
    expect(listPendingMigrations(CURRENT_SCHEMA_VERSION)).toEqual([]);
  });

  it("assertSupportedSchemaVersion 拒绝非当前版本", () => {
    expect(() => assertSupportedSchemaVersion(1)).not.toThrow();
    expect(() => assertSupportedSchemaVersion(0)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );
    expect(() => assertSupportedSchemaVersion(2)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );
  });

  it("resolveMigrationPath 对未知版本 Fail Closed，不自动猜测路径", () => {
    expect(resolveMigrationPath(1, 1)).toEqual([]);
    expect(() => resolveMigrationPath(0, 1)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );
    expect(() => resolveMigrationPath(1, 2)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );
  });
});
