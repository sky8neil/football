#!/usr/bin/env python3
"""串行 OpenCode 开发监督器。

每轮一个最小垂直切片。支持三态状态机：
- PASS        本轮有完整成果且验证通过 -> 自动进入下一轮
- BLOCKED_SPEC 当前分支被规范缺口阻塞 -> 记录、跳过、下一轮选择其他切片
- MVP_COMPLETE 全部完成且验证通过     -> 成功退出

SPEC_GAP 只停当前分支，不停止整个流程；连续 MAX_CONSECUTIVE_BLOCKED 轮
全部 BLOCKED（无其他可开发内容）才停止整个 Supervisor。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/home/football")
LOG_DIR = ROOT / ".opencode-supervisor"
MAX_ROUNDS = 2
MAX_REPAIRS_PER_ROUND = 3
MAX_CONSECUTIVE_BLOCKED = 2
OPCODE_TIMEOUT_SECONDS = 3600
VERIFY_TIMEOUT_SECONDS = 900
MODEL = "opencode-go-2d59ed8d/deepseek-v4-flash"
VARIANT = "max"

BASE_PROMPT = """你是 /home/football 项目的编码 Agent。本轮任务**仅完成 F3**（session 再 init 不同 nickname 回归测试），不得扩展范围。

依据：
1. DEV_PLAN_SEC49_FIX__v1.0.md 的 **F3** 小节
2. docs/SEC49_DIFF_REVIEW__v1.0.md finding #4（低）
3. docs/MVP__v1.0.md 第 49.1（再 init 忽略 body nickname）

F1/F2 已完成，不要改鉴权 code，不要改结算状态机入口。

本轮必须做：
- 在 `src/application/session.test.ts`（优先）补一条显式回归：
  - 已有 active 用户 nickname=`Bob`
  - 再 init body nickname=`Alice`（同 openid）
  - 断言：created=false、返回 nickname 仍为 `Bob`、资料未被更新为 Alice
- 若实现已符合 49.1（existing active 直接返回、不更新 nickname），只加测试即可，不要“顺手改实现”
- 先写失败测试再确认实现；跑 typecheck + 全量 test + build + git diff --check

明确不做：F1/F2 重做、H3/H4/H5/U、新业务、commit/push、真实外部 API。

完成后报告实际验证结果与修改文件。

重要：你的最后一条输出必须以一行机器可读状态结束，取以下三值之一，不要有其他文本混在同一行：
- 本轮有完整代码成果且验证通过：SUPERVISOR_STATUS=PASS
- 本轮被规范缺口阻塞：SUPERVISOR_STATUS=BLOCKED_SPEC 并另起一行 BLOCKED_KEY=xxx
- F3 完成且验证通过：SUPERVISOR_STATUS=MVP_COMPLETE
"""

REDACT_PATTERNS = [
    (re.compile(r"(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|session[_-]?key)\s*[:=]\s*[^\s,;]+"), r"\1=[REDACTED]"),
    (re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+"), "Bearer [REDACTED]"),
]


def redact(text: str) -> str:
    for pattern, replacement in REDACT_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def now_name() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def run_logged(cmd: list[str], log_path: Path, timeout: int) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            env={**os.environ, "CI": "1"},
        )
        output = redact(proc.stdout or "")
        log_path.write_text(output, encoding="utf-8")
        return proc.returncode, output
    except subprocess.TimeoutExpired as exc:
        output = redact((exc.stdout or "") if isinstance(exc.stdout, str) else "") + "\nTIMEOUT\n"
        log_path.write_text(output, encoding="utf-8")
        return 124, output


def verify(round_dir: Path) -> tuple[bool, str]:
    commands = [
        ["npm", "run", "typecheck"],
        ["npm", "test", "--", "--run"],
        ["npm", "run", "build"],
        ["git", "diff", "--check"],
    ]
    combined: list[str] = []
    for index, cmd in enumerate(commands, 1):
        code, output = run_logged(cmd, round_dir / f"verify-{index}.log", VERIFY_TIMEOUT_SECONDS)
        combined.append(f"$ {' '.join(cmd)}\n{output}")
        if code != 0:
            return False, "\n\n".join(combined)
    return True, "\n\n".join(combined)


def parse_status(output: str) -> str | None:
    # 取最后一次出现的 SUPERVISOR_STATUS：Codex 中间消息可能讨论到
    # BLOCKED_SPEC，但最终结论以最后一行机器状态为准。
    matches = re.findall(r"SUPERVISOR_STATUS=(\w+)", output)
    if matches:
        return matches[-1]
    if "SPEC_GAP_BLOCKER" in output:
        return "BLOCKED_SPEC"
    return None


def parse_blocked_key(output: str) -> str | None:
    matches = re.findall(r"BLOCKED_KEY=([A-Za-z0-9_.:-]+)", output)
    return matches[-1] if matches else None


def codex_prompt(round_no: int, blocked_keys: list[str], repair: bool = False, failure: str = "") -> str:
    skip = ""
    if blocked_keys:
        skip = "已知被规范缺口阻塞的切片（不要选择这些）：" + ", ".join(blocked_keys) + "\n"
    if repair:
        return BASE_PROMPT + f"""
