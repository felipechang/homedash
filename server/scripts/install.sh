#!/usr/bin/env bash
#
# homedash remote enrollment
#
# Joins this Debian machine to a homedash control panel. It will:
#   1. create a "homedash" service account with passwordless sudo
#   2. authorize the control panel's SSH key for that account
#   3. pin this machine's IP address so it never moves
#   4. install Docker
#   5. report this machine's specs back to the control panel
#
# Run it as root. It is safe to run more than once.

set -euo pipefail

HUB_URL="@@HUB_URL@@"
TOKEN="@@TOKEN@@"
HOST_ID="@@HOST_ID@@"
SSH_USER="@@SSH_USER@@"
HUB_PUBKEY="@@HUB_PUBKEY@@"
WANT_IP="@@WANT_IP@@"           # empty => pin whatever address this box has now
WANT_GATEWAY="@@WANT_GATEWAY@@"
WANT_DNS="@@WANT_DNS@@"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }

# Minimal JSON string escaper, so we do not depend on jq being installed.
json_str() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\r//g' \
    | awk 'BEGIN{printf "\""} {printf "%s", (NR>1 ? "\\n" : "") $0} END{printf "\""}'
}

report_failure() {
  curl -fsS --max-time 10 -X POST "$HUB_URL/api/enroll/$TOKEN/failed" \
    -H 'Content-Type: application/json' \
    --data "$(printf '{"error":%s}' "$(json_str "${1:-unknown}")")" >/dev/null 2>&1 || true
}

die() {
  printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2
  report_failure "$*"
  exit 1
}

# ---------------------------------------------------------------- preflight --

[ "$(id -u)" -eq 0 ] || die "This script must run as root. Try: curl -fsSL $HUB_URL/i/$TOKEN | sudo bash"
command -v curl >/dev/null || die "curl is required but not installed."
[ -f /etc/debian_version ] || warn "This does not look like Debian/Ubuntu. Continuing anyway."

say "Enrolling $(hostname) with $HUB_URL"

# ------------------------------------------------------------ service account --

if ! id "$SSH_USER" >/dev/null 2>&1; then
  say "Creating service account: $SSH_USER"
  useradd --create-home --shell /bin/bash --comment "homedash control account" "$SSH_USER"
else
  say "Service account $SSH_USER already exists"
fi

install -d -m 0700 -o "$SSH_USER" -g "$SSH_USER" "/home/$SSH_USER/.ssh"
AUTHKEYS="/home/$SSH_USER/.ssh/authorized_keys"
touch "$AUTHKEYS"
if ! grep -qxF "$HUB_PUBKEY" "$AUTHKEYS"; then
  say "Authorizing the control panel's SSH key"
  printf '%s\n' "$HUB_PUBKEY" >> "$AUTHKEYS"
fi
chown "$SSH_USER:$SSH_USER" "$AUTHKEYS"
chmod 0600 "$AUTHKEYS"

say "Granting passwordless sudo to $SSH_USER"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$SSH_USER" > /etc/sudoers.d/90-homedash
chmod 0440 /etc/sudoers.d/90-homedash
visudo -cf /etc/sudoers.d/90-homedash >/dev/null || die "Generated a bad sudoers file; aborting."

# -------------------------------------------------------------- networking ---

PRIMARY_IFACE="$(ip -4 route show default | awk '{print $5; exit}')"
[ -n "$PRIMARY_IFACE" ] || die "Could not determine the primary network interface."
CUR_CIDR="$(ip -4 -o addr show dev "$PRIMARY_IFACE" | awk '{print $4; exit}')"
CUR_IP="${CUR_CIDR%%/*}"
CUR_PREFIX="${CUR_CIDR##*/}"
CUR_GATEWAY="$(ip -4 route show default | awk '{print $3; exit}')"
CUR_DNS="$(awk '/^nameserver/{print $2}' /etc/resolv.conf 2>/dev/null | paste -sd, - || true)"
[ -n "${CUR_DNS:-}" ] || CUR_DNS="1.1.1.1,9.9.9.9"

TARGET_IP="${WANT_IP:-$CUR_IP}"
TARGET_GATEWAY="${WANT_GATEWAY:-$CUR_GATEWAY}"
TARGET_DNS="${WANT_DNS:-$CUR_DNS}"
IP_CHANGES=0
if [ "$TARGET_IP" != "$CUR_IP" ]; then IP_CHANGES=1; fi

say "Pinning $PRIMARY_IFACE to $TARGET_IP/$CUR_PREFIX via $TARGET_GATEWAY"

if systemctl is-enabled --quiet systemd-networkd 2>/dev/null; then
  NET_BACKEND="systemd-networkd"
  cat > /etc/systemd/network/10-homedash.network <<NETCFG
# Managed by homedash. Edits here may be overwritten.
[Match]
Name=$PRIMARY_IFACE

