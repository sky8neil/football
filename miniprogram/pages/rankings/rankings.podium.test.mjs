import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it, expect } from "vitest";
function load(board) {
  let config;
  runInNewContext(readFileSync(new URL("./rankings.js", import.meta.url), "utf8"), {
    Page: value => { config = value; },
    require: name => name.includes("rankings-view-model") ? { buildRankingViewModel: () => ({ weekOptions: [], showPodium: true }) } : { headerHeight: () => 88 },
  });
  return { ...config, data: { ...structuredClone(config.data), board }, setData(value) { Object.assign(this.data, value); } };
}
describe("shared ranking podium", () => {
  it.each(["season", "strength"])("keeps the leading podium raised on %s even with historical rank gaps", board => {
    const page = load(board);
    page.applyListResult({ statusCode: 200, data: {
      available_boards: ["season", "strength"], entry_count: 3,
      items: [5, 6, 7].map(rank => ({ rank, user_id: "user" + rank, display_name: "Player" + rank, season_points: 180 - rank, strength_index: "6.75", season_valid_predictions: 30, window_n: 50 })),
    } }, true);
    expect(page.data.podiumItems.map(item => item.isWinner)).toEqual([true, false, false]);
    expect(page.data.podiumItems.map(item => item.placeText)).toEqual(["第 5 名", "第 6 名", "第 7 名"]);
    expect(page.data.items.map(item => item.rank)).toEqual([5, 6, 7]);
  });
});
