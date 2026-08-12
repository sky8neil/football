import { MVP_SEASON } from "../domain/config.js";
import {
  LevelScope,
  PeriodType,
  SettlementItemStatus,
  SettlementStatus,
} from "../domain/enums.js";
import { internalError } from "../domain/errors.js";
import { calculateLevel } from "../domain/levels.js";
import { calculatePeriodKey } from "../domain/time.js";
import type {
  LevelHistoryEntry,
  Match,
  RankingEntry,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import {
  activeSettlement,
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
  DailyConsistencyInput,
  RankingCacheValues,
  SeasonStatsCacheValues,
} from "./daily-consistency.js";

type DailyConsistencyUnitOfWork = UnitOfWork & {
  userSeasonStats: NonNullable<UnitOfWork["userSeasonStats"]>;
  rankings: NonNullable<UnitOfWork["rankings"]>;
  levelHistory: NonNullable<UnitOfWork["levelHistory"]>;
};

function requirePorts(tx: UnitOfWork): asserts tx is DailyConsistencyUnitOfWork {
  if (
    tx.userSeasonStats === undefined ||
    tx.rankings === undefined ||
    tx.levelHistory === undefined
  ) {
    throw internalError("daily consistency 缺少聚合或 level_history repository ports");
  }
}

function historyBestLevel(
  history: readonly LevelHistoryEntry[],
  scope: LevelScope,
  seasonId: string | null,
): number {
  let best = 1;
  for (const entry of history) {
    if (entry.scope !== scope || entry.season_id !== seasonId) {
      continue;
    }
    if (!Number.isInteger(entry.to_level) || entry.to_level < 1 || entry.to_level > 8) {
      throw invalidLedger(`level_history 的 to_level 非法（level_history_id=${entry.level_history_id}）`);
    }
    best = Math.max(best, entry.to_level);
  }
  return best;
}

function careerValues(user: User): CareerCacheValues {
  return {
    career_points: user.career_points,
    career_valid_predictions: user.career_valid_predictions,
    career_wdl_hits: user.career_wdl_hits,
    career_exact_hits: user.career_exact_hits,
    career_level: user.career_level,
    career_best_level: user.career_best_level,
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
  };
}

function seasonValues(stats: UserSeasonStats | undefined): SeasonStatsCacheValues {
  if (stats === undefined) {
    return zeroSeasonValues();
  }
  return {
    points: stats.points,
    valid_predictions: stats.valid_predictions,
    wdl_hits: stats.wdl_hits,
    exact_hits: stats.exact_hits,
    level: stats.level,
    best_level: stats.best_level,
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

function expectedCareerValues(
  facts: readonly AppliedSettlementFact[],
  history: readonly LevelHistoryEntry[],
  existingBestLevel: number,
): CareerCacheValues {
  const seasonByPrediction = new Map(
    facts.map((fact) => [fact.item.prediction_id, fact.match.season_id]),
  );
  const rebuilt = rebuildStatsFromLedger(
    facts.map((fact) => fact.item),
    seasonByPrediction,
  );
  const currentLevel = calculateLevel(
    LevelScope.Career,
    rebuilt.career.career_valid_predictions,
    rebuilt.career.career_wdl_hits,
  );
  return {
    career_points: rebuilt.career.career_points,
    career_valid_predictions: rebuilt.career.career_valid_predictions,
    career_wdl_hits: rebuilt.career.career_wdl_hits,
    career_exact_hits: rebuilt.career.career_exact_hits,
    career_level: currentLevel,
    career_best_level: Math.max(
      currentLevel,
      existingBestLevel,
      historyBestLevel(history, LevelScope.Career, null),
    ),
  };
}

function expectedSeasonValues(
  seasonId: string,
  facts: readonly AppliedSettlementFact[],
  history: readonly LevelHistoryEntry[],
  existingBestLevel: number,
): SeasonStatsCacheValues {
  const seasonByPrediction = new Map(
    facts.map((fact) => [fact.item.prediction_id, fact.match.season_id]),
  );
  const rebuilt = rebuildStatsFromLedger(
    facts.map((fact) => fact.item),
    seasonByPrediction,
  );
  const stats = rebuilt.seasons.find((item) => item.season_id === seasonId);
  const base = stats ?? {
    points: 0,
    valid_predictions: 0,
    wdl_hits: 0,
    exact_hits: 0,
  };
  const currentLevel = calculateLevel(
    LevelScope.Season,
    base.valid_predictions,
    base.wdl_hits,
  );
  return {
    points: base.points,
    valid_predictions: base.valid_predictions,
    wdl_hits: base.wdl_hits,
    exact_hits: base.exact_hits,
    level: currentLevel,
    best_level: Math.max(
      currentLevel,
      existingBestLevel,
      historyBestLevel(history, LevelScope.Season, seasonId),
    ),
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
  period_type: PeriodType;
  period_key: string;
  items: AppliedSettlementFact["item"][];
  periodByPrediction: Map<string, PeriodRef>;
  anchorByPrediction: Map<string, Date>;
}

function addPeriodFact(
  groups: Map<string, PeriodGroup>,
  fact: AppliedSettlementFact,
  periodType: PeriodType,
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
    addPeriodFact(groups, fact, PeriodType.Month);
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
    .map((match) => ({
      match_id: match.match_id,
      user_ids: [...(usersByMatch.get(match.match_id) ?? new Set<string>())].sort(),
      season_id: match.season_id,
      periods:
        match.period_anchor_at === null
          ? []
          : [
              {
                period_type: PeriodType.Week,
                period_key: calculatePeriodKey(PeriodType.Week, match.period_anchor_at),
              },
              {
                period_type: PeriodType.Month,
                period_key: calculatePeriodKey(PeriodType.Month, match.period_anchor_at),
              },
            ],
    }));
}

/** 从事实账本与缓存文档加载 daily consistency 的比较输入，不写入任何业务数据。 */
export async function loadDailyConsistencySnapshot(
  tx: UnitOfWork,
): Promise<DailyConsistencyInput> {
  requirePorts(tx);
  const users = await tx.users.findAll();
  const matches = await tx.matches.findBySeason(MVP_SEASON.season_id);
  const predictions = [] as Awaited<ReturnType<UnitOfWork["predictions"]["findByUser"]>>;
  for (const user of users) {
    predictions.push(...(await tx.predictions.findByUser(user.user_id)));
  }

  const appliedItems = await tx.settlementItems.findByStatus(SettlementItemStatus.Applied);
  const facts = await loadAppliedSettlementFacts(tx, appliedItems);
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
      ),
    };
  });

  const seasonStats = [] as DailyConsistencyInput["season_stats"];
  for (const user of users) {
    const history = histories.get(user.user_id) ?? [];
    const actualStats = seasonStatsByUser.get(user.user_id) ?? [];
    const seasonIds = new Set(actualStats.map((stats) => stats.season_id));
    for (const fact of factsByUser.get(user.user_id) ?? []) {
      seasonIds.add(fact.match.season_id);
    }
    for (const entry of history) {
      if (entry.scope === LevelScope.Season && entry.season_id !== null) {
        seasonIds.add(entry.season_id);
      }
    }
    const actualBySeason = new Map(actualStats.map((stats) => [stats.season_id, stats]));
    const userFacts = factsByUser.get(user.user_id) ?? [];
    for (const seasonId of [...seasonIds].sort((a, b) => a.localeCompare(b))) {
      seasonStats.push({
        user_id: user.user_id,
        season_id: seasonId,
        actual: seasonValues(actualBySeason.get(seasonId)),
        expected: expectedSeasonValues(
          seasonId,
          userFacts,
          history,
          actualBySeason.get(seasonId)?.best_level ?? 1,
        ),
      });
    }
  }

  const expectedRankings = buildExpectedRankings(facts);
  const actualRankings = await tx.rankings.findAll();
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

  return {
    career,
    season_stats: seasonStats,
    rankings,
    active_settlements: activeSettlementScopes(matches, predictions),
  };
}

/** AppRepository 事务内使用的 source；daily consistency 锁由外层 service 持有。 */
export class RepositoryDailyConsistencySnapshotSource {
  constructor(private readonly repo: AppRepository) {}

  load(_serverNow: Date): Promise<DailyConsistencyInput> {
    return this.repo.withTransaction((tx) => loadDailyConsistencySnapshot(tx));
  }
}
