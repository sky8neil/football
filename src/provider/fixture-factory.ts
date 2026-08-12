/**
 * Deterministic fixture 工厂（阶段 3 测试用）。
 *
 * 生成 API-Football fixture 形状的固定输入，供 mapper/engine 的确定性测试复用。
 * 所有 id、时间、比分均由调用方覆盖或使用固定默认值，不依赖真实 API。
 */
import type { ApiFootballFixture } from "./types.js";

export interface FixtureFactoryOverrides {
  fixtureId?: number;
  statusShort?: string;
  date?: string;
  timestamp?: number;
  homeTeamId?: number;
  awayTeamId?: number;
  leagueId?: number;
  season?: number | string;
  round?: string;
  fulltimeHome?: number | null;
  fulltimeAway?: number | null;
  extratimeHome?: number | null;
  extratimeAway?: number | null;
  penaltyHome?: number | null;
  penaltyAway?: number | null;
  goalsHome?: number | null;
  goalsAway?: number | null;
}

/**
 * 固定基准：2026-08-08T14:00:00Z（UTC）。timestamp 与 date 指向同一时刻。
 */
export const DEFAULT_KICKOFF_UTC = "2026-08-08T14:00:00.000Z";
export const DEFAULT_KICKOFF_TIMESTAMP = Date.parse(DEFAULT_KICKOFF_UTC) / 1000;

export function makeApiFixture(
  overrides: FixtureFactoryOverrides = {},
): ApiFootballFixture {
  const date = overrides.date ?? DEFAULT_KICKOFF_UTC;
  const timestamp = overrides.timestamp ?? DEFAULT_KICKOFF_TIMESTAMP;
  const fulltimeHome = overrides.fulltimeHome !== undefined ? overrides.fulltimeHome : 2;
  const fulltimeAway = overrides.fulltimeAway !== undefined ? overrides.fulltimeAway : 1;

  return {
    fixture: {
      id: overrides.fixtureId ?? 1100001,
      date,
      timestamp,
      status: { short: overrides.statusShort ?? "NS", long: "Not Started" },
    },
    league: {
      id: overrides.leagueId ?? 39,
      name: "Premier League",
      season: overrides.season ?? "2026",
      round: overrides.round ?? "Round 1",
    },
    teams: {
      home: { id: overrides.homeTeamId ?? 40, name: "Home FC", winner: null },
      away: { id: overrides.awayTeamId ?? 41, name: "Away FC", winner: null },
    },
    goals: { home: overrides.goalsHome ?? null, away: overrides.goalsAway ?? null },
    score: {
      halftime: { home: null, away: null },
      fulltime: { home: fulltimeHome, away: fulltimeAway },
      extratime: {
        home: overrides.extratimeHome ?? null,
        away: overrides.extratimeAway ?? null,
      },
      penalty: {
        home: overrides.penaltyHome ?? null,
        away: overrides.penaltyAway ?? null,
      },
    },
  };
}
