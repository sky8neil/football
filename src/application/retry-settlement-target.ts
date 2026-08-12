import { SettlementDocStatus, SettlementStatus } from "../domain/enums.js";
import { conflictError, internalError } from "../domain/errors.js";
import type { Match, SettlementDoc } from "../domain/types.js";

export type RetrySettlementTargetMatch = Pick<
  Match,
  | "match_id"
  | "result_version"
  | "settled_result_version"
  | "settlement_status"
  | "scoring_rule_version"
>;

function consistencyError(message: string): never {
  throw internalError(`retry settlement 数据一致性异常：${message}`);
}

/**
 * 按第 48.5 节唯一规则选择管理员 retry 目标。
 * 选择前验证版本连续性与 settlement 关键字段，发现冲突时拒绝猜测。
 */
export function selectFailedSettlementTarget(
  match: RetrySettlementTargetMatch,
  failedSettlements: readonly SettlementDoc[],
  allSettlements?: readonly SettlementDoc[],
): SettlementDoc {
  if (
    !Number.isInteger(match.result_version) ||
    match.result_version < 0 ||
    !Number.isInteger(match.settled_result_version) ||
    match.settled_result_version < 0 ||
    match.settled_result_version > match.result_version
  ) {
    consistencyError("match 结果版本无效");
  }
  if (
    match.settlement_status === SettlementStatus.Settled &&
    match.settled_result_version !== match.result_version
  ) {
    consistencyError("settled match 未追平 result_version");
  }

  const relevantAll = (allSettlements ?? failedSettlements).filter(
    (settlement) => settlement.match_id === match.match_id,
  );
  const relevant = failedSettlements.filter((settlement) => settlement.match_id === match.match_id);
  if (allSettlements !== undefined) {
    const completeSettlementIds = new Set(
      relevantAll.map((settlement) => settlement.settlement_id),
    );
    const failedSettlementIds = new Set(
      relevant.map((settlement) => settlement.settlement_id),
    );
    for (const settlement of relevant) {
      if (!completeSettlementIds.has(settlement.settlement_id)) {
        consistencyError("failed settlement 不在完整 settlement 列表中");
      }
    }
    for (const settlement of relevantAll) {
      if (
        settlement.status === SettlementDocStatus.Failed &&
        !failedSettlementIds.has(settlement.settlement_id)
      ) {
        consistencyError("完整 settlement 列表中的 failed settlement 未传入");
      }
    }
  }
  if (relevant.length === 0) {
    if (match.settlement_status === SettlementStatus.Failed) {
      consistencyError("match 为 failed 但找不到对应 failed settlement");
    }
    throw conflictError("SETTLEMENT_NOT_READY", "比赛当前没有可重试的 failed settlement");
  }

  const seenVersions = new Set<number>();
  for (const settlement of relevantAll) {
    if (
      !Number.isInteger(settlement.result_version) ||
      settlement.result_version < 1 ||
      settlement.result_version > match.result_version
    ) {
      consistencyError("settlement result_version 无效");
    }
    if (settlement.rule_version !== match.scoring_rule_version) {
      consistencyError("settlement rule_version 与 match 不一致");
    }
    if (settlement.status === SettlementDocStatus.Running) {
      consistencyError("同一 match 存在 running settlement");
    }
    if (seenVersions.has(settlement.result_version)) {
      consistencyError("同一 result_version 存在多个 settlement");
    }
    seenVersions.add(settlement.result_version);
    if (
      settlement.result_version <= match.settled_result_version &&
      settlement.status !== SettlementDocStatus.Settled
    ) {
      consistencyError("已追平 result_version 存在未完成 settlement");
    }
    if (
      settlement.status === SettlementDocStatus.Settled &&
      settlement.result_version > match.settled_result_version
    ) {
      consistencyError("更高 result_version 已 settled 但 match 未追平");
    }
  }

  if (allSettlements !== undefined) {
    const firstSettlementVersion = Math.min(
      ...relevantAll.map((settlement) => settlement.result_version),
    );
    for (const settlement of relevantAll) {
      const expectedCorrection = settlement.result_version !== firstSettlementVersion;
      if (settlement.is_correction !== expectedCorrection) {
        consistencyError("settlement correction 标记与版本序列不一致");
      }
    }
  }

  if (allSettlements !== undefined) {
    for (let version = 1; version <= match.settled_result_version; version += 1) {
      if (!relevantAll.some((settlement) => settlement.result_version === version)) {
        consistencyError(`已追平 result_version 缺少 settlement（result_version=${version}）`);
      }
    }
  }

  const existingOutstanding = relevantAll
    .filter((settlement) => settlement.result_version > match.settled_result_version)
    .sort((a, b) => a.result_version - b.result_version);
  const firstOutstandingVersion =
    match.settled_result_version === 0
      ? existingOutstanding[0]?.result_version
      : match.settled_result_version + 1;
  if (firstOutstandingVersion === undefined) {
    consistencyError("无法解析首个未完成 settlement 版本");
  }
  for (let index = 0; index < existingOutstanding.length; index += 1) {
    const settlement = existingOutstanding[index];
    if (settlement === undefined) {
      consistencyError("已有 settlement 版本列表为空洞");
    }
    if (settlement.result_version !== firstOutstandingVersion + index) {
      consistencyError("已有 settlement 版本存在缺失");
    }
  }

  const expectedCorrection = match.settled_result_version > 0;
  for (const settlement of relevant) {
    if (
      settlement.status !== SettlementDocStatus.Failed ||
      !Number.isInteger(settlement.result_version) ||
      settlement.result_version < 1
    ) {
      consistencyError("failed settlement 的状态或 result_version 无效");
    }
    if (settlement.rule_version !== match.scoring_rule_version) {
      consistencyError("settlement rule_version 与 match 不一致");
    }
    if (settlement.result_version <= match.settled_result_version) {
      consistencyError("failed settlement 早于或等于 settled_result_version");
    }
    if (settlement.result_version > match.result_version) {
      consistencyError("failed settlement 超过 match 当前 result_version");
    }
    if (settlement.is_correction !== expectedCorrection) {
      consistencyError("settlement correction 标记与 match 版本状态不一致");
    }
  }

  const ordered = [...relevant].sort((a, b) => a.result_version - b.result_version);
  for (let index = 0; index < ordered.length; index += 1) {
    const settlement = ordered[index];
    if (settlement === undefined) {
      consistencyError("failed settlement 目标列表为空洞");
    }
    if (settlement.result_version !== firstOutstandingVersion + index) {
      consistencyError("failed settlement 版本存在缺失或重复");
    }
    if (
      index > 0 &&
      settlement.result_version === ordered[index - 1]?.result_version
    ) {
      consistencyError("同一 result_version 存在多个 failed settlement");
    }
  }

  const target = ordered[0];
  if (target === undefined) {
    consistencyError("无法解析 failed settlement 目标");
  }
  return target;
}
