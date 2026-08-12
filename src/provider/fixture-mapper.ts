/**
 * Fixture normalize mapper（阶段 3，规范 31.2-31.5）。
 *
 * 把原始 API-Football fixture 归一化为可信领域结构；任何关键字段缺失、
 * 状态异常（未知/ET/AET/PEN）或正式比分非法时 fail-closed：
 * - 不产出可用 kickoff / 状态 / 比分（调用方不得更新数据库可信值）；
 * - 返回相应 blocking 或数据异常 anomaly。
 */
import { AnomalyType } from "../domain/enums.js";
import { MVP_SEASON } from "../domain/config.js";
import { parseKickoff, KICKOFF_TOLERANCE_MS } from "./kickoff.js";
import { mapProviderStatus, type ProviderFixtureStatus } from "./status.js";
import type { ApiFootballFixture } from "./types.js";

export interface MapperAnomaly {
  type: AnomalyType;
  blocking: boolean;
  details: Record<string, unknown>;
}

export interface NormalizedFixture {
  providerMatchId: string;
  leagueProviderId: string;
  season: string | null;
  round: string | null;
  homeTeamProviderId: string;
  awayTeamProviderId: string;
  kickoffAt: Date | null;
  kickoffConfirmed: boolean;
  kickoffDeltaMs: number | null;
  status: ProviderFixtureStatus;
  /** 仅 status=FT 且 fulltime 合法整数 0..99 时非 null（31.4）。 */
  fulltime: { home: number; away: number } | null;
  rawStatus: string | null;
}

export interface NormalizeFixtureResult {
  fixture: NormalizedFixture;
  anomalies: MapperAnomaly[];
  entityFailed: boolean;
}

export const FINAL_SCORE_MIN = 0;
export const FINAL_SCORE_MAX = 99;

