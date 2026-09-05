#!/usr/bin/env bash
#
# Stands up Proxmox VMs to test homedash's enrollment flow against, so
# install.sh, facts.sh and the heartbeat sweep can be exercised against real
# Debian boxes instead of hand-picked hardware.
#
# Run this ON the Proxmox node, as root. It is not part of the homedash app;
# it just gives you disposable Debian VMs plus a "clean" snapshot to roll
# back to, so re-running enrollment doesn't mean rebuilding a VM by hand.
#
# Usage:
#   ./setup-test-vms.sh up        create the template (once) and the test VMs
#   ./setup-test-vms.sh status    show state/IP/snapshots for the test VMs
#   ./setup-test-vms.sh reset     roll every test VM back to its clean snapshot
#   ./setup-test-vms.sh ssh <vmid>  ssh into one test VM as root
#   ./setup-test-vms.sh destroy   stop and remove the test VMs (keeps the template)
#
# Config is via environment variables, all optional (defaults below).

set -euo pipefail

# ---------------------------------------------------------------- config ---

STORAGE="${STORAGE:-local-lvm}"          # where VM disks live
BRIDGE="${BRIDGE:-vmbr0}"                # network bridge; must hand out DHCP
                                          # leases reachable from the hub
TEMPLATE_VMID="${TEMPLATE_VMID:-9000}"
MEMORY_MB="${MEMORY_MB:-2048}"
CORES="${CORES:-2}"
DISK_SIZE="${DISK_SIZE:-8G}"

DEBIAN_IMAGE_URL="${DEBIAN_IMAGE_URL:-https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DIR="$HERE/.cache"
SSH_DIR="$HERE/.ssh"
SSH_KEY="$SSH_DIR/id_ed25519"

# vmid:hostname:network-backend — one VM per backend install.sh supports, so
# both branches of its networking logic actually get run in anger.
HOMEDASH_TEST_VMS="${HOMEDASH_TEST_VMS:-9001:homedash-test-networkd:systemd-networkd 9002:homedash-test-ifupdown:ifupdown}"

# ------------------------------------------------------------------ util ---

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" -eq 0 ] || die "Run this as root on the Proxmox node."
}

require_pve() {
  command -v qm >/dev/null 2>&1 || die "qm not found — this must run on a Proxmox node."
}

ensure_ssh_key() {
  if [ ! -f "$SSH_KEY" ]; then
    say "Generating a throwaway SSH key for reaching test VMs ($SSH_KEY)"
    mkdir -p "$SSH_DIR"
    chmod 700 "$SSH_DIR"
    ssh-keygen -t ed25519 -N "" -C "homedash-proxmox-test" -f "$SSH_KEY" >/dev/null
  fi
}

vm_exists() { qm status "$1" >/dev/null 2>&1; }

wait_for_ip() {
  local vmid="$1" timeout="${2:-180}" waited=0 ip=""
  say "Waiting for $vmid to report an IP via the guest agent..."
  while [ "$waited" -lt "$timeout" ]; do
    ip="$(qm guest cmd "$vmid" network-get-interfaces 2>/dev/null \
      | grep -oP '"ip-address"\s*:\s*"\K[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
      | grep -v '^127\.' | head -n1 || true)"
    [ -n "$ip" ] && { echo "$ip"; return 0; }
    sleep 5
    waited=$((waited + 5))
  done
  die "$vmid never reported an IP within ${timeout}s (guest agent not running yet, or no DHCP on $BRIDGE?)."
}

wait_for_ssh() {
  local ip="$1" timeout="${2:-120}" waited=0
  say "Waiting for SSH on $ip..."
  while [ "$waited" -lt "$timeout" ]; do
    if timeout 3 bash -c "cat < /dev/null > /dev/tcp/$ip/22" 2>/dev/null; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  die "SSH on $ip never came up within ${timeout}s."
}

ssh_vm() {
  local ip="$1"; shift
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -i "$SSH_KEY" "root@$ip" "$@"
}

scp_to_vm() {
  local ip="$1" src="$2" dst="$3"
  scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -i "$SSH_KEY" "$src" "root@$ip:$dst"
}

