import { MatchStatus, SettlementStatus } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import { activeWindow } from "../application/provider-active-window.js";
import { coerceMatchKickoff, kickoffMs } from "./settlement-todo-query.js";

export type ActiveWindowJob = "near_match" | "live_match" | "post_finish_verify" | "stale_recovery";

export interface ActiveWindowQuery {
  jobType: ActiveWindowJob;
  now: Date;
  /** 合并去重后返回的最大条数；按 kickoff_at 升序取前 N。 */
  limit: number;
  /** 仅 post_finish_verify 使用：是否由持久化状态允许当日超 24h 每日兜底。 */
  includeOverdueDailyFallback?: boolean;
}

/** 单个数据库查询片段：等值条件和可选 kickoff_at 上下界。 */
export interface ActiveWindowFilterFragment {
  equals: Record<string, string>;
  /** 为 true 时在数据库侧下推 superseded_by = null 过滤，防止历史改期记录占满分页上限。 */
  supersededByNull?: boolean;
  kickoffAtGte?: Date;
  /** 上界（含），作用于 kickoff_at；缺省表示不限。 */
  kickoffAtLte?: Date;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** 滞留场次告警中最多附带多少条样本明细，避免聚合日志本身过长。 */
const STALE_ALERT_SAMPLE_LIMIT = 10;

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
    const kickoffAtGte = new Date(nowMs - 6 * HOUR_MS);
    const kickoffAtLte = new Date(nowMs + 2 * HOUR_MS);
    return [
      { equals: { match_status: MatchStatus.Live }, kickoffAtGte, kickoffAtLte },
      {
        equals: { match_status: MatchStatus.Scheduled },
        kickoffAtGte,
        kickoffAtLte,
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
      ...[MatchStatus.Live, MatchStatus.Scheduled].flatMap((status) =>
        [SettlementStatus.Pending, SettlementStatus.Waiting].map((settlement) => ({
          equals: { match_status: status, settlement_status: settlement },
          kickoffAtGte: new Date(nowMs - 6 * HOUR_MS), kickoffAtLte,
        }))),
    ];
  }
  if (query.jobType === "stale_recovery") {
    const kickoffAtLte = new Date(nowMs - 6 * HOUR_MS);
    return [MatchStatus.Scheduled, MatchStatus.Live].map((status) => ({
      equals: { match_status: status },
      supersededByNull: true,
      kickoffAtLte,
    }));
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
  if (query.jobType === "live_match") {
    const staleKickoffBefore = query.now.getTime() - 6 * HOUR_MS;
    const stale = coerced.filter(
      (match) =>
        (match.match_status === MatchStatus.Scheduled || match.match_status === MatchStatus.Live) &&
        match.kickoff_at.getTime() < staleKickoffBefore,
    );
    if (stale.length > 0) {
      // 逐场告警会在滞留场次多时刷爆日志（曾出现单轮 240 条 / 每 15 分钟一轮），
      // 因此按轮聚合成一条：给出总量、按联赛分布与有限条样本明细。
      const leagueCounts = new Map<string, number>();
      for (const match of stale) {
        leagueCounts.set(match.league_id, (leagueCounts.get(match.league_id) ?? 0) + 1);
      }
      console.warn("[live_match_stale]", {
        count: stale.length,
        scheduled_count: stale.filter((match) => match.match_status === MatchStatus.Scheduled).length,
        live_count: stale.filter((match) => match.match_status === MatchStatus.Live).length,
        leagues: [...leagueCounts.entries()].map(([league_id, count]) => ({ league_id, count })),
        sample: stale.slice(0, STALE_ALERT_SAMPLE_LIMIT).map((match) => ({
          match_id: match.match_id,
          league_id: match.league_id,
          kickoff_at: match.kickoff_at.toISOString(),
        })),
        server_now: query.now.toISOString(),
      });
    }
  }
  const filtered = activeWindow(
    coerced,
    query.now,
    query.jobType,
    query.includeOverdueDailyFallback === undefined
      ? undefined
      : { includeOverdueDailyFallback: query.includeOverdueDailyFallback },
  );
  const seen = new Set<string>();
  const unique: Match[] = [];
  for (const match of filtered.sort(compareActiveWindow)) {
    if (seen.has(match.match_id)) continue;
    seen.add(match.match_id);
    unique.push(match);
  }
  return unique.slice(0, Math.max(0, query.limit));
}
