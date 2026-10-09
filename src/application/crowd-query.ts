import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { UserStatus } from "../domain/enums.js";
import { conflictError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { crowdStatus, roundDistribution } from "../domain/crowd-distribution.js";
import type { CrowdStatus } from "../domain/crowd-distribution.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { assertValidServerNow } from "./period-finalize.js";

export interface CrowdQueryInput {
  authenticated_user_id: string | null | undefined;
  match_id: string;
  server_now: Date;
}

export interface CrowdQueryResult {
  match_id: string;
  status: CrowdStatus;
  distribution: { home: number; draw: number; away: number } | null;
  granularity: number;
  min_predictions: number;
}

export class CrowdQueryService {
  constructor(private readonly repo: AppRepository) {}

  async get(input: CrowdQueryInput): Promise<CrowdQueryResult> {
    assertValidServerNow(input.server_now);
    if (!isValidUuid(input.match_id)) {
      throw validationError("match_id 必须为 UUID v4", { field: "match_id" });
    }

    const match = await this.repo.matches.findById(input.match_id);
    if (match === null) {
      throw notFoundError("MATCH");
    }

    const userId = input.authenticated_user_id;
    if (typeof userId !== "string" || userId.length === 0) {
      throw conflictError("UNAUTHORIZED", "需要登录后查看大家怎么选");
    }
    if (!isValidUuid(userId)) {
      throw validationError("authenticated_user_id 必须为 UUID v4", {
        field: "authenticated_user_id",
      });
    }
    const user = await this.repo.users.findById(userId);
    if (user === null) {
      throw conflictError("UNAUTHORIZED", "需要登录后查看大家怎么选");
    }
    if (user.status !== UserStatus.Active) {
      throw conflictError("USER_DELETED", "该账号已被注销");
    }

    const initialStatus = crowdStatus({
      match,
      predictionCount: 0,
      serverNow: input.server_now,
    });
    if (initialStatus === "not_closed" || initialStatus === "unavailable") {
      return this.mapResult(input.match_id, initialStatus, null);
    }

    const counts = await this.repo.predictions.countByMatchGroupedByResult(match.match_id);
    const predictionCount = counts.HOME + counts.DRAW + counts.AWAY;
    const status = crowdStatus({ match, predictionCount, serverNow: input.server_now });
    return this.mapResult(
      input.match_id,
      status,
      status === "available" ? roundDistribution(counts) : null,
    );
  }

  private mapResult(
    matchId: string,
    status: CrowdStatus,
    distribution: CrowdQueryResult["distribution"],
  ): CrowdQueryResult {
    return {
      match_id: matchId,
      status,
      distribution,
      granularity: FIXED_CONFIG_V1.CROWD_GRANULARITY_PERCENT,
      min_predictions: FIXED_CONFIG_V1.CROWD_MIN_PREDICTIONS,
    };
  }
}