# --------------------------------------------------------------- template --

ensure_guest_agent_snippet() {
  # Debian's genericcloud image doesn't ship qemu-guest-agent, so `qm guest
  # cmd` (which wait_for_ip / cmd_status / cmd_ssh all depend on) never works
  # without this, regardless of networking. Snippets need a storage with the
  # 'snippets' content type; 'local' doesn't have it by default.
  if ! pvesm status -storage local -content snippets >/dev/null 2>&1; then
    local existing; existing="$(awk '/^dir: local$/{f=1} f&&/content/{print $2; exit}' /etc/pve/storage.cfg)"
    pvesm set local --content "${existing:+$existing,}snippets"
  fi

  SNIPPET_PATH="local:snippets/homedash-test-cloudinit.yaml"
  mkdir -p /var/lib/vz/snippets
  cat > /var/lib/vz/snippets/homedash-test-cloudinit.yaml <<'EOF'
#cloud-config
packages:
  - qemu-guest-agent
runcmd:
  - systemctl enable --now qemu-guest-agent
EOF
}

ensure_template() {
  if vm_exists "$TEMPLATE_VMID"; then
    say "Template $TEMPLATE_VMID already exists, skipping."
    return
  fi

  mkdir -p "$CACHE_DIR"
  local image="$CACHE_DIR/$(basename "$DEBIAN_IMAGE_URL")"
  if [ ! -f "$image" ]; then
    say "Downloading Debian cloud image..."
    curl -fsSL "$DEBIAN_IMAGE_URL" -o "$image.part"
    mv "$image.part" "$image"
  fi

  ensure_guest_agent_snippet

  say "Building template $TEMPLATE_VMID"
  qm create "$TEMPLATE_VMID" \
    --name homedash-test-template \
    --memory "$MEMORY_MB" --cores "$CORES" \
    --net0 "virtio,bridge=$BRIDGE" \
    --serial0 socket --vga serial0 \
    --agent enabled=1 \
    --scsihw virtio-scsi-pci

  qm importdisk "$TEMPLATE_VMID" "$image" "$STORAGE" --format qcow2
  qm set "$TEMPLATE_VMID" --scsi0 "$STORAGE:vm-$TEMPLATE_VMID-disk-0"
  qm set "$TEMPLATE_VMID" --ide2 "$STORAGE:cloudinit"
  qm set "$TEMPLATE_VMID" --boot order=scsi0
  qm resize "$TEMPLATE_VMID" scsi0 "$DISK_SIZE"

  qm set "$TEMPLATE_VMID" --ciuser root --sshkeys "$SSH_KEY.pub" --ipconfig0 ip=dhcp --cicustom "user=$SNIPPET_PATH"
  qm template "$TEMPLATE_VMID"
  say "Template $TEMPLATE_VMID ready."
}

# --------------------------------------------------------------- test vms --

ensure_test_vm() {
  local vmid="$1" name="$2" backend="$3"

  if vm_exists "$vmid"; then
    say "$vmid ($name) already exists, skipping create."
    return
  fi

  say "Cloning $name ($vmid) from template $TEMPLATE_VMID"
  qm clone "$TEMPLATE_VMID" "$vmid" --name "$name" --full
  qm set "$vmid" --memory "$MEMORY_MB" --cores "$CORES"
  qm set "$vmid" --ciuser root --sshkeys "$SSH_KEY.pub" --ipconfig0 ip=dhcp
  qm cloudinit update "$vmid" 2>/dev/null || true

  qm start "$vmid"
  local ip; ip="$(wait_for_ip "$vmid")"
  # cloud-init's package install (qemu-guest-agent) runs before the final
  # stage on first boot, and sshd here waits on network-online.target, so
  # under nested virtualization first boot can take several minutes longer
  # than a normal boot before sshd actually answers.
  wait_for_ssh "$ip" 600

  if [ "$backend" = "ifupdown" ]; then
    say "$name: switching to ifupdown so install.sh's other branch gets tested"
    scp_to_vm "$ip" "$HERE/remote/flip-to-ifupdown.sh" /root/flip-to-ifupdown.sh
    ssh_vm "$ip" "chmod +x /root/flip-to-ifupdown.sh && /root/flip-to-ifupdown.sh" || true
    # the VM reboots itself at the end of that script
    sleep 5
    ip="$(wait_for_ip "$vmid")"
    wait_for_ssh "$ip" 300
  fi

  say "$name is up at $ip (backend: $backend)"
  say "Snapshotting $name as 'clean' so you can reset after each enrollment test"
  qm snapshot "$vmid" clean --description "post-boot, pre-enrollment"
}

