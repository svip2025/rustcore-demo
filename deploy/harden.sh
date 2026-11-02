#!/bin/bash
# Preparation never changes SSH/firewall. Apply only after a new key login was verified.
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
asset_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
admin_user=${ADMIN_USER:-rustcore-admin}
[[ $admin_user =~ ^[a-z_][a-z0-9_-]*$ && $admin_user != rustcore-demo && $admin_user != root ]] || exit 1
verified=false
key_file=''
while (( $# )); do
  case $1 in
    --ssh-verified) verified=true; shift ;;
    --prepare-admin) [[ $# -ge 2 ]] || exit 1; key_file=$2; shift 2 ;;
    *) echo 'Usage: ADMIN_USER=name harden.sh [--prepare-admin public-key-file] [--ssh-verified]' >&2; exit 1 ;;
  esac
done
for executable in getent useradd install visudo sudo sshd nft ip systemctl; do
  command -v "$executable" >/dev/null || { echo "Required tool missing: $executable" >&2; exit 1; }
done
if ! id "$admin_user" >/dev/null 2>&1; then
  [[ -n $key_file && -s $key_file && ! -L $key_file ]] || { echo 'New administrator requires --prepare-admin public-key-file.' >&2; exit 1; }
  ssh-keygen -l -f "$key_file" >/dev/null
  useradd --create-home --shell /bin/bash "$admin_user"
  admin_home=$(getent passwd "$admin_user" | cut -d: -f6)
  install -d -o "$admin_user" -g "$admin_user" -m 0700 "$admin_home/.ssh"
  install -o "$admin_user" -g "$admin_user" -m 0600 "$key_file" "$admin_home/.ssh/authorized_keys"
  admin_rule=$(mktemp)
  printf '%s ALL=(ALL:ALL) NOPASSWD: ALL\n' "$admin_user" > "$admin_rule"
  visudo -cf "$admin_rule" >/dev/null
  install -o root -g root -m 0440 "$admin_rule" "/etc/sudoers.d/80-$admin_user"
  rm -f "$admin_rule"
elif [[ -n $key_file ]]; then
  echo 'Existing administrator keys will not be replaced; omit --prepare-admin.' >&2
  exit 1
fi
admin_home=$(getent passwd "$admin_user" | cut -d: -f6)
[[ $(id -u "$admin_user") != 0 && -s $admin_home/.ssh/authorized_keys ]] || { echo 'Administrator key login is not configured.' >&2; exit 1; }
if ! $verified; then
  echo 'Administrator prepared. Verify a separate key-only SSH login and sudo -n id; then rerun with --ssh-verified.'
  exit 0
fi
# --ssh-verified records the operator's successful independent login, not a guessed timeout.
if ! id rustcore-demo >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/rustcore-demo --shell /usr/sbin/nologin rustcore-demo
fi
[[ $(getent passwd rustcore-demo | cut -d: -f7) == /usr/sbin/nologin ]] || { echo 'Service account must use nologin.' >&2; exit 1; }
for group in $(id -nG rustcore-demo); do
  case $group in sudo|admin|wheel|docker|lxd) echo 'Service account has a privileged group; remove it explicitly before continuing.' >&2; exit 1 ;; esac
done
stamp=$(date -u +%Y%m%dT%H%M%S)-$$
backup=/var/backups/rustcore-demo/harden-$stamp
install -d -o root -g root -m 0700 "$backup"
nft list ruleset > "$backup/nft-before.conf"
for file in /etc/ssh/sshd_config.d/00-rustcore-demo.conf /etc/sudoers.d/90-rustcore-demo /etc/apt/apt.conf.d/52rustcore-demo-security /etc/systemd/journald.conf.d/rustcore-demo.conf; do
  if [[ -e $file ]]; then cp -a --parents "$file" "$backup"; fi
