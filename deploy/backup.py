#!/usr/bin/python3
"""SQLite online backup; each database is consistent, not a cross-database transaction."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path("/var/lib/rustcore-demo"))
    parser.add_argument("--backup-dir", type=Path, default=Path("/var/backups/rustcore-demo/sqlite"))
    args = parser.parse_args()
    os.umask(0o077)
    args.backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.backup_dir.is_symlink():
        raise RuntimeError("Backup directory must not be a symlink")
    with (args.backup_dir / ".backup.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        temporary = Path(tempfile.mkdtemp(prefix=".pending-", dir=args.backup_dir))
        try:
            manifest = {"created_at": dt.datetime.now(dt.timezone.utc).isoformat(), "databases": {}}
            for name in ("kernel.db", "caller.db"):
                source_path = args.data_dir / name
                if not source_path.is_file() or source_path.is_symlink():
                    raise RuntimeError("Both ordinary SQLite database files must exist")
                deadline = time.monotonic() + 240

                def progress(_status, _remaining, _total):
                    if time.monotonic() > deadline:
                        raise TimeoutError("Online SQLite backup deadline exceeded")

                destination = temporary / name
                with sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True) as source:
                    with sqlite3.connect(destination) as target:
                        source.backup(target, pages=256, progress=progress, sleep=0.1)
                        if target.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                            raise RuntimeError("Backup integrity check failed")
                with destination.open("rb") as result:
                    manifest["databases"][name] = hashlib.file_digest(result, "sha256").hexdigest()
                    os.fsync(result.fileno())
            (temporary / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
            name = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ-") + uuid.uuid4().hex[:8]
            temporary.rename(args.backup_dir / name)
            generations = sorted(path for path in args.backup_dir.iterdir()
                                 if re.fullmatch(r"\d{8}T\d{6}\.\d{6}Z-[0-9a-f]{8}", path.name)
                                 and path.is_dir() and not path.is_symlink())
            for old in generations[:-7]:
                shutil.rmtree(old)
            print(json.dumps({"event": "sqlite_backup_complete", "databases": 2, "retained": min(7, len(generations))}))
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)


if __name__ == "__main__":
    main()
