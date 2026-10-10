import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("home crowd entry", () => {
  it("is limited to live and finished cards and stops parent tap propagation", () => {
    const markup = readFileSync(join(HERE, "matches.wxml"), "utf8");
    expect(markup).toContain("item.cardClass === 'is-live' || item.cardClass === 'is-done'");
    expect(markup).toContain('class="crowd-link" data-match-id="{{item.match_id}}" catchtap="onCardTap"');
    expect(markup).not.toContain("item.cardClass === 'is-open'");
    expect(markup).not.toContain("item.cardClass === 'is-closed'");
  });
});
