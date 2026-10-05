import { createHmac, timingSafeEqual } from "node:crypto";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import {
  GroupMemberStatus,
  GroupStatus,
  RankingBoard,
  RankingScope,
  UserStatus,
  type RankingBoard as RankingBoardType,
  type RankingScope as RankingScopeType,
} from "../domain/enums.js";
import { conflictError, groupError, internalError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { formatSDisplay } from "../domain/levels.js";
import { compareRankingEntry } from "../domain/ranking.js";
import { calculatePeriodKey, isValidPeriodKey, periodEndAt } from "../domain/time.js";
import type { BoardSnapshot, Group, RankingEntry, User } from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";

export interface RankingQuery {
  board: RankingBoardType;
  period_key: string | null;
  scope: RankingScopeType;
  group_id: string | null;
  limit: number;
  cursor: string | null;
  server_now: Date;
  authenticated_user_id?: string | null;
}

interface RankingItemBase {
  rank: number;
  user_id: string;
  display_name: string;
  favorite_team_id: string | null;
  career_level: number;
}

export type RankingListItem = RankingItemBase & (
  | {
      period_score: number;
      valid_predictions: number;
      exact_hits: number;
      last_scoring_match_at: string | null;
    }
  | {
      career_points: number;
      career_valid_predictions: number;
      exact_hits: number;
      last_scoring_match_at: string | null;
    }
  | {
      strength_index: string;
      window_n: number;
    }
);

export type RankingMe =
  | { status: "ranked"; rank: number | null; top_percent: number | null }
  | { status: "not_participated" }
  | { status: "below_threshold"; remaining_valid_predictions: number };

export interface RankingQueryResult {
  board: RankingBoardType;
  scope: RankingScopeType;
  period_key: string | null;
  updated_at: string | null;
  items: RankingListItem[];
  has_more: boolean;
  next_cursor: string | null;
  me?: RankingMe;
}

interface RankingCursorPayload {
  version: 1;
  board: RankingBoardType;
  scope: RankingScopeType;
  group_id: string | null;
  period_key: string | null;
  offset: number;
}

type RankingSource = RankingEntry | BoardSnapshot;

interface RankedEntry {
  source: RankingSource;
  user: User;
}

const CURSOR_VERSION = 1 as const;

function isCursorShape(value: unknown): value is string {
  return typeof value === "string" && value.split(".").length === 2 && value.length > 2;
}

function validateQuery(input: RankingQuery): void {
  if (
    !Object.values(RankingBoard).includes(input.board) ||
    !Object.values(RankingScope).includes(input.scope) ||
    (input.board === RankingBoard.Week
      ? input.period_key !== null && !isValidPeriodKey("week", input.period_key)
      : input.period_key !== null) ||
    (input.scope === RankingScope.Group
      ? input.group_id === null || !isValidUuid(input.group_id)
      : input.group_id !== null) ||
    !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > FIXED_CONFIG_V1.API_MAX_LIMIT ||
    (input.cursor !== null && !isCursorShape(input.cursor)) ||
    !(input.server_now instanceof Date) || !Number.isFinite(input.server_now.getTime()) ||
    (input.authenticated_user_id != null && !isValidUuid(input.authenticated_user_id))
  ) {
    throw validationError("排行榜查询参数无效");
  }
}

function parseCursor(value: unknown): RankingCursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== CURSOR_VERSION ||
    !Object.values(RankingBoard).includes(payload.board as RankingBoardType) ||
    !Object.values(RankingScope).includes(payload.scope as RankingScopeType) ||
    (payload.group_id !== null && (typeof payload.group_id !== "string" || !isValidUuid(payload.group_id))) ||
    (payload.period_key !== null && typeof payload.period_key !== "string") ||
    !Number.isSafeInteger(payload.offset) || (payload.offset as number) < 0
  ) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  if (
    payload.board === RankingBoard.Week
      ? typeof payload.period_key !== "string" || !isValidPeriodKey("week", payload.period_key)
      : payload.period_key !== null
  ) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  return payload as unknown as RankingCursorPayload;
}

export class RankingCursorCodec {
  constructor(private readonly secret: string) {
    if (secret.length === 0) throw new Error("ranking cursor secret must not be empty");
  }

