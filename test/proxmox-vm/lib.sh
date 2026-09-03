#!/usr/bin/env bash
#
# Shared config and helpers for the scripts in this directory. Sourced, not run.

LAB_DIR="${HOMEDASH_LAB_DIR:-$HOME/homedash-lab}"
SSH_KEY="$LAB_DIR/ssh/id_ed25519"
ROOT_PASSWORD_FILE="$LAB_DIR/root-password"

ISO_TOOL_IMAGE="homedash-pve-iso-tool"

# Check download.proxmox.com/iso/ if this drifts too far behind current.
PVE_ISO_URL="${PVE_ISO_URL:-https://enterprise.proxmox.com/iso/proxmox-ve_9.2-1.iso}"

PVE_KEYBOARD="${PVE_KEYBOARD:-en-us}"
PVE_COUNTRY="${PVE_COUNTRY:-us}"
PVE_FQDN="${PVE_FQDN:-pve.homedash.lab}"
PVE_MAILTO="${PVE_MAILTO:-root@homedash.lab}"
PVE_TIMEZONE="${PVE_TIMEZONE:-Etc/UTC}"

NET_NAME="${NET_NAME:-homedash-pve}"
NET_BRIDGE="${NET_BRIDGE:-virbr-hpve}"
NET_CIDR="${NET_CIDR:-10.20.30.0/24}"
NET_GATEWAY="${NET_GATEWAY:-10.20.30.1}"
NET_DHCP_START="${NET_DHCP_START:-10.20.30.10}"
NET_DHCP_END="${NET_DHCP_END:-10.20.30.250}"

VM_NAME="${VM_NAME:-homedash-pve}"
VM_MEMORY_MB="${VM_MEMORY_MB:-8192}"
VM_VCPUS="${VM_VCPUS:-6}"
VM_DISK_GB="${VM_DISK_GB:-64}"
VM_DISK="$LAB_DIR/$VM_NAME.qcow2"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found. Did you run ./setup-host.sh?"
}

ensure_ssh_key() {
  if [ ! -f "$SSH_KEY" ]; then
    say "Generating a throwaway SSH key for the virtualized Proxmox node ($SSH_KEY)"
    mkdir -p "$(dirname "$SSH_KEY")"
    chmod 700 "$(dirname "$SSH_KEY")"
    ssh-keygen -t ed25519 -N "" -C "homedash-pve-vm" -f "$SSH_KEY" >/dev/null
  fi
}

vm_mac() {
  virsh dumpxml "$VM_NAME" | grep -oP "mac address='\K[0-9a-f:]+" | head -n1
}

vm_ip() {
  local mac; mac="$(vm_mac 2>/dev/null || true)"
  [ -n "$mac" ] || return 1
  virsh net-dhcp-leases "$NET_NAME" 2>/dev/null \
    | awk -v mac="$mac" 'tolower($0) ~ tolower(mac) {print $5}' \
    | sed 's#/.*##' | head -n1
}

wait_for_tcp() {
  local ip="$1" port="$2" timeout="${3:-120}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if timeout 3 bash -c "cat < /dev/null > /dev/tcp/$ip/$port" 2>/dev/null; then
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

ssh_pve() {
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -i "$SSH_KEY" "root@$1" "${@:2}"
}
