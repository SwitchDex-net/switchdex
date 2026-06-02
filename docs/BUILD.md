# Building the appliance image (OVA + qcow2)

Produces a turnkey VM image from this project. Run on a Linux build host.

## Build-host requirements

| Tool | Purpose | Ubuntu/Debian install |
|---|---|---|
| Packer | drives the build | see https://developer.hashicorp.com/packer/install |
| QEMU/KVM | builds the qcow2 | `sudo apt install qemu-system-x86 qemu-utils cpu-checker` |
| VirtualBox | exports the OVA | `sudo apt install virtualbox` |

The build boots a real VM to install Ubuntu unattended, so the host needs
working KVM:

```bash
kvm-ok          # expect: "KVM acceleration can be used"
ls /dev/kvm     # must exist
```

If the build host is itself a VM (cloud instance, ESXi/Proxmox guest), enable
**nested virtualization** on it first, or the build will be very slow / fail.

You also need ~15 GB free disk on the build host and outbound internet (to pull
the Ubuntu ISO and Docker images).

## Build

```bash
cd appliance
make validate                 # optional: sanity-check the template
make build VERSION=1.0.0      # produces both images (15-40 min)
```

Outputs:
```
packer/output/qemu/switchdex-1.0.0.qcow2   ← Proxmox / KVM
packer/output/switchdex-1.0.0.ova          ← VMware / VirtualBox
```

## If the ISO link is dead

`appliance/packer/switchdex.pkr.hcl` pins the Ubuntu 24.04 point release in
`iso_url`. Ubuntu periodically supersedes point releases and removes the old
file. If the build fails on the ISO download, check the current filename at
https://releases.ubuntu.com/24.04/ and update `iso_url` to match (the
`iso_checksum` uses `file:.../SHA256SUMS`, so it auto-resolves once the URL is
right).

## qcow2 only (skip the OVA / VirtualBox dependency)

If you only deploy to Proxmox/KVM you don't need VirtualBox. Build the qcow2
and skip the export by removing (or commenting out) the `post-processor
"shell-local"` block in `switchdex.pkr.hcl`, then `make build`.

## Smoke-test the image before shipping

```bash
# boot the qcow2 locally and watch the console
qemu-system-x86_64 -enable-kvm -m 4096 -smp 2 \
  -drive file=packer/output/qemu/switchdex-1.0.0.qcow2,format=qcow2 \
  -nic user,hostfwd=tcp::8443-:443
```

You should see the network-setup wizard on the console. Choose DHCP for this
local test, let it finish, then browse to `https://localhost:8443`.
