import { describe, expect, it, vi } from "vitest";
import { executePlan, parseArgs } from "./identity-migration.mjs";

describe("identity migration command", () => {
  it("defaults to dry-run and parses apply and rollback options", () => {
    expect(parseArgs([]).mode).toBe("dry-run");
    expect(parseArgs(["--apply", "--backup", "backup.json", "--manifest", "manifest.json"])).toMatchObject({ mode: "apply", backup: expect.stringMatching(/backup\.json$/), manifest: expect.stringMatching(/manifest\.json$/) });
    expect(parseArgs(["--rollback", "manifest.json"])).toMatchObject({ mode: "rollback", rollback: expect.stringMatching(/manifest\.json$/) });
  });
  it("rejects conflicting, incomplete and unknown options", () => {
    expect(() => parseArgs(["--apply", "--dry-run"])).toThrow();
    expect(() => parseArgs(["--rollback"])).toThrow();
    expect(() => parseArgs(["--backup", "file"])).toThrow();
    expect(() => parseArgs(["--unknown"])).toThrow();
  });
  it("refuses apply before calling the injected writer when review is nonempty", async () => {
    const writer = vi.fn();
    await expect(executePlan({ review: [{ kind: "duplicate_prediction" }] }, writer)).rejects.toThrow("duplicate_prediction");
    expect(writer).not.toHaveBeenCalled();
  });
});
