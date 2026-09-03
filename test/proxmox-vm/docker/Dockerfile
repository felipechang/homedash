# Builds a throwaway image that carries proxmox-auto-install-assistant, the
# tool Proxmox ships for baking an answer.toml into a PVE ISO so it installs
# with zero interaction. It's only published as a Debian package against
# Proxmox's own repo, so it's built here instead of on the host, to avoid
# adding a foreign apt repo (and its dependency chain) to the host machine.
#
# Not part of homedash — test scaffolding for the Proxmox-in-a-VM path.
FROM debian:trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates wget gnupg xorriso \
  && wget -qO /usr/share/keyrings/proxmox-archive-keyring.gpg \
       https://enterprise.proxmox.com/debian/proxmox-archive-keyring-trixie.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/proxmox-archive-keyring.gpg] http://download.proxmox.com/debian/pve trixie pve-no-subscription" \
       > /etc/apt/sources.list.d/pve.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends proxmox-auto-install-assistant \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work
ENTRYPOINT ["proxmox-auto-install-assistant"]
