import { createHmac, timingSafeEqual } from "node:crypto";
import { FIXED_CONFIG_V1, MIN_RANK_PREDICTIONS } from "../domain/config.js";
import { PeriodType, UserStatus } from "../domain/enums.js";
import { internalError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { isValidPeriodKey, calculatePeriodKey } from "../domain/time.js";
import type { RankingEntry, User } from "../domain/types.js";
import type { AppRepository, RankingRepository } from "../infrastructure/repositories.js";

export interface RankingQuery {
  period_type: PeriodType;
  period_key: string | null;
  limit: number;
  cursor: string | null;
  server_now: Date;
}

export interface RankingListItem {
  global_rank: number;
  user_id: string;
  display_name: string;
  favorite_team_id: string | null;
  period_score: number;
  valid_predictions: number;
  wdl_hits: number;
  exact_hits: number;
  wdl_accuracy_percent: string;
  last_scoring_match_at: string | null;
}

export interface RankingQueryResult {
  items: RankingListItem[];
  has_more: boolean;
  next_cursor: string | null;
}

interface RankingCursorPayload {
  version: 1;
  period_type: PeriodType;
  period_key: string;
  global_rank: number;
  user_id: string;
}

const CURSOR_VERSION = 1 as const;

function requireRankings(
  repo: Pick<AppRepository, "rankings">,
): RankingRepository {
  if (repo.rankings === undefined) {
    throw internalError("rankings repository port 未配置");
  }
  return repo.rankings;
}

function assertQuery(input: RankingQuery): void {
  if (
    (input.period_type !== PeriodType.Week && input.period_type !== PeriodType.Month) ||
    (input.period_key !== null && !isValidPeriodKey(input.period_type, input.period_key)) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > FIXED_CONFIG_V1.API_MAX_LIMIT ||
    !(input.server_now instanceof Date) ||
    Number.isNaN(input.server_now.getTime()) ||
    (input.cursor !== null && !isOpaqueCursorShape(input.cursor))
  ) {
    throw validationError("排行榜查询参数无效");
  }
}

function isOpaqueCursorShape(value: unknown): value is string {
  return typeof value === "string" && value.split(".").length === 2 && value.length > 2;
}

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw validationError("cursor 格式无效", { field: "cursor" });
  }
}

function parseCursorPayload(value: unknown): RankingCursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== CURSOR_VERSION ||
    (payload.period_type !== PeriodType.Week && payload.period_type !== PeriodType.Month) ||
    typeof payload.period_key !== "string" ||
    !isValidPeriodKey(payload.period_type, payload.period_key) ||
    !Number.isSafeInteger(payload.global_rank) ||
    (payload.global_rank as number) < 1 ||
    typeof payload.user_id !== "string" ||
    !isValidUuid(payload.user_id)
  ) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  return {
    version: CURSOR_VERSION,
    period_type: payload.period_type,
    period_key: payload.period_key,
    global_rank: payload.global_rank as number,
    user_id: payload.user_id,
  };
}

export class RankingCursorCodec {
  constructor(private readonly secret: string) {
    if (secret.length === 0) {
      throw new Error("ranking cursor secret must not be empty");
    }
  }

  encode(position: Omit<RankingCursorPayload, "version">): string {
    const payload: RankingCursorPayload = {
      version: CURSOR_VERSION,
      ...position,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret)
      .update(encodedPayload)
      .digest("base64url");
    return `${encodedPayload}.${signature}`;
  }

  decode(cursor: string): Omit<RankingCursorPayload, "version"> {
    if (!isOpaqueCursorShape(cursor)) {
      throw validationError("cursor 格式无效", { field: "cursor" });
    }
    const [encodedPayload, encodedSignature] = cursor.split(".") as [string, string];
    const expectedSignature = createHmac("sha256", this.secret)
      .update(encodedPayload)
      .digest("base64url");
    const provided = Buffer.from(encodedSignature, "utf8");
    const expected = Buffer.from(expectedSignature, "utf8");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw validationError("cursor 签名无效", { field: "cursor" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeBase64Url(encodedPayload));
    } catch {
      throw validationError("cursor 内容无效", { field: "cursor" });
    }
    const payload = parseCursorPayload(parsed);
    return {
      period_type: payload.period_type,
      period_key: payload.period_key,
      global_rank: payload.global_rank,
      user_id: payload.user_id,
    };
  }
}

function assertRankingEntry(entry: RankingEntry, periodType: PeriodType, periodKey: string): void {
  if (
    entry.period_type !== periodType ||
    entry.period_key !== periodKey ||
    entry.global_rank !== null && (!Number.isSafeInteger(entry.global_rank) || entry.global_rank < 1) ||
    entry.global_rank !== null && entry.valid_predictions < MIN_RANK_PREDICTIONS ||
    !Number.isInteger(entry.period_score) ||
    entry.period_score < 0 ||
    !Number.isInteger(entry.valid_predictions) ||
    entry.valid_predictions < 0 ||
    !Number.isInteger(entry.wdl_hits) ||
    entry.wdl_hits < 0 ||
    !Number.isInteger(entry.exact_hits) ||
    entry.exact_hits < 0 ||
    entry.exact_hits > entry.wdl_hits ||
    entry.wdl_hits > entry.valid_predictions ||
    !isValidUuid(entry.user_id)
  ) {
    throw internalError(`ranking 文档数据非法（user_id=${entry.user_id}）`);
  }
}

