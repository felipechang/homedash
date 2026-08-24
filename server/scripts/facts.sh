#!/usr/bin/env bash
#
# Prints this machine's specs as a JSON object on stdout.
#
# Single source of truth for the fact schema: install.sh runs it at enrollment,
# and the control panel pipes it over SSH on every heartbeat. Keep it read-only
# and dependency-free — it must work on a stock Debian netinst with no jq.

set -euo pipefail

json_str() {
  printf '%s' "${1:-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\r//g' \
    | awk 'BEGIN{printf "\""} {printf "%s", (NR>1 ? "\\n" : "") $0} END{printf "\""}'
}

IFACE="$(ip -4 route show default 2>/dev/null | awk '{print $5; exit}')"
[ -n "${IFACE:-}" ] || IFACE="unknown"
ADDRESS="$(ip -4 -o addr show dev "$IFACE" 2>/dev/null | awk '{split($4,a,"/"); print a[1]; exit}')"

HOSTNAME_FQDN="$(hostname -f 2>/dev/null || hostname)"
OS="$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-unknown}")"
ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"

CPU_MODEL="$(awk -F': ' '/model name/{print $2; exit}' /proc/cpuinfo)"
[ -n "$CPU_MODEL" ] || CPU_MODEL="$(awk -F': ' '/^Model/{print $2; exit}' /proc/cpuinfo)"
[ -n "$CPU_MODEL" ] || CPU_MODEL="unknown"

# Load average over the number of cores, so the panel can compare machines.
CORES="$(nproc)"
LOAD1="$(awk '{print $1}' /proc/loadavg)"
MEM_MB="$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)"
MEM_AVAIL_MB="$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)"
UPTIME_S="$(awk '{printf "%d", $1}' /proc/uptime)"

CONTAINERS="$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')"
CONTAINERS_TOTAL="$(docker ps -aq 2>/dev/null | wc -l | tr -d ' ')"

cat <<EOF
{
  "hostname": $(json_str "$HOSTNAME_FQDN"),
  "os": $(json_str "$OS"),
  "kernel": $(json_str "$(uname -r)"),
  "arch": $(json_str "$ARCH"),
  "virt": $(json_str "$(systemd-detect-virt 2>/dev/null || echo unknown)"),
  "cpu_model": $(json_str "$CPU_MODEL"),
  "cpu_cores": $CORES,
  "load1": $LOAD1,
  "mem_mb": $MEM_MB,
  "mem_available_mb": $MEM_AVAIL_MB,
  "disk_gb": $(df -BG --output=size / | tail -1 | tr -dc '0-9'),
  "disk_free_gb": $(df -BG --output=avail / | tail -1 | tr -dc '0-9'),
  "uptime_s": $UPTIME_S,
  "iface": $(json_str "$IFACE"),
  "address": $(json_str "${ADDRESS:-}"),
  "mac": $(json_str "$(cat "/sys/class/net/$IFACE/address" 2>/dev/null || echo unknown)"),
  "docker": $(json_str "$(docker --version 2>/dev/null | sed 's/,.*//' || echo none)"),
  "compose": $(json_str "$(docker compose version --short 2>/dev/null || echo none)"),
  "containers_running": ${CONTAINERS:-0},
  "containers_total": ${CONTAINERS_TOTAL:-0}
}
EOF
