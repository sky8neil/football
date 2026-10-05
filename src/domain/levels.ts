/**
 * 等级计算。
 *
 * v2 唯一实现入口（规范 0.4 / 17）：
 *   buildLevelInputs / evaluateLevel / replayLevel
 *
 */
import { FIXED_CONFIG_V1, LEVEL_ELIGIBLE_LEAGUES } from "./config.js";
import { LevelScope, type LevelScope as LevelScopeType } from "./enums.js";
import { validationError } from "./errors.js";
import { isMondayLevelEvalAt, levelSeasonOf } from "./time.js";

const ELIGIBLE_LEAGUE_IDS = new Set(
  LEVEL_ELIGIBLE_LEAGUES.map((row) => row.league_id),
);

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

const PRIOR_K = FIXED_CONFIG_V1.LEVEL_PRIOR_WEIGHT_K;
const PRIOR_MEAN_X100 = FIXED_CONFIG_V1.LEVEL_PRIOR_MEAN_X100;
/** P0 = K·μ0 = 40 × 1.70 = 68。必须为整数，否则交叉乘法无定义。 */
const PRIOR_P0 = (PRIOR_K * PRIOR_MEAN_X100) / 100;
if (!Number.isInteger(PRIOR_P0)) {
  throw new Error("SPEC_GAP: LEVEL_PRIOR_WEIGHT_K * LEVEL_PRIOR_MEAN_X100 不能被 100 整除");
}

/** 实力榜 / 等级判定共用先验；禁止在 ranking.ts 另立常量。 */
export const LEVEL_PRIOR_K = PRIOR_K;
export const LEVEL_PRIOR_P0 = PRIOR_P0;

/**
 * D52 最小登记：仅 level_v3.0。
 * effectiveAsOf=null：Q1 上线日未登记，本版本视为始终生效（Fail Closed 不发明其它版本）。
 */
export const LEVEL_RULE_VERSIONS = [
  {
    version: "level_v3.0" as const,
    effectiveAsOf: null,
  },
] as const;

export type LevelRuleVersionId = (typeof LEVEL_RULE_VERSIONS)[number]["version"];

export interface LevelAppliedItemFact {
  applied_at: Date;
  valid_prediction_delta: number;
  source_result_version: number;
  new_score: number;
  score_delta: number;
}

export interface LevelPredictionFact {
  prediction_id: string;
  match_id: string;
  league_id: string;
  period_anchor_at: Date;
  applied_items: readonly LevelAppliedItemFact[];
}

export interface LevelInputs {
  n: number;
  S: number;
  b_points: number;
  valid_total: number;
}

export interface LevelEvalState {
  level: number;
  best_level: number;
  below_count: number;
}

export interface ReplayLevelParams {
  scope: LevelScopeType;
  facts: readonly LevelPredictionFact[];
  firstEvalAsOf: Date | null;
  untilAsOf: Date;
  correctionSettledAts: readonly Date[];
  ruleVersion: string;
  protectionEndAsOf: Date | null;
  initialState?: LevelEvalState;
  levelSeasonId?: string;
}

export interface ReplayLevelResult extends LevelEvalState {
  week_base: LevelEvalState;
  week_base_as_of: Date | null;
  last_inputs: LevelInputs | null;
  last_eval_as_of: Date | null;
}

function itemsBefore(
  items: readonly LevelAppliedItemFact[],
  asOf: Date,
): LevelAppliedItemFact[] {
  const cutoff = asOf.getTime();
  return items.filter((item) => item.applied_at.getTime() < cutoff);
}

function latestScoreBefore(items: readonly LevelAppliedItemFact[]): number | null {
  if (items.length === 0) {
    return null;
  }
  let best = items[0]!;
  for (let i = 1; i < items.length; i += 1) {
    const item = items[i]!;
    if (item.source_result_version > best.source_result_version) {
      best = item;
    }
  }
  return best.new_score;
}

function hasValidAppliedBefore(
  items: readonly LevelAppliedItemFact[],
): boolean {
  return items.some((item) => item.valid_prediction_delta === 1);
}

/**
 * §17.5：由已应用结算事实构造某 scope、某 as_of 的窗口输入截面。纯函数，无 I/O。
 *
 * season scope 必须显式传入 levelSeasonId（不得用 as_of 推断：最终评估的 as_of
 * 可落在赛季结束之后，§17.8.4）。
 */
