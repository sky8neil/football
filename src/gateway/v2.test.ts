import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../api/v1/rate-limit.js";
import { MatchQueryService } from "../application/match-query.js";
import { SessionService } from "../application/session.js";
import { SCHEMA_VERSION } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Prediction } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { handleGatewayRequest, type GatewayRequestInput } from "./assemble.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "./config.js";
import { seedGatewayRepository } from "./seed.js";

const TEST_CURSOR_SECRET = "test-match-cursor-secret-v2";
const MOCK_OPENID = "mock-openid-v2";
const NOW = new Date("2026-08-09T12:00:00.000Z");

const NOT_SCHEDULED_STATUSES = [
  "live",
  "finished",
  "postponed",
  "cancelled",
  "abandoned",
] as const;

type MatchCard = {
  match_id: string;
  match_status: string;
  home_team: { name: string };
  away_team: { name: string };
  regular_home_score: number | null;
  regular_away_score: number | null;
  can_predict: boolean;
  can_predict_reason: string | null;
  prediction_deadline_at: string | null;
  prediction_closed_at: string | null;
  match_score?: number | null;
  wdl_hit?: boolean | null;
  exact_hit?: boolean | null;
  my_prediction?: {
    match_score: number | null;
    wdl_hit: boolean | null;
    exact_hit: boolean | null;
  } | null;
};

function makeConfig(overrides: Partial<GatewayRuntimeConfig> = {}): GatewayRuntimeConfig {
  return {
    environment: "test",
    mock_trusted_openid: MOCK_OPENID,
    match_cursor_secret: TEST_CURSOR_SECRET,
    public_source: LOCAL_PUBLIC_SOURCE,
    ...overrides,
  };
}

function makeHarness(config: GatewayRuntimeConfig = makeConfig()) {
  const repo = new InMemoryRepository();
  const rateLimiter = new InMemoryRateLimiter();
  return {
    repo,
    rateLimiter,
    config,
    session: new SessionService(repo),
    matches: new MatchQueryService(repo, config.match_cursor_secret),
  };
}

function request(
  harness: ReturnType<typeof makeHarness>,
  input: Partial<GatewayRequestInput> & Pick<GatewayRequestInput, "method" | "path">,
) {
  return handleGatewayRequest({
    method: input.method,
    path: input.path,
    query: input.query ?? {},
    body: input.body,
    server_now: input.server_now ?? NOW,
    config: harness.config,
    services: { session: harness.session, matches: harness.matches },
    repo: harness.repo,
    rate_limiter: harness.rateLimiter,
  });
}

async function seedAuthedHarness() {
  const harness = makeHarness();
  await seedGatewayRepository(harness.repo, NOW);
  const init = await request(harness, {
    method: "POST",
    path: "/v1/session/init",
    body: { nickname: "Sky" },
  });
  expect(init.status).toBe(201);
  const initBody = init.body as { data: { user_id: string } };
  return { harness, userId: initBody.data.user_id };
}

async function listItems(harness: ReturnType<typeof makeHarness>): Promise<MatchCard[]> {
  const listed = await request(harness, { method: "GET", path: "/v1/matches" });
  expect(listed.status).toBe(200);
  const body = listed.body as { data: { items: MatchCard[] } };
  return body.data.items;
}

function assertNoFakeSettlement(item: MatchCard): void {
  if ("match_score" in item) {
    expect(item.match_score).toBeNull();
  }
  if ("wdl_hit" in item) {
    expect(item.wdl_hit).toBeNull();
  }
  if ("exact_hit" in item) {
    expect(item.exact_hit).toBeNull();
  }
}

