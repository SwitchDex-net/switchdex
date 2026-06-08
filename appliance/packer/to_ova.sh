#!/usr/bin/env bash
# Convert the Packer qcow2 output into a distributable OVA (VMware/VirtualBox).
# Requires: qemu-img and VirtualBox (VBoxManage). Run from appliance/packer/.
set -euo pipefail
VERSION="${1:-2.0.2}"
QCOW="output/qemu/switchdex-${VERSION}.qcow2"
VMDK="output/switchdex-${VERSION}.vmdk"
OVA="output/switchdex-${VERSION}.ova"
VM="switchdex-export-${VERSION}"

echo "==> Converting qcow2 -> vmdk"
qemu-img convert -O vmdk "$QCOW" "$VMDK"

echo "==> Registering a temporary VM and attaching disk"
VBoxManage createvm --name "$VM" --ostype Ubuntu_64 --register
VBoxManage modifyvm "$VM" --memory 2048 --cpus 2 --nic1 nat
VBoxManage storagectl "$VM" --name SATA --add sata --controller IntelAhci
VBoxManage storageattach "$VM" --storagectl SATA --port 0 --device 0 --type hdd --medium "$VMDK"

echo "==> Exporting OVA"
VBoxManage export "$VM" --output "$OVA" \
  --vsys 0 --product "SwitchDex" --vendor "SwitchDex" --version "$VERSION"

echo "==> Cleaning up temporary VM"
VBoxManage unregistervm "$VM" --delete

echo "==> Done:"
echo "    qcow2 (KVM/Proxmox): $QCOW"
echo "    OVA   (VMware/VBox): $OVA"
