/**
 * ID 工具（规范 2.2）。
 *
 * 内部 ID 使用 UUID v4，小写 canonical 36 字符字符串。
 * league_id / season_id / round_id 为稳定业务字符串，不使用 UUID。
 */
import { randomUUID } from "node:crypto";

export function newUuid(): string {
  return randomUUID();
}

export function isValidUuid(value: string): boolean {
  const pattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return pattern.test(value);
}

export function isValidIdempotencyKey(value: string): boolean {
  return isValidUuid(value);
}