[Network]
Address=$TARGET_IP/$CUR_PREFIX
Gateway=$TARGET_GATEWAY
DNS=${TARGET_DNS//,/ }
NETCFG
elif [ -d /etc/network/interfaces.d ]; then
  NET_BACKEND="ifupdown"
  cat > /etc/network/interfaces.d/homedash <<NETCFG
# Managed by homedash. Edits here may be overwritten.
auto $PRIMARY_IFACE
iface $PRIMARY_IFACE inet static
    address $TARGET_IP/$CUR_PREFIX
    gateway $TARGET_GATEWAY
    dns-nameservers ${TARGET_DNS//,/ }
NETCFG
else
  NET_BACKEND="none"
  warn "No supported network config found; leaving addressing alone."
fi

# ------------------------------------------------------------------ docker ---

if command -v docker >/dev/null 2>&1; then
  say "Docker already installed ($(docker --version))"
else
  say "Installing Docker (this takes a minute)"
  curl -fsSL https://get.docker.com | sh >/dev/null || die "Docker installation failed."
fi
systemctl enable --now docker >/dev/null 2>&1 || warn "Could not enable the docker service."
usermod -aG docker "$SSH_USER"
install -d -m 0755 -o "$SSH_USER" -g "$SSH_USER" /opt/homedash/stacks

# ------------------------------------------------------------------- facts ---

say "Collecting machine specs"
FACT_HOSTNAME="$(hostname -f 2>/dev/null || hostname)"
FACT_OS="$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-unknown}")"
FACT_KERNEL="$(uname -r)"
FACT_ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
FACT_CPU_MODEL="$(awk -F': ' '/model name/{print $2; exit}' /proc/cpuinfo)"
[ -n "$FACT_CPU_MODEL" ] || FACT_CPU_MODEL="$(awk -F': ' '/^Model/{print $2; exit}' /proc/cpuinfo)"
[ -n "$FACT_CPU_MODEL" ] || FACT_CPU_MODEL="unknown"
FACT_CPU_CORES="$(nproc)"
FACT_MEM_MB="$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)"
FACT_DISK_GB="$(df -BG --output=size / | tail -1 | tr -dc '0-9')"
FACT_DISK_FREE_GB="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
FACT_MAC="$(cat "/sys/class/net/$PRIMARY_IFACE/address" 2>/dev/null || echo unknown)"
FACT_DOCKER="$(docker --version 2>/dev/null | sed 's/,.*//' || echo none)"
FACT_COMPOSE="$(docker compose version --short 2>/dev/null || echo none)"
FACT_VIRT="$(systemd-detect-virt 2>/dev/null || echo unknown)"
SSH_PORT="$(awk '/^Port /{print $2; exit}' /etc/ssh/sshd_config 2>/dev/null)"
[ -n "${SSH_PORT:-}" ] || SSH_PORT=22

HOST_KEY="$(awk '{print $1" "$2}' /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null)"
[ -n "$HOST_KEY" ] || die "This machine has no ed25519 SSH host key."

PAYLOAD=$(cat <<PAYLOAD_EOF
{
  "host_id": $(json_str "$HOST_ID"),
  "ssh_user": $(json_str "$SSH_USER"),
  "ssh_port": $SSH_PORT,
  "host_key": $(json_str "$HOST_KEY"),
  "address": $(json_str "$TARGET_IP"),
  "address_pending": $IP_CHANGES,
  "facts": {
    "hostname": $(json_str "$FACT_HOSTNAME"),
    "os": $(json_str "$FACT_OS"),
    "kernel": $(json_str "$FACT_KERNEL"),
    "arch": $(json_str "$FACT_ARCH"),
    "virt": $(json_str "$FACT_VIRT"),
    "cpu_model": $(json_str "$FACT_CPU_MODEL"),
    "cpu_cores": $FACT_CPU_CORES,
    "mem_mb": $FACT_MEM_MB,
    "disk_gb": $FACT_DISK_GB,
    "disk_free_gb": $FACT_DISK_FREE_GB,
    "iface": $(json_str "$PRIMARY_IFACE"),
    "mac": $(json_str "$FACT_MAC"),
    "network_backend": $(json_str "$NET_BACKEND"),
    "docker": $(json_str "$FACT_DOCKER"),
    "compose": $(json_str "$FACT_COMPOSE")
  }
}
PAYLOAD_EOF
)

say "Reporting back to the control panel"
curl -fsS --max-time 20 -X POST "$HUB_URL/api/enroll/$TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$PAYLOAD" >/dev/null \
  || die "Could not reach the control panel at $HUB_URL. Is it still running, and has the code expired?"

# ------------------------------------------------------------------ finish ---

if [ "$IP_CHANGES" -eq 1 ]; then
  warn "This machine's address is about to change from $CUR_IP to $TARGET_IP."
  warn "If you are connected over SSH, this session will drop. Reconnect on the new address."
  say "Applying the new address in 5 seconds..."
  sleep 5
  case "$NET_BACKEND" in
    systemd-networkd) systemctl restart systemd-networkd ;;
    ifupdown)         ifdown "$PRIMARY_IFACE" 2>/dev/null || true; ifup "$PRIMARY_IFACE" ;;
  esac
fi

say "Done. $FACT_HOSTNAME is now managed by homedash."
