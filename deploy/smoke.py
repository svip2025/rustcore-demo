#!/usr/bin/python3
"""Read-only readiness check; never starts a scenario or retries a write."""
import json
import time
import urllib.request

deadline = time.monotonic() + 120
while True:
    try:
        with urllib.request.urlopen("http://127.0.0.1:8787/api/health", timeout=3) as response:
            health = json.load(response)
        with urllib.request.urlopen("http://127.0.0.1:8787/api/state", timeout=3) as response:
            state = json.load(response)
        if (health.get("status") == "healthy" and state.get("schema_version") == 1
                and state.get("source", {}).get("kind") == "TESTNET"
                and state.get("rustcore", {}).get("status") == "ONLINE"
                and state.get("account", {}).get("status") == "AVAILABLE"):
            print("Caller health and state smoke checks passed")
            break
    except (OSError, ValueError):
        pass
    if time.monotonic() >= deadline:
        raise SystemExit("Caller health/state smoke check timed out")
    time.sleep(2)
