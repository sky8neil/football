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
      /  \/unlocks\/me:\n    get:[\s\S]*?'429':[\s\S]*?RateLimited/,
    );
  });
});
