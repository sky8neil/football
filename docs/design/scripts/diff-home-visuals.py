#!/usr/bin/env python3
"""比对两份首页 computed 样式快照 —— 「token 接线前后视觉 100% 不变」的判据。

用法：
  python3 docs/design/scripts/diff-home-visuals.py before.json[.gz] after.json[.gz] [--verbose]

退出码：0 = 无差异；1 = 存在差异（差异逐条打印，按场景 → 探针 → 属性定位）。
"""
import argparse
import gzip
import json
import sys

# 允许忽略的差异（默认空：任何差异都要人看）
DEFAULT_IGNORE = set()


def load_snapshot(path):
    """读快照。留档的基线是 .gz，按魔数自动识别，调用方不必关心压缩与否。"""
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def flatten(snapshot):
    """展开成 {(场景, 探针, 属性): 值}，把 rect 也当作属性纳入比对。"""
    flat = {}
    for scenario, probes in snapshot["scenarios"].items():
        for label, data in probes.items():
            if data.get("count") is None:
                flat[(scenario, label, "__count")] = data.get("count")
                continue
            flat[(scenario, label, "__count")] = data["count"]
            for k, v in (data.get("rect") or {}).items():
                flat[(scenario, label, "rect." + k)] = v
            for k, v in (data.get("props") or {}).items():
                flat[(scenario, label, k)] = v
    return flat


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("before")
    ap.add_argument("after")
    ap.add_argument("--verbose", action="store_true", help="连未变化的项也统计输出")
    args = ap.parse_args()

    before = load_snapshot(args.before)
    after = load_snapshot(args.after)

    print("=" * 96)
    print("computed 样式比对（token 接线前后）")
    print("=" * 96)
    for tag, snap in (("before", before), ("after", after)):
        meta = snap["meta"]
        print(f"  {tag}: 生成于 {meta['generated_at']}｜场景 {len(snap['scenarios'])} "
              f"｜tokens 指纹 {meta['sources']['miniprogram/styles/design-tokens.wxss']} "
              f"｜wxss 指纹 {meta['sources']['miniprogram/pages/matches/matches.wxss']}")

    fb, fa = flatten(before), flatten(after)
    only_before = sorted(set(fb) - set(fa))
    only_after = sorted(set(fa) - set(fb))
    diffs = [(k, fb[k], fa[k]) for k in sorted(set(fb) & set(fa)) if fb[k] != fa[k]]

    print()
    if only_before:
        print(f"仅在 before 出现的采样点（{len(only_before)}）：")
        for k in only_before[:20]:
            print(f"  - {k}")
    if only_after:
        print(f"仅在 after 出现的采样点（{len(only_after)}）：")
        for k in only_after[:20]:
            print(f"  + {k}")

    if diffs:
        print()
        print(f"❌ 值发生变化的采样点：{len(diffs)}")
        cur = None
        for (scenario, label, prop), b, a in diffs:
            if (scenario, label) != cur:
                cur = (scenario, label)
                print(f"\n  【{scenario}】{label}")
            print(f"      {prop}")
            print(f"         before: {b}")
            print(f"         after : {a}")
    print()
    print("=" * 96)
    changed = bool(diffs or only_before or only_after)
    print("结论：" + ("存在差异 ❌ —— 必须查明原因，不得自行接受" if changed else "逐项一致 ✅ 视觉未变"))
    print(f"  采样点 {len(fb)} 个（场景 {len(before['scenarios'])} × 探针）")
    print("=" * 96)
    return 1 if changed else 0


if __name__ == "__main__":
    sys.exit(main())
