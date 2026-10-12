/**
 * API-Football 原始响应类型（阶段 3）。
 *
 * 只建模第 31 节允许读取的只读数据：赛程（fixtures）、球队（teams）、round、status。
 * 明确不建模 odds / bookmaker / bet 等博彩字段（31.1）。
 */

export interface ApiFootballFixtureStatus {
  short: string;
  long?: string;
  elapsed?: number | null;
}

export interface ApiFootballFixtureTeam {
  id: number | string;
  name?: string;
  winner?: boolean | null;
}

export interface ApiFootballScorePeriod {
  home: number | null;
  away: number | null;
}

/** fixture 对象（31 节只读契约的输入）。 */
export interface ApiFootballFixture {
  /** Source tag for fixtures normalized by the multi-provider adapters. */
  provider?: "api_football" | "football_data" | "bsd" | "5dollar" | "openfoot" | "sportapi";
  fixture: {
    id: number | string;
    /** ISO 8601 时间字符串 */
    date: string;
    /** unix 秒时间戳 */
    timestamp: number;
    status: ApiFootballFixtureStatus;
  };
  league: {
    id: number | string;
    name?: string;
    season?: number | string;
    round?: number | string;
  };
  teams: {
    home: ApiFootballFixtureTeam;
    away: ApiFootballFixtureTeam;
  };
  goals?: ApiFootballScorePeriod;
  score?: {
    halftime?: ApiFootballScorePeriod;
    fulltime?: ApiFootballScorePeriod;
    extratime?: ApiFootballScorePeriod;
    penalty?: ApiFootballScorePeriod;
  };
}

export interface ApiFootballTeam {
  provider?: "api_football" | "football_data" | "bsd" | "5dollar" | "openfoot" | "sportapi";
  team: {
    id: number | string;
    name: string;
    short_code?: string | null;
    country?: string | null;
  };
}

export interface ApiFootballStatusResult {
  account: { firstname?: string; lastname?: string };
  subscription?: { active?: boolean; plan?: string }[];
  requests?: { current?: number; limit_day?: number };
}

/** API-Football 响应信封（{ get, parameters, errors, results, paging, response }）。 */
export interface ApiFootballEnvelope<T> {
  get: string;
  parameters?: Record<string, unknown>;
  /** 数组或 { quota: ... } 对象；MVP 只读取，不轮询 quota 上限之外的接口 */
  errors: unknown;
  results: number;
  paging?: { current: number; total: number };
  response: T[];
}
