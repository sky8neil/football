import { MVP_SEASON } from "../domain/config.js";
import { MatchStatus, PeriodType, SCHEMA_VERSION, UserStatus } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import { calculatePeriodKey } from "../domain/time.js";
import type { Match, RankingEntry, Team, User } from "../domain/types.js";
import type { InMemoryRepository } from "../infrastructure/repositories.js";

function makeTeam(teamId: string, name: string, now: Date): Team {
  return {
    schema_version: SCHEMA_VERSION,
    team_id: teamId,
    name,
    short_name: null,
    primary_color: null,
    secondary_color: null,
    status: "active",
    created_at: now,
    updated_at: now,
  };
}

function makeMatch(
  matchId: string,
  homeTeamId: string,
  awayTeamId: string,
  kickoffAt: Date,
  now: Date,
  overrides: Partial<Match> = {},
): Match {
  const deadline = new Date(kickoffAt.getTime() - 10 * 60 * 1000);
  return {
    schema_version: SCHEMA_VERSION,
    match_id: matchId,
    league_id: MVP_SEASON.league_id,
    season_id: MVP_SEASON.season_id,
    round_id: "01",
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    kickoff_at: kickoffAt,
    kickoff_confirmed: true,
    prediction_deadline_at: deadline,
    prediction_closed_at: null,
    period_anchor_at: null,
    match_status: MatchStatus.Scheduled,
    settlement_status: "pending",
    regular_home_score: null,
    regular_away_score: null,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 0,
    settled_result_version: 0,
    result_source: null,
    scoring_rule_version: "scoring_v1",
    finish_detected_at: null,
    settled_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeRankingUser(
  userId: string,
  nickname: string,
  now: Date,
  overrides: Partial<User> = {},
): User {
  return {
    schema_version: SCHEMA_VERSION,
    user_id: userId,
    openid: `ranking-seed-openid-${userId}`,
    unionid: null,
    nickname,
    favorite_team_id: null,
    status: UserStatus.Active,
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    deleted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeRankingEntry(
  userId: string,
  periodType: PeriodType,
  periodKey: string,
  now: Date,
  overrides: Partial<RankingEntry> = {},
): RankingEntry {
  return {
    schema_version: SCHEMA_VERSION,
    period_type: periodType,
    period_key: periodKey,
    user_id: userId,
    period_score: 33,
    valid_predictions: 3,
    wdl_hits: 2,
    exact_hits: 1,
    last_scoring_match_at: now,
    global_rank: 1,
    is_final: false,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/**
 * 排行榜公开读所需的 users + ranking 文档（ranking-query.test.ts 模式）。
 * RankingQueryService.list 只读 rankings/users，不读 settlement_items。
 * 不得并入 seedGatewayRepository：V1 在默认种子后断言 users 为空。
 * openid 与 mock 登录身份隔离，不占用 session/init 的 201。
 */
export async function seedRankingLeaderboard(
  repo: InMemoryRepository,
  serverNow: Date,
): Promise<void> {
  const weekKey = calculatePeriodKey(PeriodType.Week, serverNow);
  const monthKey = calculatePeriodKey(PeriodType.Month, serverNow);
  const lastScoringAt = new Date(serverNow.getTime() - 2 * 60 * 60 * 1000);

  const rows: Array<{
    nickname: string;
    favoriteTeamId: string | null;
    globalRank: number;
    periodScore: number;
    validPredictions: number;
    wdlHits: number;
    exactHits: number;
  }> = [
    {
      nickname: "RankAlice",
      favoriteTeamId: newUuid(),
      globalRank: 1,
      periodScore: 36,
      validPredictions: 3,
      wdlHits: 3,
      exactHits: 3,
    },
    {
      nickname: "RankBob",
      favoriteTeamId: null,
      globalRank: 2,
      periodScore: 27,
      validPredictions: 4,
      wdlHits: 3,
      exactHits: 2,
    },
    {
      nickname: "RankCara",
      favoriteTeamId: null,
      globalRank: 3,
      periodScore: 18,
      validPredictions: 5,
      wdlHits: 4,
      exactHits: 1,
    },
    {
      nickname: "RankDrew",
      favoriteTeamId: null,
      globalRank: 4,
      periodScore: 9,
      validPredictions: 3,
      wdlHits: 3,
      exactHits: 0,
    },
  ];

  for (const row of rows) {
    const userId = newUuid();
    await repo.users.insert(makeRankingUser(userId, row.nickname, serverNow, {
      favorite_team_id: row.favoriteTeamId,
    }));
    const stats = {
      global_rank: row.globalRank,
      period_score: row.periodScore,
      valid_predictions: row.validPredictions,
      wdl_hits: row.wdlHits,
      exact_hits: row.exactHits,
      last_scoring_match_at: lastScoringAt,
    };
    await repo.rankings.insert(
      makeRankingEntry(userId, PeriodType.Week, weekKey, serverNow, stats),
    );
    await repo.rankings.insert(
      makeRankingEntry(userId, PeriodType.Month, monthKey, serverNow, stats),
    );
  }
}

/** 预置 ≥2 支球队、≥3 场默认窗内 scheduled 比赛，并附加状态矩阵种子；不预置用户。 */
export async function seedGatewayRepository(
  repo: InMemoryRepository,
  serverNow: Date,
): Promise<void> {
  const homeTeamId = newUuid();
  const awayTeamId = newUuid();
  await repo.teams.insert(makeTeam(homeTeamId, "Arsenal", serverNow));
  await repo.teams.insert(makeTeam(awayTeamId, "Chelsea", serverNow));

  const hourMs = 60 * 60 * 1000;
  const kickoffs = [
    new Date(serverNow.getTime() + 2 * hourMs),
    new Date(serverNow.getTime() + 4 * hourMs),
    new Date(serverNow.getTime() + 6 * hourMs),
  ];
  for (const kickoffAt of kickoffs) {
    await repo.matches.insert(
      makeMatch(newUuid(), homeTeamId, awayTeamId, kickoffAt, serverNow),
    );
  }

  const extraSeeds: Array<{ kickoffAt: Date; overrides: Partial<Match> }> = [
    {
      kickoffAt: new Date(serverNow.getTime() + 8 * hourMs),
      overrides: {
        match_status: MatchStatus.Live,
        kickoff_confirmed: true,
        prediction_closed_at: serverNow,
      },
    },
    {
      kickoffAt: new Date(serverNow.getTime() + 10 * hourMs),
      overrides: {
        match_status: MatchStatus.Finished,
        regular_home_score: 2,
        regular_away_score: 1,
      },
    },
    {
      kickoffAt: new Date(serverNow.getTime() + 12 * hourMs),
      overrides: {
        match_status: MatchStatus.Postponed,
        prediction_deadline_at: new Date(serverNow.getTime() - 2 * hourMs),
        prediction_closed_at: null,
      },
    },
    {
      kickoffAt: new Date(serverNow.getTime() + 14 * hourMs),
      overrides: {
        match_status: MatchStatus.Cancelled,
      },
    },
    {
      kickoffAt: new Date(serverNow.getTime() + 16 * hourMs),
      overrides: {
        match_status: MatchStatus.Abandoned,
      },
    },
    {
      kickoffAt: new Date(serverNow.getTime() + 18 * hourMs),
      overrides: {
        kickoff_confirmed: false,
        prediction_deadline_at: null,
      },
    },
  ];
  for (const extra of extraSeeds) {
    await repo.matches.insert(
      makeMatch(newUuid(), homeTeamId, awayTeamId, extra.kickoffAt, serverNow, extra.overrides),
    );
  }
}
