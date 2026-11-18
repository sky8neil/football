import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const PAGE = new URL("./rankings.js", import.meta.url);
const WXML = new URL("./rankings.wxml", import.meta.url);
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
  return {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
}

describe("ranking empty and standing copy", () => {
  it("renders 去预测 as a dedicated empty-state button", () => {
    const wxml = readFileSync(WXML, "utf8");
    const emptyBlock = wxml.match(/entryCount === 0[\s\S]*?(?=<view wx:if="\{\{view\.showPodium)/)[0];
    expect(emptyBlock).toContain('class="go-predict"');
    expect(emptyBlock).toContain('bindtap="onGoPredict"');
    expect(emptyBlock).toContain("{{goPredictText}}");
    expect(emptyBlock).not.toMatch(/wx:if="\{\{board === 'week'\}\}"/);
  });

  it("states a ranked place once", () => {
    const page = loadPage();
    page.applyListResult({
      statusCode: 200,
      data: {
        available_boards: ["week", "career", "strength"],
        entry_count: 20,
        me: { status: "ranked", rank: 2 },
        items: [{
          user_id: "user-2",
          rank: 2,
          display_name: "Player",
          favorite_team_id: null,
          career_level: 1,
          period_score: 12,
          valid_predictions: 4,
        }],
      },
    }, true);
    expect(page.data.standingStatus).toBe("你位于全站第 2 名。");
    expect(page.data.standingStatus).not.toContain("排名第");
  });

  it("stays neutral when me is missing", () => {
    const page = loadPage();
    page.applyListResult({
      statusCode: 200,
      data: {
        available_boards: ["week"],
        entry_count: 0,
        me: null,
        items: [],
      },
    }, true);
    expect(page.data.standingStatus).not.toMatch(/没有预测/);
    expect(page.data.view.emptyText).not.toMatch(/没有预测/);
    expect(page.data.standingStatus).not.toMatch(/待结算/);
    expect(page.data.view.emptyText).not.toContain("你就是第一名");
  });
});
