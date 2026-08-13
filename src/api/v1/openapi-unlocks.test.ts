import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("unlocks OpenAPI contract", () => {
  it("declares GET /unlocks/me and its default/unlocked data", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");

    expect(specification).toMatch(
      /  \/unlocks\/me:\n    get:[\s\S]*?\$ref: '#\/components\/schemas\/UnlocksEnvelope'/,
    );
    expect(specification).toMatch(
      /    UnlocksData:[\s\S]*?required: \[default_resources, unlocked\][\s\S]*?default_resources:[\s\S]*?unlocked:[\s\S]*?UnlockRecord/,
    );
    expect(specification).toMatch(
      /    UnlocksData:[\s\S]*?default_resources:[\s\S]*?const: \[avatar_frame, profile_card, share_card\]/,
    );
    expect(specification).toMatch(
      /    UnlockRecord:[\s\S]*?required: \[unlock_id, unlock_code, threshold_points, source_version, unlocked_at\][\s\S]*?unlocked_at:[\s\S]*?format: date-time/,
    );
    expect(specification).toMatch(
      /    UnlockRecord:[\s\S]*?unlock_code:[\s\S]*?enum: \[profile_card_style_1, favorite_team_name_accent, favorite_team_avatar_frame_1\]/,
    );
    expect(specification).toMatch(
      /    UnlockRecord:[\s\S]*?threshold_points:[\s\S]*?enum: \[30, 100, 200\]/,
    );
    expect(specification).toMatch(
      /  \/unlocks\/me:\n    get:[\s\S]*?'429':[\s\S]*?RateLimited/,
    );
  });

  it("declares the complete unlock failure mapping and trusted runtime identity requirement", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const endpoint = specification.match(/  \/unlocks\/me:\n    get:[\s\S]*?\n  \/share-card\/me:/)?.[0] ?? "";

    expect(endpoint).toContain("x-requires-trusted-openid: true");
    expect(endpoint).not.toContain("security:");
    expect(endpoint).not.toMatch(/parameters:/);
    expect(endpoint).not.toMatch(/requestBody:/);
    expect(endpoint).toMatch(/'401':[\s\S]*?Unauthorized/);
    expect(endpoint).toMatch(/'404':[\s\S]*?UnlocksUserNotFound/);
    expect(endpoint).toMatch(/'409':[\s\S]*?UnlocksUserDeleted/);
    expect(endpoint).toMatch(/'422':[\s\S]*?ValidationError/);
    expect(endpoint).toMatch(/'429':[\s\S]*?RateLimited/);
    expect(endpoint).toMatch(/'500':[\s\S]*?InternalError/);

    expect(specification).toMatch(
      /    UnlocksUserNotFound:\n      description: 404 USER_NOT_FOUND/,
    );
    expect(specification).toMatch(
      /    UnlocksUserDeleted:\n      description: 409 USER_DELETED/,
    );
  });
});
