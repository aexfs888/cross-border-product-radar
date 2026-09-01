from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys

PROJECT = pathlib.Path(r"E:\跨境热销商品")
STATE = PROJECT / "系统数据" / "cloud-state" / "hermes-cron-state.json"
SYNC_SCRIPT = PROJECT / "采集程序" / "scripts" / "sync-github.ps1"


def tool_environment() -> tuple[dict[str, str], str | None, str | None, str | None]:
    """Rebuild the user tool PATH because Hermes cron intentionally starts with a minimal environment."""
    env = os.environ.copy()
    system_root = pathlib.Path(env.get("SystemRoot", r"C:\Windows"))
    local_app_data = pathlib.Path(env.get("LOCALAPPDATA", ""))
    candidates = [
        pathlib.Path(r"D:\Git\cmd"), pathlib.Path(r"F:\nodejs"),
        pathlib.Path(env.get("ProgramFiles", r"C:\Program Files")) / "Git" / "cmd",
        system_root / "System32", system_root / "System32" / "WindowsPowerShell" / "v1.0",
    ]
    winget_root = local_app_data / "Microsoft" / "WinGet" / "Packages"
    if winget_root.exists():
        candidates.extend(item.parent for item in winget_root.glob("GitHub.cli_*/bin/gh.exe"))
    existing = [str(item) for item in candidates if item.exists()]
    env["PATH"] = os.pathsep.join(existing + [env.get("PATH", "")])
    return env, shutil.which("gh", path=env["PATH"]), shutil.which("git", path=env["PATH"]), shutil.which("powershell.exe", path=env["PATH"])


def notify_once(message: str, key: str) -> None:
    state = {}
    if STATE.exists():
        try:
            state = json.loads(STATE.read_text(encoding="utf-8-sig"))
        except Exception:
            state = {}
    if state.get("last_notice") == key:
        return
    STATE.parent.mkdir(parents=True, exist_ok=True)
    state["last_notice"] = key
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    print(message)


def main() -> int:
    env, gh, git, powershell = tool_environment()
    if not gh or not git or not powershell:
        notify_once("跨境商品雷达：Hermes 定时环境缺少 GitHub CLI、Git 或 PowerShell，请运行系统体检。", "cron-tools-missing")
        return 1
    auth = subprocess.run([gh, "auth", "status"], cwd=PROJECT, capture_output=True, text=True, timeout=20, env=env)
    if auth.returncode != 0:
        notify_once("跨境商品雷达：GitHub 尚未连接。请在项目目录双击“⑥连接GitHub云端采集.cmd”；本地数据没有丢失。", "github-not-connected")
        return 0
    remote = subprocess.run([git, "remote", "get-url", "origin"], cwd=PROJECT, capture_output=True, text=True, timeout=10, env=env)
    if remote.returncode != 0:
        notify_once("跨境商品雷达：GitHub 已登录，但项目还没有远程仓库。请双击“⑥连接GitHub云端采集.cmd”。", "github-no-remote")
        return 0
    completed = subprocess.run(
        [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SYNC_SCRIPT)],
        cwd=PROJECT, capture_output=True, text=True, timeout=165, env=env,
    )
    output = "\n".join(part.strip() for part in [completed.stdout, completed.stderr] if part.strip())
    if completed.returncode != 0:
        print(f"跨境商品雷达同步失败，旧版结果已保留。\n{output[-1800:]}")
        return completed.returncode
    if "没有新的加密采集包" not in output:
        print(output[-1800:] or "跨境商品雷达已完成同步、分库、报表与备份。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
