import { activeSeasonIds, FIXED_CONFIG_V1, seasonBounds, SUPPORTED_LEAGUES } from "../domain/config.js";
import {
  LevelScope,
  PeriodType,
  RankingBoard,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementStatus,
} from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import {
  buildLevelInputs,
  replayLevel,
  type LevelPredictionFact,
} from "../domain/levels.js";
import { isDeletedForPeriod } from "../domain/ranking.js";
import {
  calculatePeriodKey,
  levelProtectionEndAsOf,
  levelSeasonOf,
  periodEndAt,
} from "../domain/time.js";
import type {
  LevelHistoryEntry,
  LevelState,
  BoardSnapshot,
  Match,
  RankingEntry,
  SettlementDoc,
  SettlementItem,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import { defaultLevelState } from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import {
  activeSettlement,
  buildReplayFacts,
  invalidLedger,
  loadAppliedSettlementFacts,
  type AppliedSettlementFact,
} from "./rebuild-service-support.js";
import {
  rebuildPeriodRankings,
  type PeriodRef,
  type RebuiltRankingEntry,
} from "./ranking-rebuild.js";
import { rebuildStatsFromLedger } from "./stats-rebuild.js";
import type {
  CareerCacheValues,
  BoardSnapshotCacheValues,
  DailyConsistencyInput,
  RankingCacheValues,
  SeasonStatsCacheValues,
} from "./daily-consistency.js";
import { buildBoardSnapshotEntries } from "./board-snapshot.js";

type DailyConsistencyUnitOfWork = UnitOfWork & {
  userSeasonStats: NonNullable<UnitOfWork["userSeasonStats"]>;
  rankings: NonNullable<UnitOfWork["rankings"]>;
  levelHistory: NonNullable<UnitOfWork["levelHistory"]>;
  boardSnapshots: NonNullable<UnitOfWork["boardSnapshots"]>;
};

function requirePorts(tx: UnitOfWork): asserts tx is DailyConsistencyUnitOfWork {
  if (
    tx.userSeasonStats === undefined ||
    tx.rankings === undefined ||
    tx.levelHistory === undefined ||
    tx.boardSnapshots === undefined
  ) {
    throw internalError("daily consistency 缺少聚合、快照或 level_history repository ports");
  }
}

const CONSISTENCY_SETTLEMENT_BATCH_SIZE = 100;
const CONSISTENCY_FACT_BATCH_SIZE = 200;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function chunkSettlementItemsByPrediction(
  items: readonly SettlementItem[],
  size: number,
): SettlementItem[][] {
  const byPrediction = new Map<string, SettlementItem[]>();
  for (const item of items) {
    const group = byPrediction.get(item.prediction_id) ?? [];
    group.push(item);
    byPrediction.set(item.prediction_id, group);
  }
  const batches: SettlementItem[][] = [];
  let current: SettlementItem[] = [];
  for (const group of byPrediction.values()) {
    if (current.length > 0 && current.length + group.length > size) {
      batches.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function historyBestLevel(
  history: readonly LevelHistoryEntry[],
  scope: LevelScope,
  seasonId: string | null,
): number {
  let best = 1;
  for (const entry of history) {
    if (entry.scope !== scope || entry.level_season_id !== seasonId) {
      continue;
    }
    if (!Number.isInteger(entry.to_level) || entry.to_level < 1 || entry.to_level > 6) {
      throw invalidLedger(`level_history 的 to_level 非法（level_history_id=${entry.level_history_id}）`);
    }
    best = Math.max(best, entry.to_level);
  }
  return best;
}

function careerValues(user: User): CareerCacheValues {
  const state = user.career_level_state ?? defaultLevelState();
  return {
    career_points: user.career_points,
    career_valid_predictions: user.career_valid_predictions,
    career_wdl_hits: user.career_wdl_hits,
    career_exact_hits: user.career_exact_hits,
    career_level: user.career_level,
    career_best_level: user.career_best_level,
    career_last_scoring_match_at: user.career_last_scoring_match_at ?? null,
    career_below_count: state.below_count,
    career_last_eval_as_of: state.last_eval_as_of,
    career_last_eval_n: state.last_eval_n,
    career_last_eval_score_sum: state.last_eval_score_sum,
    career_last_eval_b_points: state.last_eval_b_points,
    career_last_eval_rule_version: state.last_eval_rule_version,
  };
}

function zeroSeasonValues(): SeasonStatsCacheValues {
  return {
    points: 0,
    valid_predictions: 0,
    wdl_hits: 0,
    exact_hits: 0,
    last_scoring_match_at: null,
    level: 1,
    best_level: 1,
    below_count: 0,
    last_eval_as_of: null,
    last_eval_n: 0,
    last_eval_score_sum: 0,
    last_eval_b_points: 0,
    last_eval_rule_version: null,
  };
}

function seasonValues(stats: UserSeasonStats | undefined): SeasonStatsCacheValues {
  if (stats === undefined) {
    return zeroSeasonValues();
  }
  const state = stats.level_state ?? defaultLevelState();
  return {
    points: stats.points,
    valid_predictions: stats.valid_predictions,
    wdl_hits: stats.wdl_hits,
    exact_hits: stats.exact_hits,
    last_scoring_match_at: stats.last_scoring_match_at ?? null,
    level: stats.level,
    best_level: stats.best_level,
    below_count: state.below_count,
    last_eval_as_of: state.last_eval_as_of,
    last_eval_n: state.last_eval_n,
    last_eval_score_sum: state.last_eval_score_sum,
    last_eval_b_points: state.last_eval_b_points,
    last_eval_rule_version: state.last_eval_rule_version,
  };
}

function rankingValues(entry: RankingEntry | undefined): RankingCacheValues {
  if (entry === undefined) {
    return {
      period_score: 0,
      valid_predictions: 0,
      wdl_hits: 0,
      exact_hits: 0,
      last_scoring_match_at: null,
      global_rank: null,
    };
  }
  return {
    period_score: entry.period_score,
    valid_predictions: entry.valid_predictions,
    wdl_hits: entry.wdl_hits,
    exact_hits: entry.exact_hits,
    last_scoring_match_at: entry.last_scoring_match_at,
    global_rank: entry.global_rank,
  };
}

function rebuiltRankingValues(entry: RebuiltRankingEntry): RankingCacheValues {
  return {
    period_score: entry.period_score,
    valid_predictions: entry.valid_predictions,
    wdl_hits: entry.wdl_hits,
    exact_hits: entry.exact_hits,
    last_scoring_match_at: entry.last_scoring_match_at,
    global_rank: entry.global_rank,
  };
}

function boardSnapshotValues(
  snapshot: BoardSnapshot | undefined,
): BoardSnapshotCacheValues {
  return {
    rank: snapshot?.rank ?? null,
    career_points: snapshot?.career_points ?? null,
    career_exact_hits: snapshot?.career_exact_hits ?? null,
    career_valid_predictions: snapshot?.career_valid_predictions ?? null,
    career_last_scoring_match_at: snapshot?.career_last_scoring_match_at ?? null,
    window_score_sum: snapshot?.window_score_sum ?? null,
    window_n: snapshot?.window_n ?? null,
    season_points: snapshot?.season_points ?? null,
    season_exact_hits: snapshot?.season_exact_hits ?? null,
    season_valid_predictions: snapshot?.season_valid_predictions ?? null,
    season_last_scoring_match_at: snapshot?.season_last_scoring_match_at ?? null,
  };
}

async function loadBoardSnapshotConsistency(
  tx: DailyConsistencyUnitOfWork,
  users: readonly User[],
  activeSettlements: DailyConsistencyInput["active_settlements"],
): Promise<DailyConsistencyInput["board_snapshots"]> {
  const activeUserIds = new Set(activeSettlements.flatMap((scope) => scope.user_ids));
  const entries: DailyConsistencyInput["board_snapshots"] = [];
  for (const board of [RankingBoard.Career, RankingBoard.Strength, RankingBoard.Season] as const) {
    const snapshotVersion = await tx.boardSnapshots.findLatestByBoard(board);
    if (snapshotVersion.length === 0) {
      continue;
    }
    const snapshotAt = snapshotVersion[0]!.snapshot_at;
    const actualSnapshots = snapshotVersion.filter((snapshot) => snapshot.snapshot_kind !== "head");
    const levelSeasonId = board === RankingBoard.Season
      ? snapshotVersion[0]!.level_season_id
      : null;
    if (board === RankingBoard.Season && levelSeasonId === null) {
      throw internalError("season board snapshot 缺少 level_season_id");
    }
    const seasonStats = board === RankingBoard.Season
      ? await tx.userSeasonStats.findByLevelSeason(levelSeasonId as string)
      : undefined;
    const expectedSnapshots = buildBoardSnapshotEntries({
      users,
      board,
      snapshotAt,
      ...(seasonStats === undefined ? {} : { seasonStats }),
      ...(levelSeasonId === null ? {} : { levelSeasonId }),
    });
    const expectedByUser = new Map(expectedSnapshots.map((snapshot) => [snapshot.user_id, snapshot]));
    const actualByUser = new Map(actualSnapshots.map((snapshot) => [snapshot.user_id, snapshot]));
    const hasChangedUsers = users.some((user) => user.updated_at.getTime() > snapshotAt.getTime());
    const changedSeasonStatsByUser = new Set(
      (seasonStats ?? [])
        .filter((stats) => stats.updated_at.getTime() > snapshotAt.getTime())
        .map((stats) => stats.user_id),
    );
    const rankCheckSkipped =
      hasChangedUsers || changedSeasonStatsByUser.size > 0 || activeUserIds.size > 0;

    if (rankCheckSkipped) {
      for (const user of users) {
        if (
          user.updated_at.getTime() > snapshotAt.getTime() ||
          changedSeasonStatsByUser.has(user.user_id) ||
          activeUserIds.has(user.user_id)
        ) {
          continue;
        }
        const actual = actualByUser.get(user.user_id);
        const expected = expectedByUser.get(user.user_id);
        if (actual === undefined || expected === undefined) {
          continue;
        }
        entries.push({
          board,
          snapshot_at: snapshotAt,
          user_id: user.user_id,
          rank_check_skipped: true,
          actual: boardSnapshotValues(actual),
          expected: boardSnapshotValues(expected),
        });
      }
      continue;
    }

    const userIds = new Set([...actualByUser.keys(), ...expectedByUser.keys()]);

    for (const userId of [...userIds].sort()) {
      const actual = actualByUser.get(userId);
      const expected = expectedByUser.get(userId);
      entries.push({
        board,
        snapshot_at: snapshotAt,
        user_id: userId,
        rank_check_skipped: false,
        actual: boardSnapshotValues(actual),
        expected: boardSnapshotValues(expected),
      });
    }
  }
  return entries;
}

function levelSeasonByPrediction(
  facts: readonly AppliedSettlementFact[],
): Map<string, string> {
  const seasons = new Map<string, string>();
  for (const fact of facts) {
    if (fact.match.period_anchor_at === null) {
      throw invalidLedger(`applied match 缺少 period_anchor_at（match_id=${fact.match.match_id}）`);
    }
    seasons.set(fact.item.prediction_id, levelSeasonOf(fact.match.period_anchor_at));
  }
  return seasons;
}

function periodAnchorByPrediction(
  facts: readonly AppliedSettlementFact[],
): Map<string, Date> {
  const anchors = new Map<string, Date>();
  for (const fact of facts) {
    if (fact.match.period_anchor_at === null) {
      throw invalidLedger(`applied match 缺少 period_anchor_at（match_id=${fact.match.match_id}）`);
    }
    anchors.set(fact.item.prediction_id, fact.match.period_anchor_at);
  }
  return anchors;
}

function expectedCareerLastScoringAt(facts: readonly AppliedSettlementFact[]): Date | null {
  const byPrediction = new Map<string, {
    valid: boolean;
    score: number;
    version: number;
    periodAnchorAt: Date;
  }>();
  for (const fact of facts) {
    if (fact.match.period_anchor_at === null) {
      throw invalidLedger(`applied match 缺少 period_anchor_at（match_id=${fact.match.match_id}）`);
    }
    const current = byPrediction.get(fact.item.prediction_id) ?? {
      valid: false,
      score: 0,
      version: 0,
      periodAnchorAt: fact.match.period_anchor_at,
    };
    current.valid ||= fact.item.valid_prediction_delta === 1;
    if (fact.item.source_result_version > current.version) {
      current.score = fact.item.new_score;
      current.version = fact.item.source_result_version;
    }
    byPrediction.set(fact.item.prediction_id, current);
  }

  let latest: Date | null = null;
  for (const fact of byPrediction.values()) {
    if (fact.valid && fact.score > 0 && (latest === null || fact.periodAnchorAt > latest)) {
      latest = fact.periodAnchorAt;
    }
  }
  return latest;
}

function expectedLevelValues(params: {
  level: number;
  bestLevel: number;
  state: LevelState | undefined;
  facts: readonly LevelPredictionFact[];
  correctionSettledAts: readonly Date[];
  scope: LevelScope;
  levelSeasonId: string | null;
  history: readonly LevelHistoryEntry[];
  firstEvalAsOf: Date | null;
}): {
  level: number;
  best_level: number;
  below_count: number;
  last_eval_as_of: Date | null;
  last_eval_n: number;
  last_eval_score_sum: number;
  last_eval_b_points: number;
  last_eval_rule_version: string | null;
} {
  const firstEvalAsOf = params.firstEvalAsOf;
  const state = params.state ?? defaultLevelState();
  const replay = replayLevel({
    scope: params.scope,
    facts: params.facts,
    correctionSettledAts: params.correctionSettledAts,
    firstEvalAsOf,
    untilAsOf: state.last_eval_as_of ?? new Date(0),
    protectionEndAsOf: firstEvalAsOf === null ? null : levelProtectionEndAsOf(firstEvalAsOf),
    ruleVersion: FIXED_CONFIG_V1.LEVEL_RULE_VERSION,
    ...(params.levelSeasonId === null ? {} : { levelSeasonId: params.levelSeasonId }),
  });
  const level = replay.level;
  const belowCount = replay.below_count;
  const lastEvalAsOf = replay.last_eval_as_of;
  const lastEvalN = replay.last_inputs?.n ?? 0;
  const lastEvalScoreSum = replay.last_inputs?.S ?? 0;
  const lastEvalBPoints = replay.last_inputs?.b_points ?? 0;
  const lastEvalRuleVersion = lastEvalAsOf === null ? null : FIXED_CONFIG_V1.LEVEL_RULE_VERSION;

  const maximumHistoryLevel = historyBestLevel(
    params.history,
    params.scope,
    params.levelSeasonId,
  );
  return {
    level,
    best_level: Math.max(level, maximumHistoryLevel),
    below_count: belowCount,
    last_eval_as_of: lastEvalAsOf,
    last_eval_n: lastEvalN,
    last_eval_score_sum: lastEvalScoreSum,
    last_eval_b_points: lastEvalBPoints,
    last_eval_rule_version: lastEvalRuleVersion,
  };
}

function expectedCareerValues(
  facts: readonly AppliedSettlementFact[],
  history: readonly LevelHistoryEntry[],
  existingBestLevel: number,
  existingLevel: number,
  existingState: LevelState | undefined,
  firstEvalAsOf: Date | null,
): CareerCacheValues {
  const rebuilt = rebuildStatsFromLedger(
    facts.map((fact) => fact.item),
    levelSeasonByPrediction(facts),
    periodAnchorByPrediction(facts),
  );
  const levelValues = expectedLevelValues({
    level: existingLevel,
    bestLevel: existingBestLevel,
    state: existingState,
    facts: buildReplayFacts(facts).facts,
    correctionSettledAts: buildReplayFacts(facts).correctionSettledAts,
    scope: LevelScope.Career,
    levelSeasonId: null,
    history,
    firstEvalAsOf,
  });
  return {
    career_points: rebuilt.career.career_points,
    career_valid_predictions: rebuilt.career.career_valid_predictions,
    career_wdl_hits: rebuilt.career.career_wdl_hits,
    career_exact_hits: rebuilt.career.career_exact_hits,
    career_last_scoring_match_at: expectedCareerLastScoringAt(facts),
    career_level: levelValues.level,
    career_best_level: levelValues.best_level,
    career_below_count: levelValues.below_count,
    career_last_eval_as_of: levelValues.last_eval_as_of,
    career_last_eval_n: levelValues.last_eval_n,
    career_last_eval_score_sum: levelValues.last_eval_score_sum,
    career_last_eval_b_points: levelValues.last_eval_b_points,
    career_last_eval_rule_version: levelValues.last_eval_rule_version,
  };
}

function expectedSeasonValues(
  seasonId: string,
  facts: readonly AppliedSettlementFact[],
  history: readonly LevelHistoryEntry[],
  existingBestLevel: number,
  existingLevel: number,
  existingState: LevelState | undefined,
  firstEvalAsOf: Date | null,
): SeasonStatsCacheValues {
  const rebuilt = rebuildStatsFromLedger(
    facts.map((fact) => fact.item),
    levelSeasonByPrediction(facts),
    periodAnchorByPrediction(facts),
  );
  const stats = rebuilt.seasons.find((item) => item.level_season_id === seasonId);
  const base = stats ?? {
    points: 0,
    valid_predictions: 0,
    wdl_hits: 0,
    exact_hits: 0,
    last_scoring_match_at: null,
  };
  const levelValues = expectedLevelValues({
    level: existingLevel,
    bestLevel: existingBestLevel,
    state: existingState,
    facts: buildReplayFacts(facts).facts,
    correctionSettledAts: buildReplayFacts(facts).correctionSettledAts,
    scope: LevelScope.Season,
    levelSeasonId: seasonId,
    history,
    firstEvalAsOf,
  });
  return {
    points: base.points,
    valid_predictions: base.valid_predictions,
    wdl_hits: base.wdl_hits,
    exact_hits: base.exact_hits,
    last_scoring_match_at: base.last_scoring_match_at,
    level: levelValues.level,
    best_level: levelValues.best_level,
    below_count: levelValues.below_count,
    last_eval_as_of: levelValues.last_eval_as_of,
    last_eval_n: levelValues.last_eval_n,
    last_eval_score_sum: levelValues.last_eval_score_sum,
    last_eval_b_points: levelValues.last_eval_b_points,
    last_eval_rule_version: levelValues.last_eval_rule_version,
  };
}

function rankingIdentity(
  periodType: RankingEntry["period_type"],
  periodKey: string,
  userId: string,
): string {
  return `${periodType}\u0000${periodKey}\u0000${userId}`;
}

interface PeriodGroup {
  period_type: typeof PeriodType.Week;
  period_key: string;
  items: AppliedSettlementFact["item"][];
  periodByPrediction: Map<string, PeriodRef>;
  anchorByPrediction: Map<string, Date>;
}

function addPeriodFact(
  groups: Map<string, PeriodGroup>,
  fact: AppliedSettlementFact,
  periodType: typeof PeriodType.Week,
): void {
  if (fact.match.period_anchor_at === null) {
    throw invalidLedger(`finished match 缺少 period_anchor_at（match_id=${fact.match.match_id}）`);
  }
  const periodKey = calculatePeriodKey(periodType, fact.match.period_anchor_at);
  const identity = `${periodType}\u0000${periodKey}`;
  let group = groups.get(identity);
  if (group === undefined) {
    group = {
      period_type: periodType,
      period_key: periodKey,
      items: [],
      periodByPrediction: new Map(),
      anchorByPrediction: new Map(),
    };
    groups.set(identity, group);
  }
  group.items.push(fact.item);
  group.periodByPrediction.set(fact.item.prediction_id, {
    period_type: periodType,
    period_key: periodKey,
  });
  group.anchorByPrediction.set(fact.item.prediction_id, fact.match.period_anchor_at);
}

function buildExpectedRankings(
  facts: readonly AppliedSettlementFact[],
  users: readonly User[],
): Map<string, RebuiltRankingEntry> {
  const groups = new Map<string, PeriodGroup>();
  for (const fact of facts) {
    addPeriodFact(groups, fact, PeriodType.Week);
  }

  const expected = new Map<string, RebuiltRankingEntry>();
  for (const group of groups.values()) {
    const weekEndAt = periodEndAt(PeriodType.Week, group.period_key);
    const deletedUserIds = new Set(
      users
        .filter((user) => isDeletedForPeriod(user, weekEndAt))
        .map((user) => user.user_id),
    );
    for (const entry of rebuildPeriodRankings(
      group.items,
      group.periodByPrediction,
      group.anchorByPrediction,
      deletedUserIds,
    )) {
      expected.set(
        rankingIdentity(entry.period_type, entry.period_key, entry.user_id),
        entry,
      );
    }
  }
  return expected;
}

function activeSettlementScopes(
  matches: readonly Match[],
  predictions: readonly { user_id: string; match_id: string; canonical_match_id?: string }[],
  failedRankMatches: readonly Match[] = [],
): DailyConsistencyInput["active_settlements"] {
  const usersByCanonicalMatch = new Map<string, Set<string>>();
  for (const prediction of predictions) {
    const canonicalId = prediction.canonical_match_id ?? prediction.match_id;
    const users = usersByCanonicalMatch.get(canonicalId) ?? new Set<string>();
    users.add(prediction.user_id);
    usersByCanonicalMatch.set(canonicalId, users);
  }

  const activeScopes = matches
    .filter((match) => activeSettlement(match))
    .map((match) => {
      const anchor = match.period_anchor_at ?? match.kickoff_at;
      const canonicalId = match.canonical_match_id ?? match.match_id;
      return {
        match_id: match.match_id,
        user_ids: [...(usersByCanonicalMatch.get(canonicalId) ?? new Set<string>())].sort(),
        season_id: levelSeasonOf(anchor),
        periods: [{
          period_type: PeriodType.Week,
          period_key: calculatePeriodKey(PeriodType.Week, anchor),
        }],
      };
    });

  const activeIds = new Set(activeScopes.map((scope) => scope.match_id));
  const failedRankScopes = failedRankMatches
    .filter((match) => !activeIds.has(match.match_id))
    .map((match) => {
      const anchor = match.period_anchor_at ?? match.kickoff_at;
      return {
        match_id: match.match_id,
        // failed 赛果尚未完成最终 global_rank 重排，仅跳过该周 global_rank 比对，继续校验已 applied item 积分与统计。
        user_ids: [] as string[],
        season_id: levelSeasonOf(anchor),
        periods: [{
          period_type: PeriodType.Week,
          period_key: calculatePeriodKey(PeriodType.Week, anchor),
        }],
      };
    });

  return [...activeScopes, ...failedRankScopes].sort((a, b) => a.match_id.localeCompare(b.match_id));
}

async function loadActiveSettlementScopes(
  tx: UnitOfWork,
  matches: readonly Match[],
): Promise<DailyConsistencyInput["active_settlements"]> {
  const activeMatches = matches.filter((match) => activeSettlement(match));
  const failedRankMatches = matches.filter((match) => match.settlement_status === SettlementStatus.Failed);
  const canonicalIds = activeMatches.map((match) => match.canonical_match_id ?? match.match_id);
  const predictions: Array<{ user_id: string; match_id: string; canonical_match_id?: string }> =
    canonicalIds.length === 0
      ? []
      : tx.predictions.findByCanonicalMatchIds !== undefined
        ? await tx.predictions.findByCanonicalMatchIds(canonicalIds)
        : (await Promise.all([...new Set(canonicalIds)].map((id) => tx.predictions.findByCanonicalMatch(id)))).flat();
  return activeSettlementScopes(activeMatches, predictions, failedRankMatches);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function weekStartMs(periodKey: string): number {
  return periodEndAt(PeriodType.Week, periodKey).getTime() - WEEK_MS;
}

function periodOverlapsActiveWindows(
  periodKey: string,
  activeWindows: readonly { start: Date; end: Date }[],
): boolean {
  const weekStart = weekStartMs(periodKey);
  const weekEnd = weekStart + WEEK_MS;
  return activeWindows.some(
    (bounds) => weekStart < bounds.end.getTime() && weekEnd > bounds.start.getTime(),
  );
}

/**
 * 所有支持联赛当前活跃赛季窗口的共同完整覆盖起点：
 * `max_{league}(min_{s in activeSeasonIds(league, now)}(seasonBounds(s).start))`。
 * 用于排除仅加载了部分联赛历史（跨年 vs 自然年错位期）的等级赛季、生涯汇总与周榜。
 */
export function computeCompleteCoverageStart(effectiveNow: Date): Date {
  let latestMinStartMs: number | null = null;
  for (const league of SUPPORTED_LEAGUES) {
    let leagueMinStartMs: number | null = null;
    for (const seasonId of activeSeasonIds(league, effectiveNow)) {
      const bounds = seasonBounds(seasonId);
      if (bounds === null) continue;
      leagueMinStartMs = leagueMinStartMs === null
        ? bounds.start.getTime()
        : Math.min(leagueMinStartMs, bounds.start.getTime());
    }
    if (leagueMinStartMs !== null) {
      latestMinStartMs = latestMinStartMs === null
        ? leagueMinStartMs
        : Math.max(latestMinStartMs, leagueMinStartMs);
    }
  }
  return new Date(latestMinStartMs ?? 0);
}

/** 从事实账本与缓存文档加载 daily consistency 的比较输入，不写入任何业务数据。 */
export async function loadDailyConsistencySnapshot(
  tx: UnitOfWork,
  now?: Date,
  firstEvalAsOf: Date | null = FIXED_CONFIG_V1.LEVEL_FIRST_EVAL_AS_OF,
  assertHealthy?: () => void,
): Promise<DailyConsistencyInput> {
  requirePorts(tx);
  const users = await tx.users.findAll();
  assertHealthy?.();
  const matchesById = new Map<string, Match>();
  const effectiveNow = now ?? new Date();
  const seasonIds = new Set(
    SUPPORTED_LEAGUES.flatMap((league) => activeSeasonIds(league, effectiveNow)),
  );
  const seasonMatchBatches = await Promise.all(
    [...seasonIds].map((seasonId) => tx.matches.findBySeason(seasonId)),
  );
  for (const batch of seasonMatchBatches) {
    for (const match of batch) {
      matchesById.set(match.match_id, match);
    }
  }
  const matches = [...matchesById.values()];
  assertHealthy?.();
  const settlementsById = new Map<string, SettlementDoc>();
  for (const status of [SettlementDocStatus.Settled, SettlementDocStatus.Failed]) {
    for (const settlement of await tx.settlements.findByStatus(status)) {
      settlementsById.set(settlement.settlement_id, settlement);
    }
    assertHealthy?.();
  }
  const appliedItems: SettlementItem[] = [];
  for (const settlementIdBatch of chunk(
    [...settlementsById.keys()],
    CONSISTENCY_SETTLEMENT_BATCH_SIZE,
  )) {
    if (tx.settlementItems.findBySettlementIdsAndStatus !== undefined) {
      appliedItems.push(
        ...(await tx.settlementItems.findBySettlementIdsAndStatus(
          settlementIdBatch,
          SettlementItemStatus.Applied,
        )),
      );
    } else {
      for (const settlementId of settlementIdBatch) {
        appliedItems.push(
          ...(await tx.settlementItems.findBySettlementAndStatus(
            settlementId,
            SettlementItemStatus.Applied,
          )),
        );
      }
    }
    assertHealthy?.();
  }
  const facts: AppliedSettlementFact[] = [];
  for (const factBatch of chunkSettlementItemsByPrediction(
    appliedItems,
    CONSISTENCY_FACT_BATCH_SIZE,
  )) {
    facts.push(
      ...(await loadAppliedSettlementFacts(tx, factBatch, {
        skipActiveSettlement: true,
      })),
    );
    assertHealthy?.();
  }
  assertHealthy?.();
  const knownUsers = new Set(users.map((user) => user.user_id));
  for (const fact of facts) {
    if (!knownUsers.has(fact.item.user_id)) {
      throw invalidLedger(`applied item 缺少 user（user_id=${fact.item.user_id}）`);
    }
  }

  const completeCoverageStartMs = computeCompleteCoverageStart(effectiveNow).getTime();
  const currentLevelSeasonId = levelSeasonOf(effectiveNow);
  const isVerifiableLevelSeason = (seasonId: string): boolean => {
    if (seasonId === currentLevelSeasonId) {
      return true;
    }
    const bounds = seasonBounds(seasonId);
    return bounds !== null && bounds.start.getTime() >= completeCoverageStartMs;
  };
  const isVerifiableWeek = (periodKey: string): boolean =>
    weekStartMs(periodKey) >= completeCoverageStartMs;

  const activeWindows = [...seasonIds]
    .map((id) => seasonBounds(id))
    .filter((bounds): bounds is { start: Date; end: Date } => bounds !== null);

  const factsByUser = new Map<string, AppliedSettlementFact[]>();
  for (const fact of facts) {
    const userFacts = factsByUser.get(fact.item.user_id) ?? [];
    userFacts.push(fact);
    factsByUser.set(fact.item.user_id, userFacts);
  }
  const userIds = users.map((user) => user.user_id);
  const histories = tx.levelHistory.findByUserIds !== undefined
    ? await tx.levelHistory.findByUserIds(userIds)
    : new Map<string, LevelHistoryEntry[]>();
  if (tx.levelHistory.findByUserIds === undefined) {
    for (let i = 0; i < users.length; i += 1) {
      if (i > 0 && i % 100 === 0) assertHealthy?.();
      const user = users[i]!;
      histories.set(user.user_id, await tx.levelHistory.findByUser(user.user_id));
    }
  }
  assertHealthy?.();
  const seasonStatsByUser = tx.userSeasonStats.findByUserIds !== undefined
    ? await tx.userSeasonStats.findByUserIds(userIds)
    : new Map<string, UserSeasonStats[]>();
  if (tx.userSeasonStats.findByUserIds === undefined) {
    for (let i = 0; i < users.length; i += 1) {
      if (i > 0 && i % 100 === 0) assertHealthy?.();
      const user = users[i]!;
      seasonStatsByUser.set(user.user_id, await tx.userSeasonStats.findByUser(user.user_id));
    }
  }
  assertHealthy?.();

  // 老用户比赛已按 settlement 引用分批加载，career 可在第二年起继续全量核对。
  const career = users.map((user, index) => {
    if (index > 0 && index % 200 === 0) assertHealthy?.();
    const history = histories.get(user.user_id) ?? [];
    return {
      user_id: user.user_id,
      actual: careerValues(user),
      expected: expectedCareerValues(
        factsByUser.get(user.user_id) ?? [],
        history,
        user.career_best_level,
        user.career_level,
        user.career_level_state,
        firstEvalAsOf,
      ),
    };
  });

  const seasonStats = [] as DailyConsistencyInput["season_stats"];
  for (let userIndex = 0; userIndex < users.length; userIndex += 1) {
    if (userIndex > 0 && userIndex % 200 === 0) assertHealthy?.();
    const user = users[userIndex]!;
    const history = histories.get(user.user_id) ?? [];
    const actualStats = seasonStatsByUser.get(user.user_id) ?? [];
    const userLevelSeasonIds = new Set(
      actualStats
        .map((stats) => stats.level_season_id)
        .filter((seasonId) => isVerifiableLevelSeason(seasonId)),
    );
    for (const fact of factsByUser.get(user.user_id) ?? []) {
      if (fact.match.period_anchor_at === null) {
        throw invalidLedger(`applied match 缺少 period_anchor_at（match_id=${fact.match.match_id}）`);
      }
      const seasonId = levelSeasonOf(fact.match.period_anchor_at);
      if (isVerifiableLevelSeason(seasonId)) {
        userLevelSeasonIds.add(seasonId);
      }
    }
    for (const entry of history) {
      if (
        entry.scope === LevelScope.Season &&
        entry.level_season_id &&
        isVerifiableLevelSeason(entry.level_season_id)
      ) {
        userLevelSeasonIds.add(entry.level_season_id);
      }
    }
    const actualBySeason = new Map(actualStats.map((stats) => [stats.level_season_id, stats]));
    const userFacts = factsByUser.get(user.user_id) ?? [];
    for (const seasonId of [...userLevelSeasonIds].sort((a, b) => a.localeCompare(b))) {
      const seasonFacts = userFacts.filter(
        (fact) => fact.match.period_anchor_at !== null && levelSeasonOf(fact.match.period_anchor_at) === seasonId,
      );
      seasonStats.push({
        user_id: user.user_id,
        level_season_id: seasonId,
        actual: seasonValues(actualBySeason.get(seasonId)),
        expected: expectedSeasonValues(
          seasonId,
          seasonFacts,
          history,
          actualBySeason.get(seasonId)?.best_level ?? 1,
          actualBySeason.get(seasonId)?.level ?? 1,
          actualBySeason.get(seasonId)?.level_state,
          firstEvalAsOf,
        ),
      });
    }
  }

  const verifiableRankingFacts = facts.filter((fact) => {
    if (fact.match.period_anchor_at === null) {
      throw invalidLedger(`finished match 缺少 period_anchor_at（match_id=${fact.match.match_id}）`);
    }
    return isVerifiableWeek(calculatePeriodKey(PeriodType.Week, fact.match.period_anchor_at));
  });
  const expectedRankings = buildExpectedRankings(verifiableRankingFacts, users);
  const minWeekPeriodKey = calculatePeriodKey(
    PeriodType.Week,
    new Date(completeCoverageStartMs),
  );
  const actualRankingRows = tx.rankings.findWeekEntriesSince !== undefined
    ? await tx.rankings.findWeekEntriesSince(minWeekPeriodKey, true)
    : await tx.rankings.findAll();
  const actualRankings = actualRankingRows.filter(
    (entry) =>
      entry.period_type === PeriodType.Week &&
      isVerifiableWeek(entry.period_key) &&
      (expectedRankings.has(rankingIdentity(entry.period_type, entry.period_key, entry.user_id)) ||
        !entry.is_final ||
        periodOverlapsActiveWindows(entry.period_key, activeWindows)),
  );
  const actualRankingMap = new Map(
    actualRankings.map((entry) => [
      rankingIdentity(entry.period_type, entry.period_key, entry.user_id),
      entry,
    ]),
  );
  const rankingKeys = new Set([...actualRankingMap.keys(), ...expectedRankings.keys()]);
  const rankings: DailyConsistencyInput["rankings"] = [];
  for (const key of [...rankingKeys].sort()) {
    const actual = actualRankingMap.get(key);
    const expected = expectedRankings.get(key);
    if (actual !== undefined) {
      rankings.push({
        period_type: actual.period_type,
        period_key: actual.period_key,
        user_id: actual.user_id,
        actual: rankingValues(actual),
        expected: expected === undefined
          ? rankingValues(undefined)
          : rebuiltRankingValues(expected),
      });
      continue;
    }
    if (expected === undefined) {
      throw internalError("daily consistency ranking snapshot key missing");
    }
    rankings.push({
      period_type: expected.period_type,
      period_key: expected.period_key,
      user_id: expected.user_id,
      actual: rankingValues(undefined),
      expected: rebuiltRankingValues(expected),
    });
  }

  const activeSettlements = await loadActiveSettlementScopes(tx, matches);
  assertHealthy?.();
  const boardSnapshots = await loadBoardSnapshotConsistency(tx, users, activeSettlements);
  assertHealthy?.();

  return {
    career,
    season_stats: seasonStats,
    rankings,
    board_snapshots: boardSnapshots,
    active_settlements: activeSettlements,
  };
}

/** AppRepository 事务内使用的 source；daily consistency 锁由外层 service 持有。 */
export class RepositoryDailyConsistencySnapshotSource {
  constructor(
    private readonly repo: AppRepository,
    private readonly firstEvalAsOf?: Date | null,
  ) {}

  load(
    serverNow: Date,
    firstEvalAsOf: Date | null = this.firstEvalAsOf !== undefined
      ? this.firstEvalAsOf
      : FIXED_CONFIG_V1.LEVEL_FIRST_EVAL_AS_OF,
    assertHealthy?: () => void,
  ): Promise<DailyConsistencyInput> {
    return this.repo.withTransaction((tx) =>
      loadDailyConsistencySnapshot(tx, serverNow, firstEvalAsOf, assertHealthy),
    );
  }
}
