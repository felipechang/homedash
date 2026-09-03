#!/usr/bin/env bash
#
# One-time host prep for running a virtualized Proxmox VE node on THIS
# machine, so test/proxmox/setup-test-vms.sh has a Proxmox to run on without
# needing real second hardware.
#
# Run with sudo, once. Installs qemu/KVM + libvirt, and adds your user to the
# libvirt/kvm groups (log out and back in — or `newgrp libvirt` in the
# current shell — for that part to take effect).

set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo." >&2; exit 1; }

TARGET_USER="${SUDO_USER:-$(logname)}"

echo "==> Installing qemu/KVM + libvirt"
apt-get update
apt-get install -y \
  qemu-system-x86 qemu-utils \
  libvirt-daemon-system libvirt-clients \
  virtinst bridge-utils sshpass acl

echo "==> Enabling libvirtd"
systemctl enable --now libvirtd

echo "==> Adding $TARGET_USER to the libvirt and kvm groups"
usermod -aG libvirt,kvm "$TARGET_USER"

if [ ! -e /dev/kvm ]; then
  echo "!! /dev/kvm does not exist — is virtualization (VT-x/AMD-V) enabled?" >&2
elif ! grep -q '^1$' /sys/module/kvm_intel/parameters/nested 2>/dev/null \
   && ! grep -q '^1$' /sys/module/kvm_amd/parameters/nested 2>/dev/null; then
  echo "!! Nested virtualization does not look enabled — Proxmox's own VMs need it." >&2
  echo "   Intel: echo 'options kvm_intel nested=1' > /etc/modprobe.d/kvm-nested.conf" >&2
  echo "   AMD:   echo 'options kvm_amd nested=1'   > /etc/modprobe.d/kvm-nested.conf" >&2
  echo "   then reload the module (or reboot)." >&2
fi

echo
echo "Done. Log out and back in (or run 'newgrp libvirt') so group membership"
echo "takes effect, then run ./up.sh."
