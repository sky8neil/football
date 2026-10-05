import { FIXED_CONFIG_V1, SUPPORTED_LEAGUES } from "../domain/config.js";
import {
  LevelScope,
  PeriodType,
  RankingBoard,
  SettlementItemStatus,
} from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import {
  buildLevelInputs,
  evaluateLevel,
  type LevelPredictionFact,
} from "../domain/levels.js";
import {
  calculatePeriodKey,
  levelProtectionEndAsOf,
  levelSeasonOf,
} from "../domain/time.js";
import type {
  LevelHistoryEntry,
  LevelState,
  BoardSnapshot,
  Match,
  RankingEntry,
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
  };
}

async function loadBoardSnapshotConsistency(
  tx: DailyConsistencyUnitOfWork,
  users: readonly User[],
  activeSettlements: DailyConsistencyInput["active_settlements"],
): Promise<DailyConsistencyInput["board_snapshots"]> {
  const activeUserIds = new Set(activeSettlements.flatMap((scope) => scope.user_ids));
  const entries: DailyConsistencyInput["board_snapshots"] = [];
  for (const board of [RankingBoard.Career, RankingBoard.Strength] as const) {
    const snapshotVersion = await tx.boardSnapshots.findLatestByBoard(board);
    if (snapshotVersion.length === 0) {
      continue;
    }
    const snapshotAt = snapshotVersion[0]!.snapshot_at;
    const actualSnapshots = snapshotVersion.filter((snapshot) => snapshot.snapshot_kind !== "head");
    const expectedSnapshots = buildBoardSnapshotEntries(users, board, snapshotAt);
    const expectedByUser = new Map(expectedSnapshots.map((snapshot) => [snapshot.user_id, snapshot]));
    const actualByUser = new Map(actualSnapshots.map((snapshot) => [snapshot.user_id, snapshot]));
    const hasChangedUsers = users.some((user) => user.updated_at.getTime() > snapshotAt.getTime());
    const rankCheckSkipped = hasChangedUsers || activeUserIds.size > 0;

    if (rankCheckSkipped) {
      for (const user of users) {
        if (user.updated_at.getTime() > snapshotAt.getTime() || activeUserIds.has(user.user_id)) {
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
  scope: LevelScope;
  levelSeasonId: string | null;
  history: readonly LevelHistoryEntry[];
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
  const state = params.state ?? defaultLevelState();
  const lastEvalAsOf = state.last_eval_as_of;
  let level = params.level;
  let belowCount = state.below_count;
  let lastEvalN = state.last_eval_n;
  let lastEvalScoreSum = state.last_eval_score_sum;
  let lastEvalBPoints = state.last_eval_b_points;
  let lastEvalRuleVersion = state.last_eval_rule_version;

  if (lastEvalAsOf !== null) {
    const inputs = buildLevelInputs(
      params.facts,
      params.scope,
      lastEvalAsOf,
      params.levelSeasonId ?? undefined,
    );
    lastEvalN = inputs.n;
    lastEvalScoreSum = inputs.S;
    lastEvalBPoints = inputs.b_points;
    lastEvalRuleVersion = FIXED_CONFIG_V1.LEVEL_RULE_VERSION;

    const firstEvalAsOf = FIXED_CONFIG_V1.LEVEL_FIRST_EVAL_AS_OF as Date | null;
    if (firstEvalAsOf !== null && lastEvalAsOf.getTime() >= firstEvalAsOf.getTime()) {
      const result = evaluateLevel(
        {
          level: state.week_base_level ?? params.level,
          best_level: params.bestLevel,
          below_count: state.week_base_below_count ?? state.below_count,
        },
        inputs,
        lastEvalRuleVersion,
        lastEvalAsOf,
        levelProtectionEndAsOf(firstEvalAsOf),
      );
      level = result.level;
      belowCount = result.below_count;
    }
  }

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
): CareerCacheValues {
  const rebuilt = rebuildStatsFromLedger(
    facts.map((fact) => fact.item),
    levelSeasonByPrediction(facts),
  );
  const levelValues = expectedLevelValues({
    level: existingLevel,
    bestLevel: existingBestLevel,
    state: existingState,
    facts: buildReplayFacts(facts).facts,
    scope: LevelScope.Career,
    levelSeasonId: null,
    history,
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
): SeasonStatsCacheValues {
  const rebuilt = rebuildStatsFromLedger(
    facts.map((fact) => fact.item),
    levelSeasonByPrediction(facts),
  );
  const stats = rebuilt.seasons.find((item) => item.level_season_id === seasonId);
  const base = stats ?? {
    points: 0,
    valid_predictions: 0,
    wdl_hits: 0,
    exact_hits: 0,
  };
  const levelValues = expectedLevelValues({
    level: existingLevel,
    bestLevel: existingBestLevel,
    state: existingState,
    facts: buildReplayFacts(facts).facts,
    scope: LevelScope.Season,
    levelSeasonId: seasonId,
    history,
  });
  return {
    points: base.points,
    valid_predictions: base.valid_predictions,
    wdl_hits: base.wdl_hits,
    exact_hits: base.exact_hits,
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
): Map<string, RebuiltRankingEntry> {
  const groups = new Map<string, PeriodGroup>();
  for (const fact of facts) {
    addPeriodFact(groups, fact, PeriodType.Week);
  }

  const expected = new Map<string, RebuiltRankingEntry>();
  for (const group of groups.values()) {
    for (const entry of rebuildPeriodRankings(
      group.items,
      group.periodByPrediction,
      group.anchorByPrediction,
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
  predictions: readonly { user_id: string; match_id: string }[],
): DailyConsistencyInput["active_settlements"] {
  const usersByMatch = new Map<string, Set<string>>();
  for (const prediction of predictions) {
    const users = usersByMatch.get(prediction.match_id) ?? new Set<string>();
    users.add(prediction.user_id);
    usersByMatch.set(prediction.match_id, users);
  }

  return matches
    .filter((match) => activeSettlement(match))
    .sort((a, b) => a.match_id.localeCompare(b.match_id))
    .map((match) => {
      const anchor = match.period_anchor_at ?? match.kickoff_at;
      return {
        match_id: match.match_id,
        user_ids: [...(usersByMatch.get(match.match_id) ?? new Set<string>())].sort(),
        season_id: levelSeasonOf(anchor),
        periods: [{
          period_type: PeriodType.Week,
          period_key: calculatePeriodKey(PeriodType.Week, anchor),
        }],
      };
    });
}

async function loadActiveSettlementScopes(
  tx: UnitOfWork,
  matches: readonly Match[],
): Promise<DailyConsistencyInput["active_settlements"]> {
  const activeMatches = matches.filter((match) => activeSettlement(match));
  const predictions: Array<{ user_id: string; match_id: string }> = [];
  for (const match of activeMatches) {
    predictions.push(...(await tx.predictions.findByMatch(match.match_id)));
  }
  return activeSettlementScopes(activeMatches, predictions);
}

/** 从事实账本与缓存文档加载 daily consistency 的比较输入，不写入任何业务数据。 */
export async function loadDailyConsistencySnapshot(
  tx: UnitOfWork,
): Promise<DailyConsistencyInput> {
  requirePorts(tx);
  const users = await tx.users.findAll();
  const matchesById = new Map<string, Match>();
  for (const seasonId of new Set(SUPPORTED_LEAGUES.map((league) => league.season_id))) {
    for (const match of await tx.matches.findBySeason(seasonId)) {
      matchesById.set(match.match_id, match);
    }
  }
  const matches = [...matchesById.values()];
  const appliedItems = await tx.settlementItems.findByStatus(SettlementItemStatus.Applied);
  const facts = await loadAppliedSettlementFacts(tx, appliedItems, {
    skipActiveSettlement: true,
  });
  const knownUsers = new Set(users.map((user) => user.user_id));
  for (const fact of facts) {
    if (!knownUsers.has(fact.item.user_id)) {
      throw invalidLedger(`applied item 缺少 user（user_id=${fact.item.user_id}）`);
    }
  }

  const factsByUser = new Map<string, AppliedSettlementFact[]>();
  for (const fact of facts) {
    const userFacts = factsByUser.get(fact.item.user_id) ?? [];
    userFacts.push(fact);
    factsByUser.set(fact.item.user_id, userFacts);
  }
  const histories = new Map<string, LevelHistoryEntry[]>();
  const seasonStatsByUser = new Map<string, UserSeasonStats[]>();
  for (const user of users) {
    histories.set(user.user_id, await tx.levelHistory.findByUser(user.user_id));
    seasonStatsByUser.set(user.user_id, await tx.userSeasonStats.findByUser(user.user_id));
  }

  const career = users.map((user) => {
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
      ),
    };
  });

  const seasonStats = [] as DailyConsistencyInput["season_stats"];
  for (const user of users) {
    const history = histories.get(user.user_id) ?? [];
    const actualStats = seasonStatsByUser.get(user.user_id) ?? [];
    const seasonIds = new Set(actualStats.map((stats) => stats.level_season_id));
    for (const fact of factsByUser.get(user.user_id) ?? []) {
      if (fact.match.period_anchor_at === null) {
        throw invalidLedger(`applied match 缺少 period_anchor_at（match_id=${fact.match.match_id}）`);
      }
      seasonIds.add(levelSeasonOf(fact.match.period_anchor_at));
    }
    for (const entry of history) {
      if (entry.scope === LevelScope.Season && entry.level_season_id) {
        seasonIds.add(entry.level_season_id);
      }
    }
    const actualBySeason = new Map(actualStats.map((stats) => [stats.level_season_id, stats]));
    const userFacts = factsByUser.get(user.user_id) ?? [];
    for (const seasonId of [...seasonIds].sort((a, b) => a.localeCompare(b))) {
      seasonStats.push({
        user_id: user.user_id,
        level_season_id: seasonId,
        actual: seasonValues(actualBySeason.get(seasonId)),
        expected: expectedSeasonValues(
          seasonId,
          userFacts,
          history,
          actualBySeason.get(seasonId)?.best_level ?? 1,
          actualBySeason.get(seasonId)?.level ?? 1,
          actualBySeason.get(seasonId)?.level_state,
        ),
      });
    }
  }

  const expectedRankings = buildExpectedRankings(facts);
  const actualRankings = (await tx.rankings.findAll()).filter(
    (entry) => entry.period_type === PeriodType.Week,
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
  const boardSnapshots = await loadBoardSnapshotConsistency(tx, users, activeSettlements);

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
  constructor(private readonly repo: AppRepository) {}

  load(_serverNow: Date): Promise<DailyConsistencyInput> {
    return this.repo.withTransaction((tx) => loadDailyConsistencySnapshot(tx));
  }
}
