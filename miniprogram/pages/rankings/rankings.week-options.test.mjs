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

function loadPage() {
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
  page.setData({ board: "week" });
  return page;
}

function weekResult(data) {
  return {
    statusCode: 200,
    data: {
      board: "week",
      available_boards: ["week", "career", "strength"],
      entry_count: 1,
      me: { status: "ranked", rank: 1, period_score: 12, valid_predictions: 4, exact_hits: 1 },
      items: [{
        user_id: "user-1",
        rank: 1,
        display_name: "Player",
        favorite_team_id: null,
        career_level: 1,
        period_score: 12,
        valid_predictions: 4,
        exact_hits: 1,
      }],
      ...data,
    },
  };
}

describe("ranking week options from first_period_key", () => {
  it("prefers GET /v1/rankings first_period_key over the local config fallback", () => {
    const page = loadPage();
    page.applyListResult(weekResult({
      current_period_key: "2026-W47",
      period_key: "2026-W47",
      first_period_key: "2026-W45",
    }), true);
    expect(page.data.weekOptions.map((item) => item.key)).toEqual([
      "2026-W47",
      "2026-W46",
      "2026-W45",
    ]);
  });

  it("falls back to rankingFirstPeriodKey when the old payload omits first_period_key", () => {
    const page = loadPage();
    page.applyListResult(weekResult({
      current_period_key: "2026-W32",
      period_key: "2026-W32",
    }), true);
    expect(page.data.weekOptions.map((item) => item.key)).toEqual(["2026-W32", "2026-W31"]);
  });

  it("falls back when first_period_key is null or empty", () => {
    const missing = loadPage();
    missing.applyListResult(weekResult({
      current_period_key: "2026-W32",
      period_key: "2026-W32",
      first_period_key: null,
    }), true);
    const empty = loadPage();
    empty.applyListResult(weekResult({
      current_period_key: "2026-W32",
      period_key: "2026-W32",
      first_period_key: "",
    }), true);
    expect(missing.data.weekOptions.map((item) => item.key)).toEqual(["2026-W32", "2026-W31"]);
    expect(empty.data.weekOptions.map((item) => item.key)).toEqual(["2026-W32", "2026-W31"]);
  });

  it("keeps ISO weeks across a year boundary from the payload first_period_key", () => {
    const page = loadPage();
    page.applyListResult(weekResult({
      current_period_key: "2027-W02",
      period_key: "2027-W02",
      first_period_key: "2026-W53",
    }), true);
    expect(page.data.weekOptions.map((item) => item.key)).toEqual([
      "2027-W02",
      "2027-W01",
      "2026-W53",
    ]);
    expect(page.data.weekOptionLabels[0]).toBe("本周");
  });
});
