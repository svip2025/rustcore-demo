#!/usr/bin/env python3
"""Publish completed, already-public caller recordings without changing their facts."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
from datetime import datetime


def read_recording(path):
    value = json.loads(path.read_text())
    if value.get('schema_version') != 1 or value.get('source', {}).get('kind') != 'TESTNET':
        raise ValueError('Only public v1 TESTNET recordings can be published')
    rounds = [e['data'] for e in value['events'] if e['type'] == 'round']
    final = rounds[-1]
    if final['status'] not in ('SUCCEEDED', 'FAILED') or not final['ended_at']:
        raise ValueError('Recording is not complete')
    return value, final


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--private-dir', default='/var/lib/rustcore-demo/recordings')
    parser.add_argument('--public-dir', default='/srv/rustcore-demo-recordings')
    args = parser.parse_args()
    private, public = Path(args.private_dir), Path(args.public_dir)
    if not public.is_dir() or public.is_symlink():
        raise ValueError('Public recording directory must already exist')
    lock = os.open(public / '.publish.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    # Independent path/timer/manual export invocations cannot race the catalog.
    fcntl.flock(lock, fcntl.LOCK_EX)
    entries = {}
    for path in sorted(public.glob('*.json')):
        if path.name == 'index.json':
            continue
        if path.is_symlink():
            raise ValueError('Recording symlinks are not accepted')
        value, final = read_recording(path)
        entries[value['recording_id']] = (path.name, value, final)
    added = 0
    for path in sorted(private.glob('*.json')):
        if path.is_symlink():
            raise ValueError('Recording symlinks are not accepted')
        value, final = read_recording(path)
        if value['recording_id'] in entries:
            continue
        round_id = final['round_id']
        if not re.fullmatch(r'round_[A-Za-z0-9]+', round_id):
            raise ValueError('Invalid public round identifier')
        at = datetime.fromisoformat(value['started_at'].replace('Z', '+00:00'))
        name = f'run-{at:%Y%m%d-%H%M}-{round_id}.json'
        destination = public / name
        # Completed facts are immutable. Never overwrite an earlier recording.
        pending = public / f'.recording-{os.getpid()}.tmp'
        try:
            with pending.open('x') as output:
                json.dump(value, output, ensure_ascii=False, indent=2)
                output.write('\n')
                output.flush()
                os.fsync(output.fileno())
            os.chmod(pending, 0o644)
            os.link(pending, destination)
        finally:
            pending.unlink(missing_ok=True)
        entries[value['recording_id']] = (name, value, final)
        added += 1
    catalog = []
    for name, value, final in entries.values():
        start = datetime.fromisoformat(value['started_at'].replace('Z', '+00:00'))
        end = datetime.fromisoformat(value['ended_at'].replace('Z', '+00:00'))
        catalog.append(dict(id=value['recording_id'], title=value['title'], source=value['source'],
                            status=final['status'], reason=final['reason'], file='recordings/' + name,
                            duration_ms=round((end-start).total_seconds()*1000),
                            started_at=value['started_at'], ended_at=value['ended_at']))
    catalog.sort(key=lambda item: (item['started_at'], item['id']), reverse=True)
    default = next((item['id'] for item in catalog if item['status'] == 'SUCCEEDED'), None)
    index = dict(schema_version=1, default_id=default, recordings=catalog)
    temporary = public / f'.index-{os.getpid()}.tmp'
    try:
        with temporary.open('x') as output:
            json.dump(index, output, ensure_ascii=False, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, public / 'index.json')
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps(dict(event='recordings_published', added=added, total=len(catalog))))
    os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No untrusted path, document content or OS error is copied to journald.
        print(json.dumps(dict(event='recordings_publish_failed', error=type(error).__name__)))
        raise SystemExit(1)
