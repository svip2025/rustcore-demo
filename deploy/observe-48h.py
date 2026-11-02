#!/usr/bin/env python3
"""Private, read-only 48-hour observations. Does not run scenarios or manage services."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
import urllib.error
import urllib.parse
import urllib.request

UTC = timezone.utc
HOURS = 48
MIN_ROUNDS = 8
SAMPLE_SECONDS = 300
POLL_SECONDS = 5
TERMINAL = {"STOPPED", "INVALIDATED", "WINDOW_ELAPSED", "INSUFFICIENT_ROUNDS"}
STOP_KINDS = ("DEPLOYMENT_BUG", "CODE_CHANGE", "BUILD_CHANGE", "CONFIG_CHANGE", "OPERATOR_STOP", "EXTERNAL_TESTNET")


def utc() -> datetime:
    return datetime.now(UTC)


def stamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def instant(value: object) -> datetime | None:
    try:
        if not isinstance(value, str) or not value.endswith("Z"):
            return None
        return datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return None


def write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def append_json(path: Path, value: dict) -> None:
    with path.open("a", encoding="utf-8") as output:
        output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
        output.flush()
        os.fsync(output.fileno())


def git_text(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", "-c", f"safe.directory={repo.resolve()}", "-C", str(repo), *args],
                            capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise ValueError("CODE_FINGERPRINT_UNAVAILABLE")
    return result.stdout.strip()


def freeze(repo: Path, files: list[Path]) -> dict:
    # Require a clean release, then any tracked/untracked code change invalidates it.
    if git_text(repo, "status", "--porcelain=v1", "--untracked-files=normal"):
        raise ValueError("CODE_NOT_FROZEN")
    if git_text(repo / "rustcore", "status", "--porcelain=v1", "--untracked-files=normal"):
        raise ValueError("KERNEL_NOT_FROZEN")
    digests = {}
    for index, path in enumerate(files):
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        # No filenames, configuration values or per-secret fingerprints in evidence.
        digests[f"config_{index}"] = digest.hexdigest()
    return {
        "caller_commit": git_text(repo, "rev-parse", "HEAD"),
        "kernel_commit": git_text(repo / "rustcore", "rev-parse", "HEAD"),
        "release_location_hash": hashlib.sha256(os.fsencode(repo.resolve())).hexdigest(),
        "config_sha256": digests,
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def api_reader(base: str):
    parsed = urllib.parse.urlsplit(base)
    if (parsed.scheme not in {"http", "https"} or parsed.hostname not in {"127.0.0.1", "::1"}
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise ValueError("API_MUST_BE_LOOPBACK")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def read(path: str) -> dict:
        try:
            request = urllib.request.Request(base.rstrip("/") + path, method="GET")
            try:
                response = opener.open(request, timeout=10)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status = response.code
                body = response.read(4 * 1024 * 1024 + 1)
            if len(body) > 4 * 1024 * 1024:
                return {"http_status": status, "error": "RESPONSE_TOO_LARGE"}
            value = json.loads(body)
            return {"http_status": status, "value": value} if isinstance(value, dict) else {"http_status": status, "error": "INVALID_JSON"}
        except (OSError, ValueError, urllib.error.URLError):
            return {"http_status": None, "error": "READ_UNAVAILABLE"}

    return read


def process_memory(unit: str) -> dict:
    try:
        result = subprocess.run(["systemctl", "show", "--property=MainPID", "--value", "--", unit],
                                capture_output=True, text=True, timeout=5)
        pid = int(result.stdout.strip()) if result.returncode == 0 else 0
        if pid <= 0:
            return {"pid": None, "rss_bytes": None, "peak_rss_bytes": None, "error": "NOT_RUNNING"}
        status = Path(f"/proc/{pid}/status").read_text()
        fields = {}
        for name in ("VmRSS", "VmHWM", "VmSize"):
            match = re.search(rf"^{name}:\s+(\d+) kB$", status, re.MULTILINE)
            fields[name] = int(match[1]) * 1024 if match else None
        return {"pid": pid, "rss_bytes": fields["VmRSS"], "peak_rss_bytes": fields["VmHWM"], "virtual_bytes": fields["VmSize"]}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {"pid": None, "rss_bytes": None, "peak_rss_bytes": None, "error": "RESOURCE_UNAVAILABLE"}


def resources(data: Path, caller_unit: str, kernel_unit: str) -> dict:
    try:
        disk = shutil.disk_usage(data)
        disk_value = {"total_bytes": disk.total, "used_bytes": disk.used, "free_bytes": disk.free}
    except OSError:
        disk_value = {"error": "DISK_UNAVAILABLE"}
    databases = {}
    for name in ("caller", "kernel"):
        sizes = {}
        for label, suffix in (("main_bytes", ""), ("wal_bytes", "-wal"), ("shm_bytes", "-shm")):
            try:
                sizes[label] = (data / f"{name}.db{suffix}").stat().st_size
            except FileNotFoundError:
                sizes[label] = None  # Missing is not a measured zero-byte file.
            except OSError:
                sizes[label] = None
        databases[name] = sizes
    return {"caller": process_memory(caller_unit), "kernel": process_memory(kernel_unit),
            "disk": disk_value, "databases": databases}


def round_summary(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    identifier = value.get("round_id")
    if (not isinstance(identifier, str) or not re.fullmatch(r"round_[A-Za-z0-9_-]{1,120}", identifier)
            or value.get("trigger") not in {"MANUAL", "SCHEDULED"}
            or value.get("status") not in {"RUNNING", "SUCCEEDED", "FAILED"}
            or instant(value.get("started_at")) is None):
        return None
    if value["status"] == "RUNNING":
        if value.get("ended_at") is not None:
            return None
    elif instant(value.get("ended_at")) is None:
        return None
    return {name: value.get(name) for name in ("round_id", "trigger", "status", "started_at", "ended_at", "reason")}


def response_rounds(state: dict, timeline: dict) -> list[dict]:
    candidates = [state.get("latest_round")]
    if isinstance(timeline.get("rounds"), list):
        candidates.extend(timeline["rounds"])
    return [item for value in candidates if (item := round_summary(value)) is not None]


def build_from(state: dict) -> dict | None:
    build = state.get("build")
    if not isinstance(build, dict):
        return None
    if all(isinstance(build.get(key), str) and re.fullmatch(r"[0-9a-f]{40}", build[key])
           for key in ("caller_commit", "rustcore_commit")):
        return {key: build[key] for key in ("caller_commit", "rustcore_commit")}
    return None


class Attempt:
    def __init__(self, armed_at: datetime):
        self.summary = {"private_observation": True, "status": "WAITING_FOR_SCHEDULED",
                        "armed_at": stamp(armed_at), "start": None, "end": None, "finished_at": None,
                        "duration_hours": HOURS, "minimum_completed_scheduled_rounds": MIN_ROUNDS,
                        "rounds": {}, "samples": 0, "healthy_samples": 0, "other_health_samples": 0,
                        "freeze": None, "build": None, "stop_kind": None}
        self.rounds: dict[str, dict] = {}

    def finish(self, now: datetime, status: str, kind: str | None = None) -> None:
        if self.summary["status"] not in TERMINAL:
            self.summary.update(status=status, finished_at=stamp(now), stop_kind=kind)

    def check_freeze(self, now: datetime, current: dict) -> None:
        previous = self.summary["freeze"]
        if previous is None:
            self.summary["freeze"] = current
        elif current != previous:
            kind = "CONFIG_CHANGE" if current["config_sha256"] != previous["config_sha256"] else "CODE_CHANGE"
            self.finish(now, "INVALIDATED", kind)

    def observe(self, now: datetime, state: dict, candidates: list[dict]) -> list[dict]:
        if self.summary["status"] in TERMINAL:
            return []
        source = state.get("source", {})
        if source.get("kind") not in {None, "TESTNET"}:
            self.finish(now, "INVALIDATED", "SOURCE_CHANGED")
            return []
        build = build_from(state)
        if build is not None:
            if self.summary["build"] is None:
                self.summary["build"] = build
            elif self.summary["build"] != build:
                self.finish(now, "INVALIDATED", "BUILD_CHANGE")
                return []
        if self.summary["start"] is None:
            armed = instant(self.summary["armed_at"])
            running = [item for item in candidates if item["trigger"] == "SCHEDULED" and item["status"] == "RUNNING"
                       and armed <= instant(item["started_at"]) <= now]
            if not running or source.get("kind") != "TESTNET" or build is None:
                return []
            first = min(running, key=lambda item: item["started_at"])
            start = instant(first["started_at"])
            self.summary.update(status="RUNNING", start=stamp(start), end=stamp(start + timedelta(hours=HOURS)),
                                first_running_observed_at=stamp(now), first_round_id=first["round_id"])
        start, end = instant(self.summary["start"]), instant(self.summary["end"])
        changed = []
        for item in candidates:
            if start <= instant(item["started_at"]) < end and self.rounds.get(item["round_id"]) != item:
                previous = self.rounds.get(item["round_id"])
                if previous and previous["status"] != "RUNNING":
                    self.finish(now, "INVALIDATED", "TERMINAL_ROUND_CHANGED")
                    return changed
                self.rounds[item["round_id"]] = item
                changed.append(item)
        scheduled = [item for item in self.rounds.values() if item["trigger"] == "SCHEDULED"]
        completed = [item for item in scheduled if item["status"] != "RUNNING" and instant(item["ended_at"]) <= end]
        self.summary["rounds"] = {
            "scheduled_seen": len(scheduled), "scheduled_completed_in_window": len(completed),
            "scheduled_succeeded": sum(item["status"] == "SUCCEEDED" for item in completed),
            "scheduled_failed": sum(item["status"] == "FAILED" for item in completed),
            "scheduled_running": sum(item["status"] == "RUNNING" for item in scheduled),
            "manual_seen": sum(item["trigger"] == "MANUAL" for item in self.rounds.values()),
        }
        if now >= end:
            self.finish(now, "WINDOW_ELAPSED" if len(completed) >= MIN_ROUNDS else "INSUFFICIENT_ROUNDS")
        return changed


def run(args) -> int:
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.mkdir(mode=0o700)  # A new attempt must never overwrite or resume an old directory.
    attempt = Attempt(utc())
    stopped = False

    def on_stop(_signum, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, on_stop)
    signal.signal(signal.SIGINT, on_stop)
    read = api_reader(args.api)
    files = [Path(args.config), *map(Path, args.freeze_file)]
    try:
        attempt.check_freeze(utc(), freeze(Path(args.repo), files))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        attempt.finish(utc(), "INVALIDATED", "FROZEN_INPUT_UNAVAILABLE_OR_DIRTY")
    write_json(output / "summary.json", attempt.summary)
    next_sample = 0.0
    while attempt.summary["status"] not in TERMINAL:
        now = utc()
        marker = output / "stop.json"
        if marker.exists() or stopped:
            command = json.loads(marker.read_text()) if marker.exists() else {"kind": "OPERATOR_STOP", "requested_at": stamp(now)}
            attempt.finish(instant(command["requested_at"]), "STOPPED", command["kind"])
            break
        waiting = attempt.summary["start"] is None
        if not waiting and time.monotonic() < next_sample:
            time.sleep(POLL_SECONDS)
            continue
        try:
            current = freeze(Path(args.repo), files)
            attempt.check_freeze(now, current)
            if attempt.summary["status"] in TERMINAL:
                break
        except (OSError, ValueError, subprocess.TimeoutExpired):
            attempt.finish(now, "INVALIDATED", "FROZEN_INPUT_UNAVAILABLE_OR_DIRTY")
            break
        state_read = read("/api/state")
        timeline_read = read("/api/timeline?limit=100")
        state = state_read.get("value", {}) if state_read.get("http_status") == 200 else {}
        timeline = timeline_read.get("value", {}) if timeline_read.get("http_status") == 200 else {}
        changes = attempt.observe(utc(), state, response_rounds(state, timeline))
        for item in changes:
            append_json(output / "rounds.jsonl", {"observed_at": stamp(utc()), "round": item})
        if waiting and attempt.summary["start"] is None:
            # Keep a lightweight waiting record every five minutes, not every 5s poll.
            if time.monotonic() >= next_sample:
                append_json(output / "samples.jsonl", {"observed_at": stamp(utc()), "status": attempt.summary["status"],
                            "state_http": state_read.get("http_status"), "timeline_http": timeline_read.get("http_status")})
                next_sample = time.monotonic() + SAMPLE_SECONDS
        else:
            health_read = read("/api/health")
            health = health_read.get("value", {})
            healthy = health_read.get("http_status") == 200 and health.get("status") == "healthy"
            metrics = resources(Path(args.data_dir), args.caller_unit, args.kernel_unit)
            sample = {"observed_at": stamp(utc()), "status": attempt.summary["status"],
                      "health": {"http_status": health_read.get("http_status"), "status": health.get("status"),
                                 "snapshot_complete": health.get("snapshot_complete"), "dependencies": health.get("dependencies")},
                      "state_http": state_read.get("http_status"), "timeline_http": timeline_read.get("http_status"),
                      "build": build_from(state), "rounds": attempt.summary["rounds"], "resources": metrics}
            append_json(output / "samples.jsonl", sample)
            attempt.summary["samples"] += 1
            attempt.summary["healthy_samples" if healthy else "other_health_samples"] += 1
            attempt.summary.setdefault("resources_first", metrics)
            attempt.summary["resources_latest"] = metrics
            next_sample = time.monotonic() + SAMPLE_SECONDS
        write_json(output / "summary.json", attempt.summary)
        time.sleep(POLL_SECONDS)
    write_json(output / "summary.json", attempt.summary)
    print(json.dumps(attempt.summary, ensure_ascii=False))
    return 0 if attempt.summary["status"] == "WINDOW_ELAPSED" else 1


def self_test() -> int:
    """Pure synthetic clock/state tests; no HTTP, services or observation files."""
    start = datetime(2030, 1, 1, tzinfo=UTC)
    state = {"source": {"kind": "TESTNET"}, "build": {"caller_commit": "a" * 40, "rustcore_commit": "b" * 40}}

    def item(number, trigger="SCHEDULED", status="RUNNING", hours=0):
        at = start + timedelta(hours=hours)
        return {"round_id": f"round_SYNTHETIC_{number}", "trigger": trigger, "status": status,
                "started_at": stamp(at), "ended_at": None if status == "RUNNING" else stamp(at + timedelta(minutes=2)),
                "reason": "synthetic external failure" if status == "FAILED" else "synthetic only"}

    attempt = Attempt(start)
    attempt.observe(start, state, [item(0, trigger="MANUAL")])
    assert attempt.summary["start"] is None
    attempt.observe(start + timedelta(minutes=3), state, [item(0, status="SUCCEEDED")])
    assert attempt.summary["start"] is None  # Completed history cannot manufacture a start.
    at = start + timedelta(hours=1)
    attempt.observe(at + timedelta(seconds=4), state, [item(0, hours=1)])
    assert attempt.summary["start"] == stamp(at)
    assert attempt.summary["end"] == stamp(at + timedelta(hours=48))
    rounds = [item(index, status="FAILED" if index == 3 else "SUCCEEDED", hours=1 + 6 * index) for index in range(8)]
    attempt.observe(start + timedelta(hours=48), state, rounds)
    assert attempt.summary["status"] == "RUNNING"
    attempt.observe(start + timedelta(hours=49), state, rounds)
    assert attempt.summary["status"] == "WINDOW_ELAPSED"
    assert attempt.summary["rounds"]["scheduled_completed_in_window"] == 8
    assert attempt.summary["rounds"]["scheduled_failed"] == 1
    assert attempt.rounds["round_SYNTHETIC_3"]["reason"] == "synthetic external failure"
    changed = Attempt(start)
    changed.observe(start, state, [item(1)])
    changed.observe(start + timedelta(seconds=1), {**state, "build": {**state["build"], "caller_commit": "c" * 40}}, [])
    assert changed.summary["status"] == "INVALIDATED"
    assert changed.summary["stop_kind"] == "BUILD_CHANGE"
    short = Attempt(start)
    short.observe(start, state, [item(1)])
    short.observe(start + timedelta(hours=48), state, [item(1, status="FAILED")])
    assert short.summary["status"] == "INSUFFICIENT_ROUNDS"
    changed.finish(start + timedelta(days=10), "WINDOW_ELAPSED")
    assert changed.summary["status"] == "INVALIDATED"
    baseline = {"caller_commit": "a" * 40, "kernel_commit": "b" * 40, "config_sha256": {"config_0": "old"}}
    for drift, kind in [({**baseline, "caller_commit": "c" * 40}, "CODE_CHANGE"),
                        ({**baseline, "config_sha256": {"config_0": "new"}}, "CONFIG_CHANGE")]:
        frozen = Attempt(start)
        frozen.check_freeze(start, baseline)
        frozen.check_freeze(start + timedelta(seconds=1), drift)
        assert frozen.summary["status"] == "INVALIDATED"
        assert frozen.summary["stop_kind"] == kind
        assert frozen.summary["freeze"] == baseline
    stopped = Attempt(start)
    stopped.observe(start, state, [item(1)])
    stopped.finish(start + timedelta(minutes=1), "STOPPED", "DEPLOYMENT_BUG")
    stopped.observe(start + timedelta(hours=48), state, rounds)
    assert stopped.summary["status"] == "STOPPED"
    assert stopped.summary["stop_kind"] == "DEPLOYMENT_BUG"
    print(json.dumps({"synthetic_only": True, "self_test": "PASS", "real_observation_started": False}))
    return 0


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    monitor = commands.add_parser("run")
    monitor.add_argument("--output", required=True, help="new private attempt directory")
    monitor.add_argument("--repo", default="/opt/rustcore-demo/current")
    monitor.add_argument("--api", default="http://127.0.0.1:8787")
    monitor.add_argument("--config", default="/etc/rustcore-demo/env")
    monitor.add_argument("--freeze-file", action="append", default=[], help="additional frozen unit/timer/config file; repeatable")
    monitor.add_argument("--data-dir", default="/var/lib/rustcore-demo")
    monitor.add_argument("--caller-unit", default="caller.service")
    monitor.add_argument("--kernel-unit", default="rustcore.service")
    for name in ("status", "stop"):
        command = commands.add_parser(name)
        command.add_argument("--output", required=True)
        if name == "stop":
            command.add_argument("--kind", choices=STOP_KINDS, required=True)
    commands.add_parser("self-test")
    args = parser.parse_args()
    if args.command == "self-test":
        return self_test()
    if args.command == "run":
        if not all(re.fullmatch(r"[A-Za-z0-9_.@:-]+\.service", name) for name in (args.caller_unit, args.kernel_unit)):
            raise ValueError("INVALID_SERVICE_NAME")
        return run(args)
    output = Path(args.output)
    if args.command == "stop":
        summary = json.loads((output / "summary.json").read_text())
        if summary["status"] not in TERMINAL:
            with (output / "stop.json").open("x", encoding="utf-8") as control:
                json.dump({"kind": args.kind, "requested_at": stamp(utc())}, control)
        print(json.dumps({"stop_requested": summary["status"] not in TERMINAL, "kind": args.kind}))
    else:
        print((output / "summary.json").read_text(), end="")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.TimeoutExpired):
        # Never forward filenames, configuration text, subprocess stderr or HTTP bodies.
        print(json.dumps({"error": "OBSERVATION_COMMAND_FAILED"}), file=sys.stderr)
        sys.exit(1)
