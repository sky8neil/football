import type { Match, Prediction } from "../domain/types.js";

export interface IdentityMigrationInput {
  matches: Match[];
  predictions: Prediction[];
}

export interface IdentityMigrationPlan {
  match_updates: Array<{ match_id: string; before: { canonical_match_id: string | null; superseded_by: string | null }; after: { canonical_match_id: string; superseded_by: string | null }; reasons: string[] }>;
  prediction_updates: Array<{ prediction_id: string; user_id: string; match_id: string; before_canonical_match_id: string | null; after_canonical_match_id: string; reasons: string[] }>;
  review: Array<{ kind: "ambiguous_identity" | "duplicate_prediction" | "dangling_prediction_match"; key: Record<string, string | null>; details: string }>;
}

export function planIdentityMigration({ matches, predictions }: IdentityMigrationInput): IdentityMigrationPlan {
  const plan: IdentityMigrationPlan = { match_updates: [], prediction_updates: [], review: [] };
  const byId = new Map(matches.map((match) => [match.match_id, match]));
  const groups = new Map<string, Match[]>();
  const after = new Map<string, { canonical_match_id: string; superseded_by: string | null }>();
  const reasons = new Map<string, string[]>();
  const blocked = new Set<string>();
  const inboundIds = new Set(matches.flatMap((match) => match.superseded_by == null ? [] : [match.superseded_by]));
  for (const match of matches) {
    after.set(match.match_id, { canonical_match_id: match.canonical_match_id ?? match.match_id, superseded_by: match.superseded_by ?? null });
    reasons.set(match.match_id, []);
    if (match.superseded_by == null) {
      const key = JSON.stringify([match.league_id, match.season_id, match.home_team_id, match.away_team_id]);
      groups.set(key, [...(groups.get(key) ?? []), match]);
    }
  }
  for (const group of groups.values()) {
    if (new Set(group.map((match) => match.canonical_match_id ?? match.match_id)).size <= 1) continue;
    const finished = group.filter((match) => match.match_status === "finished");
    const invalid = group.filter((match) => !["finished", "scheduled", "live", "postponed"].includes(match.match_status));
    const target = finished[0];
    const inbound = group.some((match) => match !== target && inboundIds.has(match.match_id));
    if (finished.length !== 1 || invalid.length > 0 || inbound) {
      const first = group[0]!;
      const why = [finished.length === 0 ? "无 finished 终态" : finished.length > 1 ? "多条 finished 终态" : "", invalid.length ? "含 cancelled、abandoned 或其他不允许的状态" : "", inbound ? "候选记录已有入向取代关系，逐条改写会违反禁止链式及身份不变量" : ""].filter(Boolean).join("；");
      plan.review.push({ kind: "ambiguous_identity", key: { league_id: first.league_id, season_id: first.season_id, home_team_id: first.home_team_id, away_team_id: first.away_team_id }, details: `状态：${group.map((match) => `${match.match_id}:${match.match_status}`).join("、")}；${why}；缺少安全自动归并依据` });
      group.forEach((match) => blocked.add(match.match_id));
      continue;
    }
    const canonical = target!.canonical_match_id ?? target!.match_id;
    for (const match of group) {
      after.set(match.match_id, { canonical_match_id: canonical, superseded_by: match === target ? null : target!.match_id });
      reasons.get(match.match_id)!.push(`唯一 finished ${target!.match_id}；其余为 scheduled/live/postponed`);
    }
  }
  for (const match of matches) {
    const next = after.get(match.match_id)!;
    const target = next.superseded_by == null ? undefined : after.get(next.superseded_by);
    const hasInbound = inboundIds.has(match.match_id);
    if ((next.superseded_by != null && (!target || target.superseded_by != null || target.canonical_match_id !== next.canonical_match_id)) ||
      (hasInbound && match.canonical_match_id !== next.canonical_match_id)) {
      blocked.add(match.match_id);
      if (next.superseded_by != null) blocked.add(next.superseded_by);
      plan.review.push({ kind: "ambiguous_identity", key: { match_id: match.match_id }, details: "取代目标缺失、身份不一致或已有入向关系阻止修改身份，需人工复核不变量" });
    }
  }
  for (const match of matches) {
    if (blocked.has(match.match_id)) continue;
    const next = after.get(match.match_id)!;
    if (match.canonical_match_id == null) reasons.get(match.match_id)!.push("backfill_canonical");
    if (match.superseded_by === undefined) reasons.get(match.match_id)!.push("backfill_superseded");
    if (match.canonical_match_id !== next.canonical_match_id || match.superseded_by !== next.superseded_by) {
      plan.match_updates.push({ match_id: match.match_id, before: { canonical_match_id: match.canonical_match_id ?? null, superseded_by: match.superseded_by ?? null }, after: next, reasons: reasons.get(match.match_id)! });
    }
  }
  const pending: IdentityMigrationPlan["prediction_updates"] = [];
  const predictionGroups = new Map<string, Prediction[]>();
  for (const prediction of predictions) {
    const match = byId.get(prediction.match_id);
    if (!match) {
      plan.review.push({ kind: "dangling_prediction_match", key: { prediction_id: prediction.prediction_id, match_id: prediction.match_id }, details: "预测关联的比赛不存在" });
      continue;
    }
    if (blocked.has(match.match_id) || (match.superseded_by != null && blocked.has(match.superseded_by))) continue;
    const target = match.superseded_by == null ? match : byId.get(match.superseded_by);
    if (!target || target.superseded_by != null) {
      plan.review.push({ kind: "ambiguous_identity", key: { match_id: match.match_id }, details: "取代目标不存在或形成链式关系，无法安全解析预测身份" });
      continue;
    }
    const canonical = after.get(target.match_id)!.canonical_match_id;
    const key = JSON.stringify([prediction.user_id, canonical]);
    predictionGroups.set(key, [...(predictionGroups.get(key) ?? []), prediction]);
    if (prediction.canonical_match_id !== canonical) pending.push({ prediction_id: prediction.prediction_id, user_id: prediction.user_id, match_id: prediction.match_id, before_canonical_match_id: prediction.canonical_match_id ?? null, after_canonical_match_id: canonical, reasons: ["按关联比赛的规划后逻辑身份回填"] });
  }
  const duplicateIds = new Set<string>();
  for (const [key, group] of predictionGroups) {
    if (group.length < 2) continue;
    const [user_id, canonical_match_id] = JSON.parse(key) as [string, string];
    group.forEach((prediction) => duplicateIds.add(prediction.prediction_id));
    plan.review.push({ kind: "duplicate_prediction", key: { user_id, canonical_match_id }, details: `同一用户的逻辑比赛存在多条预测：${group.map((prediction) => prediction.prediction_id).join("、")}；需人工处理` });
  }
  plan.prediction_updates = pending.filter((update) => !duplicateIds.has(update.prediction_id));
  return plan;
}
