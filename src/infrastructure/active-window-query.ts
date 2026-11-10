import { MatchStatus, SettlementStatus } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import { activeWindow } from "../application/provider-active-window.js";
import { coerceMatchKickoff, kickoffMs } from "./settlement-todo-query.js";

export type ActiveWindowJob = "near_match" | "live_match" | "post_finish_verify";

export interface ActiveWindowQuery {
  jobType: ActiveWindowJob;
  now: Date;
  /** 合并去重后返回的最大条数；按 kickoff_at 升序取前 N。 */
  limit: number;
}

/** 单个数据库查询片段：等值条件 + 至多一个 kickoff_at 上界。 */
export interface ActiveWindowFilterFragment {
  equals: Record<string, string>;
  /** 上界（含），作用于 kickoff_at；缺省表示不限。 */
  kickoffAtLte?: Date;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** 按上面的设计返回该任务需要的查询片段（取并集）。 */
export function buildActiveWindowFilters(query: ActiveWindowQuery): ActiveWindowFilterFragment[] {
  const nowMs = query.now.getTime();
  if (query.jobType === "near_match") {
    return [{
      equals: { match_status: MatchStatus.Scheduled },
      kickoffAtLte: new Date(nowMs + 24 * HOUR_MS),
    }];
  }
  if (query.jobType === "live_match") {
    return [
      { equals: { match_status: MatchStatus.Live } },
      {
        equals: { match_status: MatchStatus.Scheduled },
        kickoffAtLte: new Date(nowMs + 2 * HOUR_MS),
      },
    ];
  }
  if (query.jobType === "post_finish_verify") {
    /**
     * 上界取 now 而不是 now-105min：`activeWindow` 的 due 条件还有一条
     * 「finish_detected_at != null」，赛事可能已置完场时间但 match_status 尚未转 finished，
     * 且开球不足 105 分钟。若按 now-105min 截断，这类比赛会被静默漏掉，要等 105 分钟
     * 才被捡回来。放到 now 是覆盖全部已开球情形的必要条件；集合本身很小（待结算集）。
     */
    const kickoffAtLte = query.now;
    return [
      {
        equals: {
          match_status: MatchStatus.Finished,
          settlement_status: SettlementStatus.Pending,
        },
      },
      {
        equals: {
          match_status: MatchStatus.Finished,
          settlement_status: SettlementStatus.Waiting,
        },
      },
      {
        equals: { settlement_status: SettlementStatus.Pending },
        kickoffAtLte,
      },
      {
        equals: { settlement_status: SettlementStatus.Waiting },
        kickoffAtLte,
      },
    ];
  }
  return [];
}

function compareActiveWindow(left: Match, right: Match): number {
  const kickoffDelta = kickoffMs(left.kickoff_at) - kickoffMs(right.kickoff_at);
  if (kickoffDelta !== 0) return kickoffDelta;
  if (left.match_id < right.match_id) return -1;
  if (left.match_id > right.match_id) return 1;
  return 0;
}

/** 内存侧最终裁剪：复用现有 activeWindow()，再按 kickoff_at/match_id 排序取前 limit 条。 */
export function selectActiveWindow(
  matches: Iterable<Match>,
  query: ActiveWindowQuery,
): Match[] {
  const coerced = [...matches].map(coerceMatchKickoff);
  const filtered = activeWindow(coerced, query.now, query.jobType);
  const seen = new Set<string>();
  const unique: Match[] = [];
  for (const match of filtered.sort(compareActiveWindow)) {
    if (seen.has(match.match_id)) continue;
    seen.add(match.match_id);
    unique.push(match);
  }
  return unique.slice(0, Math.max(0, query.limit));
}
