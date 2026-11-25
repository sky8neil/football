import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MATCHES_JS = join(HERE, "matches.js");
const originalPage = Object.getOwnPropertyDescriptor(globalThis, "Page");

function loadPage() {
  const pageConfig = {};
  Object.defineProperty(globalThis, "Page", { value: (config) => Object.assign(pageConfig, config), configurable: true });
  const module = { exports: {} };
  const factory = runInThisContext(`(function (module, exports, require) {\n${readFileSync(MATCHES_JS, "utf8")}\n})`, {
    filename: MATCHES_JS,
  });
  factory(module, module.exports, (id) => {
    if (id === "../../utils/ui-layout.js") return { headerHeight: () => 88 };
    if (id === "../../utils/logo-registry.js") return { getTeamLogo: () => "", getLeagueLogo: () => "" };
    if (id === "../../utils/team-presentation.js") {
      return { presentTeam: () => ({ nameZh: "Team", logo: "", missing: false }) };
    }
    if (id === "../../utils/nickname.js") return { resolveNickname: () => "球友", truncateNickname: (v) => v };
    if (id === "../../services/matches.js") return { listMatches: vi.fn(async () => ({ statusCode: 200 })) };
    if (id === "../../services/leagues.js") return { getLeagueStatus: vi.fn(async () => ({ statusCode: 200, data: { items: [] } })) };
    if (id === "../../utils/matches-default-league.js") return { resolveDefaultLeagueFromStatus: () => ({ leagueId: "premier_league", activeLeagueIds: [] }) };
    if (id === "../../services/predictions.js") return { createUuidV4: () => "uuid", submitPrediction: vi.fn(), getMyLeagueSummary: vi.fn() };
    if (id === "../../utils/crowd-copy.js") return { COPY: { homeLink: "大家怎么选 ›" } };
    if (id === "../../utils/match-presentation.js") return { formatRound: () => "第 1 轮" };
    if (id === "../../utils/match-card-state.js") {
      const m = { exports: {} };
      runInThisContext(`(function(module, exports){${readFileSync(join(HERE, "../../utils/match-card-state.js"), "utf8")}})`)(m, m.exports);
      return m.exports;
    }
    if (id === "../../utils/rankings-view-model.js") return { currentSeasonId: () => "2026_2027" };
    if (id === "../../utils/level-season.js") return { formatLevelSeasonLabel: () => "" };
    if (id === "../../services/auth.js") return { getLoginGeneration: () => 0 };
    throw new Error(`Unexpected require: ${id}`);
  });
  return Object.assign({}, pageConfig, {
    data: structuredClone(pageConfig.data),
    setData(patch) { Object.assign(this.data, patch); },
  });
}

afterEach(() => {
  if (originalPage) Object.defineProperty(globalThis, "Page", originalPage);
  else delete globalThis.Page;
});

describe("home crowd entry", () => {
  it("[D-S2-04] renders crowd entry via item.showCrowdLink and stops parent tap propagation", () => {
    const markup = readFileSync(join(HERE, "matches.wxml"), "utf8");
    expect(markup).toContain('wx:if="{{item.showCrowdLink}}"');
    expect(markup).toContain('class="crowd-link" data-match-id="{{item.match_id}}" catchtap="onCardTap"');
    expect(markup).not.toContain("item.cardClass === 'is-open'");
  });

  it("[D-S2-04] shows crowd link for live, finished, and post-deadline scheduled matches, but hides it pre-deadline and for cancelled/postponed/abandoned", () => {
    const page = loadPage();
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01" });
    const base = {
      match_id: "m1",
      league_id: "premier_league",
      kickoff_at: "2026-09-01T14:00:00.000Z",
      home_team: {},
      away_team: {},
    };

    expect(page.decorateItem({ ...base, match_status: "live", can_predict: false, can_predict_reason: "NOT_SCHEDULED", is_prediction_closed: true }).showCrowdLink).toBe(true);
    expect(page.decorateItem({ ...base, match_status: "finished", can_predict: false, can_predict_reason: "NOT_SCHEDULED", is_prediction_closed: true }).showCrowdLink).toBe(true);
    expect(page.decorateItem({ ...base, match_status: "scheduled", can_predict: false, can_predict_reason: "CLOSED", is_prediction_closed: true }).showCrowdLink).toBe(true);
    expect(page.decorateItem({ ...base, match_status: "scheduled", can_predict: false, can_predict_reason: "ALREADY_SUBMITTED", is_prediction_closed: true }).showCrowdLink).toBe(true);
    expect(page.decorateItem({ ...base, match_status: "scheduled", can_predict: false, can_predict_reason: "AUTH_REQUIRED", is_prediction_closed: true }).showCrowdLink).toBe(true);
    expect(page.decorateItem({ ...base, match_status: "scheduled", can_predict: false, can_predict_reason: "CLOSED" }).showCrowdLink).toBe(true);

    expect(page.decorateItem({ ...base, match_status: "scheduled", can_predict: true, can_predict_reason: null, is_prediction_closed: false }).showCrowdLink).toBe(false);
    expect(page.decorateItem({ ...base, match_status: "scheduled", can_predict: false, can_predict_reason: "ALREADY_SUBMITTED", is_prediction_closed: false }).showCrowdLink).toBe(false);
    expect(page.decorateItem({ ...base, match_status: "postponed", can_predict: false, can_predict_reason: "CLOSED", is_prediction_closed: true }).showCrowdLink).toBe(false);
    expect(page.decorateItem({ ...base, match_status: "cancelled", can_predict: false, can_predict_reason: "NOT_SCHEDULED", is_prediction_closed: true }).showCrowdLink).toBe(false);
    expect(page.decorateItem({ ...base, match_status: "abandoned", can_predict: false, can_predict_reason: "NOT_SCHEDULED", is_prediction_closed: true }).showCrowdLink).toBe(false);
  });
});