done
install -d -o root -g root -m 0755 /opt/rustcore-demo /opt/rustcore-demo/releases /opt/rustcore-demo/tools /usr/local/lib/rustcore-demo
install -d -o root -g rustcore-demo -m 0750 /etc/rustcore-demo
install -d -o rustcore-demo -g rustcore-demo -m 0700 /var/lib/rustcore-demo /var/lib/rustcore-demo/recordings
install -d -o rustcore-demo -g rustcore-demo -m 0755 /srv/rustcore-demo-recordings
if [[ ! -e /etc/rustcore-demo/env ]]; then install -o rustcore-demo -g rustcore-demo -m 0600 /dev/null /etc/rustcore-demo/env; fi
[[ -f /etc/rustcore-demo/env && ! -L /etc/rustcore-demo/env ]] || exit 1
chown rustcore-demo:rustcore-demo /etc/rustcore-demo/env
chmod 0600 /etc/rustcore-demo/env
service_rule=$(mktemp)
printf '%s\n' 'rustcore-demo ALL=(root) NOPASSWD: /usr/bin/systemctl restart rustcore.service' > "$service_rule"
visudo -cf "$service_rule" >/dev/null
install -o root -g root -m 0440 "$service_rule" /etc/sudoers.d/90-rustcore-demo
rm -f "$service_rule"
visudo -c >/dev/null
sudo_rules=$(LC_ALL=C sudo -l -U rustcore-demo | sed -n '/may run the following commands/,$p' | tail -n +2 | sed '/^[[:space:]]*$/d;s/^[[:space:]]*//')
[[ $sudo_rules == '(root) NOPASSWD: /usr/bin/systemctl restart rustcore.service' ]] || { echo 'Unexpected additional service-account sudo permission; SSH/firewall unchanged.' >&2; exit 1; }
install -d -m 0755 /etc/ssh/sshd_config.d /etc/systemd/journald.conf.d
install -o root -g root -m 0644 "$asset_dir/templates/00-rustcore-demo.conf" /etc/ssh/sshd_config.d/00-rustcore-demo.conf
restore_ssh() {
  if [[ -e $backup/etc/ssh/sshd_config.d/00-rustcore-demo.conf ]]; then
    cp -a "$backup/etc/ssh/sshd_config.d/00-rustcore-demo.conf" /etc/ssh/sshd_config.d/00-rustcore-demo.conf
  else rm -f /etc/ssh/sshd_config.d/00-rustcore-demo.conf; fi
}
if ! sshd -t; then restore_ssh; exit 1; fi
effective=$(sshd -T -C "user=$admin_user,host=localhost,addr=127.0.0.1")
for expected in 'permitrootlogin no' 'passwordauthentication no' 'kbdinteractiveauthentication no' 'pubkeyauthentication yes' 'authenticationmethods publickey'; do
  if ! grep -qx "$expected" <<< "$effective"; then
    restore_ssh
    echo 'Existing SSH precedence/Match rules prevent requested policy; configuration restored.' >&2
    exit 1
  fi
done
if systemctl is-active --quiet ssh.service; then systemctl reload ssh.service; else systemctl reload sshd.service; fi
install -o root -g root -m 0755 "$asset_dir/firewall.sh" /usr/local/lib/rustcore-demo/firewall.sh
install -o root -g root -m 0644 "$asset_dir/systemd/rustcore-firewall.service" /etc/systemd/system/rustcore-firewall.service
systemctl daemon-reload
systemctl enable rustcore-firewall.service >/dev/null
systemctl restart rustcore-firewall.service
if command -v ufw >/dev/null && LC_ALL=C ufw status | grep -Eq '^8080/tcp([[:space:]]+\(v6\))?[[:space:]]+ALLOW'; then
  # Retire only this known obsolete opening, without resetting any other UFW rule.
  ufw --force delete allow 8080/tcp
fi
printf '[Journal]\nSystemMaxUse=500M\nRuntimeMaxUse=100M\n' > /etc/systemd/journald.conf.d/rustcore-demo.conf
install -o root -g root -m 0644 "$asset_dir/templates/52rustcore-demo-security" /etc/apt/apt.conf.d/52rustcore-demo-security
if ! command -v unattended-upgrade >/dev/null; then
  echo 'Install unattended-upgrades before enabling automatic security updates.' >&2; exit 1
fi
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null
systemctl restart systemd-journald.service
echo "Hardening complete. Backup: $backup. Recheck a new administrator SSH session before closing the current session."
