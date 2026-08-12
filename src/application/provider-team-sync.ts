import { MVP_SEASON } from "../domain/config.js";
import { Provider, SCHEMA_VERSION, TeamStatus } from "../domain/enums.js";
import { internalError, validationError } from "../domain/errors.js";
import { newUuid } from "../domain/ids.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import {
  ProviderDataError,
  type ApiFootballTeamQuery,
} from "../provider/http.js";
import type { ApiFootballTeam } from "../provider/types.js";
import type { Team, TeamProviderMapping } from "../domain/types.js";

export interface ProviderTeamClient {
  getTeams(query: ApiFootballTeamQuery): Promise<readonly ApiFootballTeam[]>;
}

export interface ProviderTeamSyncOutcome {
  kind: "completed";
  teams_read: number;
  teams_created: number;
  teams_unchanged: number;
}

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

function parseProviderTeam(raw: ApiFootballTeam): {
  provider_team_id: string;
  name: string;
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
    typeof id !== "number" ||
    !Number.isInteger(id) ||
    id <= 0 ||
    typeof name !== "string" ||
    name.length === 0 ||
    (shortCode !== undefined && shortCode !== null && typeof shortCode !== "string")
  ) {
    throw new ProviderDataError("provider team response contains invalid team fields");
  }

  return {
    provider_team_id: String(id),
    name,
  };
}

/** 同步固定 MVP 赛季的 Provider 球队，并只在首次发现时创建内部球队。 */
export class ProviderTeamSyncService {
  constructor(
    private readonly repo: AppRepository,
    private readonly client: ProviderTeamClient,
  ) {}

  async sync(serverNow: Date): Promise<ProviderTeamSyncOutcome> {
    assertValidServerNow(serverNow);
    const providerTeams = await this.client.getTeams({
      leagueId: MVP_SEASON.api_football_league_id,
      season: MVP_SEASON.api_football_season,
    });
    if (!Array.isArray(providerTeams)) {
      throw new ProviderDataError("provider teams response must be an array");
    }

    return this.repo.withTransaction(async (tx) => {
      requireTeamSyncPorts(tx);
      let teamsCreated = 0;
      let teamsUnchanged = 0;

      for (const raw of providerTeams) {
        const parsed = parseProviderTeam(raw);
        const existingMapping =
          await tx.teamProviderMappings.findByProviderAndExternalId(
            Provider.ApiFootball,
            parsed.provider_team_id,
          );

        if (existingMapping !== null) {
          const existingTeam = await tx.teams.findById(existingMapping.team_id);
          if (existingTeam === null) {
            throw internalError("Provider team mapping 指向不存在的 team");
          }
          teamsUnchanged += 1;
          continue;
        }

        const teamId = newUuid();
        const team: Team = {
          schema_version: SCHEMA_VERSION,
          team_id: teamId,
          name: parsed.name,
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
          provider: Provider.ApiFootball,
          provider_team_id: parsed.provider_team_id,
          created_at: serverNow,
          updated_at: serverNow,
        };

        await tx.teams.insert(team);
        await tx.teamProviderMappings.insert(mapping);
        teamsCreated += 1;
      }

      return {
        kind: "completed",
        teams_read: providerTeams.length,
        teams_created: teamsCreated,
        teams_unchanged: teamsUnchanged,
      };
    });
  }
}
