/**
 * Session 应用服务（阶段 2）。
 *
 * session init：按 openid 查找 active 用户（find-or-create）。
 * - openid 不存在：创建新 active 用户（昵称按 trim 校验后保存）。
 * - openid 已存在且 active：返回现有用户。
 * - openid 已存在但已删除：抛 USER_DELETED（数据保留，不可复用）。
 * - 并发唯一冲突（uk_openid 竞争）：回读胜者，返回现有用户。
 */
import { SCHEMA_VERSION, UserStatus } from "../domain/enums.js";
import { conflictError, validationError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import type { User } from "../domain/types.js";
import {
  UniqueConstraintError,
  type AppRepository,
} from "../infrastructure/repositories.js";
import { assertValidServerNow } from "./period-finalize.js";

export interface SessionInitResult {
  user: User;
  created: boolean;
}

export interface SessionInitInput {
  openid: string;
  nickname: string;
}

const SESSION_INIT_FIELDS: ReadonlySet<string> = new Set(["openid", "nickname"]);
const MAX_NICKNAME_GRAPHEMES = 32;
const graphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

function assertJsonObject(payload: unknown): asserts payload is Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw validationError("请求体必须为 JSON 对象");
  }
}

function validateOpenid(value: unknown): string {
  if (typeof value !== "string") {
    throw validationError("openid 必须为字符串", { field: "openid" });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw validationError("openid 不能为空", { field: "openid" });
  }
  if (trimmed !== value) {
    throw validationError("openid 不能包含首尾空白", { field: "openid" });
  }
  return value;
}

/** 昵称 trim 校验：必填、非空白，且长度为 1～32 个 Unicode grapheme。 */
export function validateNickname(value: unknown): string {
  if (typeof value !== "string") {
    throw validationError("nickname 必须为字符串", { field: "nickname" });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw validationError("nickname 不能为空白字符串", { field: "nickname" });
  }
  const graphemeCount = [...graphemeSegmenter.segment(trimmed)].length;
  if (graphemeCount > MAX_NICKNAME_GRAPHEMES) {
    throw validationError("nickname 长度必须为 1～32 个 Unicode grapheme", {
      field: "nickname",
    });
  }
  return trimmed;
}

export function validateSessionInitPayload(
  payload: Record<string, unknown>,
): SessionInitInput {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw validationError("请求体必须为 JSON 对象");
  }
  for (const key of Object.keys(payload)) {
    if (!SESSION_INIT_FIELDS.has(key)) {
      throw validationError("请求包含未定义字段", { field: key });
    }
  }
  const openid = validateOpenid(payload.openid);
  const nickname = validateNickname(payload.nickname);
  return { openid, nickname };
}

function buildUser(openid: string, nickname: string, now: Date): User {
  return {
    schema_version: SCHEMA_VERSION,
    user_id: newUuid(),
    openid,
    unionid: null,
    nickname,
    favorite_team_id: null,
    status: UserStatus.Active,
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
}

export class SessionService {
  constructor(private readonly repo: AppRepository) {}

  async init(payload: Record<string, unknown>, serverNow: Date): Promise<SessionInitResult> {
    assertValidServerNow(serverNow);
    assertJsonObject(payload);
    const input = validateSessionInitPayload(payload);

    const existing = await this.repo.users.findByOpenid(input.openid);
    if (existing !== null) {
      if (existing.status !== UserStatus.Active) {
        throw conflictError("USER_DELETED", "该账号已被注销");
      }
      return { user: existing, created: false };
    }

    const user = buildUser(input.openid, input.nickname, serverNow);
    try {
      await this.repo.users.insert(user);
      return { user, created: true };
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        const winner = await this.repo.users.findByOpenid(input.openid);
        if (winner !== null) {
          return { user: winner, created: false };
        }
      }
      throw err;
    }
  }
}
