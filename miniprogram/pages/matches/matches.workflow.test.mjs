import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MATCHES_JS = join(HERE, "matches.js");
const LEAGUE_UTIL = join(HERE, "..", "..", "utils", "matches-default-league.js");
const savedGlobals = {
  Page: Object.getOwnPropertyDescriptor(globalThis, "Page"),
  wx: Object.getOwnPropertyDescriptor(globalThis, "wx"),
};

const match = (id) => ({
  match_id: id,
  league_id: "premier_league",
  kickoff_at: "2026-09-01T10:00:00.000Z",
  match_status: "scheduled",
  can_predict: true,
  can_predict_reason: null,
  regular_home_score: null,
  regular_away_score: null,
  home_team: { team_id: "arsenal", name: "阿森纳" },
  away_team: { team_id: "chelsea", name: "切尔西" },
});

function loadCommonJs(file, requires) {
  const module = { exports: {} };
  const factory = runInThisContext(`(function (module, exports, require) {\n${readFileSync(file, "utf8")}\n})`, {
    filename: file,
  });
  factory(module, module.exports, requires);
  return module.exports;
}

function loadPage({ matchesResult, submitResult } = {}) {
  const listMatches = vi.fn(async () => matchesResult || ({
    statusCode: 200,
    data: { items: [], page: { has_more: false, next_cursor: null } },
  }));
  const submitPrediction = vi.fn(async () => submitResult || ({ statusCode: 201 }));
  const pageConfig = {};
  Object.defineProperty(globalThis, "Page", {
    value: (config) => Object.assign(pageConfig, config),
    configurable: true,
  });
  const logoRegistry = { getTeamLogo: () => "team.png", getLeagueLogo: () => "league.png" };
  const nickname = { resolveNickname: () => "球友", truncateNickname: (value) => value };
  loadCommonJs(MATCHES_JS, (id) => {
    if (id === "../../utils/logo-registry.js") return logoRegistry;
    if (id === "../../utils/nickname.js") return nickname;
    if (id === "../../services/matches.js") return { listMatches };
    if (id === "../../utils/matches-default-league.js") {
      return loadCommonJs(LEAGUE_UTIL, () => { throw new Error("Unexpected league utility dependency"); });
    }
    if (id === "../../services/predictions.js") {
      return { createUuidV4: () => "00000000-0000-4000-8000-000000000001", submitPrediction };
    }
    throw new Error(`Unexpected require: ${id}`);
  });
  const page = Object.assign({}, pageConfig, {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(patch) { Object.assign(this.data, patch); },
  });
  return { page, listMatches, submitPrediction };
}

afterEach(() => {
  for (const [key, descriptor] of Object.entries(savedGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

describe("matches page gateway workflows", () => {
  it("loads matches for the selected league and Beijing calendar date", async () => {
    const { page, listMatches } = loadPage({
      matchesResult: { statusCode: 200, data: { items: [match("match-1")] } },
    });
    page.setData({ selectedLeague: "la_liga", selectedDate: "2026-09-01" });

    await page.loadFirstPage();

    expect(listMatches).toHaveBeenCalledWith({
      from: "2026-08-31T16:00:00.000Z",
      to: "2026-09-01T16:00:00.000Z",
      league_id: "la_liga",
      limit: 100,
    });
    expect(page.data.state).toBe("list");
    expect(page.data.items.map((item) => item.match_id)).toEqual(["match-1"]);
  });

  it("loads the next page using the API cursor and appends matches", async () => {
    const { page, listMatches } = loadPage({
      matchesResult: {
        statusCode: 200,
        data: { items: [match("match-2")], page: { has_more: false, next_cursor: null } },
      },
    });
    page.setData({
      selectedLeague: "premier_league",
      selectedDate: "2026-09-01",
      items: [page.decorateItem(match("match-1"))],
      hasMore: true,
      nextCursor: "next-page",
    });

    page.onMore();
    await vi.waitFor(() => expect(page.data.loadingMore).toBe(false));

    expect(listMatches).toHaveBeenCalledWith(expect.objectContaining({ cursor: "next-page" }));
    expect(page.data.items.map((item) => item.match_id)).toEqual(["match-1", "match-2"]);
  });

  it("submits the edited score with a UUID and locks the submitted prediction", async () => {
    const { page, submitPrediction } = loadPage();
    const item = match("match-1");
    const key = "premier_league:2026-09-01:match-1";
    page.setData({ selectedLeague: "premier_league", selectedDate: "2026-09-01", items: [item] });
    page.drafts[key] = { home: 2, away: 1 };
    page.uiStates[key] = "editing";

    page.onSubmitTap({ currentTarget: { dataset: { matchId: "match-1" } } });
    await vi.waitFor(() => expect(submitPrediction).toHaveBeenCalledOnce());

    expect(submitPrediction).toHaveBeenCalledWith({
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      matchId: "match-1",
      homeScore: 2,
      awayScore: 1,
    });
    await vi.waitFor(() => expect(page.uiStates[key]).toBe("submitted_locked"));
    expect(page.submittedMap[key]).toEqual({ home: 2, away: 1 });
  });
});
