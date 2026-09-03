# Virtualizing Proxmox itself, on this host

[`test/proxmox/`](../proxmox/) tests homedash's enrollment flow against a
Proxmox node — but it expects one to already exist. This directory builds
that node as a nested VM on whatever machine you're developing on, so you
don't need second hardware to run the whole loop.

Three layers, outer to inner:

```
this host (L0) --nested KVM--> Proxmox VE (L1) --KVM--> Debian test VMs (L2)
```

`up.sh` here builds L1. Once it's up, you SSH into it and run
[`../proxmox/setup-test-vms.sh`](../proxmox/setup-test-vms.sh) — unmodified —
exactly as you would against real hardware, to build L2.

## Prerequisites

- A CPU with virtualization extensions and **nested virtualization enabled**
  (Proxmox itself needs to run VMs, i.e. needs `/dev/kvm` inside a VM).
  `./setup-host.sh` checks this and tells you the fix if it's off.
- Docker, usable by your user (`docker info` without sudo). It's only used to
  build `proxmox-auto-install-assistant` (see below) — Proxmox's own VMs
  don't run in it.
- Comfortably 12GB+ free RAM and ~80GB disk for the default sizing (Proxmox
  itself plus two 8GB Debian test VMs inside it).

Run once, with sudo:

```bash
./setup-host.sh   # installs qemu/KVM + libvirt, adds you to the libvirt/kvm groups
# log out and back in (or `newgrp libvirt`) for group membership to apply
```

## Usage

```bash
./up.sh up        # builds the Proxmox VM (10-20 min, unattended)
./up.sh status     # IP, state, snapshots, and any leases (incl. nested test VMs)
./up.sh ssh          # root shell on the Proxmox node
./up.sh reset       # revert Proxmox to just-installed (drops anything built inside it)
./up.sh destroy    # stop + remove the Proxmox VM (keeps the network + cached ISO)
```

After `up`, it prints the node's IP, root password (also saved to
`$HOME/homedash-lab/root-password`), and the web UI URL. From there:

```bash
ssh -i ~/homedash-lab/ssh/id_ed25519 root@<ip>
/root/homedash-test/setup-test-vms.sh up      # builds the L2 Debian test VMs
```

Point the homedash hub's **New remote** dialog at one of those L2 IPs — the
hub can reach them directly, because they're bridged through Proxmox's own
`vmbr0` onto the same libvirt network Proxmox itself is on.

## How the unattended install works

Proxmox supports baking an `answer.toml` into its ISO so the installer runs
with zero prompts (network, disk, root password all pre-filled), via a tool
called `proxmox-auto-install-assistant`. That tool is only published as a
package against Proxmox's own apt repo, so rather than add that repo to this
host, `build-autoinstall-iso.sh` builds a small throwaway Debian container
that has it (`docker/Dockerfile`) and runs the ISO preparation inside that —
the host's own package set is never touched.

`up.sh` boots the resulting ISO in a VM with `--cpu host-passthrough` (so
Proxmox sees real virtualization extensions and can run its own VMs) and
`--boot hd,cdrom` (so the *second* boot, after install, comes from the disk
instead of looping back into the installer).

## If this breaks

The Proxmox ISO version, the answer-file schema, and `proxmox-auto-install-assistant`'s
packaging are all Proxmox-version-pinned and can drift. If `build-autoinstall-iso.sh`
starts failing:

- Check `download.proxmox.com/iso/` for the current filename and update
  `PVE_ISO_URL` in [`lib.sh`](lib.sh).
- Check https://pve.proxmox.com/wiki/Automated_Installation for schema changes.
- As a fallback, comment out the `--cdrom "$LAB_DIR/autoinstall.iso"` /
  autoinstall path in `up.sh`, point `--cdrom` at the plain downloaded ISO
  instead, drop `--noautoconsole`, and click through Proxmox's normal
  installer once via `virt-viewer --connect qemu:///system homedash-pve`.
  Everything after that (snapshotting, the handoff to `setup-test-vms.sh`)
  works the same either way.

## Config

Environment variables, all optional — see [`lib.sh`](lib.sh) for the full list
and defaults. The ones you're most likely to touch:

| Variable | Default | |
| --- | --- | --- |
| `HOMEDASH_LAB_DIR` | `~/homedash-lab` | ISO cache, disk image, generated SSH key, root password |
| `PVE_ISO_URL` | Proxmox VE 9.2-1 | source ISO |
| `VM_MEMORY_MB` / `VM_VCPUS` / `VM_DISK_GB` | `8192` / `6` / `64` | sizing for the Proxmox VM itself |
| `NET_CIDR` / `NET_GATEWAY` | `10.20.30.0/24` / `.1` | the libvirt NAT network Proxmox (and its nested VMs) live on |
