#!/bin/bash
# Usage: rollback.sh [previous-tag-or-fullsha]. Restores code, never historical DB state.
set -euo pipefail
asset_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$asset_dir/release-common.sh"
[[ $# -le 1 ]] || exit 1
name=${1:-$(cat "$release_base/previous-release")}
assert_release "$name"
quiesce
/usr/bin/python3 "$asset_dir/backup.py"
if activate "$name"; then
  resume_timer
  echo 'Code rollback complete; current SQLite data preserved.'
else
  systemctl stop caller.service rustcore.service
  echo 'Rollback smoke check failed; services stopped and all databases preserved.' >&2
  exit 1
fi
