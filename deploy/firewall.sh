#!/bin/bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
command -v nft >/dev/null
command -v ip >/dev/null
mapfile -t interfaces < <({ ip -o -4 route show default; ip -o -6 route show default; } | awk '{for(i=1;i<NF;i++) if($i=="dev") print $(i+1)}' | sort -u)
(( ${#interfaces[@]} )) || { echo 'No default-route interface; firewall unchanged.' >&2; exit 1; }
devices=''
for interface in "${interfaces[@]}"; do
  [[ $interface =~ ^[A-Za-z0-9_.:-]+$ ]] || exit 1
  devices+="\"$interface\", "
done
devices=${devices%, }
rules=$(mktemp)
trap 'rm -f "$rules"' EXIT
# Replace only our own table, atomically. Existing UFW/Docker rules are retained.
if nft list table inet rustcore_demo >/dev/null 2>&1; then
  echo 'delete table inet rustcore_demo' >> "$rules"
fi
cat >> "$rules" <<EOF
table inet rustcore_demo {
  chain input {
    type filter hook input priority -5; policy accept;
    ct state invalid drop
    ct state established,related accept
    iifname "lo" accept
    meta l4proto { icmp, ipv6-icmp } accept
    tcp dport { 22, 80, 443 } accept
    udp dport 443 accept
    counter drop
  }
  chain forward {
    type filter hook forward priority -5; policy accept;
    iifname { $devices } ct state invalid drop
    iifname { $devices } ct state established,related accept
    iifname { $devices } ct status dnat meta l4proto tcp ct original proto-dst { 22, 80, 443 } accept
    iifname { $devices } ct status dnat meta l4proto udp ct original proto-dst 443 accept
    iifname { $devices } counter drop
  }
}
EOF
nft --check --file "$rules"
nft --file "$rules"
echo 'Dedicated input and Docker-forward guards installed; existing rules retained.'
