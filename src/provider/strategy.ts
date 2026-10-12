import type { ProviderBudgetJob } from "./budget.js";
import type { ProviderSource, ProviderSourceId } from "./sources.js";

export interface ProviderRequestDemand {
  league_id: string;
  job_type: ProviderBudgetJob;
}

export interface ProviderRequestBudgetState {
  unavailable_sources?: ReadonlyMap<ProviderSourceId, string>;
  last_success_at?: ReadonlyMap<string, Date>;
}

export interface ProviderRequestPlan {
  source_id: ProviderSourceId;
  league_id: string;
  job_type: ProviderBudgetJob;
  reason: "primary" | "fallback_budget" | "fallback_provider_unavailable";
  planned_at: string;
}

export interface ProviderStrategyConfig {
  sources: readonly ProviderSource[];
}

const PRIORITY: Record<ProviderBudgetJob, number> = {
  post_finish_verify: 0,
  live_match: 1,
  near_match: 2,
  future_schedule: 3,
  full_schedule_verify: 4,
};

function roleForJob(jobType: ProviderBudgetJob): keyof ProviderSource["leagues"][number]["roles"] {
  if (jobType === "future_schedule" || jobType === "full_schedule_verify") return "schedule";
  if (jobType === "near_match") return "kickoff";
  if (jobType === "live_match") return "live";
  return "result";
}

function lastSuccessKey(demand: ProviderRequestDemand): string {
  return `${demand.league_id}:${demand.job_type}`;
}

/**
 * Each demand represents work for one league after its local match window has been selected.
 * The result is pure so callers can inspect the complete priority and fallback plan before dispatch.
 */
export function planRequests(
  now: Date,
  matches: readonly ProviderRequestDemand[],
  budgetState: ProviderRequestBudgetState,
  config: ProviderStrategyConfig,
): ProviderRequestPlan[] {
  const unique = new Map<string, ProviderRequestDemand>();
  for (const match of matches) unique.set(lastSuccessKey(match), match);

  const demands = [...unique.values()].sort((left, right) => {
    const priority = PRIORITY[left.job_type] - PRIORITY[right.job_type];
    if (priority !== 0) return priority;
    const leftAt = budgetState.last_success_at?.get(lastSuccessKey(left))?.getTime() ?? Number.NEGATIVE_INFINITY;
    const rightAt = budgetState.last_success_at?.get(lastSuccessKey(right))?.getTime() ?? Number.NEGATIVE_INFINITY;
    return leftAt - rightAt || left.league_id.localeCompare(right.league_id);
  });

  const plans: ProviderRequestPlan[] = [];
  for (const demand of demands) {
    const role = roleForJob(demand.job_type);
    const entries = config.sources.flatMap((source) => {
      const league = source.leagues.find((entry) => entry.league_id === demand.league_id);
      return league ? [{ source, league }] : [];
    });
    const primary = entries.find((entry) => entry.league.roles[role] === "primary");
    const primaryUnavailable = primary
      ? budgetState.unavailable_sources?.get(primary.source.source_id)
      : undefined;
    const selected = primary && primaryUnavailable === undefined
      ? { entry: primary, reason: "primary" as const }
      : entries
        .filter((entry) => entry.league.roles[role] === "fallback" || entry.league.roles[role] === "secondary")
        .find((entry) => budgetState.unavailable_sources?.has(entry.source.source_id) !== true);

    if (!selected) continue;
    const entry = "entry" in selected ? selected.entry : selected;
    plans.push({
      source_id: entry.source.source_id,
      league_id: demand.league_id,
      job_type: demand.job_type,
      reason: "entry" in selected
        ? selected.reason
        : primaryUnavailable === "provider_unavailable" ? "fallback_provider_unavailable" : "fallback_budget",
      planned_at: now.toISOString(),
    });
  }
  return plans;
}