export function buildLevelInputs(
  facts: readonly LevelPredictionFact[],
  scope: LevelScopeType,
  asOf: Date,
  levelSeasonId?: string,
): LevelInputs {
  if (scope !== LevelScope.Season && scope !== LevelScope.Career) {
    throw validationError("未知等级 scope", { scope });
  }
  if (scope === LevelScope.Season && (levelSeasonId === undefined || levelSeasonId === "")) {
    throw validationError("season scope 必须提供 level_season_id", { scope });
  }

  const windowMs = FIXED_CONFIG_V1.LEVEL_WINDOW_MAX_DAYS * MS_PER_DAY;
  const windowStartExclusive = asOf.getTime() - windowMs;
  const maxN = FIXED_CONFIG_V1.LEVEL_WINDOW_MAX_N;

  const candidates: LevelPredictionFact[] = [];
  let bPoints = 0;
  let validTotal = 0;

  for (const fact of facts) {
    const before = itemsBefore(fact.applied_items, asOf);
    const eligibleLeague = ELIGIBLE_LEAGUE_IDS.has(
      fact.league_id as (typeof LEVEL_ELIGIBLE_LEAGUES)[number]["league_id"],
    );
    const inSeason =
      scope !== LevelScope.Season ||
      levelSeasonOf(fact.period_anchor_at) === levelSeasonId;

    if (eligibleLeague && inSeason) {
      for (const item of before) {
        bPoints += item.score_delta;
      }
      if (hasValidAppliedBefore(before)) {
        validTotal += 1;
      }
    }

    if (!eligibleLeague || !inSeason) {
      continue;
    }
    if (!hasValidAppliedBefore(before)) {
      continue;
    }
    if (fact.period_anchor_at.getTime() <= windowStartExclusive) {
      continue;
    }
    candidates.push(fact);
  }

  candidates.sort((a, b) => {
    const anchorDiff = b.period_anchor_at.getTime() - a.period_anchor_at.getTime();
    if (anchorDiff !== 0) {
      return anchorDiff;
    }
    if (a.match_id < b.match_id) {
      return -1;
    }
    if (a.match_id > b.match_id) {
      return 1;
    }
    return 0;
  });

  const window = candidates.slice(0, Math.min(maxN, candidates.length));
  let S = 0;
  for (const fact of window) {
    const score = latestScoreBefore(itemsBefore(fact.applied_items, asOf));
    if (score === null) {
      throw validationError("窗口条目缺少 as_of 前 applied item", {
        match_id: fact.match_id,
      });
    }
    S += score;
  }

  return { n: window.length, S, b_points: bPoints, valid_total: validTotal };
}

function assertNonNegInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw validationError(`${name} 必须为非负整数`, { [name]: value });
  }
}

function resolveRuleVersion(ruleVersion: string): void {
  const found = LEVEL_RULE_VERSIONS.find((row) => row.version === ruleVersion);
  if (found === undefined) {
    throw validationError("未知 level_rule_version", {
      rule_version: ruleVersion,
    });
  }
}

function promoteX100(targetLevel: number): number {
  const table = FIXED_CONFIG_V1.LEVEL_PROMOTE_X100;
  if (targetLevel === 3) {
    return table[3];
  }
  if (targetLevel === 4) {
    return table[4];
  }
  if (targetLevel === 5) {
    return table[5];
  }
  if (targetLevel === 6) {
    return table[6];
  }
  throw validationError("无对应升级线", { target_level: targetLevel });
}

function holdX100(level: number): number {
  const table = FIXED_CONFIG_V1.LEVEL_HOLD_X100;
  if (level === 3) {
    return table[3];
  }
  if (level === 4) {
    return table[4];
  }
  if (level === 5) {
    return table[5];
  }
  if (level === 6) {
    return table[6];
  }
  throw validationError("无对应保级线", { level });
}

function bPointsFor(targetLevel: number): number {
  const table = FIXED_CONFIG_V1.LEVEL_B_POINTS;
  if (targetLevel === 3) {
    return table[3];
  }
  if (targetLevel === 4) {
    return table[4];
  }
  if (targetLevel === 5) {
    return table[5];
  }
  if (targetLevel === 6) {
    return table[6];
  }
  throw validationError("无对应 B 线", { target_level: targetLevel });
}

