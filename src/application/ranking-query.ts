import { createHmac, timingSafeEqual } from "node:crypto";
import { FIXED_CONFIG_V1, RANKING_FIRST_PERIOD_KEY } from "../domain/config.js";
import {
  GroupMemberStatus,
  GroupStatus,
  RankingBoard,
  RankingScope,
  UserStatus,
  type RankingBoard as RankingBoardType,
  type RankingScope as RankingScopeType,
} from "../domain/enums.js";
import { conflictError, groupError, internalError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { formatSDisplay } from "../domain/levels.js";
import {
  compareRankingEntry,
  countSeasonsParticipated,
  isSeasonBoardVisible,
  isSeasonRankEligible,
} from "../domain/ranking.js";
import {
  calculatePeriodKey,
  isValidPeriodKey,
  levelSeasonOf,
  periodEndAt,
  toShanghaiParts,
} from "../domain/time.js";
import type {
  BoardSnapshot,
  Group,
  RankingEntry,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";

export interface RankingQuery {
  board: RankingBoardType;
  period_key: string | null;
  scope: RankingScopeType;
  group_id: string | null;
  level_season_id?: string | null;
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
      season_points: number;
      season_valid_predictions: number;
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
  | { status: "below_threshold"; remaining_valid_predictions: number }
  | { status: "not_eligible"; seasons_participated: number };

export interface RankingQueryResult {
  board: RankingBoardType;
  scope: RankingScopeType;
  period_key: string | null;
  updated_at: string | null;
  current_period_key?: string;
  available_boards: RankingBoardType[];
  seasons_participated: number;
  entry_count: number;
  level_season_id?: string;
  is_provisional?: boolean;
  available_level_seasons?: string[];
  items: RankingListItem[];
  has_more: boolean;
  next_cursor: string | null;
  me?: RankingMe;
}

export interface AvailableBoardsInput {
  scope: RankingScopeType;
  seasons_participated: number;
  strength_window_n: number;
  career_entry_count: number;
  current_season_entry_count: number;
  previous_season_entry_count: number;
  selected_season_entry_count?: number;
}

export function computeAvailableBoards(input: AvailableBoardsInput): RankingBoardType[] {
  const boards: RankingBoardType[] = [RankingBoard.Week];
  if (input.career_entry_count > 0) {
    boards.push(RankingBoard.Career);
  }
  if (input.strength_window_n >= FIXED_CONFIG_V1.STRENGTH_BOARD_MIN_WINDOW_N) {
    boards.push(RankingBoard.Strength);
  }
  if (
    isSeasonBoardVisible(input.seasons_participated) &&
    (input.current_season_entry_count > 0 ||
      (input.scope === RankingScope.Global &&
        (input.previous_season_entry_count > 0 || (input.selected_season_entry_count ?? 0) > 0)))
  ) {
    boards.push(RankingBoard.Season);
  }
  return boards;
}

interface RankingCursorPayload {
  version: 1;
  board: RankingBoardType;
  scope: RankingScopeType;
  group_id: string | null;
  period_key: string | null;
  level_season_id: string | null;
  offset: number;
}

type RankingSource = RankingEntry | BoardSnapshot;

interface RankedEntry {
  source: RankingSource;
  user: User;
}

const CURSOR_VERSION = 1 as const;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function shiftWeek(periodKey: string, weeks: number): string {
  const endAt = periodEndAt("week", periodKey);
  return calculatePeriodKey("week", new Date(endAt.getTime() - 1 + weeks * WEEK_MS));
}

function selectableWeekKeys(currentPeriodKey: string, firstPeriodKey: string): string[] {
  const keys: string[] = [];
  for (let offset = 0; offset < FIXED_CONFIG_V1.RANKING_WEEK_WINDOW; offset += 1) {
    const key = shiftWeek(currentPeriodKey, -offset);
    if (key < firstPeriodKey) break;
    keys.push(key);
  }
  return keys;
}

function defaultWeekKey(serverNow: Date, currentPeriodKey: string, selectable: readonly string[]): string {
  const candidate = toShanghaiParts(serverNow).weekday === 0
    ? shiftWeek(currentPeriodKey, -1)
    : currentPeriodKey;
  return selectable.includes(candidate) ? candidate : currentPeriodKey;
}

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
    (input.board === RankingBoard.Season
      ? input.level_season_id != null && !isValidLevelSeasonId(input.level_season_id)
      : input.level_season_id != null) ||
    (input.scope === RankingScope.Group
      ? input.group_id === null || !isValidUuid(input.group_id)
      : input.group_id !== null) ||
    (input.scope === RankingScope.Group && input.level_season_id != null &&
      input.level_season_id !== levelSeasonOf(input.server_now)) ||
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
    (payload.level_season_id !== null && typeof payload.level_season_id !== "string") ||
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
  if (
    payload.board === RankingBoard.Season
      ? payload.level_season_id !== null &&
        (typeof payload.level_season_id !== "string" || !isValidLevelSeasonId(payload.level_season_id))
      : payload.level_season_id !== null
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
      level_season_id: parsed.level_season_id,
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
  if (board === RankingBoard.Season) {
    if (
      !("season_points" in a) || !("season_points" in b) ||
      a.season_points === null || b.season_points === null ||
      a.season_exact_hits === null || b.season_exact_hits === null ||
      a.season_valid_predictions === null || b.season_valid_predictions === null
    ) {
      throw internalError("season snapshot 缺少排序字段");
    }
    return compareRankingEntry(board, {
      period_score: a.season_points,
      exact_hits: a.season_exact_hits,
      valid_predictions: a.season_valid_predictions,
      last_scoring_match_at: a.season_last_scoring_match_at,
      user_id: a.user_id,
    }, {
      period_score: b.season_points,
      exact_hits: b.season_exact_hits,
      valid_predictions: b.season_valid_predictions,
      last_scoring_match_at: b.season_last_scoring_match_at,
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
  if (board === RankingBoard.Season) {
    if (
      !("season_points" in source) || source.season_points === null ||
      source.season_valid_predictions === null || source.season_exact_hits === null
    ) {
      throw internalError("season snapshot 缺少展示字段");
    }
    return {
      ...base,
      season_points: source.season_points,
      season_valid_predictions: source.season_valid_predictions,
      exact_hits: source.season_exact_hits,
      last_scoring_match_at: source.season_last_scoring_match_at?.toISOString() ?? null,
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

function previousLevelSeasonId(levelSeasonId: string): string {
  const startYear = Number(levelSeasonId.slice(0, 4));
  return `${startYear - 1}_${startYear}`;
}

function isValidLevelSeasonId(value: string): boolean {
  const match = /^(\d{4})_(\d{4})$/.exec(value);
  return match !== null && Number(match[2]) === Number(match[1]) + 1;
}

export class RankingQueryService {
  private readonly cursorCodec: RankingCursorCodec;
  private readonly firstPeriodKey: string;

  constructor(
    private readonly repo: Pick<
      AppRepository,
      "users" | "rankings" | "boardSnapshots" | "userSeasonStats" | "groups" | "groupMembers"
    >,
    cursorSecret: string,
    options: { firstPeriodKey?: string } = {},
  ) {
    this.cursorCodec = new RankingCursorCodec(cursorSecret);
    this.firstPeriodKey = options.firstPeriodKey ?? RANKING_FIRST_PERIOD_KEY;
  }

  async list(input: RankingQuery): Promise<RankingQueryResult> {
    validateQuery(input);
    const cursorPosition = input.cursor === null ? null : this.cursorCodec.decode(input.cursor);
    const currentPeriodKey = calculatePeriodKey("week", input.server_now);
    const selectableWeeks = selectableWeekKeys(currentPeriodKey, this.firstPeriodKey);
    let periodKey = input.board === RankingBoard.Week
      ? input.period_key ?? cursorPosition?.period_key ?? defaultWeekKey(
          input.server_now,
          currentPeriodKey,
          selectableWeeks,
        )
      : null;
    if (input.board === RankingBoard.Week && !selectableWeeks.includes(periodKey!)) {
      throw validationError("period_key 超出可选周范围", { field: "period_key" });
    }
    if (cursorPosition !== null && (
      cursorPosition.board !== input.board || cursorPosition.scope !== input.scope ||
      cursorPosition.group_id !== input.group_id || cursorPosition.period_key !== periodKey ||
      (input.level_season_id != null && cursorPosition.level_season_id !== input.level_season_id)
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

    let resolvedDefaultWeekRows: RankingEntry[] | null = null;
    if (
      input.board === RankingBoard.Week &&
      input.period_key === null &&
      cursorPosition === null
    ) {
      if (this.repo.rankings === undefined) throw internalError("rankings repository port 未配置");
      const candidateKey = periodKey!;
      const candidateIndex = selectableWeeks.indexOf(candidateKey);
      for (const weekKey of selectableWeeks.slice(candidateIndex)) {
        const rows = await this.repo.rankings.findByPeriod("week", weekKey);
        for (const entry of rows) assertRanking(entry, weekKey);
        let visibleCount = 0;
        const historical = periodEndAt("week", weekKey).getTime() <= input.server_now.getTime();
        for (const entry of rows) {
          if (entry.global_rank === null || (groupMembers !== null && !groupMembers.has(entry.user_id))) {
            continue;
          }
          const user = await readUser(entry.user_id);
          if (user.status === UserStatus.Deleted && !historical) continue;
          if (user.status !== UserStatus.Active && user.status !== UserStatus.Deleted) {
            throw internalError(`用户状态非法（user_id=${user.user_id}）`);
          }
          visibleCount += 1;
        }
        if (visibleCount > 0) {
          periodKey = weekKey;
          resolvedDefaultWeekRows = rows;
          break;
        }
      }
      if (resolvedDefaultWeekRows === null) {
        resolvedDefaultWeekRows = await this.repo.rankings.findByPeriod("week", candidateKey);
        for (const entry of resolvedDefaultWeekRows) assertRanking(entry, candidateKey);
      }
    }

    if (this.repo.boardSnapshots === undefined) {
      throw internalError("board_snapshots repository port 未配置");
    }
    const currentLevelSeasonId = levelSeasonOf(input.server_now);
    const previousSeasonId = previousLevelSeasonId(currentLevelSeasonId);
    const [careerVersion, strengthVersion, currentSeasonVersion, previousSeasonRegularVersion,
      previousSeasonFinalVersion, finalSeasonIds] = await Promise.all([
        this.repo.boardSnapshots.findLatestByBoard(RankingBoard.Career),
        this.repo.boardSnapshots.findLatestByBoard(RankingBoard.Strength),
        this.repo.boardSnapshots.findLatestBySeason(currentLevelSeasonId),
        this.repo.boardSnapshots.findLatestBySeason(previousSeasonId),
        this.repo.boardSnapshots.findFinalBySeason(previousSeasonId),
        this.repo.boardSnapshots.listFinalSeasonIds(),
      ]);

    const filterSnapshotEntries = async (
      version: readonly BoardSnapshot[],
      members: Set<string> | null,
      keepDeleted = false,
    ): Promise<RankedEntry[]> => {
      const filtered: RankedEntry[] = [];
      for (const snapshot of version) {
        if (snapshot.snapshot_kind === "head") continue;
        const user = await readUser(snapshot.user_id);
        if (user.status === UserStatus.Deleted && !keepDeleted) continue;
        if (user.status !== UserStatus.Active && user.status !== UserStatus.Deleted) {
          throw internalError(`用户状态非法（user_id=${user.user_id}）`);
        }
        if (members !== null && !members.has(user.user_id)) continue;
        filtered.push({ source: snapshot, user });
      }
      return filtered;
    };

    const previousSeasonVersion = previousSeasonFinalVersion.length > 0
      ? previousSeasonFinalVersion
      : previousSeasonRegularVersion;
    const [currentSeasonGlobalEntries, careerEntries, currentSeasonEntries, previousSeasonEntries] =
      await Promise.all([
        filterSnapshotEntries(currentSeasonVersion, null),
        filterSnapshotEntries(careerVersion, groupMembers),
        filterSnapshotEntries(currentSeasonVersion, groupMembers),
        filterSnapshotEntries(previousSeasonVersion, null, true),
      ]);
    const requestedSeasonId = input.level_season_id ?? cursorPosition?.level_season_id ?? null;
    let selectedSeasonVersion: readonly BoardSnapshot[] = currentSeasonVersion;
    let selectedSeasonId = requestedSeasonId ?? currentLevelSeasonId;
    let isProvisional = false;
    if (
      input.board === RankingBoard.Season &&
      requestedSeasonId === null &&
      input.scope === RankingScope.Global &&
      currentSeasonGlobalEntries.length === 0 &&
      previousSeasonEntries.length > 0
    ) {
      selectedSeasonVersion = previousSeasonVersion;
      selectedSeasonId = previousSeasonId;
      isProvisional = previousSeasonFinalVersion.length === 0;
    } else if (input.board === RankingBoard.Season && selectedSeasonId !== currentLevelSeasonId) {
      if (selectedSeasonId === previousSeasonId && previousSeasonFinalVersion.length > 0) {
        selectedSeasonVersion = previousSeasonFinalVersion;
      } else {
        const finalVersion = await this.repo.boardSnapshots.findFinalBySeason(selectedSeasonId);
        if (finalVersion.length > 0) {
          selectedSeasonVersion = finalVersion;
        } else if (selectedSeasonId === previousSeasonId) {
          selectedSeasonVersion = await this.repo.boardSnapshots.findLatestBySeason(selectedSeasonId);
          isProvisional = selectedSeasonVersion.some((snapshot) => snapshot.snapshot_kind !== "head");
        } else {
          selectedSeasonVersion = [];
        }
      }
      if (!selectedSeasonVersion.some((snapshot) => snapshot.snapshot_kind !== "head")) {
        throw notFoundError("LEVEL_SEASON");
      }
    } else if (
      input.board === RankingBoard.Season &&
      requestedSeasonId !== null &&
      selectedSeasonVersion.every((snapshot) => snapshot.snapshot_kind === "head")
    ) {
      throw notFoundError("LEVEL_SEASON");
    }
    const selectedSeasonEntries = input.board === RankingBoard.Season
      ? await filterSnapshotEntries(
          selectedSeasonVersion,
          groupMembers,
          selectedSeasonId !== currentLevelSeasonId,
        )
      : [];

    let sourceEntries: RankingSource[];
    let updatedAt: string | null;
    if (input.board === RankingBoard.Week) {
      if (this.repo.rankings === undefined) throw internalError("rankings repository port 未配置");
      const rankings = resolvedDefaultWeekRows ?? await this.repo.rankings.findByPeriod("week", periodKey!);
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
      const snapshotVersion = input.board === RankingBoard.Career
        ? careerVersion
        : input.board === RankingBoard.Strength
          ? strengthVersion
          : selectedSeasonVersion;
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

    let meUser: User | null = null;
    let seasonsParticipated = 0;
    let userParticipatedInSelectedSeason = false;
    if (input.authenticated_user_id !== undefined && input.authenticated_user_id !== null) {
      meUser = await readUser(input.authenticated_user_id);
      if (this.repo.userSeasonStats === undefined) {
        throw internalError("user_season_stats repository port 未配置");
      }
      const seasonStats: UserSeasonStats[] = await this.repo.userSeasonStats.findByUser(
        input.authenticated_user_id,
      );
      seasonsParticipated = countSeasonsParticipated(seasonStats);
      userParticipatedInSelectedSeason = seasonStats.some(
        (stats) => stats.level_season_id === selectedSeasonId && isSeasonRankEligible(stats.valid_predictions),
      );
    }
    const isHistoricalWeek = input.board === RankingBoard.Week &&
      periodEndAt("week", periodKey!).getTime() <= input.server_now.getTime();
    const isHistoricalSeason = input.board === RankingBoard.Season &&
      selectedSeasonId !== currentLevelSeasonId;
    const withUsers: RankedEntry[] = [];
    for (const source of sourceEntries) {
      const user = await readUser(sourceUserId(source));
      if (user.status === UserStatus.Deleted && !isHistoricalWeek && !isHistoricalSeason) continue;
      if (user.status !== UserStatus.Active && user.status !== UserStatus.Deleted) {
        throw internalError(`用户状态非法（user_id=${user.user_id}）`);
      }
      if (groupMembers !== null && !groupMembers.has(user.user_id)) continue;
      withUsers.push({ source, user });
    }
    withUsers.sort((a, b) => compareSources(input.board, a.source, b.source));

    const ranked = withUsers.map((entry, index) => {
      const keepHistoricalRank =
        (isHistoricalWeek || isHistoricalSeason) && input.scope === RankingScope.Global;
      return {
        ...entry,
        rank: keepHistoricalRank ? sourceRank(entry.source) : index + 1,
      };
    });

    let me: RankingMe | undefined;
    if (meUser !== null && meUser.status !== UserStatus.Deleted) {
      if (input.board === RankingBoard.Season && !isSeasonBoardVisible(seasonsParticipated)) {
        me = { status: "not_eligible", seasons_participated: seasonsParticipated };
      } else if (input.board === RankingBoard.Season && !userParticipatedInSelectedSeason) {
        me = { status: "not_participated" };
      } else {
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

    const strengthWindowN = meUser?.career_level_state?.last_eval_n ?? 0;
    const availableBoards = computeAvailableBoards({
      scope: input.scope,
      seasons_participated: seasonsParticipated,
      strength_window_n: strengthWindowN,
      career_entry_count: careerEntries.length,
      current_season_entry_count: currentSeasonEntries.length,
      previous_season_entry_count: previousSeasonEntries.length,
      selected_season_entry_count: selectedSeasonEntries.length,
    });
    const historicalFinalSeasons = await Promise.all(finalSeasonIds
      .filter((seasonId) => seasonId !== currentLevelSeasonId && seasonId !== previousSeasonId)
      .map(async (seasonId) => {
        const snapshots = await this.repo.boardSnapshots!.findFinalBySeason(seasonId);
        return snapshots.some((snapshot) => snapshot.snapshot_kind !== "head") ? seasonId : null;
      }));
    const availableLevelSeasons = [
      ...(currentSeasonGlobalEntries.length > 0 ? [currentLevelSeasonId] : []),
      ...(previousSeasonEntries.length > 0 ? [previousSeasonId] : []),
      ...historicalFinalSeasons.filter((seasonId) => seasonId !== null),
    ].sort((a, b) => b.localeCompare(a));

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
          level_season_id: input.board === RankingBoard.Season ? selectedSeasonId : null,
          offset: offset + pageEntries.length,
        })
      : null;
    return {
      board: input.board,
      scope: input.scope,
      period_key: periodKey,
      updated_at: updatedAt,
      ...(input.board === RankingBoard.Week
        ? { current_period_key: calculatePeriodKey("week", input.server_now) }
        : {}),
      available_boards: availableBoards,
      seasons_participated: seasonsParticipated,
      entry_count: ranked.length,
      ...(input.board === RankingBoard.Season
        ? {
            level_season_id: selectedSeasonId,
            available_level_seasons: availableLevelSeasons,
            is_provisional: isProvisional,
          }
        : {}),
      items: pageEntries.map(({ source, user, rank }) => makeItem(input.board, rank, user, source)),
      has_more: hasMore,
      next_cursor: nextCursor,
      ...(me === undefined ? {} : { me }),
    };
  }
}