for_each_test_vm() {
  local fn="$1"
  for entry in $HOMEDASH_TEST_VMS; do
    IFS=: read -r vmid name backend <<<"$entry"
    "$fn" "$vmid" "$name" "$backend"
  done
}

cmd_up() {
  require_root; require_pve; ensure_ssh_key
  ensure_template
  for_each_test_vm ensure_test_vm
  echo
  say "Done. Point homedash's 'New remote' dialog at these VMs' IPs (see 'status')."
  say "The hub must be reachable from $BRIDGE, and these VMs must be reachable from the hub."
}

cmd_status() {
  require_pve
  print_status() {
    local vmid="$1" name="$2" backend="$3"
    local state; state="$(qm status "$vmid" 2>/dev/null | awk '{print $2}')" || state="missing"
    local ip="-"
    if [ "$state" = "running" ]; then
      ip="$(qm guest cmd "$vmid" network-get-interfaces 2>/dev/null \
        | grep -oP '"ip-address"\s*:\s*"\K[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
        | grep -v '^127\.' | head -n1 || echo "?")"
    fi
    printf '%-6s %-28s %-10s %-9s %-15s snapshots: %s\n' \
      "$vmid" "$name" "$backend" "$state" "$ip" \
      "$(qm listsnapshot "$vmid" 2>/dev/null | awk '{print $2}' | tr '\n' ',' )"
  }
  for_each_test_vm print_status
}

cmd_reset() {
  require_root; require_pve
  reset_one() {
    local vmid="$1" name="$2" backend="$3"
    say "Resetting $name ($vmid) to its clean snapshot"
    qm stop "$vmid" >/dev/null 2>&1 || true
    while [ "$(qm status "$vmid" | awk '{print $2}')" != "stopped" ]; do sleep 2; done
    qm rollback "$vmid" clean
    qm start "$vmid"
    local ip; ip="$(wait_for_ip "$vmid")"
    say "$name back to clean at $ip"
  }
  for_each_test_vm reset_one
}

cmd_destroy() {
  require_root; require_pve
  destroy_one() {
    local vmid="$1" name="$2" backend="$3"
    if ! vm_exists "$vmid"; then return; fi
    say "Destroying $name ($vmid)"
    qm stop "$vmid" >/dev/null 2>&1 || true
    while [ "$(qm status "$vmid" | awk '{print $2}')" != "stopped" ]; do sleep 2; done
    qm destroy "$vmid" --purge
  }
  for_each_test_vm destroy_one
  warn "Template $TEMPLATE_VMID was left in place; remove it yourself with 'qm destroy $TEMPLATE_VMID' if you're done."
}

cmd_ssh() {
  require_pve
  local target_vmid="${1:-}"
  [ -n "$target_vmid" ] || die "Usage: $0 ssh <vmid>"
  local ip; ip="$(qm guest cmd "$target_vmid" network-get-interfaces 2>/dev/null \
    | grep -oP '"ip-address"\s*:\s*"\K[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
    | grep -v '^127\.' | head -n1)"
  [ -n "$ip" ] || die "Could not find an IP for $target_vmid — is it running?"
  ssh_vm "$ip"
}

# ------------------------------------------------------------------ main ---

case "${1:-up}" in
  up)      cmd_up ;;
  status)  cmd_status ;;
  reset)   cmd_reset ;;
  destroy) cmd_destroy ;;
  ssh)     shift; cmd_ssh "$@" ;;
  *)       die "Usage: $0 {up|status|reset|destroy|ssh <vmid>}" ;;
esac
