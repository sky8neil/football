import { describe, expect, it } from "vitest";
import { newUuid } from "../domain/ids.js";
import type { Unlock, User } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { UnlocksQueryService } from "./unlocks.js";

const NOW = new Date("2026-08-10T00:00:00.000Z");
const USER_ID = "00000000-0000-4000-8000-000000000001";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: USER_ID,
    openid: "openid-unlocks",
    unionid: null,
    nickname: "Sky",
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeUnlock(overrides: Partial<Unlock> = {}): Unlock {
  return {
    schema_version: 1,
    unlock_id: newUuid(),
    user_id: USER_ID,
    unlock_code: "profile_card_style_1",
    threshold_points: 30,
    source_version: "unlock_v1",
    unlocked_at: NOW,
    ...overrides,
  };
}

describe("UnlocksQueryService", () => {
  it("returns fixed default resources and all historical unlocks", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ career_points: 0 });
    await repo.users.insert(user);
    const unlock = makeUnlock();
    await repo.unlocks.insert(unlock);

    await expect(new UnlocksQueryService(repo).getUnlocks(USER_ID)).resolves.toEqual({
      default_resources: ["avatar_frame", "profile_card", "share_card"],
      unlocked: [
        {
          unlock_id: unlock.unlock_id,
          unlock_code: unlock.unlock_code,
          threshold_points: unlock.threshold_points,
          source_version: unlock.source_version,
          unlocked_at: NOW.toISOString(),
        },
      ],
    });
  });

  it("does not hide a historical unlock when current points are below its threshold", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ career_points: 0 });
    await repo.users.insert(user);
    await repo.unlocks.insert(makeUnlock());

    await expect(new UnlocksQueryService(repo).getUnlocks(USER_ID)).resolves.toMatchObject({
      unlocked: [{ unlock_code: "profile_card_style_1" }],
    });
  });

  it("returns an empty unlocked list and keeps the existing stable order", async () => {
    const emptyRepo = new InMemoryRepository();
    await emptyRepo.users.insert(makeUser());
    await expect(new UnlocksQueryService(emptyRepo).getUnlocks(USER_ID)).resolves.toEqual({
      default_resources: ["avatar_frame", "profile_card", "share_card"],
      unlocked: [],
    });

    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser());
    const later = makeUnlock({
      unlock_id: "00000000-0000-4000-8000-000000000102",
      unlock_code: "favorite_team_name_accent",
      threshold_points: 100,
    });
    const earlier = makeUnlock({
      unlock_id: "00000000-0000-4000-8000-000000000101",
      unlock_code: "profile_card_style_1",
      threshold_points: 30,
    });
    await repo.unlocks.insert(later);
    await repo.unlocks.insert(earlier);

    await expect(new UnlocksQueryService(repo).getUnlocks(USER_ID)).resolves.toMatchObject({
      unlocked: [
        { unlock_id: earlier.unlock_id },
        { unlock_id: later.unlock_id },
      ],
    });
  });

  it("rejects deleted and invalid users", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser({ status: "deleted", deleted_at: NOW }));

    await expect(new UnlocksQueryService(repo).getUnlocks(USER_ID)).rejects.toMatchObject({
      code: "USER_DELETED",
    });
    await expect(new UnlocksQueryService(repo).getUnlocks("not-a-uuid")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(new UnlocksQueryService(new InMemoryRepository()).getUnlocks(USER_ID)).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
    });
  });
});
