import { internalError } from "../domain/errors.js";
import type { Match } from "../domain/types.js";
import type { MatchRepository, UnitOfWork } from "../infrastructure/repositories.js";

const LATEST_MATCH_VIEW_MAX_HOPS = 20;
const STRICT_MATCH_CHAIN_MAX_HOPS = 3;

export async function fetchByIds<T>(
  repo: {
    findById(id: string): Promise<T | null>;
    findByIds?(ids: readonly string[]): Promise<Map<string, T>>;
  },
  ids: readonly string[],
): Promise<Map<string, T>> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) return new Map();
  if (repo.findByIds !== undefined) {
    return repo.findByIds(unique);
  }
  const entries = await Promise.all(unique.map(async (id) => [id, await repo.findById(id)] as const));
  const found = new Map<string, T>();
  for (const [id, value] of entries) {
    if (value !== null) found.set(id, value);
  }
  return found;
}

/**
 * 批量沿着 superseded_by 链路解析一组 matchId 到最新有效比赛，按跳按批拉取替代循环 findById。
 * - 默认严格模式（与 resolveEffectiveMatch 一致）：成环或超过 3 跳抛 INTERNAL_ERROR，链断裂时不写入结果 Map。
 * - lenient 模式（与 resolveLatestMatchView 一致）：允许最多 20 跳，成环/断链返回最后可达记录。
 */
export async function resolveEffectiveMatchesByIds(
  matches: Pick<MatchRepository, "findById" | "findByIds">,
  matchIds: readonly string[],
  options: { lenient?: boolean } = {},
): Promise<Map<string, Match>> {
  const unique = [...new Set(matchIds.filter((id) => id.length > 0))];
  if (unique.length === 0) return new Map();

  const rawCache = new Map<string, Match | null>();
  const loadBatch = async (ids: readonly string[]): Promise<void> => {
    const missing = [...new Set(ids)].filter((id) => !rawCache.has(id));
    if (missing.length === 0) return;
    const fetched = await fetchByIds(matches, missing);
    for (const id of missing) {
      rawCache.set(id, fetched.get(id) ?? null);
    }
  };

  const maxHops = options.lenient === true ? LATEST_MATCH_VIEW_MAX_HOPS : STRICT_MATCH_CHAIN_MAX_HOPS;
  let frontier: readonly string[] = unique;
  for (let round = 0; round <= maxHops && frontier.length > 0; round += 1) {
    await loadBatch(frontier);
    const next: string[] = [];
    for (const id of frontier) {
      const match = rawCache.get(id);
      if (match?.superseded_by != null && !rawCache.has(match.superseded_by)) {
        next.push(match.superseded_by);
      }
    }
    frontier = [...new Set(next)];
  }

  const resolved = new Map<string, Match>();
  for (const startId of unique) {
    const visited = new Set<string>();
    let currentId = startId;
    let lastReachable: Match | null = null;
    for (let hops = 0; hops <= maxHops; hops += 1) {
      if (visited.has(currentId)) {
        if (options.lenient === true) break;
        throw internalError("比赛取代关系存在环");
      }
      visited.add(currentId);
      const match = rawCache.get(currentId) ?? null;
      if (match === null) {
        if (options.lenient === true && lastReachable !== null) {
          resolved.set(startId, lastReachable);
        }
        break;
      }
      lastReachable = match;
      if (match.superseded_by == null) {
        resolved.set(startId, match);
        break;
      }
      if (hops === maxHops) {
        if (options.lenient === true) {
          resolved.set(startId, match);
          break;
        }
        throw internalError("比赛取代关系超过三跳");
      }
      currentId = match.superseded_by;
    }
  }
  return resolved;
}

export async function resolveEffectiveMatch(repo: Pick<UnitOfWork, "matches">, matchId: string): Promise<Match | null> {
  const visited = new Set<string>();
  let currentId = matchId;
  for (let hops = 0; hops <= 3; hops += 1) {
    if (visited.has(currentId)) throw internalError("比赛取代关系存在环");
    visited.add(currentId);
    const match = await repo.matches.findById(currentId);
    if (match === null || match.superseded_by === null) return match;
    if (hops === 3) throw internalError("比赛取代关系超过三跳");
    currentId = match.superseded_by;
  }
  throw internalError("比赛取代关系异常");
}

/** 读路径容错解析：沿 superseded_by 链路追踪到最新有效比赛；若链断裂或成环则返回当前最后可达记录。 */
export async function resolveLatestMatchView(
  matches: Pick<MatchRepository, "findById">,
  initialMatch: Match,
): Promise<Match> {
  let current = initialMatch;
  const visited = new Set<string>([current.match_id]);
  for (let hops = 0; hops < LATEST_MATCH_VIEW_MAX_HOPS && current.superseded_by != null; hops += 1) {
    if (visited.has(current.superseded_by)) {
      break;
    }
    const next = await matches.findById(current.superseded_by);
    if (next === null) {
      break;
    }
    visited.add(next.match_id);
    current = next;
  }
  return current;
}

export function roundIdMatches(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): boolean {
  if (existing == null || existing.trim() === "" || incoming == null || incoming.trim() === "") {
    return true;
  }
  const left = existing.trim();
  const right = incoming.trim();
  if (left === right) return true;
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return Number(left) === Number(right);
  }
  return false;
}

export function filterByTeamPair(
  matches: readonly Match[],
  input: {
    leagueId: string;
    seasonId: string;
    homeTeamId: string;
    awayTeamId: string;
    roundId?: string | null;
  },
): Match[] {
  return matches.filter((match) =>
    match.superseded_by == null &&
    match.league_id === input.leagueId &&
    match.season_id === input.seasonId &&
    match.home_team_id === input.homeTeamId &&
    match.away_team_id === input.awayTeamId &&
    roundIdMatches(match.round_id, input.roundId));
}
