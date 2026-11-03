#!/bin/bash
# Sourced only by root-owned deploy/rollback entrypoints.
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
release_base=/opt/rustcore-demo
web_base=/srv/rustcore-demo-web
node_dir=$release_base/tools/node-v22.23.2-linux-x64/bin
export PATH="$node_dir:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
exec {deploy_lock}>/run/lock/rustcore-demo-deploy.lock
flock -n "$deploy_lock" || { echo 'Another deploy or rollback is running.' >&2; exit 1; }

valid_release() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]]; }
switch_link() {
  local target=$1 link=$2
  ln -s -- "$target" "$link.pending-$$" || return
  mv -Tf -- "$link.pending-$$" "$link"
}
assert_release() {
  valid_release "$1" || return 1
  [[ -d $release_base/releases/$1 && -x $release_base/bin/$1/rustcore && -f $release_base/manifests/$1.json && -f $web_base/releases/$1/dist/index.html && -f $web_base/releases/$1/BUILD-INFO.json ]] || return 1
  local unsafe
  unsafe=$(find "$release_base/releases/$1" "$release_base/bin/$1" "$web_base/releases/$1" -xdev \( ! -user root -o \( ! -type l -perm /022 \) \) -print -quit)
  [[ -z $unsafe ]] || { echo 'Release must be root-owned and unwritable by the service account.' >&2; return 1; }
}
quiesce() {
  timer_was_active=false
  if systemctl is-active --quiet scenario.timer; then timer_was_active=true; fi
  systemctl stop scenario.timer
  # This guard is deployment-only. The scenario unit does not add an outer flock.
  # Holding the existing native scenario lock prevents stopping an active round.
  if [[ ! -e /var/lib/rustcore-demo/scenario.lock ]]; then
    install -o rustcore-demo -g rustcore-demo -m 0600 /dev/null /var/lib/rustcore-demo/scenario.lock
  fi
  exec {scenario_guard}>/var/lib/rustcore-demo/scenario.lock
  if ! flock -n "$scenario_guard"; then
    $timer_was_active && systemctl start scenario.timer
    echo 'Active scenario; deploy/rollback refused without stopping it.' >&2
    exit 1
  fi
}
activate() {
  local name=$1
  assert_release "$name" || return
  systemctl stop caller.service rustcore.service || return
  /usr/bin/python3 "$release_base/releases/$name/deploy/release-env.py" "$name" || return
  switch_link "$release_base/bin/$name/rustcore" "$release_base/kernel-current" || return
  switch_link "$release_base/releases/$name" "$release_base/current" || return
  switch_link "$web_base/releases/$name" "$web_base/current" || return
  install -o root -g root -m 0644 "$release_base/releases/$name"/deploy/systemd/* /etc/systemd/system/ || return
  systemctl daemon-reload || return
  systemctl enable rustcore.service caller.service rustcore-health.timer rustcore-backup.timer rustcore-recordings.path >/dev/null || return
  systemctl start rustcore.service caller.service || return
  /usr/bin/python3 "$release_base/releases/$name/deploy/smoke.py" || return
  systemctl start rustcore-health.timer rustcore-backup.timer rustcore-recordings.path rustcore-recordings.service
}
resume_timer() {
  flock -u "$scenario_guard"
  if $timer_was_active; then systemctl start scenario.timer; fi
}
