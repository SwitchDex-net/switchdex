#!/usr/bin/env bash
# SwitchDex first-boot NETWORK setup wizard.
#
# Runs on the VM console before the app starts. Production-first: it defaults to
# the STATIC path so the appliance lands on the right management network/VLAN
# from the very first boot. DHCP is offered as an explicit opt-out.
#
# Writes a netplan file and applies it, then hands off to the app firstboot.
set -uo pipefail

MARKER=/opt/switchdex/.netcfg-done
NETPLAN=/etc/netplan/99-switchdex.yaml
[ -f "$MARKER" ] && exit 0

# Primary physical NIC (first non-loopback ethernet)
IFACE=$(ls /sys/class/net | grep -vE '^(lo|docker|veth|br-)' | head -n1)
IFACE=${IFACE:-eth0}

valid_ip()   { [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
valid_cidr() { [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]]; }

clear
cat <<'BANNER'
 ┌────────────────────────────────────────────────────────┐
 │              SwitchDex — Network Setup                  │
 ├────────────────────────────────────────────────────────┤
 │ This appliance manages your network, so a STATIC address │
 │ is strongly recommended for production.                  │
 └────────────────────────────────────────────────────────┘
BANNER
echo "  Detected interface: $IFACE"
echo
echo "  1) Static IP   (recommended — default)"
echo "  2) DHCP        (evaluation only)"
echo
read -r -t 120 -p "  Choice [1]: " CHOICE || CHOICE=1
CHOICE=${CHOICE:-1}

write_dhcp() {
  cat > "$NETPLAN" <<EOF
network:
  version: 2
  ethernets:
    ${IFACE}:
      dhcp4: true
EOF
}

write_static() {
  local addr=$1 gw=$2 dns=$3 vlanid=$4
  if [ -n "$vlanid" ]; then
    # Tagged subinterface for trunk-port topologies
    cat > "$NETPLAN" <<EOF
network:
  version: 2
  ethernets:
    ${IFACE}:
      dhcp4: false
  vlans:
    ${IFACE}.${vlanid}:
      id: ${vlanid}
      link: ${IFACE}
      addresses: [${addr}]
      routes:
        - to: default
          via: ${gw}
      nameservers:
        addresses: [${dns}]
EOF
  else
    cat > "$NETPLAN" <<EOF
network:
  version: 2
  ethernets:
    ${IFACE}:
      dhcp4: false
      addresses: [${addr}]
      routes:
        - to: default
          via: ${gw}
      nameservers:
        addresses: [${dns}]
EOF
  fi
}

if [ "$CHOICE" = "2" ]; then
  echo "  → Configuring DHCP..."
  write_dhcp
else
  echo
  echo "  Enter static network details (CIDR form, e.g. 10.20.0.50/24):"
  while true; do
    read -r -p "    IP address/prefix : " ADDR
    valid_cidr "$ADDR" && break || echo "    ! Use CIDR form, e.g. 10.20.0.50/24"
  done
  while true; do
    read -r -p "    Default gateway   : " GW
    valid_ip "$GW" && break || echo "    ! Invalid IP"
  done
  read -r -p "    DNS server [1.1.1.1] : " DNS; DNS=${DNS:-1.1.1.1}
  read -r -p "    Management VLAN ID (blank if untagged/access port) : " VLANID
  if [ -n "$VLANID" ] && ! [[ $VLANID =~ ^[0-9]+$ ]]; then VLANID=""; fi
  echo "  → Applying static configuration..."
  write_static "$ADDR" "$GW" "$DNS" "$VLANID"
fi

chmod 600 "$NETPLAN"
netplan apply 2>/dev/null || netplan generate

touch "$MARKER"
echo
echo "  Network configured. Continuing boot..."
sleep 2
