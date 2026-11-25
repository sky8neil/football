import { activeLeagueSeason, SUPPORTED_LEAGUES, type SupportedLeague, type SupportedLeagueId } from "../domain/config.js";
import { AnomalyType, Provider, SCHEMA_VERSION, SyncJobType, TeamStatus } from "../domain/enums.js";
import { internalError, validationError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import { ProviderBudgetDeferredError } from "../provider/budget.js";
import {
  ProviderDataError,
  type ApiFootballTeamQuery,
} from "../provider/http.js";
import type { ApiFootballTeam } from "../provider/types.js";
import type { Team, TeamProviderMapping } from "../domain/types.js";
import { persistAnomalyInTransaction } from "./anomaly-persistence.js";

export interface ProviderTeamClient {
  getTeams(query: ApiFootballTeamQuery): Promise<readonly ApiFootballTeam[]>;
}

export interface ProviderTeamSyncOutcome {
  kind: "completed";
  teams_read: number;
  teams_created: number;
  teams_unchanged: number;
}

export type ProviderTargetSeasonsInput = Partial<Record<SupportedLeagueId, string | readonly string[]>>;

type TeamSyncUnitOfWork = UnitOfWork & {
  teams: NonNullable<UnitOfWork["teams"]>;
  teamProviderMappings: NonNullable<UnitOfWork["teamProviderMappings"]>;
};

function requireTeamSyncPorts(tx: UnitOfWork): asserts tx is TeamSyncUnitOfWork {
  if (tx.teams === undefined || tx.teamProviderMappings === undefined) {
    throw internalError("Provider 球队同步缺少 teams/team mapping repository port");
  }
}

function assertValidServerNow(serverNow: Date): void {
  if (!(serverNow instanceof Date) || Number.isNaN(serverNow.getTime())) {
    throw validationError("server_now 必须是有效时间", { field: "server_now" });
  }
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseProviderTeam(raw: ApiFootballTeam): {
  provider: Provider;
  provider_team_id: string;
  name: string;
  name_zh: string | null;
  logo_url: string | null;
} {
  const team = (raw as unknown as { team?: unknown }).team;
  if (typeof team !== "object" || team === null || Array.isArray(team)) {
    throw new ProviderDataError("provider team response missing team fields");
  }

  const fields = team as Record<string, unknown>;
  const id = fields.id;
  const name = fields.name;
  const shortCode = fields.short_code;
  if (
    !(typeof id === "number" && Number.isInteger(id) && id > 0) &&
      !(typeof id === "string" && id.length > 0) ||
    typeof name !== "string" ||
    name.length === 0 ||
    (shortCode !== undefined && shortCode !== null && typeof shortCode !== "string")
  ) {
    throw new ProviderDataError("provider team response contains invalid team fields");
  }

  return {
    provider: raw.provider ?? Provider.ApiFootball,
    provider_team_id: String(id),
    name,
    name_zh: normalizeOptionalString(fields.name_zh),
    logo_url: normalizeOptionalString(fields.logo_url),
  };
}

function resolveLeagueSeasonRequests(
  league: SupportedLeague,
  serverNow: Date,
  targetSeasons?: ProviderTargetSeasonsInput,
): Array<{ seasonId: string; passSeasonId: boolean; isSecondaryProbe: boolean }> {
  const configured = targetSeasons?.[league.league_id];
  if (configured === undefined) {
    return [{ seasonId: activeLeagueSeason(league, serverNow).season_id, passSeasonId: false, isSecondaryProbe: false }];
  }
  const rawList = typeof configured === "string" ? [configured] : configured;
  const deduped = [...new Set(rawList)];
  return deduped.map((seasonId, index) => ({
    seasonId,
    passSeasonId: true,
    isSecondaryProbe: index > 0,
  }));
}

/** 同步目标赛季的 Provider 球队，只在首次发现时创建内部球队且绝不覆盖已有中文名/队徽。 */
export class ProviderTeamSyncService {
  constructor(
    private readonly repo: AppRepository,
    private readonly client: ProviderTeamClient,
  ) {}

  async sync(
    serverNow: Date,
    jobType: typeof SyncJobType.FutureSchedule | typeof SyncJobType.FullScheduleVerify = SyncJobType.FutureSchedule,
    leagueIds?: readonly string[],
    targetSeasons?: ProviderTargetSeasonsInput,
  ): Promise<ProviderTeamSyncOutcome> {
    assertValidServerNow(serverNow);
    const batches: Array<{
      league: SupportedLeague;
      seasonId: string;
      teams: readonly ApiFootballTeam[];
    }> = [];
    let teamsRead = 0;
    const leagues = leagueIds
      ? SUPPORTED_LEAGUES.filter((league) => leagueIds.includes(league.league_id))
      : SUPPORTED_LEAGUES;
    let firstError: unknown;
    let deferredError: ProviderBudgetDeferredError | undefined;
    for (const league of leagues) {
      const seasonRequests = resolveLeagueSeasonRequests(league, serverNow, targetSeasons);
      for (const req of seasonRequests) {
        try {
          const providerTeams = await this.client.getTeams({
            leagueId: league.api_football_league_id,
            season: req.seasonId.split("_")[0]!,
            ...(req.passSeasonId ? { seasonId: req.seasonId } : {}),
            jobType,
            serverNow,
          });
          if (!Array.isArray(providerTeams)) {
            throw new ProviderDataError("provider teams response must be an array");
          }
          batches.push({ league, seasonId: req.seasonId, teams: providerTeams });
          teamsRead += providerTeams.length;
        } catch (error) {
          if (!req.isSecondaryProbe) {
            if (firstError === undefined) firstError = error;
            if (deferredError === undefined && error instanceof ProviderBudgetDeferredError) deferredError = error;
          }
          console.warn(
            req.isSecondaryProbe ? "[provider_team_sync_season_probe_failed]" : "[provider_team_sync_league_failed]",
            {
              job_type: jobType,
              league_id: league.league_id,
              season_id: req.seasonId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
    }
    if (leagues.length > 0 && batches.length === 0 && firstError !== undefined) {
      throw deferredError ?? firstError;
    }

    return this.repo.withTransaction(async (tx) => {
      requireTeamSyncPorts(tx);
      let teamsCreated = 0;
      let teamsUnchanged = 0;

      for (const batch of batches) {
        const seasonTeams = await tx.seasonTeams?.findByLeagueSeason(batch.league.league_id, batch.seasonId) ?? [];
        const seasonTeamIds = new Set(seasonTeams.map((team) => team.team_id));
        for (const raw of batch.teams) {
          const parsed = parseProviderTeam(raw);
          const existingMapping =
            await tx.teamProviderMappings.findByProviderAndExternalId(
              parsed.provider,
              parsed.provider_team_id,
            );

          if (existingMapping !== null) {
            const existingTeam = await tx.teams.findById(existingMapping.team_id);
            if (existingTeam === null) {
              throw internalError("Provider team mapping 指向不存在的 team");
            }
            if (tx.seasonTeams && !seasonTeamIds.has(existingMapping.team_id)) {
              seasonTeamIds.add(existingMapping.team_id);
              await tx.seasonTeams.upsertMany([{ schema_version: SCHEMA_VERSION, league_id: batch.league.league_id, season_id: batch.seasonId, team_id: existingMapping.team_id, source: "map_teams", provider: parsed.provider, provider_team_id: parsed.provider_team_id, created_at: serverNow, updated_at: serverNow }]);
            }
            teamsUnchanged += 1;
            continue;
          }

          const teamId = newUuid();
          const team: Team = {
            schema_version: SCHEMA_VERSION,
            team_id: teamId,
            league_id: batch.league.league_id,
            name: parsed.name,
            name_zh: parsed.name_zh,
            logo_url: parsed.logo_url,
            short_name: null,
            primary_color: null,
            secondary_color: null,
            status: TeamStatus.Active,
            created_at: serverNow,
            updated_at: serverNow,
          };
          const mapping: TeamProviderMapping = {
            schema_version: SCHEMA_VERSION,
            team_id: teamId,
            provider: parsed.provider,
            provider_team_id: parsed.provider_team_id,
            created_at: serverNow,
            updated_at: serverNow,
          };

          await tx.teams.insert(team);
          await tx.teamProviderMappings.insert(mapping);
          seasonTeamIds.add(teamId);
          await tx.seasonTeams?.upsertMany([{ schema_version: SCHEMA_VERSION, league_id: batch.league.league_id, season_id: batch.seasonId, team_id: teamId, source: "map_teams", provider: parsed.provider, provider_team_id: parsed.provider_team_id, created_at: serverNow, updated_at: serverNow }]);
          if (team.name_zh == null && tx.anomalies !== undefined) {
            await persistAnomalyInTransaction(
              tx,
              teamId,
              AnomalyType.ProviderDataInvalid,
              { open: true, blocking: false },
              {
                entity_type: "team",
                reason: "team_name_zh_missing",
                team_id: teamId,
                league_id: batch.league.league_id,
                season_id: batch.seasonId,
                provider: parsed.provider,
                provider_team_id: parsed.provider_team_id,
                team_name: parsed.name,
              },
              serverNow,
            );
          }
          teamsCreated += 1;
        }
      }

      return {
        kind: "completed",
        teams_read: teamsRead,
        teams_created: teamsCreated,
        teams_unchanged: teamsUnchanged,
      };
    });
  }
}