describe("V2 list status matrix", () => {
  it("returns every seeded match_status with frozen can_predict reasons", async () => {
    const { harness } = await seedAuthedHarness();
    const items = await listItems(harness);

    const statuses = new Set(items.map((item) => item.match_status));
    expect(statuses).toEqual(new Set([
      "scheduled",
      "live",
      "finished",
      "postponed",
      "cancelled",
      "abandoned",
    ]));

    const predictable = items.filter(
      (item) => item.match_status === "scheduled" && item.can_predict,
    );
    expect(predictable.length).toBeGreaterThan(0);
    for (const item of predictable) {
      expect(item.can_predict_reason).toBeNull();
    }

    const unconfirmed = items.filter(
      (item) => item.match_status === "scheduled" && !item.can_predict,
    );
    expect(unconfirmed.length).toBeGreaterThan(0);
    for (const item of unconfirmed) {
      expect(item.can_predict_reason).toBe("KICKOFF_UNCONFIRMED");
    }

    for (const status of NOT_SCHEDULED_STATUSES) {
      const group = items.filter((item) => item.match_status === status);
      expect(group.length).toBeGreaterThan(0);
      for (const item of group) {
        expect(item.can_predict).toBe(false);
        expect(item.can_predict_reason).toBe("NOT_SCHEDULED");
      }
    }
  });

  it("M2: list cards include team names, finished regular scores, and no fake zeros", async () => {
    const { harness } = await seedAuthedHarness();
    const items = await listItems(harness);

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.home_team.name.length).toBeGreaterThan(0);
      expect(item.away_team.name.length).toBeGreaterThan(0);
      assertNoFakeSettlement(item);
    }

    const finished = items.filter((item) => item.match_status === "finished");
    expect(finished.length).toBeGreaterThan(0);
    for (const item of finished) {
      expect(item.regular_home_score).not.toBeNull();
      expect(item.regular_away_score).not.toBeNull();
    }

    const unsettled = items.filter((item) => item.match_status !== "finished");
    for (const item of unsettled) {
      expect(item.regular_home_score).toBeNull();
      expect(item.regular_away_score).toBeNull();
    }
  });

  it("M9: postponed with a stale deadline and null closed_at is NOT_SCHEDULED", async () => {
    const { harness } = await seedAuthedHarness();
    const items = await listItems(harness);
    const postponed = items.filter((item) => item.match_status === "postponed");
    expect(postponed.length).toBeGreaterThan(0);

    for (const item of postponed) {
      expect(item.prediction_closed_at).toBeNull();
      expect(item.prediction_deadline_at).not.toBeNull();
      expect(Date.parse(item.prediction_deadline_at ?? "")).toBeLessThan(NOW.getTime());
      expect(item.can_predict).toBe(false);
      expect(item.can_predict_reason).toBe("NOT_SCHEDULED");
    }
  });

  it("M13: finished unsettled prediction caches stay null; settled caches are non-null", async () => {
    const { harness, userId } = await seedAuthedHarness();
    const items = await listItems(harness);
    const finished = items.find((item) => item.match_status === "finished");
    expect(finished).toBeDefined();
    const matchId = finished!.match_id;

    const unsetDetail = await request(harness, {
      method: "GET",
      path: `/v1/matches/${matchId}`,
    });
    expect(unsetDetail.status).toBe(200);
    const unsetBody = unsetDetail.body as { data: MatchCard };
    expect(unsetBody.data.my_prediction).toBeNull();
    assertNoFakeSettlement(unsetBody.data);

    const prediction: Prediction = {
      schema_version: SCHEMA_VERSION,
      prediction_id: newUuid(),
      user_id: userId,
      match_id: matchId,
      idempotency_key: newUuid(),
      pred_home_score: 2,
      pred_away_score: 1,
      derived_result: "HOME",
      submitted_at: NOW,
      scoring_rule_version: "scoring_v1",
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
      applied_result_version: 0,
      created_at: NOW,
      updated_at: NOW,
    };
    await harness.repo.predictions.insert(prediction);

    const pendingDetail = await request(harness, {
      method: "GET",
      path: `/v1/matches/${matchId}`,
    });
    expect(pendingDetail.status).toBe(200);
    const pendingBody = pendingDetail.body as { data: MatchCard };
    expect(pendingBody.data.my_prediction).toEqual(expect.objectContaining({
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
    }));

    await harness.repo.predictions.update({
      ...prediction,
      match_score: 12,
      wdl_hit: true,
      exact_hit: true,
      applied_result_version: 1,
      updated_at: NOW,
    });

    const settledDetail = await request(harness, {
      method: "GET",
      path: `/v1/matches/${matchId}`,
    });
    expect(settledDetail.status).toBe(200);
    const settledBody = settledDetail.body as { data: MatchCard };
    expect(settledBody.data.my_prediction).toEqual(expect.objectContaining({
      match_score: 12,
      wdl_hit: true,
      exact_hit: true,
    }));
  });
});

describe("V2 detail status matrix", () => {
  it("GET /v1/matches/{id} returns the same status and predictability as the list", async () => {
    const { harness } = await seedAuthedHarness();
    const items = await listItems(harness);

    const byStatus = new Map<string, MatchCard>();
    for (const item of items) {
      if (item.match_status === "scheduled" && item.can_predict_reason === "KICKOFF_UNCONFIRMED") {
        byStatus.set("kickoff_unconfirmed", item);
      } else if (!byStatus.has(item.match_status)) {
        byStatus.set(item.match_status, item);
      }
    }

    expect(byStatus.has("scheduled")).toBe(true);
    expect(byStatus.has("kickoff_unconfirmed")).toBe(true);
    for (const status of NOT_SCHEDULED_STATUSES) {
      expect(byStatus.has(status)).toBe(true);
    }

    for (const [label, item] of byStatus) {
      const response = await request(harness, {
        method: "GET",
        path: `/v1/matches/${item.match_id}`,
      });
      expect(response.status).toBe(200);
      const body = response.body as { data: MatchCard };
      expect(body.data.match_status).toBe(item.match_status);
      expect(body.data.can_predict).toBe(item.can_predict);
      expect(body.data.can_predict_reason).toBe(item.can_predict_reason);
      if (label === "kickoff_unconfirmed") {
        expect(body.data.can_predict).toBe(false);
        expect(body.data.can_predict_reason).toBe("KICKOFF_UNCONFIRMED");
      } else if (label === "scheduled") {
        expect(body.data.can_predict).toBe(true);
        expect(body.data.can_predict_reason).toBeNull();
      } else {
        expect(body.data.can_predict).toBe(false);
        expect(body.data.can_predict_reason).toBe("NOT_SCHEDULED");
      }
    }
  });
});
