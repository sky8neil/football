#!/usr/bin/env python3
"""串行 Codex 开发监督器 v2。

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
LOG_DIR = ROOT / ".codex-supervisor"
MAX_ROUNDS = 10
MAX_REPAIRS_PER_ROUND = 3
MAX_CONSECUTIVE_BLOCKED = 3
CODEX_TIMEOUT_SECONDS = 3600
VERIFY_TIMEOUT_SECONDS = 900
MODEL = "grok-4.5"

BASE_PROMPT = """你是 /home/football 项目的编码 Agent。严格以项目根目录 docs/MVP__v1.0.md 为唯一业务规范（含第 48 节补充冻结决策，直接执行，不得再视为 SPEC_GAP）。每次先读取 docs/MVP__v1.0.md、README.md、docs/DEVELOPMENT_PLAN.md、当前代码和 git diff；再选择并实现一个最小且定义清晰的未完成切片；不要一次扩展多个模块。必须先写失败测试再实现。保持 TypeScript strict + ESM、现有 domain/application/infrastructure 边界、账本幂等、事务、锁、状态机和 Fail Closed 语义。不得连接真实微信、CloudBase、Provider 或外部 API，不读取、输出或保存任何凭证；不要提交或推送 Git。代码只保留最少量的防御性、健壮性要求，要避免代码过于工程化，只要功能没问题原则上即可通过。完成后运行 npm run typecheck、npm test -- --run、npm run build、git diff --check，并在最后报告实际结果、修改文件、剩余未完成项。

重要：你的最后一条输出必须以一行机器可读状态结束，取以下三值之一，不要有其他文本混在同一行：
- 本轮有完整代码成果且验证通过：SUPERVISOR_STATUS=PASS
- 本轮选择的切片被规范缺口阻塞、无法实现，且没有其他可完成内容：SUPERVISOR_STATUS=BLOCKED_SPEC 并另起一行输出 BLOCKED_KEY=xxx（稳定、小写、短横线分隔的 key，例如 admin_anomalies_cursor）
- 项目所有非 OUT_OF_SCOPE 内容与验收全部完成：SUPERVISOR_STATUS=MVP_COMPLETE
BLOCKED_SPEC 只允许在确实无法完成任何有效切片时使用；如果只是某个接口的某个字段未定义，应实现其他已定义部分并以 PASS 结束。"""

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
        return BASE_PROMPT + f"""\n这是第 {round_no} 轮的自动修复阶段（第 {failure} 次修复尝试之前）。上一轮或上一修复尝试的真实验证输出如下：\n---BEGIN ERROR---\n{failure[-30000:]}\n---END ERROR---\n{skip}请只修复这些实际错误，先补失败回归测试，再实现修复；修复后重新运行全部验证，并按要求输出 SUPERVISOR_STATUS 状态行。"""
    return BASE_PROMPT + f"""\n这是自动串行开发第 {round_no}/{MAX_ROUNDS} 轮。{skip}请根据当前 docs/DEVELOPMENT_PLAN.md 和代码状态自行选择下一个规范已定义、最小垂直切片。优先第 48 节已冻结但尚未实现的代码变更（管理员异常查询、管理员响应 data 对齐、correction retry、retry 审计、failed settlement 目标选择等）。如果一个切片完成后仍有其他切片，不要宣称整个 MVP 完成。"""


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
        "codex_timeout_seconds": CODEX_TIMEOUT_SECONDS,
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
            ["codex", "exec", "-C", str(ROOT), "--dangerously-bypass-approvals-and-sandbox", "--json", "-m", MODEL, prompt],
            round_dir / "codex.jsonl",
            CODEX_TIMEOUT_SECONDS,
        )
        (round_dir / "codex-prompt.txt").write_text(prompt, encoding="utf-8")
        (round_dir / "codex-last-output.txt").write_text(output[-50000:], encoding="utf-8")

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
            failure = f"Codex exit code={code}\n{output}"
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
                ["codex", "exec", "-C", str(ROOT), "--dangerously-bypass-approvals-and-sandbox", "--json", "-m", MODEL, repair_prompt],
                repair_dir / "codex.jsonl",
                CODEX_TIMEOUT_SECONDS,
            )
            (repair_dir / "codex-prompt.txt").write_text(repair_prompt, encoding="utf-8")
            (repair_dir / "codex-last-output.txt").write_text(repair_output[-50000:], encoding="utf-8")

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
                failure = f"Codex repair exit code={repair_code}\n{repair_output}"
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
