/**
 * 第 44 节验收矩阵可追踪覆盖：扫描测试标题中的 v2 条目 ID。
 * 自身被排除在标题扫描外，避免基线断言标题反向满足覆盖要求。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MATRIX_GROUPS: Readonly<Record<string, readonly string[]>> = {
  A: Array.from({ length: 10 }, (_, index) => `A${index + 1}`),
  B: Array.from({ length: 6 }, (_, index) => `B${index + 11}`),
  C: Array.from({ length: 7 }, (_, index) => `C${index + 17}`),
  D: Array.from({ length: 5 }, (_, index) => `D${index + 24}`),
  E: Array.from({ length: 9 }, (_, index) => `E${index + 29}`),
  F: Array.from({ length: 5 }, (_, index) => `F${index + 38}`),
  G: Array.from({ length: 10 }, (_, index) => `G${index + 43}`),
  H: Array.from({ length: 7 }, (_, index) => `H${index + 53}`),
  I: Array.from({ length: 6 }, (_, index) => `I${index + 60}`),
  J: Array.from({ length: 12 }, (_, index) => `J${index + 66}`),
  K: Array.from({ length: 11 }, (_, index) => `K${index + 78}`),
  L: Array.from({ length: 26 }, (_, index) => `L${index + 89}`),
  M: Array.from({ length: 8 }, (_, index) => `M${index + 115}`),
  N: Array.from({ length: 6 }, (_, index) => `N${index + 123}`),
};

const EXCLUDED_MATRIX_IDS: Readonly<Record<string, string>> = {
  L112: "Q3（§17.13 模板回测发布门禁）待确认且未实现；本切片不实现回测（SPEC_GAP）",
};

function collectTestTitles(root: string): string[] {
  const titles: string[] = [];
  const coverageTest = join(root, "acceptance", "matrix-44-coverage.test.ts");
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) {
        if (name === "node_modules" || name === "dist") continue;
        stack.push(path);
        continue;
      }
      if (!name.endsWith(".test.ts") || path === coverageTest) continue;
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/\bit\(\s*["'`]([^"'`]+)["'`]/g)) {
        titles.push(match[1]!);
      }
    }
  }
  return titles;
}

function coveredIds(titles: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const title of titles) {
    for (const match of title.matchAll(/\b([A-N]\d{2,3}|A[1-9])\b/g)) {
      ids.add(match[1]!);
    }
  }
  return ids;
}

describe("第 44 节验收矩阵 v2 可追踪覆盖", () => {
  const allIds = Object.values(MATRIX_GROUPS).flat();
  const excludedIds = new Set(Object.keys(EXCLUDED_MATRIX_IDS));
  const covered = coveredIds(collectTestTitles(join(process.cwd(), "src")));

  for (const [group, ids] of Object.entries(MATRIX_GROUPS)) {
    it(`${group} 组验收项全部可追踪（明确排除项除外）`, () => {
      for (const id of ids) {
        if (excludedIds.has(id)) continue;
        expect(covered.has(id), `${id} missing`).toBe(true);
      }
    });
  }

  it("基线包含 §44 A1-N128 全部 128 项，且覆盖或显式排除每项", () => {
    expect(allIds).toHaveLength(128);
    expect(new Set(allIds).size).toBe(128);
    for (const id of allIds) {
      expect(covered.has(id) || excludedIds.has(id), `${id} 未覆盖且未显式排除`).toBe(true);
    }
    for (const id of excludedIds) {
      expect(allIds).toContain(id);
      expect(EXCLUDED_MATRIX_IDS[id]?.trim().length).toBeGreaterThan(0);
    }
  });
});
