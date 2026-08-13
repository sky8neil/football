import {
  AdminAuditAction,
  ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION,
  ResultSource,
  SCHEMA_VERSION,
  SettlementStatus,
} from "../domain/enums.js";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { conflictError, internalError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid, newUuid } from "../domain/ids.js";
import { assertMatchResultVersionInvariants } from "../domain/invariants.js";
import { validateSettlementTransition } from "../domain/settlement-state-machine.js";
import { planResultCorrection } from "./result-correction-plan.js";
import { assertValidServerNow } from "./period-finalize.js";
import type { AdminAuditLog, Match, MatchResult } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { AdminAuthorizationService } from "./admin.js";
import { transitionMatchSettlementStatus } from "./first-settlement-service.js";

export interface AdminResultCorrectionInput {
  expected_result_version: number;
  regular_home_score: number;
  regular_away_score: number;
  reason: string;
}

export interface AdminResultCorrectionOutcome {
  admin_id: string;
  match: Match;
  result: MatchResult;
  audit_log: AdminAuditLog;
}

/** 第 48.3 节冻结的管理员审计 action。 */
export const ADMIN_RESULT_CORRECTION_AUDIT_ACTION = AdminAuditAction.ResultCorrection;

function assertInput(input: AdminResultCorrectionInput): void {
  if (
    typeof input !== "object" ||
    input === null ||
    !Number.isInteger(input.expected_result_version) ||
    input.expected_result_version < 0 ||
    !Number.isInteger(input.regular_home_score) ||
    input.regular_home_score < FIXED_CONFIG_V1.FINAL_SCORE_MIN ||
    input.regular_home_score > FIXED_CONFIG_V1.FINAL_SCORE_MAX ||
    !Number.isInteger(input.regular_away_score) ||
    input.regular_away_score < FIXED_CONFIG_V1.FINAL_SCORE_MIN ||
    input.regular_away_score > FIXED_CONFIG_V1.FINAL_SCORE_MAX ||
    typeof input.reason !== "string" ||
    input.reason.length < 1 ||
    input.reason.length > 500
  ) {
    throw validationError("管理员赛果修正请求参数无效");
  }
}

function assertResultVersionShape(match: Match): void {
  if (
    (match.result_version === 0 &&
      (match.regular_home_score !== null || match.regular_away_score !== null)) ||
    (match.result_version > 0 &&
      (match.regular_home_score === null || match.regular_away_score === null))
  ) {
    throw internalError("match result_version 与当前正式比分不一致");
  }
}

function nextSettlementStatus(match: Match): SettlementStatus {
  const desired =
    match.settled_result_version > 0
      ? SettlementStatus.Correcting
      : SettlementStatus.Waiting;
  if (desired === match.settlement_status) {
    return desired;
  }
  if (!validateSettlementTransition(match.settlement_status, desired)) {
    throw conflictError(
      "MATCH_STATE_CONFLICT",
      "管理员赛果修正不能绕过结算状态机",
      { from: match.settlement_status, to: desired },
    );
  }
  return desired;
}

function auditValue(next: {
  result_version: number;
  regular_home_score: number | null;
  regular_away_score: number | null;
  result_source: Match["result_source"];
  settlement_status: Match["settlement_status"];
}): Record<string, unknown> {
  return {
    result_version: next.result_version,
    regular_home_score: next.regular_home_score,
    regular_away_score: next.regular_away_score,
    result_source: next.result_source,
    settlement_status: next.settlement_status,
  };
}

export class AdminResultCorrectionService {
  private readonly authorization = new AdminAuthorizationService();

  constructor(private readonly repo: AppRepository) {}

  async correct(
    trustedOpenid: string | null | undefined,
    matchId: string,
    input: AdminResultCorrectionInput,
    serverNow: Date,
  ): Promise<AdminResultCorrectionOutcome> {
    if (typeof matchId !== "string" || !isValidUuid(matchId)) {
      throw validationError("match_id 必须为 UUID v4", { field: "match_id" });
    }
    assertInput(input);
    assertValidServerNow(serverNow);

    return this.repo.withTransaction(async (tx) => {
      const admin = await this.authorization.requireActiveAdmin(tx, trustedOpenid);
      const match = await tx.matches.findById(matchId);
      if (match === null) {
        throw notFoundError("MATCH");
      }
      if (input.expected_result_version !== match.result_version) {
        throw conflictError(
          "RESULT_VERSION_CONFLICT",
          "match 的 result_version 已变化，请重新读取后再修正",
          {
            expected_result_version: input.expected_result_version,
            actual_result_version: match.result_version,
          },
        );
      }

      assertMatchResultVersionInvariants(match);
      assertResultVersionShape(match);
      const plan = planResultCorrection(
        match.result_version,
        match.regular_home_score,
        match.regular_away_score,
        input.regular_home_score,
        input.regular_away_score,
        match.match_status,
        match.settlement_status,
        ResultSource.Admin,
      );
      const settlementStatus = nextSettlementStatus(match);
      const result: MatchResult = {
        schema_version: SCHEMA_VERSION,
        match_id: match.match_id,
        result_version: plan.next_result_version,
        regular_home_score: input.regular_home_score,
        regular_away_score: input.regular_away_score,
        source: ResultSource.Admin,
        provider_status: null,
        admin_id: admin.admin_id,
        reason: input.reason,
        created_at: serverNow,
      };
      await tx.matchResults.insert(result);
      await transitionMatchSettlementStatus(
        tx,
        match.match_id,
        settlementStatus,
        serverNow,
      );
      const transitionedMatch = await tx.matches.findById(match.match_id);
      if (transitionedMatch === null) {
        throw internalError("管理员赛果修正状态转移后比赛不存在");
      }

      const updatedMatch: Match = {
        ...transitionedMatch,
        regular_home_score: input.regular_home_score,
        regular_away_score: input.regular_away_score,
        result_version: result.result_version,
        result_source: ResultSource.Admin,
        updated_at: serverNow,
      };
      await tx.matches.update(updatedMatch);
      const persistedMatch: Match = {
        ...updatedMatch,
        settlement_status: settlementStatus,
      };

      if (tx.adminAuditLogs === undefined) {
        throw internalError("admin_audit_logs repository port 未配置");
      }
      const auditLog: AdminAuditLog = {
        schema_version: SCHEMA_VERSION,
        audit_id: newUuid(),
        admin_id: admin.admin_id,
        action: ADMIN_RESULT_CORRECTION_AUDIT_ACTION,
        entity_type: ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION[ADMIN_RESULT_CORRECTION_AUDIT_ACTION],
        entity_id: match.match_id,
        old_value: auditValue({
          result_version: match.result_version,
          regular_home_score: match.regular_home_score,
          regular_away_score: match.regular_away_score,
          result_source: match.result_source,
          settlement_status: match.settlement_status,
        }),
        new_value: auditValue(persistedMatch),
        reason: input.reason,
        created_at: serverNow,
      };
      await tx.adminAuditLogs.insert(auditLog);

      return {
        admin_id: admin.admin_id,
        match: persistedMatch,
        result,
        audit_log: auditLog,
      };
    });
  }
}