  encode(position: Omit<RankingCursorPayload, "version">): string {
    const encoded = Buffer.from(JSON.stringify({ version: CURSOR_VERSION, ...position }), "utf8")
      .toString("base64url");
    const signature = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  decode(cursor: string): Omit<RankingCursorPayload, "version"> {
    if (!isCursorShape(cursor)) throw validationError("cursor 格式无效", { field: "cursor" });
    const [encoded, signature] = cursor.split(".") as [string, string];
    const expected = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    const providedBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) {
      throw validationError("cursor 签名无效", { field: "cursor" });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw validationError("cursor 内容无效", { field: "cursor" });
    }
    const parsed = parseCursor(payload);
    return {
      board: parsed.board,
      scope: parsed.scope,
      group_id: parsed.group_id,
      period_key: parsed.period_key,
      offset: parsed.offset,
    };
  }
}

function requireGroups(repo: Pick<UnitOfWork, "groups">): NonNullable<UnitOfWork["groups"]> {
  if (repo.groups === undefined) throw internalError("groups repository port 未配置");
  return repo.groups;
}

function requireGroupMembers(repo: Pick<UnitOfWork, "groupMembers">): NonNullable<UnitOfWork["groupMembers"]> {
  if (repo.groupMembers === undefined) throw internalError("group_members repository port 未配置");
  return repo.groupMembers;
}

function assertRanking(entry: RankingEntry, periodKey: string): void {
  if (
    entry.period_type !== "week" || entry.period_key !== periodKey ||
    !Number.isSafeInteger(entry.period_score) || entry.period_score < 0 ||
    !Number.isSafeInteger(entry.valid_predictions) || entry.valid_predictions < 0 ||
    !Number.isSafeInteger(entry.wdl_hits) || entry.wdl_hits < 0 ||
    !Number.isSafeInteger(entry.exact_hits) || entry.exact_hits < 0 ||
    entry.exact_hits > entry.wdl_hits || entry.wdl_hits > entry.valid_predictions ||
    (entry.global_rank !== null && (!Number.isSafeInteger(entry.global_rank) || entry.global_rank < 1))
  ) {
    throw internalError(`ranking 文档数据非法（user_id=${entry.user_id}）`);
  }
}

function displayName(user: User): string {
  if (user.status === UserStatus.Deleted) return "已注销用户";
  if (user.status !== UserStatus.Active || user.nickname === null) {
    throw internalError(`用户展示资料非法（user_id=${user.user_id}）`);
  }
  return user.nickname;
}

function sourceUserId(source: RankingSource): string {
  return source.user_id;
}

function sourceRank(source: RankingSource): number {
  return "global_rank" in source ? source.global_rank ?? Number.MAX_SAFE_INTEGER : source.rank;
}

function compareSources(board: RankingBoardType, a: RankingSource, b: RankingSource): number {
  if (board === RankingBoard.Strength) {
    if (!("window_score_sum" in a) || !("window_score_sum" in b) || a.window_score_sum === null ||
      b.window_score_sum === null || a.window_n === null || b.window_n === null) {
      throw internalError("strength snapshot 缺少排序字段");
    }
    return compareRankingEntry(board, {
      window_score_sum: a.window_score_sum, window_n: a.window_n, user_id: a.user_id,
    }, {
      window_score_sum: b.window_score_sum, window_n: b.window_n, user_id: b.user_id,
    });
  }
  if (board === RankingBoard.Week) {
    if (!("period_score" in a) || !("period_score" in b)) throw internalError("week ranking 类型非法");
    return compareRankingEntry(board, {
      period_score: a.period_score, exact_hits: a.exact_hits,
      valid_predictions: a.valid_predictions, last_scoring_match_at: a.last_scoring_match_at,
      user_id: a.user_id,
    }, {
      period_score: b.period_score, exact_hits: b.exact_hits,
      valid_predictions: b.valid_predictions, last_scoring_match_at: b.last_scoring_match_at,
      user_id: b.user_id,
    });
  }
  if (!("career_points" in a) || !("career_points" in b) || a.career_points === null ||
    b.career_points === null || a.career_exact_hits === null || b.career_exact_hits === null ||
    a.career_valid_predictions === null || b.career_valid_predictions === null) {
    throw internalError("career snapshot 缺少排序字段");
  }
  return compareRankingEntry(board, {
    period_score: a.career_points, exact_hits: a.career_exact_hits,
    valid_predictions: a.career_valid_predictions,
    last_scoring_match_at: a.career_last_scoring_match_at, user_id: a.user_id,
  }, {
    period_score: b.career_points, exact_hits: b.career_exact_hits,
    valid_predictions: b.career_valid_predictions,
    last_scoring_match_at: b.career_last_scoring_match_at, user_id: b.user_id,
  });
}

