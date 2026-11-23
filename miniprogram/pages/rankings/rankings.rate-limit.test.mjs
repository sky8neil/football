import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const PAGE = new URL("./rankings.js", import.meta.url);
const WXML = new URL("./rankings.wxml", import.meta.url);
const CONFIG = new URL("../../config.js", import.meta.url);
const COPY = new URL("../../utils/rankings-copy.js", import.meta.url);
const MODEL = new URL("../../utils/rankings-view-model.js", import.meta.url);
const LEVEL_SEASON = new URL("../../utils/level-season.js", import.meta.url);

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

function rankingPayload() {
  return {
    statusCode: 200,
    data: {
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
      page: { has_more: false, next_cursor: null },
    },
  };
}

function loadPage(serviceOverrides = {}) {
  let definition;
  const services = {
    rankings: {
      listRankings: vi.fn(async () => rankingPayload()),
    },
    profile: {
      getMyProfile: vi.fn(async () => ({
        statusCode: 200,
        data: { user_id: "user-1", nickname: "测试用户" },
      })),
    },
    levels: {
      getMyLevels: vi.fn(async () => ({
        statusCode: 200,
        data: { season: { valid_predictions: 4 } },
      })),
    },
    groups: {
      listMyGroups: vi.fn(async () => ({ statusCode: 200, data: { items: [] } })),
    },
    ...serviceOverrides,
  };
  const dependencies = {
    "../../services/rankings.js": services.rankings,
    "../../services/profile.js": services.profile,
    "../../services/levels.js": services.levels,
    "../../services/groups.js": services.groups,
    "../../utils/rankings-view-model.js": viewModel,
    "../../utils/ui-layout.js": { headerHeight: () => 88 },
    "../../utils/rankings-copy.js": copy,
    "../../utils/level-season.js": loadCommonJs(LEVEL_SEASON),
  };
  runInNewContext(readFileSync(PAGE, "utf8"), {
    Page: (value) => { definition = value; },
    require: (name) => dependencies[name],
  });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch, callback) {
      Object.assign(this.data, patch);
      if (callback) callback();
    },
  };
  page.onLoad();
  return { page, services };
}

describe("ranking first-load rate limit retry", () => {
  it("keeps a retry action on the rate-limited first-load panel", () => {
    const wxml = readFileSync(WXML, "utf8");
    const errorBlock = wxml.match(/state !== 'list'[\s\S]*?(?=<block wx:else>)/)[0];
    expect(errorBlock).toContain('bindtap="onRetry"');
    expect(errorBlock).toMatch(/state === 'rateLimited'|state === \"rateLimited\"/);
  });

  it("lets the user retry after a first-load 429", async () => {
    const { page, services } = loadPage({
      rankings: {
        listRankings: vi.fn()
          .mockResolvedValueOnce({
            statusCode: 429,
            code: "RATE_LIMITED",
            message: "请求过于频繁，请稍后重试",
          })
          .mockResolvedValue(rankingPayload()),
      },
    });

    await page.loadFirstPage();

    expect(page.data.state).toBe("rateLimited");
    expect(page.data.items).toEqual([]);
    expect(page.data.errorMessage).toBe("请求过于频繁，请稍后重试");

    await page.onRetry();

    expect(page.data.state).toBe("list");
    expect(page.data.standingValue).toBe(12);
    expect(page.data.errorMessage).toBe("");
    expect(services.rankings.listRankings).toHaveBeenCalledTimes(2);
  });
});
