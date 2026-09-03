#!/usr/bin/env bash
#
# Boots a virtualized Proxmox VE node on this machine via nested KVM, fully
# unattended (see build-autoinstall-iso.sh), so test/proxmox/setup-test-vms.sh
# has a Proxmox to run against without needing real second hardware.
#
# Layers, outer to inner:
#   this host (L0)  -- nested KVM -->  Proxmox VE (L1)  -- KVM -->  Debian
#   test VMs (L2), created by test/proxmox/setup-test-vms.sh run *inside* L1.
#
# Run ./setup-host.sh once first. Then:
#   ./up.sh up        create the libvirt network + Proxmox VM (idempotent)
#   ./up.sh status     VM state, IP, and any leases on the lab network
#   ./up.sh reset       snapshot-revert Proxmox back to just-installed
#   ./up.sh ssh          root shell on the Proxmox node
#   ./up.sh destroy    stop + remove the VM (keeps the network + cached ISO)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"

require virsh
require virt-install
require qemu-img

ensure_network() {
  if virsh net-info "$NET_NAME" >/dev/null 2>&1; then
    return
  fi
  say "Creating libvirt network $NET_NAME ($NET_CIDR)"
  local xml; xml="$(mktemp)"
  cat > "$xml" <<EOF
<network>
  <name>$NET_NAME</name>
  <forward mode='nat'/>
  <bridge name='$NET_BRIDGE' stp='on' delay='0'/>
  <ip address='$NET_GATEWAY' netmask='255.255.255.0'>
    <dhcp>
      <range start='$NET_DHCP_START' end='$NET_DHCP_END'/>
    </dhcp>
  </ip>
</network>
EOF
  virsh net-define "$xml"
  virsh net-autostart "$NET_NAME"
  virsh net-start "$NET_NAME"
  rm -f "$xml"
}

cmd_up() {
  require docker
  docker info >/dev/null 2>&1 || die "docker isn't usable by $(whoami) — add yourself to the docker group and re-login."
  ensure_ssh_key
  ensure_network
  mkdir -p "$LAB_DIR"

  if virsh dominfo "$VM_NAME" >/dev/null 2>&1; then
    say "$VM_NAME already exists, skipping creation."
  else
    "$HERE/build-autoinstall-iso.sh"

    say "Creating disk ($VM_DISK_GB G)"
    qemu-img create -f qcow2 "$VM_DISK" "${VM_DISK_GB}G"

    say "Defining and starting $VM_NAME (installs unattended, then reboots itself)"
    virt-install \
      --name "$VM_NAME" \
      --memory "$VM_MEMORY_MB" --vcpus "$VM_VCPUS" \
      --cpu host-passthrough \
      --virt-type kvm \
      --disk "path=$VM_DISK,bus=virtio,format=qcow2" \
      --cdrom "$LAB_DIR/autoinstall.iso" \
      --boot hd,cdrom,menu=off \
      --network "network=$NET_NAME,model=virtio" \
      --graphics vnc,listen=127.0.0.1 \
      --osinfo detect=off,require=off \
      --noautoconsole

    say "Waiting for the install to finish and Proxmox to come up (this can take 10-20 min)..."
    local ip="" waited=0 timeout=2400
    while [ -z "$ip" ] && [ "$waited" -lt "$timeout" ]; do
      ip="$(vm_ip || true)"
      [ -n "$ip" ] || { sleep 15; waited=$((waited + 15)); }
    done
    [ -n "$ip" ] || die "$VM_NAME never got a DHCP lease on $NET_NAME within ${timeout}s. Check with: virt-viewer --connect qemu:///system $VM_NAME"

    wait_for_tcp "$ip" 22 600 || die "SSH on $ip never came up. The install may have failed — check: virt-viewer --connect qemu:///system $VM_NAME"
    wait_for_tcp "$ip" 8006 300 || warn "Port 8006 (web UI) isn't answering yet on $ip — give it another minute."

    say "Authorizing our SSH key on the Proxmox node ($ip)"
    sshpass -p "$(cat "$ROOT_PASSWORD_FILE")" ssh-copy-id \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
      -i "$SSH_KEY.pub" "root@$ip" >/dev/null

    say "Snapshotting $VM_NAME as 'clean' (freshly installed, nothing enrolled yet)"
    virsh snapshot-create-as "$VM_NAME" clean "freshly installed Proxmox, before any hosts enrolled" >/dev/null

    say "Copying test/proxmox/ (the enrollment test-VM script) onto the node"
    ssh_pve "$ip" "mkdir -p /root/homedash-test/remote"
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i "$SSH_KEY" \
      "$HERE/../proxmox/setup-test-vms.sh" "root@$ip:/root/homedash-test/setup-test-vms.sh"
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i "$SSH_KEY" \
      "$HERE/../proxmox/remote/flip-to-ifupdown.sh" "root@$ip:/root/homedash-test/remote/flip-to-ifupdown.sh"
    ssh_pve "$ip" "chmod +x /root/homedash-test/setup-test-vms.sh /root/homedash-test/remote/flip-to-ifupdown.sh"
  fi

  echo
  local ip; ip="$(vm_ip || true)"
  say "Proxmox is up${ip:+ at $ip} — https://${ip:-<pending>}:8006, user root, password in $ROOT_PASSWORD_FILE"
  say "SSH in with: ssh -i $SSH_KEY root@${ip:-<pending>}"
  say "Then run:    /root/homedash-test/setup-test-vms.sh up"
  say "That builds the two Debian enrollment test VMs *inside* this virtualized Proxmox node, same as against real hardware."
}

