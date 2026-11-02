#!/bin/bash
# Usage: deploy.sh <accepted-tag-or-fullsha> --web-package /srv/accepted-package
set -euo pipefail
asset_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$asset_dir/release-common.sh"
[[ $# == 3 && $2 == --web-package ]] && valid_release "$1" || { echo 'Usage: deploy.sh <accepted-tag-or-fullsha> --web-package /srv/accepted-package' >&2; exit 1; }
name=$1
web_package=$(readlink -f -- "$3")
[[ -d $web_package/dist && -f $web_package/dist/index.html && -f $web_package/BUILD-INFO.json ]] || { echo 'Accepted web package must contain dist/index.html and BUILD-INFO.json.' >&2; exit 1; }
release=$release_base/releases/$name
repository=$release_base/repository.git
[[ -x $node_dir/node && $($node_dir/node --version) == v22.23.2 ]] || { echo 'Pinned Node 22.23.2 must be installed first.' >&2; exit 1; }
for tool in git cargo python3 curl flock; do command -v "$tool" >/dev/null; done
[[ -f /etc/rustcore-demo/env && ! -L /etc/rustcore-demo/env ]] || exit 1
install -d -o root -g root -m 0755 "$release_base"/{releases,bin,manifests,build-cache} "$web_base"/releases
if [[ ! -d $release ]]; then
  if [[ ! -d $repository ]]; then
    git init --bare "$repository" >/dev/null
    git --git-dir="$repository" remote add origin https://github.com/svip2025/rustcore-demo.git
  fi
  if [[ $name =~ ^[0-9a-f]{40}$ ]]; then
    git --git-dir="$repository" fetch origin "$name"
  else
    git --git-dir="$repository" fetch origin "refs/tags/$name:refs/tags/$name"
  fi
  commit=$(git --git-dir="$repository" rev-parse 'FETCH_HEAD^{commit}')
  git clone --no-checkout --no-hardlinks "$repository" "$release"
  git -C "$release" checkout --detach "$commit"
  git -C "$release" submodule update --init --recursive
  "$node_dir/node" "$node_dir/../lib/node_modules/npm/bin/npm-cli.js" --prefix "$release" ci --ignore-scripts
  "$node_dir/node" "$release/node_modules/typescript/bin/tsc" --noEmit --project "$release/tsconfig.json"
  task_target_dir=${CARGO_TARGET_DIR:-$release_base/build-cache/cargo}
  CARGO_TARGET_DIR="$task_target_dir" cargo build --locked --release --manifest-path "$release/rustcore/Cargo.toml" --package rustcore --bin rustcore
  install -d -o root -g root -m 0755 "$release_base/bin/$name"
  install -o root -g root -m 0555 "$task_target_dir/release/rustcore" "$release_base/bin/$name/rustcore"
  # Reuse an already accepted static package, outside the immutable source tree.
  install -d -o root -g root -m 0755 "$web_base/releases/$name"
  cp -a -- "$web_package/dist" "$web_base/releases/$name/dist"
  cp -a -- "$web_package/BUILD-INFO.json" "$web_base/releases/$name/BUILD-INFO.json"
  core_commit=$(git -C "$release/rustcore" rev-parse HEAD)
  printf '{"caller_commit":"%s","rustcore_commit":"%s"}\n' "$commit" "$core_commit" > "$release_base/manifests/$name.json"
  chown -R root:root "$release" "$release_base/bin/$name" "$web_base/releases/$name"
  chmod -R go-w "$release" "$release_base/bin/$name" "$web_base/releases/$name"
fi
assert_release "$name"
previous=''
if [[ -L $release_base/current ]]; then previous=$(basename -- "$(readlink -f "$release_base/current")"); fi
[[ $previous != "$name" ]] || { echo 'Requested release is already current.'; exit 0; }
quiesce
if [[ -f /var/lib/rustcore-demo/kernel.db && -f /var/lib/rustcore-demo/caller.db ]]; then
  /usr/bin/python3 "$asset_dir/backup.py"
fi
if activate "$name"; then
  if [[ -n $previous ]]; then printf '%s\n' "$previous" > "$release_base/previous-release"; fi
  resume_timer
  echo 'Release activated; smoke checks passed. First install leaves scenario.timer stopped for observer setup.'
else
  echo 'Smoke/activation failed; reverting code only. SQLite is never rewound automatically.' >&2
  if [[ -n $previous ]] && assert_release "$previous" && activate "$previous"; then
    resume_timer
    echo 'Previous release restored and smoke checks passed.' >&2
  else
    systemctl stop caller.service rustcore.service
    echo 'Rollback unavailable/failed; services stopped, databases and backups preserved.' >&2
  fi
  exit 1
fi
