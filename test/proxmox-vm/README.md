# Virtualizing Proxmox itself, on this host

Builds the Proxmox node that [`test/proxmox/`](../proxmox/) expects, as a
nested VM on your dev machine — no second hardware needed.

```
this host (L0) --nested KVM--> Proxmox VE (L1) --KVM--> Debian test VMs (L2)
```

`up.sh` builds L1 and copies `setup-test-vms.sh` onto it; you SSH in and run
that, unmodified, to build L2.

## Prerequisites

- Virtualization extensions with nested virt enabled (`setup-host.sh` checks
  this and prints the fix).
- Docker usable without sudo — used only to build `proxmox-auto-install-assistant`
  (see below); Proxmox's own VMs don't run in it.
- ~12GB+ free RAM, ~80GB disk (default sizing: Proxmox + two 8GB test VMs).

```bash
./setup-host.sh   # once, with sudo: installs qemu/KVM + libvirt, adds you to those groups
# log out/in (or `newgrp libvirt`) for group membership to apply
```

## Usage

```bash
./up.sh up        # builds the Proxmox VM, unattended (10-20 min)
./up.sh status     # IP, state, snapshots, leases (incl. nested test VMs)
./up.sh ssh          # root shell on the Proxmox node
./up.sh reset       # revert to just-installed (drops anything built inside it)
./up.sh destroy    # stop + remove the VM (keeps the network + cached ISO)
```

`up` prints the node's IP, web UI URL, and root password (also saved to
`$HOME/.homedash/root-password`). Then:

```bash
ssh -i ~/.homedash/ssh/id_ed25519 root@<ip>
/root/homedash-test/setup-test-vms.sh up      # builds the L2 Debian test VMs
```

The hub can reach those L2 VMs directly — they're bridged through Proxmox's
`vmbr0` onto the same libvirt network Proxmox itself is on.

## How it works / if it breaks

Proxmox's zero-prompt install bakes an `answer.toml` into the ISO via
`proxmox-auto-install-assistant`, which only ships as a package against
Proxmox's own apt repo — so it's built in a throwaway Debian container
(`docker/Dockerfile`) instead of touching this host's package set. `up.sh`
boots that ISO with `--cpu host-passthrough` (so Proxmox can run its own VMs)
and `--boot hd,cdrom` (so the reboot after install lands on disk, not back in
the installer).

The ISO version and answer-file schema are Proxmox-version-pinned and can
drift. If `build-autoinstall-iso.sh` fails: check `download.proxmox.com/iso/`
for the current filename (update `PVE_ISO_URL` in `lib.sh`), or
https://pve.proxmox.com/wiki/Automated_Installation for schema changes. As a
fallback, point `--cdrom` in `up.sh` at the plain ISO, drop `--noautoconsole`,
and click through the installer once via
`virt-viewer --connect qemu:///system homedash-pve` — everything after
install (snapshot, handoff) works the same either way.

## Config

Env vars — see [`lib.sh`](lib.sh) for the full list:

| Variable | Default | |
| --- | --- | --- |
| `HOMEDASH_LAB_DIR` | `~/.homedash` | ISO cache, disk image, SSH key, root password |
| `PVE_ISO_URL` | Proxmox VE 9.2-1 | source ISO |
| `VM_MEMORY_MB` / `VM_VCPUS` / `VM_DISK_GB` | `8192` / `6` / `64` | Proxmox VM sizing |
| `NET_CIDR` / `NET_GATEWAY` | `10.20.30.0/24` / `.1` | libvirt network Proxmox + its nested VMs share |