function makeItem(board: RankingBoardType, rank: number, user: User, source: RankingSource): RankingListItem {
  const base = {
    rank,
    user_id: user.user_id,
    display_name: displayName(user),
    favorite_team_id: user.status === UserStatus.Deleted ? null : user.favorite_team_id,
    career_level: user.career_level,
  };
  if (board === RankingBoard.Week) {
    if (!("period_score" in source)) throw internalError("week ranking 类型非法");
    return {
      ...base, period_score: source.period_score, valid_predictions: source.valid_predictions,
      exact_hits: source.exact_hits, last_scoring_match_at: source.last_scoring_match_at?.toISOString() ?? null,
    };
  }
  if (board === RankingBoard.Career) {
    if (!("career_points" in source) || source.career_points === null || source.career_valid_predictions === null ||
      source.career_exact_hits === null) throw internalError("career snapshot 缺少展示字段");
    return {
      ...base, career_points: source.career_points,
      career_valid_predictions: source.career_valid_predictions, exact_hits: source.career_exact_hits,
      last_scoring_match_at: source.career_last_scoring_match_at?.toISOString() ?? null,
    };
  }
  if (!("window_score_sum" in source) || source.window_score_sum === null || source.window_n === null) {
    throw internalError("strength snapshot 缺少展示字段");
  }
  return {
    ...base, strength_index: formatSDisplay(source.window_score_sum, source.window_n),
    window_n: source.window_n,
  };
}

function topPercent(rank: number, count: number): number {
  const percent = Math.floor((100 * rank + count - 1) / count);
  const [min, max] = FIXED_CONFIG_V1.RANKING_TOP_PERCENT_CLAMP;
  return Math.min(max, Math.max(min, percent));
}

export class RankingQueryService {
  private readonly cursorCodec: RankingCursorCodec;

  constructor(
    private readonly repo: Pick<AppRepository, "users" | "rankings" | "boardSnapshots" | "groups" | "groupMembers">,
    cursorSecret: string,
  ) {
    this.cursorCodec = new RankingCursorCodec(cursorSecret);
  }