/** 判定 s ≥ T：`100*(S+P0) >= T*(n+K)`。禁止先算浮点 s。 */
export function meetsThresholdX100(S: number, n: number, thresholdX100: number): boolean {
  return 100 * (S + PRIOR_P0) >= thresholdX100 * (n + PRIOR_K);
}

/**
 * 实力榜 s 交叉乘法比较（规范 19.5）：`(S_a+P0)(n_b+K)` vs `(S_b+P0)(n_a+K)`。
 * 负数表示 a 的 s 更高。整数比较，禁止浮点。
 */
export function compareStrengthIndex(
  a: { S: number; n: number },
  b: { S: number; n: number },
): number {
  const lhs = (a.S + PRIOR_P0) * (b.n + PRIOR_K);
  const rhs = (b.S + PRIOR_P0) * (a.n + PRIOR_K);
  if (lhs === rhs) {
    return 0;
  }
  return lhs > rhs ? -1 : 1;
}

/** §17.5.2：`s_display_x100 = floor(100*(S+P0)/(n+K))`，向下取整。 */
export function sDisplayX100(S: number, n: number): number {
  return Math.floor((100 * (S + PRIOR_P0)) / (n + PRIOR_K));
}

/** 展示字符串 `"x.yy"`。 */
export function formatSDisplay(S: number, n: number): string {
  const x100 = sDisplayX100(S, n);
  const whole = Math.floor(x100 / 100);
  const frac = x100 % 100;
  return `${whole}.${String(frac).padStart(2, "0")}`;
}

function finishState(
  level: number,
  bestLevel: number,
  belowCount: number,
): LevelEvalState {
  return {
    level,
    best_level: Math.max(bestLevel, level),
    below_count: belowCount,
  };
}

/**
 * §17.6.4 唯一定级算法入口。一次最多升/降一级。
 *
 * `protectionEndAsOf` 必须显式注入（Q1：LEVEL_FIRST_EVAL_AS_OF=null，
 * 不得发明上线日期）。`as_of < protectionEndAsOf` 为保护期：不降级、不累计。
 */
export function evaluateLevel(
  state: LevelEvalState,
  inputs: LevelInputs,
  ruleVersion: string,
  asOf: Date,
  protectionEndAsOf: Date,
): LevelEvalState {
  resolveRuleVersion(ruleVersion);
  const L = state.level;
  const bc = state.below_count;
  const { n, S, b_points: B, valid_total } = inputs;

  if (!Number.isInteger(L) || L < 1 || L > FIXED_CONFIG_V1.LEVEL_MAX) {
    throw validationError("level 必须是 1..6 的整数", { level: L });
  }
  if (bc !== 0 && bc !== 1) {
    throw validationError("below_count 必须 ∈ {0,1}", { below_count: bc });
  }
  assertNonNegInt("n", n);
  assertNonNegInt("S", S);
  if (!Number.isInteger(B)) {
    throw validationError("b_points 必须为整数", { b_points: B });
  }
  assertNonNegInt("valid_total", valid_total);
  if (S > 12 * n) {
    throw validationError("S 不能大于 12n", { S, n });
  }

  const protectedPeriod = asOf.getTime() < protectionEndAsOf.getTime();

  if (L === 1) {
    if (valid_total >= FIXED_CONFIG_V1.LEVEL_RATED_MIN_VALID) {
      return finishState(2, state.best_level, 0);
    }
    return finishState(1, state.best_level, 0);
  }

  if (L < FIXED_CONFIG_V1.LEVEL_MAX) {
    const next = L + 1;
    if (meetsThresholdX100(S, n, promoteX100(next)) && B >= bPointsFor(next)) {
      return finishState(next, state.best_level, 0);
    }
  }

  if (L >= 3 && !meetsThresholdX100(S, n, holdX100(L))) {
    if (protectedPeriod) {
      return finishState(L, state.best_level, 0);
    }
    if (bc + 1 >= FIXED_CONFIG_V1.LEVEL_DEMOTE_CONSECUTIVE) {
      return finishState(L - 1, state.best_level, 0);
    }
    return finishState(L, state.best_level, 1);
  }

  return finishState(L, state.best_level, 0);
}

