# SwitchDex appliance image builder.
#
# Builds a turnkey Ubuntu 24.04 VM with Docker + the SwitchDex stack baked in,
# exporting BOTH an OVA (VMware/VirtualBox) and a qcow2 (KVM/Proxmox).
#
# Build host needs: packer, qemu-system-x86, and (for OVA) the VirtualBox or
# vmware post-processor. Then:  `make build`  (see ../Makefile)
#
# The result boots straight into the app: power on -> browse to https://<ip>.

packer {
  required_plugins {
    qemu = { version = ">= 1.0.0", source = "github.com/hashicorp/qemu" }
  }
}

variable "version"      { default = "1.6.0" }
variable "iso_url"      { default = "https://releases.ubuntu.com/24.04/ubuntu-24.04.4-live-server-amd64.iso" }
variable "iso_checksum" { default = "file:https://releases.ubuntu.com/24.04/SHA256SUMS" }
variable "disk_size"    { default = "40960" }   # 40 GB
variable "memory"       { default = "4096" }    # 4 GB
variable "cpus"         { default = "2" }

source "qemu" "switchdex" {
  iso_url      = var.iso_url
  iso_checksum = var.iso_checksum
  output_directory = "output/qemu"
  vm_name      = "switchdex-${var.version}.qcow2"
  format       = "qcow2"
  disk_size    = var.disk_size
  memory       = var.memory
  cpus         = var.cpus
  accelerator  = "kvm"
  headless     = true

  # Ubuntu autoinstall (cloud-init) served over HTTP to the installer
  http_directory = "http"
  boot_command = [
    "c<wait>",
    "linux /casper/vmlinuz --- autoinstall ds=\"nocloud-net;seedfrom=http://{{.HTTPIP}}:{{.HTTPPort}}/\"<enter><wait>",
    "initrd /casper/initrd<enter><wait>",
    "boot<enter>"
  ]
  boot_wait = "5s"

  ssh_username = "switchdex"
  ssh_password = "switchdex"          # changed/locked by firstboot
  ssh_timeout  = "30m"
  shutdown_command = "echo 'switchdex' | sudo -S shutdown -P now"
}

build {
  sources = ["source.qemu.switchdex"]

  # copy the application stack into the image
  provisioner "file" {
    source      = "../.."           # the switchdex-backend project root
    destination = "/tmp/switchdex"
  }

  provisioner "shell" {
    script          = "provision.sh"
    execute_command = "echo 'switchdex' | sudo -S bash '{{.Path}}'"
  }

  # Export OVA from the qcow2 for VMware/VirtualBox shops
  post-processor "shell-local" {
    inline = [
      "echo 'qcow2 image built at output/qemu/switchdex-${var.version}.qcow2'",
      "bash ./to_ova.sh ${var.version}"
    ]
  }
}