function compareRankingPosition(a: RankingEntry, b: RankingEntry): number {
  const rankDifference = (a.global_rank ?? Number.MAX_SAFE_INTEGER) -
    (b.global_rank ?? Number.MAX_SAFE_INTEGER);
  if (rankDifference !== 0) {
    return rankDifference;
  }
  return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
}

function displayName(user: User): string {
  if (user.status === UserStatus.Deleted) {
    return "已注销用户";
  }
  if (user.status !== UserStatus.Active || user.nickname === null) {
    throw internalError(`用户展示资料非法（user_id=${user.user_id}）`);
  }
  return user.nickname;
}

function toRankingItem(entry: RankingEntry, user: User): RankingListItem {
  if (entry.global_rank === null || entry.valid_predictions < 1) {
    throw internalError(`ranking entry 不满足公开榜单条件（user_id=${entry.user_id}）`);
  }
  return {
    global_rank: entry.global_rank,
    user_id: entry.user_id,
    display_name: displayName(user),
    favorite_team_id: user.status === UserStatus.Deleted ? null : user.favorite_team_id,
    period_score: entry.period_score,
    valid_predictions: entry.valid_predictions,
    wdl_hits: entry.wdl_hits,
    exact_hits: entry.exact_hits,
    wdl_accuracy_percent: (entry.wdl_hits * 100 / entry.valid_predictions).toFixed(1),
    last_scoring_match_at: entry.last_scoring_match_at?.toISOString() ?? null,
  };
}

export class RankingQueryService {
  private readonly cursorCodec: RankingCursorCodec;

  constructor(
    private readonly repo: Pick<AppRepository, "users" | "rankings">,
    cursorSecret: string,
  ) {
    this.cursorCodec = new RankingCursorCodec(cursorSecret);
  }

  async list(input: RankingQuery): Promise<RankingQueryResult> {
    assertQuery(input);
    const position = input.cursor === null ? null : this.cursorCodec.decode(input.cursor);
    if (position !== null && position.period_type !== input.period_type) {
      throw validationError("cursor 与当前 period_type 冲突", { field: "cursor" });
    }

    const periodKey = input.period_key ?? position?.period_key ??
      calculatePeriodKey(input.period_type, input.server_now);
    if (!isValidPeriodKey(input.period_type, periodKey)) {
      throw validationError("period_key 格式与 period_type 不匹配", { field: "period_key" });
    }
    if (position !== null && position.period_key !== periodKey) {
      throw validationError("cursor 与当前 period_key 冲突", { field: "cursor" });
    }

    const rankings = await requireRankings(this.repo).findByPeriod(
      input.period_type,
      periodKey,
    );
    const eligible = rankings.filter((entry) => entry.global_rank !== null);
    const seenRanks = new Set<number>();
    for (const entry of rankings) {
      assertRankingEntry(entry, input.period_type, periodKey);
      if (entry.global_rank !== null) {
        if (seenRanks.has(entry.global_rank)) {
          throw internalError(`ranking global_rank 重复（period=${periodKey}）`);
        }
        seenRanks.add(entry.global_rank);
      }
    }

    eligible.sort(compareRankingPosition);
    const after = position;
    const remaining = after === null
      ? eligible
      : eligible.filter((entry) =>
        entry.global_rank! > after.global_rank ||
        entry.global_rank === after.global_rank && entry.user_id > after.user_id,
      );
    const pageEntries = remaining.slice(0, input.limit);
    const userCache = new Map<string, User>();
    const items: RankingListItem[] = [];
    for (const entry of pageEntries) {
      const cachedUser = userCache.get(entry.user_id);
      let user: User;
      if (cachedUser === undefined) {
        const loadedUser = await this.repo.users.findById(entry.user_id);
        if (loadedUser === null) {
          throw internalError(`ranking entry 缺少 user（user_id=${entry.user_id}）`);
        }
        user = loadedUser;
        userCache.set(entry.user_id, loadedUser);
      } else {
        user = cachedUser;
      }
      items.push(toRankingItem(entry, user));
    }

    const hasMore = remaining.length > input.limit;
    const last = pageEntries.at(-1);
    return {
      items,
      has_more: hasMore,
      next_cursor: hasMore && last !== undefined && last.global_rank !== null
        ? this.cursorCodec.encode({
            period_type: input.period_type,
            period_key: periodKey,
            global_rank: last.global_rank,
            user_id: last.user_id,
          })
        : null,
    };
  }
}
