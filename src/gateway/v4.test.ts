import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../api/v1/rate-limit.js";
import { MatchQueryService } from "../application/match-query.js";
import { SessionService } from "../application/session.js";
import { SCHEMA_VERSION } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { handleGatewayRequest, type GatewayRequestInput } from "./assemble.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "./config.js";
import { seedGatewayRepository } from "./seed.js";

const TEST_CURSOR_SECRET = "test-match-cursor-secret-v4";
const MOCK_OPENID = "mock-openid-v4";
const NOW = new Date("2026-08-09T12:00:00.000Z");

const FROZEN_UNLOCK_ITEM_KEYS = [
  "unlock_id",
  "unlock_code",
  "threshold_points",
  "source_version",
  "unlocked_at",
] as const;

type ProfileBody = {
  data: {
    nickname: string;
    favorite_team_id: string | null;
    career_points: number;
    career_valid_predictions: number;
    career_wdl_hits: number;
    career_exact_hits: number;
    career_wdl_accuracy_percent: string | null;
    career_level: number;
    career_best_level: number;
  };
};

type LevelsBody = {
  data: {
    season: {
      season_id: string;
      valid_predictions: number;
      wdl_hits: number;
      wdl_accuracy_percent: string | null;
      level: number;
      best_level: number;
    };
    career: {
      valid_predictions: number;
      wdl_hits: number;
      wdl_accuracy_percent: string | null;
      level: number;
      best_level: number;
    };
  };
};

type UnlocksBody = {
  data: {
    default_resources?: string[];
    unlocked: Array<Record<string, unknown>>;
  };
};

function makeConfig(overrides: Partial<GatewayRuntimeConfig> = {}): GatewayRuntimeConfig {
  return {
    environment: "test",
    mock_trusted_openid: null,
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

async function initAuthedHarness() {
  const harness = makeHarness(makeConfig({ mock_trusted_openid: MOCK_OPENID }));
  await seedGatewayRepository(harness.repo, NOW);
  const init = await request(harness, {
    method: "POST",
    path: "/v1/session/init",
    body: { nickname: "Sky" },
  });
  expect(init.status).toBe(201);
  return harness;
}

async function predictableMatchIds(
  harness: ReturnType<typeof makeHarness>,
): Promise<string[]> {
  const listed = await request(harness, { method: "GET", path: "/v1/matches" });
  expect(listed.status).toBe(200);
  const body = listed.body as {
    data: { items: Array<{ match_id: string; can_predict: boolean }> };
  };
  return body.data.items
    .filter((item) => item.can_predict)
    .map((item) => item.match_id);
}

describe("GET /v1/profile/me", () => {
  it("returns 401 UNAUTHORIZED without identity", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/profile/me",
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
  });

  it("returns 200 with profile contract fields after init", async () => {
    const harness = await initAuthedHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/profile/me",
    });

    expect(response.status).toBe(200);
    const body = response.body as ProfileBody;
    expect(body).toEqual({
      data: expect.objectContaining({
        nickname: "Sky",
        favorite_team_id: null,
        career_points: 0,
        career_valid_predictions: 0,
        career_wdl_hits: 0,
        career_exact_hits: 0,
        career_wdl_accuracy_percent: null,
        career_level: 1,
        career_best_level: 1,
      }),
      request_id: expect.any(String),
    });
    expect(body.data).toHaveProperty("nickname");
    expect(body.data).toHaveProperty("career_points");
    expect(body.data).toHaveProperty("career_level");
  });

  it("returns career_points greater than 0 after the v1 submit flow and points update", async () => {
    const harness = await initAuthedHarness();
    const matchIds = await predictableMatchIds(harness);
    expect(matchIds.length).toBeGreaterThan(0);

    const created = await request(harness, {
      method: "POST",
      path: "/v1/predictions",
      body: {
        idempotency_key: newUuid(),
        match_id: matchIds[0],
        home_score: 2,
        away_score: 1,
      },
    });
    expect(created.status).toBe(201);

    const users = await harness.repo.users.findAll();
    const user = users[0];
    expect(user).toBeDefined();
    await harness.repo.users.update({
      ...user!,
      career_points: 12,
    });

    const response = await request(harness, {
      method: "GET",
      path: "/v1/profile/me",
    });
    expect(response.status).toBe(200);
    const body = response.body as ProfileBody;
    expect(body.data.career_points).toBeGreaterThan(0);
  });
});

describe("GET /v1/levels/me", () => {
  it("returns 401 UNAUTHORIZED without identity", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/levels/me",
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
  });

  it("returns 200 with season and career structures after init", async () => {
    const harness = await initAuthedHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/levels/me",
    });

    expect(response.status).toBe(200);
    const body = response.body as LevelsBody;
    expect(body.data.season).toEqual(expect.objectContaining({
      season_id: expect.any(String),
      valid_predictions: expect.any(Number),
      wdl_hits: expect.any(Number),
      level: expect.any(Number),
      best_level: expect.any(Number),
    }));
    expect(body.data.season).toHaveProperty("wdl_accuracy_percent");
    expect(body.data.career).toEqual(expect.objectContaining({
      valid_predictions: expect.any(Number),
      wdl_hits: expect.any(Number),
      level: expect.any(Number),
      best_level: expect.any(Number),
    }));
    expect(body.data.career).toHaveProperty("wdl_accuracy_percent");
  });
});

describe("GET /v1/unlocks/me", () => {
  it("returns 401 UNAUTHORIZED without identity", async () => {
    const harness = makeHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/unlocks/me",
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
  });

  it("returns 200 with an empty unlocked array after init", async () => {
    const harness = await initAuthedHarness();
    const response = await request(harness, {
      method: "GET",
      path: "/v1/unlocks/me",
    });

    expect(response.status).toBe(200);
    const body = response.body as UnlocksBody;
    expect(Array.isArray(body.data.unlocked)).toBe(true);
    expect(body.data.unlocked).toEqual([]);
    if (body.data.default_resources !== undefined) {
      expect(Array.isArray(body.data.default_resources)).toBe(true);
    }
  });

  it("freezes unlock item contract fields and does not add extras", async () => {
    const harness = await initAuthedHarness();
    const users = await harness.repo.users.findAll();
    const user = users[0];
    expect(user).toBeDefined();

    await harness.repo.unlocks.insert({
      schema_version: SCHEMA_VERSION,
      unlock_id: newUuid(),
      user_id: user!.user_id,
      unlock_code: "profile_card_style_1",
      threshold_points: 30,
      source_version: "unlock_v1",
      unlocked_at: NOW,
    });

    const response = await request(harness, {
      method: "GET",
      path: "/v1/unlocks/me",
    });
    expect(response.status).toBe(200);
    const body = response.body as UnlocksBody;
    expect(body.data.unlocked).toHaveLength(1);
    const item = body.data.unlocked[0]!;
    expect(item).toEqual(expect.objectContaining({
      unlock_id: expect.any(String),
      unlock_code: "profile_card_style_1",
      threshold_points: 30,
      source_version: "unlock_v1",
      unlocked_at: NOW.toISOString(),
    }));
    expect(Object.keys(item).sort()).toEqual([...FROZEN_UNLOCK_ITEM_KEYS].sort());
  });
});
