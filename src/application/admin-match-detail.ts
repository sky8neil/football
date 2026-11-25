import { AnomalyStatus } from "../domain/enums.js";
import { notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import type { Anomaly, Match, Team } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { AdminAuthorizationService } from "./admin.js";

export interface AdminMatchDetailOutcome {
  match: Match;
  home_team: Team | null;
  away_team: Team | null;
  open_anomalies: Anomaly[];
}

export class AdminMatchDetailService {
  private readonly authorization = new AdminAuthorizationService();

  constructor(private readonly repo: AppRepository) {}

  authorizeAdmin(trustedOpenid: string): Promise<void> {
    return this.authorization.authorizeAdmin(this.repo, trustedOpenid);
  }

  async getMatchDetail(
    trustedOpenid: string | null | undefined,
    matchId: string,
  ): Promise<AdminMatchDetailOutcome> {
    if (typeof matchId !== "string" || !isValidUuid(matchId)) {
      throw validationError("match_id 必须为 UUID v4", { field: "match_id" });
    }
    await this.authorization.requireActiveAdmin(this.repo, trustedOpenid);

    const match = await this.repo.matches.findById(matchId);
    if (match === null) {
      throw notFoundError("MATCH");
    }

    const [homeTeam, awayTeam, rawAnomalies] = await Promise.all([
      this.repo.teams?.findById(match.home_team_id) ?? Promise.resolve(null),
      this.repo.teams?.findById(match.away_team_id) ?? Promise.resolve(null),
      this.repo.anomalies === undefined
        ? Promise.resolve<Anomaly[]>([])
        : this.repo.anomalies.findOpenByMatch
          ? this.repo.anomalies.findOpenByMatch(match.match_id)
          : this.repo.anomalies.findOpenBlockingByMatch(match.match_id),
    ]);

    const openAnomalies = rawAnomalies
      .filter((anomaly) => anomaly.status === AnomalyStatus.Open)
      .sort((a, b) => {
        const tsDiff = b.last_seen_at.getTime() - a.last_seen_at.getTime();
        if (tsDiff !== 0) {
          return tsDiff;
        }
        return b.anomaly_id.localeCompare(a.anomaly_id);
      });

    return {
      match,
      home_team: homeTeam,
      away_team: awayTeam,
      open_anomalies: openAnomalies,
    };
  }
}
