# Testing against Proxmox

`setup-test-vms.sh` builds disposable Debian VMs on a Proxmox node to run
enrollment against for real, instead of only against whatever hardware you
have plugged in. It clones two VMs from a cloud-init template — one on
`systemd-networkd`, one flipped to `ifupdown` — so both branches of
`install.sh`'s networking logic get exercised, and snapshots each right
after boot so you can reset instead of rebuilding.

## Prerequisites

- Run on the Proxmox node itself, as root (it shells out to `qm`).
- A storage (`local-lvm` by default) and a bridge (`vmbr0`) with DHCP
  reachable from wherever the hub runs.
- Outbound internet on the node, to fetch the Debian cloud image (cached in
  `.cache/` after first run).

## Usage

```bash
./setup-test-vms.sh up        # template (once) + two test VMs
./setup-test-vms.sh status    # vmid, backend, state, IP, snapshots
./setup-test-vms.sh ssh 9001  # root shell on a test VM
./setup-test-vms.sh reset     # roll VMs back to their clean snapshot
./setup-test-vms.sh destroy   # stop + remove test VMs (keeps the template)
```

Point the hub's **New remote** dialog at a VM's IP, or curl the `/i/<code>`
one-liner from inside it. `reset` + re-enroll the same host entry is how to
exercise the key-mismatch path.

## Caveats

- Disk naming after `qm importdisk` assumes LVM/LVM-thin storage
  (`vm-<vmid>-disk-0`). File-backed storages may suffix it — adjust
  `qm set --scsi0` if it fails.
- Clones are full clones (`--full`); drop that flag for faster `up` on
  storage that supports linked clones (ZFS, LVM-thin, qcow2-on-dir).

## Config

Env vars, e.g. `MEMORY_MB=4096 ./setup-test-vms.sh up`:

| Variable | Default | |
| --- | --- | --- |
| `STORAGE` | `local-lvm` | VM disk + cloud-init drive storage |
| `BRIDGE` | `vmbr0` | network bridge |
| `TEMPLATE_VMID` | `9000` | shared cloud-init template |
| `HOMEDASH_TEST_VMS` | 9001 (systemd-networkd), 9002 (ifupdown) | `vmid:name:backend`, space-separated |
| `MEMORY_MB` / `CORES` / `DISK_SIZE` | `2048` / `2` / `8G` | test VM sizing |
| `DEBIAN_IMAGE_URL` | Debian 12 genericcloud qcow2 | source image |
