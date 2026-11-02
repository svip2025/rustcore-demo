#!/usr/bin/python3
"""Update only nonsecret release/path fields; never source or print the private env."""
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

base = Path("/opt/rustcore-demo")
release = sys.argv[1]
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", release):
    raise SystemExit("Invalid release identifier")
metadata = json.loads((base / "manifests" / (release + ".json")).read_text())
values = {
    "DEMO_CALLER_COMMIT": metadata["caller_commit"],
    "DEMO_RUSTCORE_COMMIT": metadata["rustcore_commit"],
    "DEMO_KERNEL_BINARY": str(base / "bin" / release / "rustcore"),
    "DEMO_KERNEL_MODE": "systemd",
    "RUSTCORE_DB_URL": "sqlite:///var/lib/rustcore-demo/kernel.db",
    "RUSTCORE_GRPC_ADDR": "127.0.0.1:50051",
    "DEMO_CALLER_DB_FILE": "/var/lib/rustcore-demo/caller.db",
    "DEMO_LOCK_FILE": "/var/lib/rustcore-demo/scenario.lock",
    "DEMO_HTTP_ADDR": "127.0.0.1:8787",
    "DEMO_TRUST_PROXY": "1",
}
path = Path("/etc/rustcore-demo/env")
original = path.lstat()
if not stat.S_ISREG(original.st_mode) or stat.S_IMODE(original.st_mode) != 0o600:
    raise SystemExit("Private environment must be an ordinary 600 file")
lines = path.read_text().splitlines()
for key, value in values.items():
    matches = [index for index, line in enumerate(lines) if re.match(r"^\s*" + key + r"=", line)]
    if len(matches) > 1:
        raise SystemExit("Duplicate nonsecret environment field")
    if matches:
        lines[matches[0]] = key + "=" + value
    else:
        lines.append(key + "=" + value)
descriptor, temporary = tempfile.mkstemp(prefix=".env-", dir=path.parent)
try:
    with os.fdopen(descriptor, "w") as result:
        os.fchmod(result.fileno(), 0o600)
        os.fchown(result.fileno(), original.st_uid, original.st_gid)
        result.write("\n".join(lines) + "\n")
        result.flush()
        os.fsync(result.fileno())
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
