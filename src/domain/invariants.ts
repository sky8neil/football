/**
 * 核心 Invariants（规范第 40 节）。
 *
 * 事务前后应调用相应断言；违反即抛出 InternalError（数据损坏）。
 */
import { SCHEMA_VERSION, SettlementDocStatus, SettlementPhase } from "./enums.js";
import { FIXED_CONFIG_V1 } from "./config.js";
import { internalError } from "./errors.js";
import type {
  BoardSnapshot,
  Group,
  GroupMember,
  LevelHistoryEntry,
  LevelState,
  Match,
  Prediction,
  RankingEntry,
  SettlementDoc,
  SettlementItem,
  User,
  UserSeasonStats,
} from "./types.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw internalError(message);
  }
}

/** 规范 2.5：核心业务文档必须携带固定 schema_version=1；未知版本 Fail Closed。 */
export function assertSchemaVersion(version: unknown): asserts version is typeof SCHEMA_VERSION {
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version !== SCHEMA_VERSION
  ) {
    throw internalError(`unsupported schema_version: ${String(version)}`);
  }
}

function assertLevelRange(field: string, value: number): void {
  assert(Number.isInteger(value) && value >= FIXED_CONFIG_V1.LEVEL_MIN, `${field} >= 1`);
  assert(value <= FIXED_CONFIG_V1.LEVEL_MAX, `${field} <= 6`);
}

function assertLevelState(state: LevelState, prefix: string): void {
  assert(
    state.below_count === 0 || state.below_count === 1,
    `${prefix}.below_count in {0,1}`,
  );
  assert(
    Number.isInteger(state.last_eval_n) &&
      state.last_eval_n >= 0 &&
      state.last_eval_n <= FIXED_CONFIG_V1.LEVEL_WINDOW_MAX_N,
    `${prefix}.last_eval_n <= 300`,
  );
  assert(
    Number.isInteger(state.last_eval_score_sum) &&
      state.last_eval_score_sum >= 0 &&
      state.last_eval_score_sum <= 12 * state.last_eval_n,
    `0 <= ${prefix}.last_eval_score_sum <= 12n`,
  );
}

export function assertUserCareerInvariants(user: User): void {
  assertSchemaVersion(user.schema_version);
  assert(user.career_points >= 0, "career_points >= 0");
  assert(user.career_valid_predictions >= 0, "career_valid_predictions >= 0");
  assert(user.career_wdl_hits >= 0, "career_wdl_hits >= 0");
  assert(user.career_exact_hits >= 0, "career_exact_hits >= 0");
  assert(
    user.career_exact_hits <= user.career_wdl_hits,
    "career_exact_hits <= career_wdl_hits",
  );
  assert(
    user.career_wdl_hits <= user.career_valid_predictions,
    "career_wdl_hits <= career_valid_predictions",
  );
  assertLevelRange("career_level", user.career_level);
  assertLevelRange("career_best_level", user.career_best_level);
  assert(
    user.career_level < 2 || user.career_valid_predictions >= FIXED_CONFIG_V1.LEVEL_RATED_MIN_VALID,
    "career_level >= 2 requires career_valid_predictions >= 20",
  );
  assert(
    user.career_best_level >= user.career_level,
    "career_best_level >= career_level",
  );

  if (user.career_level_state !== undefined) {
    assertLevelState(user.career_level_state, "career_level_state");
  }
}

export function assertSeasonStatsInvariants(stats: UserSeasonStats): void {
  assertSchemaVersion(stats.schema_version);
  assert(stats.points >= 0, "season points >= 0");
  assert(stats.valid_predictions >= 0, "season valid_predictions >= 0");
  assert(stats.wdl_hits >= 0, "season wdl_hits >= 0");
  assert(stats.exact_hits >= 0, "season exact_hits >= 0");
  assert(stats.exact_hits <= stats.wdl_hits, "season exact_hits <= wdl_hits");
  assert(
    stats.wdl_hits <= stats.valid_predictions,
    "season wdl_hits <= valid_predictions",
  );
  assertLevelRange("season level", stats.level);
  assertLevelRange("season best_level", stats.best_level);
  assert(stats.best_level >= stats.level, "season best_level >= level");
  assert(
    stats.level < 2 || stats.valid_predictions >= FIXED_CONFIG_V1.LEVEL_RATED_MIN_VALID,
    "season level >= 2 requires 20 valid_predictions",
  );

  if (stats.level_state !== undefined) {
    assertLevelState(stats.level_state, "level_state");
  }
}

export function assertRankingInvariants(entry: RankingEntry): void {
  assertSchemaVersion(entry.schema_version);
  assert(entry.period_score >= 0, "rankings period_score >= 0");
  assert(entry.valid_predictions >= 0, "rankings valid_predictions >= 0");
  assert(entry.wdl_hits >= 0, "rankings wdl_hits >= 0");
  assert(entry.exact_hits >= 0, "rankings exact_hits >= 0");
  assert(entry.exact_hits <= entry.wdl_hits, "rankings exact_hits <= wdl_hits");
  assert(
    entry.wdl_hits <= entry.valid_predictions,
    "rankings wdl_hits <= valid_predictions",
  );
}

export function assertLevelHistoryInvariants(entry: LevelHistoryEntry): void {
  assertSchemaVersion(entry.schema_version);
  assertLevelRange("from_level", entry.from_level);
  assertLevelRange("to_level", entry.to_level);
  assert(entry.from_level !== entry.to_level, "level_history from != to");
  assert(
    entry.reason === "weekly_eval" ||
      entry.reason === "correction_reeval" ||
      entry.reason === "rebuild",
    "level_history reason closed",
  );
  assert(
    entry.reason === "rebuild" || Math.abs(entry.to_level - entry.from_level) <= 1,
    "non-rebuild level_history changes at most one level",
  );
}

