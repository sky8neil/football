import { FIXED_CONFIG_V1 } from "./config.js";
import { MatchStatus, type MatchStatus as MatchStatusType } from "./enums.js";
import { validationError } from "./errors.js";
import { isDeadlineOpen } from "./prediction-policy.js";

export interface CrowdResultCounts {
  HOME: number;
  DRAW: number;
  AWAY: number;
}

export interface CrowdDistribution {
  home: number;
  draw: number;
  away: number;
}

export type CrowdStatus = "not_closed" | "insufficient" | "available" | "unavailable";

export interface CrowdMatchLike {
  match_status: MatchStatusType;
  kickoff_confirmed: boolean;
  prediction_closed_at: Date | null;
  prediction_deadline_at: Date | null;
}

export function roundDistribution(counts: CrowdResultCounts): CrowdDistribution {
  const rows = [
    { key: "home" as const, count: counts.HOME, order: 0 },
    { key: "draw" as const, count: counts.DRAW, order: 1 },
    { key: "away" as const, count: counts.AWAY, order: 2 },
  ];
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (
    !rows.every((row) => Number.isSafeInteger(row.count) && row.count >= 0) ||
    !Number.isSafeInteger(total) ||
    total === 0
  ) {
    throw validationError("crowd counts 必须是非负整数且总数大于 0");
  }

  const slots = rows.map((row) => {
    const scaledCount = row.count * 20;
    return {
      ...row,
      whole: Math.floor(scaledCount / total),
      remainder: scaledCount % total,
    };
  });
  const remaining = 20 - slots.reduce((sum, row) => sum + row.whole, 0);
  const priority = [...slots].sort(
    (a, b) => b.remainder - a.remainder || a.order - b.order,
  );
  for (const row of priority.slice(0, remaining)) {
    row.whole += 1;
  }

  return {
    home: slots[0]!.whole * FIXED_CONFIG_V1.CROWD_GRANULARITY_PERCENT,
    draw: slots[1]!.whole * FIXED_CONFIG_V1.CROWD_GRANULARITY_PERCENT,
    away: slots[2]!.whole * FIXED_CONFIG_V1.CROWD_GRANULARITY_PERCENT,
  };
}

export function crowdStatus(input: {
  match: CrowdMatchLike;
  predictionCount: number;
  serverNow: Date;
}): CrowdStatus {
  const { match, predictionCount, serverNow } = input;
  if (
    match.match_status === MatchStatus.Postponed ||
    match.match_status === MatchStatus.Cancelled ||
    match.match_status === MatchStatus.Abandoned
  ) {
    return "unavailable";
  }
  if (!match.kickoff_confirmed || match.prediction_deadline_at === null) {
    return "not_closed";
  }

  const isClosed =
    match.prediction_closed_at !== null ||
    !isDeadlineOpen(match.prediction_deadline_at, serverNow);
  if (!isClosed) {
    return "not_closed";
  }
  return predictionCount < FIXED_CONFIG_V1.CROWD_MIN_PREDICTIONS
    ? "insufficient"
    : "available";
}
