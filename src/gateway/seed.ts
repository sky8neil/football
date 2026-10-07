import { SUPPORTED_LEAGUES } from "../domain/config.js";
import {
  GroupMemberStatus,
  GroupStatus,
  MatchStatus,
  PeriodType,
  RankingBoard,
  SCHEMA_VERSION,
  UserStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import { calculatePeriodKey, levelSeasonOf, seasonFinalEvalAsOf } from "../domain/time.js";
import type {
  BoardSnapshot,
  Group,
  GroupMember,
  Match,
  Prediction,
  RankingEntry,
  Team,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import type { InMemoryRepository } from "../infrastructure/repositories.js";
import { defaultLevelState } from "../domain/types.js";

export const GATEWAY_SEED_SCENARIOS = [
  "normal",
  "empty",
  "thin1",
  "thin2",
  "thin5",
  "no-group",
  "first-season",
  "new-season",
  "predictions-long",
] as const;

export type GatewaySeedScenario = (typeof GATEWAY_SEED_SCENARIOS)[number];

export function getGatewaySeedScenario(value: string | undefined): GatewaySeedScenario {
  if (value === undefined || value === "") return "normal";
  if ((GATEWAY_SEED_SCENARIOS as readonly string[]).includes(value)) {
    return value as GatewaySeedScenario;
  }
  throw new Error(`FOOTBALL_SEED_SCENARIO must be one of: ${GATEWAY_SEED_SCENARIOS.join(", ")}`);
}

function makeTeam(
  teamId: string,
  name: string,
  now: Date,
  leagueId: (typeof SUPPORTED_LEAGUES)[number]["league_id"] = SUPPORTED_LEAGUES[0].league_id,
): Team {
  return {
    schema_version: SCHEMA_VERSION,
    team_id: teamId,
    league_id: leagueId,
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
    league_id: SUPPORTED_LEAGUES[0].league_id,
    season_id: SUPPORTED_LEAGUES[0].season_id,
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
    career_last_scoring_match_at: null,
    career_level_state: defaultLevelState(),
    deleted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeRankingEntry(
  userId: string,
  periodKey: string,
  now: Date,
  overrides: Partial<RankingEntry> = {},
): RankingEntry {
  return {
    schema_version: SCHEMA_VERSION,
    period_type: PeriodType.Week,
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
  scenario?: GatewaySeedScenario,
  trustedOpenid: string | null = null,
): Promise<void> {
  const weekKey = calculatePeriodKey(PeriodType.Week, serverNow);
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

  const legacyDefault = scenario === undefined;
  const rowCount = legacyDefault
    ? rows.length
    : scenario === "empty"
      ? 0
      : scenario === "thin1"
        ? 1
        : scenario === "thin2"
          ? 2
          : scenario === "thin5"
            ? 5
            : 24;
  const fixtureRows = Array.from({ length: rowCount }, (_, index) => rows[index] ?? ({
    nickname: `Rank${String(index + 1).padStart(2, "0")}`,
    favoriteTeamId: null,
    globalRank: index + 1,
    periodScore: Math.max(3, 216 - index * 9),
    validPredictions: 12,
    wdlHits: 8,
    exactHits: 4,
  }));
  const currentSeasonId = levelSeasonOf(serverNow);
  const seasonStart = Number(currentSeasonId.slice(0, 4));
  const previousSeasonId = `${seasonStart - 1}_${seasonStart}`;
  const secondPreviousSeasonId = `${seasonStart - 2}_${seasonStart - 1}`;
  const currentSnapshotAt = new Date(serverNow.getTime() - 60 * 60 * 1000);
  const previousSeasonFinalAt = seasonFinalEvalAsOf(previousSeasonId);
  const userIds: string[] = [];

  if (rowCount === 0 && trustedOpenid !== null) {
    await repo.users.insert(makeRankingUser(newUuid(), "本地测试用户", serverNow, {
      openid: trustedOpenid,
    }));
  }

  for (const [index, row] of fixtureRows.entries()) {
    const userId = newUuid();
    userIds.push(userId);
    const careerPoints = Math.max(row.periodScore, 120 - index * 3);
    const isTrustedUser = trustedOpenid !== null && index === 0;
    await repo.users.insert(makeRankingUser(userId, row.nickname, serverNow, {
      openid: isTrustedUser ? trustedOpenid : `ranking-seed-openid-${userId}`,
      favorite_team_id: row.favoriteTeamId,
      career_points: careerPoints,
      career_valid_predictions: 40,
      career_wdl_hits: 24,
      career_exact_hits: 8,
      career_level_state: { ...defaultLevelState(), last_eval_n: 50, last_eval_score_sum: 500 },
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
      makeRankingEntry(userId, weekKey, serverNow, { ...stats, global_rank: row.globalRank }),
    );

    if (!legacyDefault) {
      await repo.boardSnapshots.insert(makeBoardSnapshot(
        RankingBoard.Career,
        userId,
        row.globalRank,
        currentSnapshotAt,
        { careerPoints, validPredictions: 40, exactHits: 8 },
      ));
      await repo.boardSnapshots.insert(makeBoardSnapshot(
        RankingBoard.Strength,
        userId,
        row.globalRank,
        currentSnapshotAt,
        { windowN: 50, windowScoreSum: Math.max(250, 550 - index * 5) },
      ));

      const currentStats = makeUserSeasonStats(userId, currentSeasonId, serverNow, row.periodScore);
      const previousStats = makeUserSeasonStats(userId, previousSeasonId, previousSeasonFinalAt, careerPoints);
      if (scenario === "first-season") {
        await repo.userSeasonStats.insert(currentStats);
      } else if (scenario === "new-season") {
        await repo.userSeasonStats.insert(makeUserSeasonStats(
          userId,
          secondPreviousSeasonId,
          previousSeasonFinalAt,
          careerPoints - 20,
        ));
        await repo.userSeasonStats.insert(previousStats);
        await repo.boardSnapshots.insert(makeBoardSnapshot(
          RankingBoard.Season,
          userId,
          row.globalRank,
          previousSeasonFinalAt,
          { levelSeasonId: previousSeasonId, seasonPoints: careerPoints, validPredictions: 30, exactHits: 6 },
        ));
      } else {
        await repo.userSeasonStats.insert(previousStats);
        await repo.userSeasonStats.insert(currentStats);
        await repo.boardSnapshots.insert(makeBoardSnapshot(
          RankingBoard.Season,
          userId,
          row.globalRank,
          previousSeasonFinalAt,
          {
            levelSeasonId: previousSeasonId,
            seasonPoints: careerPoints,
            validPredictions: 30,
            exactHits: 6,
            isFinal: true,
          },
        ));
        await repo.boardSnapshots.insert(makeBoardSnapshot(
          RankingBoard.Season,
          userId,
          row.globalRank,
          currentSnapshotAt,
          { levelSeasonId: currentSeasonId, seasonPoints: row.periodScore * 3, validPredictions: 9, exactHits: 2 },
        ));
      }
    }
  }

  if (legacyDefault || rowCount === 0) return;

  if (scenario !== "no-group" && scenario !== "empty" && userIds.length > 0) {
    const groupId = newUuid();
    const group: Group = {
      schema_version: SCHEMA_VERSION,
      group_id: groupId,
      owner_user_id: userIds[0]!,
      invite_code: "ABCDEFGH",
      status: GroupStatus.Active,
      member_count: userIds.length,
      created_at: serverNow,
      updated_at: serverNow,
    };
    await repo.groups.insert(group);
    for (const userId of userIds) {
      const member: GroupMember = {
        schema_version: SCHEMA_VERSION,
        group_id: groupId,
        user_id: userId,
        status: GroupMemberStatus.Active,
        joined_at: serverNow,
        left_at: null,
        created_at: serverNow,
        updated_at: serverNow,
      };
      await repo.groupMembers.insert(member);
    }
  }

  if (scenario === "predictions-long" && trustedOpenid !== null) {
    const currentUser = await repo.users.findByOpenid(trustedOpenid);
    if (currentUser !== null) {
      await seedLongPredictionHistory(repo, currentUser.user_id, serverNow);
    }
  }
}

function makeBoardSnapshot(
  board: BoardSnapshot["board"],
  userId: string,
  rank: number,
  snapshotAt: Date,
  values: {
    careerPoints?: number;
    validPredictions?: number;
    exactHits?: number;
    windowN?: number;
    windowScoreSum?: number;
    levelSeasonId?: string;
    seasonPoints?: number;
    isFinal?: boolean;
  },
): BoardSnapshot {
  const isCareer = board === RankingBoard.Career;
  const isStrength = board === RankingBoard.Strength;
  return {
    schema_version: SCHEMA_VERSION,
    snapshot_id: newUuid(),
    board,
    snapshot_at: snapshotAt,
    level_season_id: isCareer || isStrength ? null : values.levelSeasonId ?? null,
    is_final: values.isFinal ?? false,
    user_id: userId,
    rank,
    career_points: isCareer ? values.careerPoints ?? 0 : null,
    career_exact_hits: isCareer ? values.exactHits ?? 0 : null,
    career_valid_predictions: isCareer ? values.validPredictions ?? 0 : null,
    career_last_scoring_match_at: isCareer ? snapshotAt : null,
    window_score_sum: isStrength ? values.windowScoreSum ?? 0 : null,
    window_n: isStrength ? values.windowN ?? 0 : null,
    season_points: isCareer || isStrength ? null : values.seasonPoints ?? 0,
    season_exact_hits: isCareer || isStrength ? null : values.exactHits ?? 0,
    season_valid_predictions: isCareer || isStrength ? null : values.validPredictions ?? 0,
    season_last_scoring_match_at: isCareer || isStrength ? null : snapshotAt,
    created_at: snapshotAt,
  };
}

function makeUserSeasonStats(
  userId: string,
  seasonId: string,
  now: Date,
  points: number,
): UserSeasonStats {
  return {
    schema_version: SCHEMA_VERSION,
    user_id: userId,
    level_season_id: seasonId,
    points,
    valid_predictions: 30,
    wdl_hits: 20,
    exact_hits: 6,
    last_scoring_match_at: now,
    level: 2,
    best_level: 3,
    level_state: defaultLevelState(),
    is_level_frozen: false,
    created_at: now,
    updated_at: now,
  };
}

async function seedLongPredictionHistory(
  repo: InMemoryRepository,
  userId: string,
  serverNow: Date,
): Promise<void> {
  const homeTeamId = newUuid();
  const awayTeamId = newUuid();
  await repo.teams.insert(makeTeam(homeTeamId, "Arsenal", serverNow));
  await repo.teams.insert(makeTeam(awayTeamId, "Chelsea", serverNow));
  for (let index = 0; index < 12; index += 1) {
    const kickoffAt = new Date(serverNow.getTime() - (index + 1) * 7 * 24 * 60 * 60 * 1000);
    const matchId = newUuid();
    const settledAt = new Date(kickoffAt.getTime() + 2 * 60 * 60 * 1000);
    await repo.matches.insert(makeMatch(matchId, homeTeamId, awayTeamId, kickoffAt, serverNow, {
      match_status: MatchStatus.Finished,
      settlement_status: "settled",
      regular_home_score: 2,
      regular_away_score: index % 2,
      result_version: 1,
      settled_result_version: 1,
      result_source: "provider",
      finish_detected_at: settledAt,
      settled_at: settledAt,
    }));
    const submittedAt = new Date(kickoffAt.getTime() - 24 * 60 * 60 * 1000);
    const prediction: Prediction = {
      schema_version: SCHEMA_VERSION,
      prediction_id: newUuid(),
      user_id: userId,
      match_id: matchId,
      idempotency_key: newUuid(),
      pred_home_score: 2,
      pred_away_score: index % 2,
      derived_result: index % 2 === 0 ? "HOME" : "DRAW",
      submitted_at: submittedAt,
      scoring_rule_version: "scoring_v1",
      match_score: 12,
      wdl_hit: true,
      exact_hit: true,
      applied_result_version: 1,
      created_at: submittedAt,
      updated_at: settledAt,
    };
    await repo.predictions.insert(prediction);
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

  const otherLeagueTeams = {
    la_liga: ["Real Madrid", "Barcelona"],
    ligue_1: ["Paris Saint-Germain", "Marseille"],
    chinese_super_league: ["Beijing Guoan", "Shanghai Shenhua"],
  } as const;
  for (const leagueId of ["la_liga", "ligue_1", "chinese_super_league"] as const) {
    const league = SUPPORTED_LEAGUES.find((item) => item.league_id === leagueId)!;
    const [homeName, awayName] = otherLeagueTeams[leagueId];
    const leagueHomeId = newUuid();
    const leagueAwayId = newUuid();
    await repo.teams.insert(makeTeam(leagueHomeId, homeName, serverNow, leagueId));
    await repo.teams.insert(makeTeam(leagueAwayId, awayName, serverNow, leagueId));
    await repo.matches.insert(makeMatch(
      newUuid(),
      leagueHomeId,
      leagueAwayId,
      new Date(serverNow.getTime() + 3 * hourMs),
      serverNow,
      { league_id: league.league_id, season_id: league.season_id },
    ));
  }

  const extraSeeds: Array<{ kickoffAt: Date; overrides: Partial<Match> }> = [
    {
      kickoffAt: new Date(serverNow.getTime() - 8 * hourMs),
      overrides: {
        match_status: MatchStatus.Live,
        kickoff_confirmed: true,
        prediction_closed_at: serverNow,
      },
    },
    {
      kickoffAt: new Date(serverNow.getTime() - 10 * hourMs),
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
      kickoffAt: new Date(serverNow.getTime() - 16 * hourMs),
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
