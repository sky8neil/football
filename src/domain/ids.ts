/**
 * ID 工具（规范 2.2）。
 *
 * 内部 ID 使用 UUID v4，小写 canonical 36 字符字符串。
 * league_id / season_id / round_id 为稳定业务字符串，不使用 UUID。
 */
import { createHash, randomUUID } from "node:crypto";

export function newUuid(): string {
  return randomUUID();
}

export function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function isValidUuid(value: string): boolean {
  const pattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return pattern.test(value);
}

export function isValidIdempotencyKey(value: string): boolean {
  return isValidUuid(value);
}