这是第 {round_no} 轮的自动修复阶段。上一轮或上一修复尝试的真实验证输出如下：
---BEGIN ERROR---
{failure[-30000:]}
---END ERROR---
{skip}请只修复这些实际错误；范围仍仅限 F3 session nickname 回归。修复后重新运行全部验证，并输出 SUPERVISOR_STATUS 状态行。"""
    return BASE_PROMPT + f"""
这是自动 F3 修复第 {round_no}/{MAX_ROUNDS} 轮。{skip}请只做 F3：session 再 init 不同 nickname 仍返回旧昵称的回归测试。F3 完成后输出 SUPERVISOR_STATUS=MVP_COMPLETE。"""


def load_blocked(session_dir: Path) -> list[str]:
    path = session_dir / "spec-gaps.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return [item["key"] for item in data.get("blocked", [])]
    except Exception:
        return []


def record_blocked(session_dir: Path, key: str, round_no: int, detail: str, log: str) -> None:
    path = session_dir / "spec-gaps.json"
    data = {"blocked": []}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            data = {"blocked": []}
    keys = {item["key"] for item in data["blocked"]}
    if key not in keys:
        data["blocked"].append({"key": key, "round": round_no, "detail": detail[:500], "log": log})
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    session = now_name()
    session_dir = LOG_DIR / session
    session_dir.mkdir(parents=True, exist_ok=True)
    (session_dir / "config.json").write_text(json.dumps({
        "max_rounds": MAX_ROUNDS,
        "max_repairs_per_round": MAX_REPAIRS_PER_ROUND,
        "max_consecutive_blocked": MAX_CONSECUTIVE_BLOCKED,
        "opencode_timeout_seconds": OPCODE_TIMEOUT_SECONDS,
        "model": MODEL,
        "project": str(ROOT),
        "started_at": session,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    blocked_keys = load_blocked(session_dir)
    consecutive_blocked = 0

    print(f"SUPERVISOR_STARTED session={session} max_rounds={MAX_ROUNDS}", flush=True)

    for round_no in range(1, MAX_ROUNDS + 1):
        round_dir = session_dir / f"round-{round_no:02d}"
        round_dir.mkdir()
        prompt = codex_prompt(round_no, blocked_keys)
        code, output = run_logged(
            ["opencode", "run", "--format", "json", "--auto", "--dir", str(ROOT), "-m", MODEL, "--variant", VARIANT, prompt],
            round_dir / "opencode.jsonl",
            OPCODE_TIMEOUT_SECONDS,
        )
        (round_dir / "opencode-prompt.txt").write_text(prompt, encoding="utf-8")
        (round_dir / "opencode-last-output.txt").write_text(output[-50000:], encoding="utf-8")

        status = parse_status(output)
        if status == "BLOCKED_SPEC":
            key = parse_blocked_key(output) or f"round{round_no}_unspecified"
            detail = output[-3000:]
            record_blocked(session_dir, key, round_no, detail, str(round_dir))
            if key not in blocked_keys:
                blocked_keys.append(key)
            consecutive_blocked += 1
            (round_dir / "result.txt").write_text("BLOCKED_SPEC\n", encoding="utf-8")
            print(f"BLOCKED round={round_no} key={key} consecutive={consecutive_blocked} log={round_dir}", flush=True)
            if consecutive_blocked >= MAX_CONSECUTIVE_BLOCKED:
                print(f"STOP reason=CONSECUTIVE_BLOCKED({consecutive_blocked}) session={session}", flush=True)
                return 2
            continue

        if status == "MVP_COMPLETE":
            ok, verification = verify(round_dir)
            if ok:
                (round_dir / "result.txt").write_text("MVP_COMPLETE\n", encoding="utf-8")
                print(f"COMPLETE session={session} log={round_dir}", flush=True)
                return 0
            failure = "MVP_COMPLETE 但验证失败\n" + verification
        elif code != 0:
            failure = f"OpenCode exit code={code}\n{output}"
        else:
            ok, verification = verify(round_dir)
            if ok:
                (round_dir / "result.txt").write_text("PASS\n", encoding="utf-8")
                consecutive_blocked = 0
                print(f"PASS round={round_no} log={round_dir}", flush=True)
                continue
            failure = "验证失败\n" + verification

        for repair_no in range(1, MAX_REPAIRS_PER_ROUND + 1):
            repair_dir = round_dir / f"repair-{repair_no:02d}"
            repair_dir.mkdir()
            repair_prompt = codex_prompt(round_no, blocked_keys, repair=True, failure=failure)
            repair_code, repair_output = run_logged(
                ["opencode", "run", "--format", "json", "--auto", "--dir", str(ROOT), "-m", MODEL, "--variant", VARIANT, repair_prompt],
                repair_dir / "opencode.jsonl",
                OPCODE_TIMEOUT_SECONDS,
            )
            (repair_dir / "opencode-prompt.txt").write_text(repair_prompt, encoding="utf-8")
            (repair_dir / "opencode-last-output.txt").write_text(repair_output[-50000:], encoding="utf-8")

            repair_status = parse_status(repair_output)
            if repair_status == "BLOCKED_SPEC":
                key = parse_blocked_key(repair_output) or f"round{round_no}_repair{repair_no}"
                record_blocked(session_dir, key, round_no, repair_output[-3000:], str(repair_dir))
                if key not in blocked_keys:
                    blocked_keys.append(key)
                consecutive_blocked += 1
                (repair_dir / "result.txt").write_text("BLOCKED_SPEC\n", encoding="utf-8")
                print(f"BLOCKED round={round_no} repair={repair_no} key={key} consecutive={consecutive_blocked}", flush=True)
                break
            if repair_code != 0:
                failure = f"OpenCode repair exit code={repair_code}\n{repair_output}"
                continue
            ok, verification = verify(repair_dir)
            if ok:
                (repair_dir / "result.txt").write_text("PASS\n", encoding="utf-8")
                consecutive_blocked = 0
                print(f"PASS round={round_no} repair={repair_no} log={repair_dir}", flush=True)
                break
            failure = "修复后验证仍失败\n" + verification
        else:
            (round_dir / "result.txt").write_text("STOP: repair attempts exhausted\n", encoding="utf-8")
            print(f"STOP round={round_no} reason=REPAIR_ATTEMPTS_EXHAUSTED log={round_dir}", flush=True)
            return 1

        if consecutive_blocked >= MAX_CONSECUTIVE_BLOCKED:
            print(f"STOP reason=CONSECUTIVE_BLOCKED({consecutive_blocked}) session={session}", flush=True)
            return 2

    print(f"STOP reason=MAX_ROUNDS_REACHED session={session}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