export function assertBoardSnapshotInvariants(snapshot: BoardSnapshot): void {
  assertSchemaVersion(snapshot.schema_version);
  assert(snapshot.board === "career" || snapshot.board === "strength", "board in {career,strength}");
  assert(Number.isInteger(snapshot.rank) && snapshot.rank >= 1, "snapshot rank >= 1");
  if (snapshot.snapshot_kind === "head") {
    assert(snapshot.user_id === "00000000-0000-0000-0000-000000000000", "snapshot head user id");
    assert(snapshot.rank === 1, "snapshot head rank");
    assert(
      snapshot.career_points === null &&
        snapshot.career_exact_hits === null &&
        snapshot.career_valid_predictions === null &&
        snapshot.career_last_scoring_match_at === null &&
        snapshot.window_score_sum === null &&
        snapshot.window_n === null,
      "snapshot head payload is empty",
    );
  } else {
    assert(snapshot.snapshot_kind === undefined, "snapshot kind closed");
  }
}

export function assertGroupInvariants(group: Group): void {
  assertSchemaVersion(group.schema_version);
  assert(group.member_count >= 0, "groups.member_count >= 0");
  assert(group.status === "active" || group.status === "dissolved", "group status closed");
}

export function assertGroupMemberInvariants(member: GroupMember): void {
  assertSchemaVersion(member.schema_version);
  assert(member.status === "active" || member.status === "left", "group member status closed");
}

export function assertPredictionInvariants(prediction: Prediction): void {
  assertSchemaVersion(prediction.schema_version);
  if (prediction.match_score !== null) {
    assert(
      prediction.match_score === 0 ||
        prediction.match_score === 3 ||
        prediction.match_score === 12,
      "prediction.match_score in {0,3,12}",
    );
  }
  if (prediction.exact_hit === true) {
    assert(prediction.wdl_hit === true, "exact_hit => wdl_hit");
  }
}

export function assertSettlementItemInvariant(item: SettlementItem): void {
  assertSchemaVersion(item.schema_version);
  assert(
    item.old_score === 0 || item.old_score === 3 || item.old_score === 12,
    "settlement_item old_score in {0,3,12}",
  );
  assert(
    item.new_score === 0 || item.new_score === 3 || item.new_score === 12,
    "settlement_item new_score in {0,3,12}",
  );
  assert(
    item.score_delta === item.new_score - item.old_score,
    "score_delta = new_score - old_score",
  );
  assert(
    item.old_exact_hit === false || item.old_wdl_hit === true,
    "settlement_item old_exact_hit => old_wdl_hit",
  );
  assert(
    item.new_exact_hit === false || item.new_wdl_hit === true,
    "settlement_item new_exact_hit => new_wdl_hit",
  );
  assert(
    item.valid_prediction_delta === 0 || item.valid_prediction_delta === 1,
    "settlement_item valid_prediction_delta in {0,1}",
  );
  assert(
    item.source_result_version >= 1,
    "settlement_item source_result_version >= 1",
  );
}

export function assertSettlementDocumentInvariant(settlement: SettlementDoc): void {
  assertSchemaVersion(settlement.schema_version);
  assert(
    Number.isInteger(settlement.result_version) && settlement.result_version >= 1,
    "settlement.result_version integer >= 1",
  );
  assert(
    Number.isInteger(settlement.attempt_count) && settlement.attempt_count >= 0,
    "settlement.attempt_count integer >= 0",
  );
  assert(
    settlement.status === SettlementDocStatus.Pending ||
      settlement.status === SettlementDocStatus.Running ||
      settlement.status === SettlementDocStatus.Settled ||
      settlement.status === SettlementDocStatus.Failed,
    "settlement.status in {pending,running,settled,failed}",
  );
  assert(
    settlement.phase === SettlementPhase.Prepare ||
      settlement.phase === SettlementPhase.ApplyItems ||
      settlement.phase === SettlementPhase.RebuildRanks ||
      settlement.phase === SettlementPhase.Finalize ||
      settlement.phase === SettlementPhase.Done,
    "settlement.phase in {prepare,apply_items,rebuild_ranks,finalize,done}",
  );
}

export function assertMatchResultVersionInvariants(match: Match): void {
  assertSchemaVersion(match.schema_version);
  assert(match.result_version >= 0, "result_version >= 0");
  assert(match.settled_result_version >= 0, "settled_result_version >= 0");
  assert(
    match.settled_result_version <= match.result_version,
    "settled_result_version <= result_version",
  );
  if (match.settlement_status === "settled") {
    assert(
      match.settled_result_version === match.result_version,
      "settled => settled_result_version == result_version",
    );
  }
}

export function assertPredictionClosedAtImmutable(
  before: Date | null,
  after: Date | null,
): void {
  if (before !== null && before.getTime() !== after?.getTime()) {
    throw internalError("prediction_closed_at 一旦非 null 不得修改");
  }
}

export function assertPeriodAnchorImmutable(
  before: Date | null,
  after: Date | null,
): void {
  if (before !== null && before.getTime() !== after?.getTime()) {
    throw internalError("period_anchor_at 一旦非 null 不得修改");
  }
}

export function assertFinishDetectedImmutable(
  before: Date | null,
  after: Date | null,
): void {
  if (before !== null && before.getTime() !== after?.getTime()) {
    throw internalError("finish_detected_at 一旦非 null 不得修改");
  }
}