cmd_status() {
  if ! virsh dominfo "$VM_NAME" >/dev/null 2>&1; then
    echo "$VM_NAME does not exist yet — run '$0 up'."
    return
  fi
  virsh dominfo "$VM_NAME" | grep -E '^(Name|State)'
  local ip; ip="$(vm_ip || true)"
  echo "IP: ${ip:-<none yet>}"
  echo "Snapshots:"
  virsh snapshot-list "$VM_NAME" 2>/dev/null || true
  echo
  echo "All leases on $NET_NAME (Proxmox + anything it's running inside):"
  virsh net-dhcp-leases "$NET_NAME" 2>/dev/null || true
}

cmd_reset() {
  virsh dominfo "$VM_NAME" >/dev/null 2>&1 || die "$VM_NAME does not exist."
  say "Reverting $VM_NAME to its 'clean' snapshot (this also discards any test VMs created inside it)"
  virsh snapshot-revert "$VM_NAME" clean --running
  say "Waiting for it to come back up..."
  local ip="" waited=0
  while [ -z "$ip" ] && [ "$waited" -lt 300 ]; do
    ip="$(vm_ip || true)"
    [ -n "$ip" ] || { sleep 5; waited=$((waited + 5)); }
  done
  say "Back at ${ip:-<pending>}"
}

cmd_destroy() {
  if ! virsh dominfo "$VM_NAME" >/dev/null 2>&1; then
    say "$VM_NAME does not exist, nothing to do."
    return
  fi
  say "Destroying $VM_NAME"
  virsh destroy "$VM_NAME" >/dev/null 2>&1 || true
  virsh undefine "$VM_NAME" --snapshots-metadata >/dev/null
  rm -f "$VM_DISK"
  warn "Network $NET_NAME and the cached ISO/root password in $LAB_DIR were left in place."
}

cmd_ssh() {
  local ip; ip="$(vm_ip || true)"
  [ -n "$ip" ] || die "$VM_NAME has no known IP — is it running? ('$0 status')"
  ssh_pve "$ip"
}

case "${1:-up}" in
  up)      cmd_up ;;
  status)  cmd_status ;;
  reset)   cmd_reset ;;
  destroy) cmd_destroy ;;
  ssh)     cmd_ssh ;;
  *)       die "Usage: $0 {up|status|reset|ssh|destroy}" ;;
esac
