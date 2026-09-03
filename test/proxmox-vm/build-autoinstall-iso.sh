#!/usr/bin/env bash
#
# Produces a Proxmox VE ISO that installs itself with no interaction, using
# Proxmox's own answer-file autoinstall feature. Called by up.sh; safe to
# call directly to rebuild the ISO (e.g. after changing config below).
#
# The one external moving part is proxmox-auto-install-assistant, which
# Proxmox only ships as a package against its own apt repo. Rather than add
# that repo to this host, we build a small Debian container that has it and
# run the ISO preparation inside that (see docker/Dockerfile).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"

say "Preparing the autoinstall ISO"

mkdir -p "$LAB_DIR"

# ---------------------------------------------------------------- source ISO --

SRC_ISO="$LAB_DIR/$(basename "$PVE_ISO_URL")"
if [ ! -f "$SRC_ISO" ]; then
  say "Downloading $PVE_ISO_URL (a few GB — cached afterwards in $LAB_DIR)"
  curl -fL# "$PVE_ISO_URL" -o "$SRC_ISO.part"
  mv "$SRC_ISO.part" "$SRC_ISO"
else
  say "Using cached ISO: $SRC_ISO"
fi

# --------------------------------------------------------------- password ---

if [ ! -f "$ROOT_PASSWORD_FILE" ]; then
  say "Generating a root password for the Proxmox VM"
  openssl rand -hex 12 > "$ROOT_PASSWORD_FILE"
  chmod 600 "$ROOT_PASSWORD_FILE"
fi
ROOT_PASSWORD="$(cat "$ROOT_PASSWORD_FILE")"

# --------------------------------------------------------------- answer.toml --

cat > "$LAB_DIR/answer.toml" <<TOML
[global]
keyboard = "$PVE_KEYBOARD"
country = "$PVE_COUNTRY"
fqdn = "$PVE_FQDN"
mailto = "$PVE_MAILTO"
timezone = "$PVE_TIMEZONE"
root-password = "$ROOT_PASSWORD"
reboot-on-error = true

[network]
source = "from-dhcp"

[disk-setup]
filesystem = "ext4"
disk-list = ["vda"]
TOML

# ------------------------------------------------------------ helper image --

if ! docker image inspect "$ISO_TOOL_IMAGE" >/dev/null 2>&1; then
  say "Building the ISO-prep helper image (one-time)"
  docker build -t "$ISO_TOOL_IMAGE" "$HERE/docker"
fi

say "Validating answer.toml"
docker run --rm -v "$LAB_DIR:/work" "$ISO_TOOL_IMAGE" \
  validate-answer /work/answer.toml \
  || warn "Could not validate (subcommand may differ by version) — continuing to prepare-iso, which will fail loudly if the file is actually bad."

say "Baking the answer file into the ISO"
rm -f "$LAB_DIR/autoinstall.iso"
docker run --rm -v "$LAB_DIR:/work" "$ISO_TOOL_IMAGE" \
  prepare-iso "/work/$(basename "$SRC_ISO")" \
  --fetch-from iso \
  --answer-file /work/answer.toml \
  --output /work/autoinstall.iso

say "Autoinstall ISO ready: $LAB_DIR/autoinstall.iso"
say "Generated root password saved to $ROOT_PASSWORD_FILE"
