#!/usr/bin/env python3
"""Launch sampler; it resolves owned-child or service identity without mutation."""
import json
from pathlib import Path
import subprocess
import sys

try:
    result = subprocess.run(["/opt/rustcore-demo/tools/node-v22.23.2-linux-x64/bin/node", "--import", "tsx",
                             "scripts/sample-round2.ts", "--kernel-pid", "auto",
                             "--state", "/var/lib/rustcore-demo/round2-schedule.db",
                             "--output", "/var/lib/rustcore-demo/round2-samples.jsonl",
                             "--env", "/etc/rustcore-demo/env"],
                            cwd=Path(__file__).resolve().parent.parent, check=False)
    sys.exit(result.returncode)
except Exception:
    print(json.dumps({"event": "hourly_sample_failed", "code": "SAMPLER_LAUNCH_FAILED"}), file=sys.stderr)
    sys.exit(1)
