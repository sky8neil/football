import type { PeriodType } from "../domain/enums.js";

export interface CareerCacheValues {
  career_points: number;
  career_valid_predictions: number;
  career_wdl_hits: number;
  career_exact_hits: number;
  career_level: number;
  career_best_level: number;
}

export interface SeasonStatsCacheValues {
  points: number;
  valid_predictions: number;
  wdl_hits: number;
  exact_hits: number;
  level: number;
  best_level: number;
}

export interface RankingCacheValues {
  period_score: number;
  valid_predictions: number;
  wdl_hits: number;
  exact_hits: number;
  last_scoring_match_at: Date | null;
  global_rank: number | null;
}

export interface CareerConsistencyEntry {
  user_id: string;
  actual: CareerCacheValues;
  expected: CareerCacheValues;
}

export interface SeasonStatsConsistencyEntry {
  user_id: string;
  season_id: string;
  actual: SeasonStatsCacheValues;
  expected: SeasonStatsCacheValues;
}

export interface RankingConsistencyEntry {
  period_type: PeriodType;
  period_key: string;
  user_id: string;
  actual: RankingCacheValues;
  expected: RankingCacheValues;
}

export interface ActiveSettlementConsistencyScope {
  match_id: string;
  user_ids: string[];
  season_id: string;
  periods: Array<{
    period_type: PeriodType;
    period_key: string;
  }>;
}

export interface DailyConsistencyInput {
  career: CareerConsistencyEntry[];
  season_stats: SeasonStatsConsistencyEntry[];
  rankings: RankingConsistencyEntry[];
  active_settlements: ActiveSettlementConsistencyScope[];
}

export type ConsistencyDifferenceScope = "career" | "season_stats" | "ranking";

export interface ConsistencyDifference {
  scope: ConsistencyDifferenceScope;
  key: string;
  fields: string[];
  actual: Record<string, number | string | null>;
  expected: Record<string, number | string | null>;
}

export interface SkippedActiveSettlement {
  kind: "skipped_active_settlement";
  match_id: string;
  user_ids: string[];
  season_id: string;
  periods: Array<{
    period_type: PeriodType;
    period_key: string;
  }>;
}

export interface DailyConsistencyResult {
  differences: ConsistencyDifference[];
  skipped_active_settlement: SkippedActiveSettlement[];
}

const CAREER_FIELDS: readonly (keyof CareerCacheValues)[] = [
  "career_points",
  "career_valid_predictions",
  "career_wdl_hits",
  "career_exact_hits",
  "career_level",
  "career_best_level",
];

const SEASON_FIELDS: readonly (keyof SeasonStatsCacheValues)[] = [
  "points",
  "valid_predictions",
  "wdl_hits",
  "exact_hits",
  "level",
  "best_level",
];

const RANKING_FIELDS: readonly (keyof RankingCacheValues)[] = [
  "period_score",
  "valid_predictions",
  "wdl_hits",
  "exact_hits",
  "last_scoring_match_at",
  "global_rank",
];

function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual instanceof Date || expected instanceof Date) {
    return (
      actual instanceof Date &&
      expected instanceof Date &&
      actual.getTime() === expected.getTime()
    );
  }
  return Object.is(actual, expected);
}

function reportValue(value: unknown): number | string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  throw new Error("daily consistency snapshot contains unsupported value");
}

function compareValues<T extends object>(
  scope: ConsistencyDifferenceScope,
  key: string,
  actual: T,
  expected: T,
  fields: readonly (keyof T)[],
): ConsistencyDifference | null {
  const changedFields = fields.filter((field) => !sameValue(actual[field], expected[field]));
  if (changedFields.length === 0) {
    return null;
  }

  const actualValues: Record<string, number | string | null> = {};
  const expectedValues: Record<string, number | string | null> = {};
  for (const field of changedFields) {
    const name = String(field);
    actualValues[name] = reportValue(actual[field]);
    expectedValues[name] = reportValue(expected[field]);
  }

  return {
    scope,
    key,
    fields: changedFields.map(String),
    actual: actualValues,
    expected: expectedValues,
  };
}

function periodKey(periodType: PeriodType, periodKeyValue: string): string {
  return `${periodType}:${periodKeyValue}`;
}

export function checkDailyConsistency(
  input: DailyConsistencyInput,
): DailyConsistencyResult {
  const skippedActiveSettlement: SkippedActiveSettlement[] = input.active_settlements.map(
    (scope) => ({
      kind: "skipped_active_settlement" as const,
      match_id: scope.match_id,
      user_ids: [...scope.user_ids],
      season_id: scope.season_id,
      periods: scope.periods.map((period) => ({ ...period })),
    }),
  );

  const activeUsers = new Set<string>();
  const activeUserSeasons = new Set<string>();
  const activeUserPeriods = new Set<string>();
  for (const scope of input.active_settlements) {
    for (const userId of scope.user_ids) {
      activeUsers.add(userId);
      activeUserSeasons.add(`${userId}:${scope.season_id}`);
      for (const period of scope.periods) {
        activeUserPeriods.add(
          `${periodKey(period.period_type, period.period_key)}:${userId}`,
        );
      }
    }
  }

  const differences: ConsistencyDifference[] = [];
  for (const entry of input.career) {
    if (activeUsers.has(entry.user_id)) {
      continue;
    }
    const difference = compareValues(
      "career",
      entry.user_id,
      entry.actual,
      entry.expected,
      CAREER_FIELDS,
    );
    if (difference !== null) {
      differences.push(difference);
    }
  }

  for (const entry of input.season_stats) {
    if (activeUserSeasons.has(`${entry.user_id}:${entry.season_id}`)) {
      continue;
    }
    const difference = compareValues(
      "season_stats",
      `${entry.user_id}:${entry.season_id}`,
      entry.actual,
      entry.expected,
      SEASON_FIELDS,
    );
    if (difference !== null) {
      differences.push(difference);
    }
  }

  for (const entry of input.rankings) {
    if (
      activeUserPeriods.has(
        `${periodKey(entry.period_type, entry.period_key)}:${entry.user_id}`,
      )
    ) {
      continue;
    }
    const difference = compareValues(
      "ranking",
      `${entry.period_type}:${entry.period_key}:${entry.user_id}`,
      entry.actual,
      entry.expected,
      RANKING_FIELDS,
    );
    if (difference !== null) {
      differences.push(difference);
    }
  }

  return {
    differences,
    skipped_active_settlement: skippedActiveSettlement,
  };
}
