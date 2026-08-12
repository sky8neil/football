/**
 * 第 44 节验收矩阵可追踪覆盖：扫描测试标题中的条目 ID。
 * 本轮冻结要求：C17-C23、F38-F42、D24-D28、M100-M104、G43-G52 必须可追踪。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function collectTestTitles(root: string): string[] {
  const titles: string[] = [];
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
      if (!name.endsWith(".test.ts")) continue;
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
    for (const match of title.matchAll(/\b([A-N]\d{2,3})\b/g)) {
      ids.add(match[1]!);
    }
  }
  return ids;
}

describe("第 44 节验收矩阵可追踪覆盖", () => {
  const titles = collectTestTitles(join(process.cwd(), "src"));
  const covered = coveredIds(titles);

  it("C17-C23 延期条目全部可追踪", () => {
    for (const id of ["C17", "C18", "C19", "C20", "C21", "C22", "C23"]) {
      expect(covered.has(id), `${id} missing`).toBe(true);
    }
  });

  it("D24-D28 并发与幂等条目全部可追踪", () => {
    for (const id of ["D24", "D25", "D26", "D27", "D28"]) {
      expect(covered.has(id), `${id} missing`).toBe(true);
    }
  });

  it("F38-F42 无效比赛条目全部可追踪", () => {
    for (const id of ["F38", "F39", "F40", "F41", "F42"]) {
      expect(covered.has(id), `${id} missing`).toBe(true);
    }
  });

  it("M100-M104 注销条目全部可追踪", () => {
    for (const id of ["M100", "M101", "M102", "M103", "M104"]) {
      expect(covered.has(id), `${id} missing`).toBe(true);
    }
  });

  it("G43-G52 Provider 数据条目全部可追踪", () => {
    for (const id of [
      "G43",
      "G44",
      "G45",
      "G46",
      "G47",
      "G48",
      "G49",
      "G50",
      "G51",
      "G52",
    ]) {
      expect(covered.has(id), `${id} missing`).toBe(true);
    }
  });

  it("H53-H59 result_version 条目全部可追踪", () => {
    for (const id of ["H53", "H54", "H55", "H56", "H57", "H58", "H59"]) {
      expect(covered.has(id), `${id} missing`).toBe(true);
    }
  });

  it("I60-I65 结算幂等条目全部可追踪", () => {
    for (const id of ["I60", "I61", "I62", "I63", "I64", "I65"]) {
      expect(covered.has(id), `${id} missing`).toBe(true);
    }
  });

  it("N108-N111 Rebuild 与一致性条目全部可追踪（49.5 事实源修订）", () => {
    for (const id of ["N108", "N109", "N110", "N111"]) {
      expect(covered.has(id), `${id} missing`).toBe(true);
    }
  });
});