# SwitchDex appliance build.
#
#   make build     -> produces output/switchdex-<ver>.qcow2 and .ova
#   make clean     -> removes build artifacts
#
# Build host requirements: packer, qemu (kvm), virtualbox (for OVA export).

VERSION ?= 1.0.0

build:
	cd packer && packer init . && packer build -var "version=$(VERSION)" switchdex.pkr.hcl

validate:
	cd packer && packer validate -var "version=$(VERSION)" switchdex.pkr.hcl

clean:
	rm -rf packer/output

.PHONY: build validate clean
