import { findSupportedLeagueById } from "../domain/config.js";
import type { Provider } from "../domain/enums.js";

export interface ProviderResultObservation {
  provider: Provider;
  status: "finished" | "live" | "unknown" | "other";
  score: { home: number; away: number } | null;
  raw_status: string | null;
  observed_at: Date;
}

export type ProviderResultAdoptionDecision =
  | { kind: "adopt"; provider: Provider; compared_providers: Provider[]; score: { home: number; away: number } }
  | { kind: "wait"; reason: "non_authoritative_single_source" | "no_final_score" }
  | { kind: "anomaly"; reason: "unknown_status" | "score_conflict" | "finished_live_conflict" };

const FINISH_GRACE_MS = 150 * 60_000;

export function decideProviderResultAdoption(
  leagueId: string,
  observations: readonly ProviderResultObservation[],
  kickoffAt: Date,
  now: Date,
): ProviderResultAdoptionDecision {
  if (observations.some((entry) => entry.status === "unknown" || /^(AWARDED|UNKNOWN|UNRESOLVED|AET|PEN)$/i.test(entry.raw_status ?? ""))) {
    return { kind: "anomaly", reason: "unknown_status" };
  }

  const latest = new Map<Provider, ProviderResultObservation>();
  for (const observation of observations) {
    const previous = latest.get(observation.provider);
    if (!previous || observation.observed_at >= previous.observed_at) latest.set(observation.provider, observation);
  }
  const values = [...latest.values()];
  const finished = values.filter((entry) => entry.status === "finished" && entry.score !== null);
  const live = values.filter((entry) => entry.status === "live");
  if (finished.length === 0) return { kind: "wait", reason: "no_final_score" };

  const scoreKey = (score: { home: number; away: number }) => `${score.home}:${score.away}`;
  if (new Set(finished.map((entry) => scoreKey(entry.score!))).size > 1) {
    return { kind: "anomaly", reason: "score_conflict" };
  }
  if (live.length > 0 && now.getTime() >= kickoffAt.getTime() + FINISH_GRACE_MS) {
    return { kind: "anomaly", reason: "finished_live_conflict" };
  }

  const league = findSupportedLeagueById(leagueId);
  const authority: Provider = league?.league_id === "chinese_super_league" ? "bsd" : "football_data";
  const authoritative = finished.find((entry) => entry.provider === authority);
  if (authoritative?.score) {
    return { kind: "adopt", provider: authority, compared_providers: values.map((entry) => entry.provider), score: authoritative.score };
  }

  const fiveDollar = finished.find((entry) => entry.provider === "5dollar");
  const openFoot = finished.find((entry) => entry.provider === "openfoot");
  if (fiveDollar && openFoot && fiveDollar.score && openFoot.score && scoreKey(fiveDollar.score) === scoreKey(openFoot.score)) {
    return { kind: "adopt", provider: "5dollar", compared_providers: values.map((entry) => entry.provider), score: fiveDollar.score };
  }
  return { kind: "wait", reason: "non_authoritative_single_source" };
}
