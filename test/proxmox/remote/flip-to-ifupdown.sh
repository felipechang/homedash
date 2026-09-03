#!/usr/bin/env bash
#
# Run on a freshly-booted Debian genericcloud VM (which ships with
# systemd-networkd) to make it look like a stock Debian netinst box instead
# (which uses ifupdown). Exists so setup-test-vms.sh can give install.sh both
# network backends to exercise, without hand-building a second cloud image.
#
# Not part of the homedash product — test scaffolding only.

set -euo pipefail

IFACE="$(ip -4 route show default | awk '{print $5; exit}')"
[ -n "$IFACE" ] || { echo "could not determine the default interface" >&2; exit 1; }

apt-get update -qq
apt-get install -y -qq ifupdown

systemctl disable --now systemd-networkd systemd-networkd-wait-online 2>/dev/null || true
rm -f /etc/systemd/network/*.network

cat > /etc/network/interfaces <<EOF
auto lo
iface lo inet loopback

auto $IFACE
iface $IFACE inet dhcp
EOF

echo "flipped $IFACE to ifupdown; rebooting"
reboot