  async list(input: RankingQuery): Promise<RankingQueryResult> {
    validateQuery(input);
    const cursorPosition = input.cursor === null ? null : this.cursorCodec.decode(input.cursor);
    const periodKey = input.board === RankingBoard.Week
      ? input.period_key ?? cursorPosition?.period_key ?? calculatePeriodKey("week", input.server_now)
      : null;
    if (cursorPosition !== null && (
      cursorPosition.board !== input.board || cursorPosition.scope !== input.scope ||
      cursorPosition.group_id !== input.group_id || cursorPosition.period_key !== periodKey
    )) {
      throw validationError("cursor 与当前排行榜查询冲突", { field: "cursor" });
    }
    const offset = cursorPosition?.offset ?? 0;
    let groupMembers: Set<string> | null = null;
    if (input.scope === RankingScope.Group) {
      const groupRepo = requireGroups(this.repo);
      const memberRepo = requireGroupMembers(this.repo);
      const group = await groupRepo.findById(input.group_id!);
      if (group === null || group.status === GroupStatus.Dissolved) {
        throw groupError("GROUP_NOT_FOUND", "群不存在");
      }
      const requester = input.authenticated_user_id === undefined || input.authenticated_user_id === null
        ? null
        : await memberRepo.findByGroupAndUser(group.group_id, input.authenticated_user_id);
      if (requester?.status !== GroupMemberStatus.Active) {
        throw conflictError("FORBIDDEN", "仅群成员可查看群榜");
      }
      groupMembers = new Set((await memberRepo.findByGroup(group.group_id))
        .filter((member) => member.status === GroupMemberStatus.Active)
        .map((member) => member.user_id));
    }

    const userCache = new Map<string, User>();
    const readUser = async (userId: string): Promise<User> => {
      const cached = userCache.get(userId);
      if (cached !== undefined) return cached;
      const user = await this.repo.users.findById(userId);
      if (user === null) throw internalError(`ranking entry 缺少 user（user_id=${userId}）`);
      userCache.set(userId, user);
      return user;
    };

    let sourceEntries: RankingSource[];
    let updatedAt: string | null;
    if (input.board === RankingBoard.Week) {
      if (this.repo.rankings === undefined) throw internalError("rankings repository port 未配置");
      const rankings = await this.repo.rankings.findByPeriod("week", periodKey!);
      for (const entry of rankings) assertRanking(entry, periodKey!);
      const seenRanks = new Set<number>();
      for (const entry of rankings) {
        if (entry.global_rank === null) {
          continue;
        }
        if (seenRanks.has(entry.global_rank)) {
          throw internalError(`ranking global_rank 重复（period=${periodKey}）`);
        }
        seenRanks.add(entry.global_rank);
      }
      const updated = rankings.reduce<Date | null>((latest, entry) =>
        latest === null || entry.updated_at > latest ? entry.updated_at : latest, null);
      updatedAt = updated?.toISOString() ?? null;
      sourceEntries = rankings.filter((entry) => entry.global_rank !== null);
    } else {
      if (this.repo.boardSnapshots === undefined) throw internalError("board_snapshots repository port 未配置");
      const snapshotVersion = await this.repo.boardSnapshots.findLatestByBoard(input.board);
      const snapshotAt = snapshotVersion[0]?.snapshot_at ?? null;
      const snapshots = snapshotVersion.filter((snapshot) => snapshot.snapshot_kind !== "head");
      const seenRanks = new Set<number>();
      for (const snapshot of snapshotVersion) {
        if (snapshot.snapshot_at.getTime() !== snapshotAt?.getTime()) {
          throw internalError(`${input.board} snapshot 数据不一致`);
        }
      }
      for (const snapshot of snapshots) {
        if (!Number.isSafeInteger(snapshot.rank) || snapshot.rank < 1 || seenRanks.has(snapshot.rank)) {
          throw internalError(`${input.board} snapshot 数据不一致`);
        }
        seenRanks.add(snapshot.rank);
      }
      updatedAt = snapshotAt?.toISOString() ?? null;
      sourceEntries = snapshots;
    }

    const isHistoricalWeek = input.board === RankingBoard.Week &&
      periodEndAt("week", periodKey!).getTime() <= input.server_now.getTime();
    const withUsers: RankedEntry[] = [];
    for (const source of sourceEntries) {
      const user = await readUser(sourceUserId(source));
      if (user.status === UserStatus.Deleted && !isHistoricalWeek) continue;
      if (user.status !== UserStatus.Active && user.status !== UserStatus.Deleted) {
        throw internalError(`用户状态非法（user_id=${user.user_id}）`);
      }
      if (groupMembers !== null && !groupMembers.has(user.user_id)) continue;
      withUsers.push({ source, user });
    }
    withUsers.sort((a, b) => compareSources(input.board, a.source, b.source));

    const ranked = withUsers.map((entry, index) => {
      const keepHistoricalRank = isHistoricalWeek && input.scope === RankingScope.Global;
      return {
        ...entry,
        rank: keepHistoricalRank ? sourceRank(entry.source) : index + 1,
      };
    });

    let me: RankingMe | undefined;
    if (input.authenticated_user_id !== undefined && input.authenticated_user_id !== null) {
      const meUser = await readUser(input.authenticated_user_id);
      if (meUser.status !== UserStatus.Deleted) {
        const current = ranked.find((entry) => entry.user.user_id === input.authenticated_user_id);
        if (current !== undefined) {
          me = current.rank <= FIXED_CONFIG_V1.RANKING_ABSOLUTE_RANK_MAX
            ? { status: "ranked", rank: current.rank, top_percent: null }
            : { status: "ranked", rank: null, top_percent: topPercent(current.rank, ranked.length) };
        } else if (input.board === RankingBoard.Strength) {
          const windowN = meUser.career_level_state?.last_eval_n ?? 0;
          if (windowN < FIXED_CONFIG_V1.STRENGTH_BOARD_MIN_WINDOW_N) {
            me = {
              status: "below_threshold",
              remaining_valid_predictions: FIXED_CONFIG_V1.STRENGTH_BOARD_MIN_WINDOW_N - windowN,
            };
          } else {
            me = { status: "not_participated" };
          }
        } else {
          me = { status: "not_participated" };
        }
      }
    }

    const topLimit = FIXED_CONFIG_V1.RANKING_TOP_LIMIT;
    const pageSize = Math.min(FIXED_CONFIG_V1.RANKING_PAGE_SIZE, input.limit);
    const visible = ranked.slice(0, topLimit);
    const pageEntries = visible.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < visible.length;
    const last = pageEntries.at(-1);
    const nextCursor = hasMore && last !== undefined
      ? this.cursorCodec.encode({
          board: input.board,
          scope: input.scope,
          group_id: input.group_id,
          period_key: periodKey,
          offset: offset + pageEntries.length,
        })
      : null;
    return {
      board: input.board,
      scope: input.scope,
      period_key: periodKey,
      updated_at: updatedAt,
      items: pageEntries.map(({ source, user, rank }) => makeItem(input.board, rank, user, source)),
      has_more: hasMore,
      next_cursor: nextCursor,
      ...(me === undefined ? {} : { me }),
    };
  }
}
