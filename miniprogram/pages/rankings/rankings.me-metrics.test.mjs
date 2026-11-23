import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const PAGE = new URL("./rankings.js", import.meta.url);
const CONFIG = new URL("../../config.js", import.meta.url);
const COPY = new URL("../../utils/rankings-copy.js", import.meta.url);
const MODEL = new URL("../../utils/rankings-view-model.js", import.meta.url);

function loadCommonJs(url, dependencies = {}) {
  const module = { exports: {} };
  runInNewContext(readFileSync(url, "utf8"), {
    module,
    exports: module.exports,
    require: (name) => dependencies[name],
  });
  return module.exports;
}

const copy = loadCommonJs(COPY);
const viewModel = loadCommonJs(MODEL, {
  "../config.js": loadCommonJs(CONFIG),
  "./rankings-copy.js": copy,
});

function loadPage(board = "week") {
  let definition;
  runInNewContext(readFileSync(PAGE, "utf8"), {
    Page: (value) => { definition = value; },
    require: (name) => {
      if (name.includes("rankings-view-model")) return viewModel;
      if (name.includes("rankings-copy")) return copy;
      if (name.includes("ui-layout")) return { headerHeight: () => 88 };
      if (name.includes("level-season")) return { formatLevelSeasonLabel: () => "" };
      return {};
    },
  });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
  page.setData({ board });
  return page;
}

function others(board) {
  const item = {
    user_id: "other-1",
    rank: 1,
    display_name: "Other",
    favorite_team_id: null,
    career_level: 1,
  };
  if (board === "career") {
    return [{ ...item, career_points: 80, career_valid_predictions: 20, exact_hits: 4 }];
  }
  if (board === "season") {
    return [{ ...item, season_points: 40, season_valid_predictions: 10, exact_hits: 2 }];
  }
  if (board === "strength") {
    return [{ ...item, strength_index: "6.75", window_n: 50 }];
  }
  return [{ ...item, period_score: 30, valid_predictions: 8, exact_hits: 2 }];
}

describe("ranking me metrics from payload.me", () => {
  it.each([
    ["week", { period_score: 175, valid_predictions: 8, exact_hits: 3 }, 175],
    ["career", { career_points: 75, career_valid_predictions: 5, exact_hits: 1 }, 75],
    ["season", { season_points: 55, season_valid_predictions: 2, exact_hits: 1 }, 55],
    ["strength", { strength_index: "2.08", window_n: 50 }, "2.08"],
  ])("uses ranked %s metrics when the current user is outside the page", (board, metrics, expected) => {
    const page = loadPage(board);
    page.applyListResult({
      statusCode: 200,
      data: {
        available_boards: ["week", "career", "strength", "season"],
        entry_count: 30,
        me: { status: "ranked", rank: null, top_percent: 84, ...metrics },
        items: others(board),
      },
    }, true);
    expect(page.data.standingValue).toBe(expected);
    expect(page.data.items.some((item) => item.user_id === "me-user")).toBe(false);
  });

  it("keeps a ranked week score of 0 instead of a missing placeholder", () => {
    const page = loadPage("week");
    page.applyListResult({
      statusCode: 200,
      data: {
        available_boards: ["week"],
        entry_count: 30,
        me: { status: "ranked", rank: null, top_percent: 99, period_score: 0, valid_predictions: 5, exact_hits: 0 },
        items: others("week"),
      },
    }, true);
    expect(page.data.standingValue).toBe(0);
  });

  it("does not read the paginated row when payload.me has a different ranked score", () => {
    const page = loadPage("week");
    page.profileData = { user_id: "me-user" };
    page.applyListResult({
      statusCode: 200,
      data: {
        available_boards: ["week"],
        entry_count: 20,
        me: { status: "ranked", rank: 2, top_percent: null, period_score: 99, valid_predictions: 8, exact_hits: 3 },
        items: [{
          user_id: "me-user",
          rank: 2,
          display_name: "Me",
          favorite_team_id: null,
          career_level: 1,
          period_score: 12,
          valid_predictions: 4,
          exact_hits: 1,
        }],
      },
    }, true);
    expect(page.data.standingValue).toBe(99);
  });

  it.each([
    ["not_participated", { status: "not_participated" }],
    ["below_threshold", { status: "below_threshold", remaining_valid_predictions: 5 }],
    ["not_eligible", { status: "not_eligible", seasons_participated: 1 }],
    ["missing me", null],
  ])("keeps the missing placeholder when me is %s", (_label, me) => {
    const page = loadPage("week");
    page.profileData = { user_id: "me-user" };
    page.applyListResult({
      statusCode: 200,
      data: {
        available_boards: ["week"],
        entry_count: 1,
        me,
        items: others("week"),
      },
    }, true);
    expect(page.data.standingValue).toBe("—");
  });
});
