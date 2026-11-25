import {
  AdminAuditAction,
  ADMIN_AUDIT_ENTITY_TYPE_BY_ACTION,
  AnomalyStatus,
  AnomalyType,
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
import { AdminAuthorizationService, type AdminWriteAuthorizer } from "./admin.js";
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
  resolved_anomaly_ids?: string[];
}

/** 第 48.3 节冻结的管理员审计 action。 */
export const ADMIN_RESULT_CORRECTION_AUDIT_ACTION = AdminAuditAction.ResultCorrection;

/**
 * 赛果修正同事务内自动解除的赛果/状态类阻塞及冲突异常白名单（A-S8-03）。
 * 队伍变更（TEAM_CHANGE_AFTER_PREDICTION）与开球时间变更（KICKOFF_CHANGE_AFTER_ANCHOR）
 * 属于比赛身份/盘口完整性异常，不在此白名单内，需由管理员单独核查解除。
 */
export const RESULT_CORRECTION_AUTO_RESOLVE_ANOMALY_TYPES: ReadonlySet<AnomalyType> = new Set([
  AnomalyType.FinishedNoScore,
  AnomalyType.InvalidFinalScore,
  AnomalyType.LiveTooLong,
  AnomalyType.ProviderStateConflict,
  AnomalyType.UnexpectedProviderStatus,
  AnomalyType.AdminProviderResultConflict,
  AnomalyType.ProviderResultConflict,
  AnomalyType.ProviderResultPending,
]);

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
    input.reason.trim().length < 1 ||
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
  if (match.settled_result_version > 0) {
    if (match.settlement_status === SettlementStatus.Correcting) {
      return SettlementStatus.Correcting;
    }
    if (!validateSettlementTransition(match.settlement_status, SettlementStatus.Correcting)) {
      throw conflictError(
        "MATCH_STATE_CONFLICT",
        "管理员赛果修正不能绕过结算状态机",
        { from: match.settlement_status, to: SettlementStatus.Correcting },
      );
    }
    return SettlementStatus.Correcting;
  }

  // settled_result_version == 0（§30.3：保持/进入 waiting）：settling/failed 保持。
  if (match.settlement_status === SettlementStatus.Pending) {
    if (!validateSettlementTransition(SettlementStatus.Pending, SettlementStatus.Waiting)) {
      throw conflictError(
        "MATCH_STATE_CONFLICT",
        "管理员赛果修正不能绕过结算状态机",
        { from: match.settlement_status, to: SettlementStatus.Waiting },
      );
    }
    return SettlementStatus.Waiting;
  }
  if (
    match.settlement_status === SettlementStatus.Waiting ||
    match.settlement_status === SettlementStatus.Settling ||
    match.settlement_status === SettlementStatus.Failed
  ) {
    return match.settlement_status;
  }
  throw conflictError("MATCH_STATE_CONFLICT", "管理员首次赛果与当前结算状态不一致", {
    from: match.settlement_status,
  });
}

function requireMatchPatchPorts(matches: AppRepository["matches"]): {
  findByIdForUpdate: (matchId: string) => Promise<Match | null>;
  patchFields: (matchId: string, fields: Partial<Match>) => Promise<void>;
} {
  const { findByIdForUpdate, patchFields } = matches;
  if (findByIdForUpdate === undefined || patchFields === undefined) {
    throw internalError("matches 行锁与局部更新端口未配置");
  }
  return { findByIdForUpdate, patchFields };
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

export class AdminResultCorrectionService implements AdminWriteAuthorizer {
  private readonly authorization = new AdminAuthorizationService();

  constructor(private readonly repo: AppRepository) {}

  authorizeAdmin(trustedOpenid: string): Promise<void> {
    return this.authorization.authorizeAdmin(this.repo, trustedOpenid);
  }

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
      const { findByIdForUpdate, patchFields } = requireMatchPatchPorts(tx.matches);
      const match = await findByIdForUpdate(matchId);
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
        match.settled_result_version,
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
      const persistedMatch: Match = {
        ...match,
        regular_home_score: input.regular_home_score,
        regular_away_score: input.regular_away_score,
        result_version: result.result_version,
        result_source: ResultSource.Admin,
        settlement_status: settlementStatus,
        updated_at: serverNow,
      };
      assertMatchResultVersionInvariants(persistedMatch);
      await patchFields(match.match_id, {
        regular_home_score: persistedMatch.regular_home_score,
        regular_away_score: persistedMatch.regular_away_score,
        result_version: persistedMatch.result_version,
        result_source: persistedMatch.result_source,
        updated_at: serverNow,
      });

      if (tx.adminAuditLogs === undefined) {
        throw internalError("admin_audit_logs repository port 未配置");
      }
      const auditId = newUuid();
      const resolvedAnomalyIds: string[] = [];
      if (tx.anomalies !== undefined) {
        const openAnomalies = tx.anomalies.findOpenByMatch !== undefined
          ? await tx.anomalies.findOpenByMatch(match.match_id)
          : await tx.anomalies.findOpenBlockingByMatch(match.match_id);
        const resolution = `admin_result_correction:${auditId}`;
        for (const anomaly of openAnomalies) {
          if (!RESULT_CORRECTION_AUTO_RESOLVE_ANOMALY_TYPES.has(anomaly.type)) {
            continue;
          }
          await tx.anomalies.update({
            ...anomaly,
            status: AnomalyStatus.Resolved,
            resolved_at: serverNow,
            resolution,
          });
          resolvedAnomalyIds.push(anomaly.anomaly_id);
        }
      }

      const newValue = auditValue(persistedMatch);
      if (resolvedAnomalyIds.length > 0) {
        newValue.resolved_anomaly_ids = resolvedAnomalyIds;
      }
      const auditLog: AdminAuditLog = {
        schema_version: SCHEMA_VERSION,
        audit_id: auditId,
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
        new_value: newValue,
        reason: input.reason,
        created_at: serverNow,
      };
      await tx.adminAuditLogs.insert(auditLog);

      return {
        admin_id: admin.admin_id,
        match: persistedMatch,
        result,
        audit_log: auditLog,
        ...(resolvedAnomalyIds.length > 0 ? { resolved_anomaly_ids: resolvedAnomalyIds } : {}),
      };
    });
  }
}