function isIntegerScore(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isValidFinalScore(home: unknown, away: unknown): boolean {
  return (
    isIntegerScore(home) &&
    isIntegerScore(away) &&
    home >= FINAL_SCORE_MIN &&
    home <= FINAL_SCORE_MAX &&
    away >= FINAL_SCORE_MIN &&
    away <= FINAL_SCORE_MAX
  );
}

function dataInvalid(details: Record<string, unknown>): MapperAnomaly {
  return { type: AnomalyType.ProviderDataInvalid, blocking: false, details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyFixture(): NormalizedFixture {
  return {
    providerMatchId: "",
    leagueProviderId: "",
    season: null,
    round: null,
    homeTeamProviderId: "",
    awayTeamProviderId: "",
    kickoffAt: null,
    kickoffConfirmed: false,
    kickoffDeltaMs: null,
    status: { kind: "missing" },
    fulltime: null,
    rawStatus: null,
  };
}

export function normalizeFixture(raw: ApiFootballFixture): NormalizeFixtureResult {
  if (!isRecord(raw) || !isRecord(raw.fixture)) {
    return {
      fixture: emptyFixture(),
      anomalies: [dataInvalid({ field: "fixture" })],
      entityFailed: true,
    };
  }

  const anomalies: MapperAnomaly[] = [];
  let entityFailed = false;

  const providerMatchId =
    typeof raw.fixture.id === "number" ? String(raw.fixture.id) : "";
  if (providerMatchId.length === 0) {
    anomalies.push(dataInvalid({ field: "fixture.id" }));
    entityFailed = true;
  }

  const homeTeamId = raw.teams?.home?.id;
  const awayTeamId = raw.teams?.away?.id;
  const homeTeamProviderId = typeof homeTeamId === "number" ? String(homeTeamId) : "";
  const awayTeamProviderId = typeof awayTeamId === "number" ? String(awayTeamId) : "";
  if (homeTeamProviderId.length === 0 || awayTeamProviderId.length === 0) {
    anomalies.push(
      dataInvalid({ field: "teams", home: homeTeamProviderId, away: awayTeamProviderId }),
    );
    entityFailed = true;
  }

  const leagueId = raw.league?.id;
  const leagueProviderId =
    typeof leagueId === "number" && Number.isInteger(leagueId) && leagueId > 0
      ? String(leagueId)
      : "";
  if (leagueProviderId.length === 0) {
    anomalies.push(dataInvalid({ field: "league.id" }));
    entityFailed = true;
  } else if (leagueProviderId !== MVP_SEASON.api_football_league_id) {
    anomalies.push(
      dataInvalid({
        field: "league.id",
        expected: MVP_SEASON.api_football_league_id,
        actual: leagueProviderId,
      }),
    );
    entityFailed = true;
  }

  const seasonValue = raw.league?.season;
  const season =
    typeof seasonValue === "string" && seasonValue.length > 0
      ? seasonValue
      : typeof seasonValue === "number" && Number.isInteger(seasonValue)
        ? String(seasonValue)
        : null;
  if (season === null) {
    anomalies.push(dataInvalid({ field: "league.season" }));
    entityFailed = true;
  } else if (season !== MVP_SEASON.api_football_season) {
    anomalies.push(
      dataInvalid({
        field: "league.season",
        expected: MVP_SEASON.api_football_season,
        actual: season,
      }),
    );
    entityFailed = true;
  }

  const round =
    typeof raw.league?.round === "string" && raw.league.round.length > 0
      ? raw.league.round
      : null;
  if (round === null) {
    anomalies.push(dataInvalid({ field: "league.round" }));
    entityFailed = true;
  }

  const rawStatus = raw.fixture.status?.short;
  const status = mapProviderStatus(rawStatus);

  const kickoff = parseKickoff(
    raw.fixture.timestamp,
    raw.fixture.date,
    KICKOFF_TOLERANCE_MS,
  );

  if (kickoff.missing) {
    anomalies.push(
      dataInvalid({ field: "kickoff", missing: true }),
    );
    entityFailed = true;
  } else if (kickoff.invalid) {
    anomalies.push(
      dataInvalid({ field: "kickoff", invalid: true }),
    );
    entityFailed = true;
  } else if (kickoff.mismatch) {
    anomalies.push(
      dataInvalid({
        field: "kickoff",
        mismatch: true,
        deltaMs: kickoff.deltaMs,
      }),
    );
    entityFailed = true;
  }

  let fulltime: { home: number; away: number } | null = null;
  if (status.kind === "unexpected") {
    anomalies.push({
      type: AnomalyType.UnexpectedProviderStatus,
      blocking: true,
      details: { status: rawStatus },
    });
    entityFailed = true;
  } else if (status.kind === "finished" && rawStatus === "FT") {
    const fulltimeHome = raw.score?.fulltime?.home;
    const fulltimeAway = raw.score?.fulltime?.away;
    if (isValidFinalScore(fulltimeHome, fulltimeAway)) {
      fulltime = { home: fulltimeHome as number, away: fulltimeAway as number };
    } else {
      anomalies.push({
        type: AnomalyType.InvalidFinalScore,
        blocking: true,
        details: {
          fulltimeHome: fulltimeHome ?? null,
          fulltimeAway: fulltimeAway ?? null,
        },
      });
      entityFailed = true;
    }
  }

  if (status.kind === "missing") {
    anomalies.push(dataInvalid({ field: "status" }));
    entityFailed = true;
  }

  const kickoffConfirmed =
    status.kind === "scheduled" ? status.kickoffConfirmed : true;

  return {
    fixture: {
      providerMatchId,
      leagueProviderId,
      season,
      round,
      homeTeamProviderId,
      awayTeamProviderId,
      kickoffAt: kickoff.kickoffAt,
      kickoffConfirmed,
      kickoffDeltaMs: kickoff.deltaMs,
      status,
      fulltime,
      rawStatus: typeof rawStatus === "string" ? rawStatus : null,
    },
    anomalies,
    entityFailed,
  };
}
