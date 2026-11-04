#!/usr/bin/env python3
"""F3 test-VPS tool. Plan is read-only; this goal never executes --inject.

Only a per-run chain and exchange destination TCP/443 rules are owned. The
independent systemd timer is armed before the first firewall mutation.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import uuid

HOSTS = ("demo-fapi.binance.com", "demo-fstream.binance.com")
CHAIN = re.compile(r"RC2A_[A-F0-9]{16}\Z")


def execute(argv):
    return subprocess.run(argv, check=True, text=True, capture_output=True,
                          timeout=20).stdout


def resolve_exchange(resolver=socket.getaddrinfo):
    addresses = set()
    for host in HOSTS:
        records = resolver(host, 443, type=socket.SOCK_STREAM)
        if not records:
            raise ValueError("DNS_EMPTY")
        addresses.update(str(ipaddress.ip_address(r[4][0])) for r in records)
    if not addresses or len(addresses) > 64:
        raise ValueError("DNS_SCOPE_INVALID")
    return sorted(addresses)


def plan(addresses, duration, ssh_peers=()):
    if duration not in (60, 300):
        raise ValueError("DURATION_MUST_BE_60_OR_300")
    peers = {str(ipaddress.ip_address(a)) for a in ssh_peers}
    targets = sorted({str(ipaddress.ip_address(a)) for a in addresses})
    if not targets or len(targets) > 64:
        raise ValueError("INVALID_TARGET_COUNT")
    for a in targets:
        ip = ipaddress.ip_address(a)
        if not ip.is_global or a in peers:
            raise ValueError("UNSAFE_OR_SSH_TARGET")
    return {"version": 1, "chain": "RC2A_" + uuid.uuid4().hex[:16].upper(),
            "duration_seconds": duration, "addresses": targets,
            "ports": [443], "hosts": list(HOSTS), "created_ms": int(time.time()*1000)}


def validate(state):
    if state.get("version") != 1 or not CHAIN.fullmatch(state.get("chain", "")):
        raise ValueError("INVALID_STATE")
    if state.get("ports") != [443] or state.get("hosts") != list(HOSTS):
        raise ValueError("INVALID_SCOPE")
    plan(state["addresses"], state["duration_seconds"])


def families(state):
    return [(tool, [a for a in state["addresses"] if ipaddress.ip_address(a).version == version])
            for tool, version in (("/usr/sbin/iptables", 4), ("/usr/sbin/ip6tables", 6))
            if any(ipaddress.ip_address(a).version == version for a in state["addresses"])]


def cleanup(state, command=execute):
    validate(state)
    name = state["chain"]
    errors = []
    for tool, _ in families(state):
        try:
            # Absence is a normal, verifiable idempotent cleanup result.
            rules = command([tool, "-w", "5", "-S"])
            if f"-N {name}" not in rules.splitlines():
                continue
            jump = f"-A OUTPUT -j {name}"
            for _ in range(rules.splitlines().count(jump)):
                command([tool, "-w", "5", "-D", "OUTPUT", "-j", name])
            command([tool, "-w", "5", "-F", name])
            command([tool, "-w", "5", "-X", name])
            if any(name in line.split() for line in command([tool, "-w", "5", "-S"]).splitlines()):
                raise ValueError("RULES_REMAIN")
        except (subprocess.SubprocessError, ValueError):
            errors.append(tool)
    if errors:
        raise RuntimeError("FIREWALL_CLEANUP_NOT_VERIFIED")


def inject(state, state_file, command=execute):
    validate(state)
    if not state_file.is_absolute() or state_file.is_symlink():
        raise ValueError("ABSOLUTE_PRIVATE_STATE_REQUIRED")
    # Fail rather than overwrite an existing receipt or unrelated file.
    with state_file.open("x", encoding="utf-8") as f:
        os.chmod(state_file, 0o600)
        json.dump(state, f)
        f.flush()
        os.fsync(f.fileno())
    timer = "rustcore-r2-f3-" + state["chain"][5:].lower()
    # Scheduling failure prevents all iptables writes. Cleanup survives SSH/tool exit.
    armed_at = time.monotonic()
    command(["/usr/bin/systemd-run", "--quiet", "--unit="+timer,
             "--on-active="+str(state["duration_seconds"])+"s",
             "--timer-property=AccuracySec=1s", "--", sys.executable,
             str(Path(__file__).resolve()), "--cleanup", str(state_file)])
    state["timer_unit"] = timer
    def mutate(args):
        # Each command has a 20s timeout. Never attach rules after the timer
        # could have fired during a delayed/partially installed injection.
        if time.monotonic() - armed_at >= state["duration_seconds"] - 25:
            raise RuntimeError("INSTALLATION_DEADLINE")
        return command(args)
    try:
        for tool, addresses in families(state):
            mutate([tool, "-w", "5", "-N", state["chain"]])
            for address in addresses:
                mutate([tool, "-w", "5", "-A", state["chain"], "-d", address,
                         "-p", "tcp", "--dport", "443", "-j", "DROP"])
            mutate([tool, "-w", "5", "-I", "OUTPUT", "1", "-j", state["chain"]])
    except BaseException:
        cleanup(state, command)
        raise
    return timer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--plan", action="store_true")
    actions.add_argument("--inject", action="store_true")
    actions.add_argument("--cleanup", type=Path)
    parser.add_argument("--duration", type=int, choices=(60, 300), default=60)
    parser.add_argument("--state", type=Path)
    parser.add_argument("--test-vps-ack", action="store_true")
    parser.add_argument("--ssh-peer", action="append", default=[])
    args = parser.parse_args()
    if args.cleanup:
        if args.cleanup.is_symlink() or args.cleanup.stat().st_mode & 0o077:
            raise ValueError("PRIVATE_RECEIPT_REQUIRED")
        state = json.loads(args.cleanup.read_text())
        cleanup(state)
        print(json.dumps({"cleanup": "VERIFIED", "chain": state["chain"]}))
        return
    peers = os.environ.get("SSH_CONNECTION", "").split()
    state = plan(resolve_exchange(), args.duration, peers[:1] + args.ssh_peer)
    if args.plan:
        print(json.dumps(state, indent=2))
        return
    if not args.test_vps_ack or not args.state or os.geteuid() != 0:
        raise ValueError("ROOT_TEST_VPS_ACK_AND_STATE_REQUIRED")
    timer = inject(state, args.state)
    print(json.dumps({"injection": "ACTIVE", "timer": timer,
                      "cleanup_due_seconds": state["duration_seconds"]}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # No raw command errors, hosts, credentials or environment values.
        print(json.dumps({"status": "FAILED", "code": "F3_NOT_COMPLETED"}), file=sys.stderr)
        sys.exit(1)