interface ReplayEvent {
  asOf: Date;
  kind: "weekly" | "correction";
}

function weeklyEvalTimes(firstEvalAsOf: Date, untilAsOf: Date): Date[] {
  if (!isMondayLevelEvalAt(firstEvalAsOf)) {
    throw validationError("首次周评估 as_of 必须是周一 10:00 Asia/Shanghai", {
      first_eval_as_of: firstEvalAsOf.toISOString(),
    });
  }
  const times: Date[] = [];
  let t = firstEvalAsOf.getTime();
  const until = untilAsOf.getTime();
  while (t <= until) {
    times.push(new Date(t));
    t += MS_PER_WEEK;
  }
  return times;
}

/**
 * §17.9.2：以「首次周评估起每个周一 10:00 + 影响该用户的 correction settled_at」
 * 为事件序列（as_of 升序）fold evaluateLevel。纯函数，事实截面由参数传入。
 *
 * 修正事件以 week_base（本周周评估之前的状态）为起点重跑，best_level 只增。
 */
export function replayLevel(params: ReplayLevelParams): ReplayLevelResult {
  const {
    scope,
    facts,
    firstEvalAsOf,
    untilAsOf,
    correctionSettledAts,
    ruleVersion,
    protectionEndAsOf,
  } = params;
  resolveRuleVersion(ruleVersion);

  const initialState = params.initialState ?? { level: 1, best_level: 1, below_count: 0 };
  if (firstEvalAsOf === null) {
    // Q1 没有评估起点时不构造评估事件，等级缓存保持不变。
    return {
      ...initialState,
      week_base: { ...initialState },
      week_base_as_of: null,
      last_inputs: null,
      last_eval_as_of: null,
    };
  }
  if (protectionEndAsOf === null) {
    throw validationError("首次周评估存在时必须提供保护期结束时刻");
  }

  const events: ReplayEvent[] = weeklyEvalTimes(firstEvalAsOf, untilAsOf).map(
    (asOf) => ({ asOf, kind: "weekly" as const }),
  );
  const untilMs = untilAsOf.getTime();
  for (const settledAt of correctionSettledAts) {
    if (settledAt.getTime() <= untilMs) {
      events.push({ asOf: settledAt, kind: "correction" });
    }
  }
  events.sort((a, b) => {
    const diff = a.asOf.getTime() - b.asOf.getTime();
    if (diff !== 0) {
      return diff;
    }
    if (a.kind === b.kind) {
      return 0;
    }
    return a.kind === "weekly" ? -1 : 1;
  });

  let state: LevelEvalState = { level: 1, best_level: 1, below_count: 0 };
  let weekBase: LevelEvalState = { level: 1, best_level: 1, below_count: 0 };
  let weekBaseAsOf: Date | null = null;
  let lastInputs: LevelInputs | null = null;
  let lastEvalAsOf: Date | null = null;

  for (const event of events) {
    const inputs = buildLevelInputs(
      facts,
      scope,
      event.asOf,
      params.levelSeasonId,
    );
    if (event.kind === "weekly") {
      weekBase = { ...state };
      weekBaseAsOf = event.asOf;
      state = evaluateLevel(
        state,
        inputs,
        ruleVersion,
        event.asOf,
        protectionEndAsOf,
      );
    } else {
      const start: LevelEvalState = {
        level: weekBase.level,
        below_count: weekBase.below_count,
        best_level: state.best_level,
      };
      state = evaluateLevel(
        start,
        inputs,
        ruleVersion,
        event.asOf,
        protectionEndAsOf,
      );
    }
    lastInputs = inputs;
    lastEvalAsOf = event.asOf;
  }

  if (lastEvalAsOf === null) {
    return {
      ...initialState,
      week_base: { ...initialState },
      week_base_as_of: null,
      last_inputs: null,
      last_eval_as_of: null,
    };
  }
  return {
    ...state,
    week_base: weekBase,
    week_base_as_of: weekBaseAsOf,
    last_inputs: lastInputs,
    last_eval_as_of: lastEvalAsOf,
  };
}
