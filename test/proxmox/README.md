# Testing against Proxmox

`setup-test-vms.sh` gives you disposable Debian VMs on a Proxmox node to run
the real enrollment flow against — `install.sh`, the SSH executor, and the
heartbeat sweep — instead of testing only against whatever hardware you
happen to have plugged in.

It builds one cloud-init template (Debian 12 "genericcloud"), then clones two
test VMs from it: one left as-is (`systemd-networkd`, the default on that
image) and one flipped to `ifupdown` (the default on a stock Debian netinst),
so both branches of `install.sh`'s networking logic actually get exercised.
Each test VM gets a `clean` snapshot right after first boot, so you can
re-run enrollment over and over without rebuilding VMs by hand.

This lives outside `server/` and `web/` on purpose — it's test scaffolding
for homedash, not something that ships to an enrolled remote.

## Prerequisites

- Run the script **on the Proxmox node itself, as root** (it shells out to
  `qm`). Copy the `test/proxmox/` directory over, or clone the repo there.
- A storage (`local-lvm` by default) that can hold VM disks, and a bridge
  (`vmbr0` by default) that hands out DHCP leases reachable from wherever
  the homedash hub runs. If your homelab bridge doesn't do DHCP, edit
  `ipconfig0=ip=dhcp` in the script to a static config instead.
- Outbound internet access on the node, to fetch the Debian cloud image
  (~400MB, cached in `test/proxmox/.cache/` after the first run).
- `qemu-guest-agent` support (the template enables it) so the script can
  read VM IPs back — this is why it uses cloud images rather than the
  netinst ISO.

## Usage

```bash
./setup-test-vms.sh up        # build the template (once) + two test VMs
./setup-test-vms.sh status    # vmid, backend, state, IP, snapshots
./setup-test-vms.sh ssh 9001  # root shell on a test VM
./setup-test-vms.sh reset     # roll every test VM back to its clean snapshot
./setup-test-vms.sh destroy   # stop + remove the test VMs (keeps the template)
```

A throwaway SSH keypair is generated into `test/proxmox/.ssh/` on first run —
that's how the script reaches into the VMs to flip one to `ifupdown` and to
detect when they're back up after a reset. It's unrelated to the hub's own
control key in `data/ssh/`.

## Typical loop

1. `./setup-test-vms.sh up`, then `./setup-test-vms.sh status` for IPs.
2. Point the hub's **New remote** dialog at one of those IPs, or curl the
   `/i/<code>` one-liner from inside the VM (`./setup-test-vms.sh ssh 9001`).
3. Watch enrollment happen for real: account creation, IP pinning, Docker
   install, the facts callback, and — once joined — the heartbeat sweep.
4. `./setup-test-vms.sh reset` to wipe that VM back to a fresh, unenrolled
   state and try again (a config tweak, a different scenario, a retry after
   a bug fix).

To specifically test the key-mismatch path, `reset` a VM and re-enroll it
under the *same* host entry in the panel — the hub should see a new SSH host
key at the same address and surface it as a mismatch rather than trusting it.

## Caveats

- The disk name the script attaches after `qm importdisk`
  (`$STORAGE:vm-$TEMPLATE_VMID-disk-0`) matches how LVM/LVM-thin storages
  name imported disks. File-backed storages (plain `dir`, some NFS setups)
  may suffix it (e.g. `.qcow2`) — if `qm set --scsi0` fails, check what
  `qm importdisk` actually printed and adjust.
- Test VMs are full clones (`qm clone --full`), which works on any storage
  but is slower than a linked clone. If your storage supports linked clones
  (ZFS, LVM-thin, qcow2-on-dir), drop `--full` in `ensure_test_vm` for
  faster `up` runs — snapshots and rollback work the same either way.

## Config

Everything is an environment variable, e.g. `MEMORY_MB=4096 ./setup-test-vms.sh up`:

| Variable | Default | |
| --- | --- | --- |
| `STORAGE` | `local-lvm` | where VM disks and the cloud-init drive live |
| `BRIDGE` | `vmbr0` | network bridge the VMs attach to |
| `TEMPLATE_VMID` | `9000` | the shared cloud-init template |
| `HOMEDASH_TEST_VMS` | two VMs, 9001 (systemd-networkd) + 9002 (ifupdown) | `vmid:name:backend` entries, space-separated |
| `MEMORY_MB` / `CORES` / `DISK_SIZE` | `2048` / `2` / `8G` | test VM sizing |
| `DEBIAN_IMAGE_URL` | Debian 12 genericcloud qcow2 | swap for another Debian release if needed |
