import type { LeagueStatusItem, LeagueStatusService } from "../../application/league-status-service.js";
import { requirePublicSource } from "./matches.js";
import { defaultApiRateLimiter, type RateLimiter } from "./rate-limit.js";
import { assertUnknownFields } from "./validation.js";

export interface GetLeagueStatusInput {
  authenticated_user_id?: string | null;
  public_source: string;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export async function getLeagueStatus(
  service: Pick<LeagueStatusService, "list">,
  input: GetLeagueStatusInput,
): Promise<{ status: 200; body: { data: { items: LeagueStatusItem[] }; request_id: string } }> {
  assertUnknownFields(input.query, new Set());
  const publicSource = requirePublicSource(input.public_source);
  await (input.rate_limiter ?? defaultApiRateLimiter).check("public_reads", publicSource, input.server_now);
  const items = await service.list(input.server_now);
  return { status: 200, body: { data: { items }, request_id: input.request_id } };
}
