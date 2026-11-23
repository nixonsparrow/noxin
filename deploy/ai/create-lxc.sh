#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 5 || $EUID != 0 ]]; then
    echo 'Użycie na hoście Proxmox jako root: bash create-lxc.sh ID SZABLON STORAGE IPv4/CIDR BRAMA' >&2
    exit 1
fi
vmid=$1 template=$2 storage=$3 address=$4 gateway=$5
bridge=vmbr0
cores=4
memory=${NOXIN_LXC_MEMORY_MIB:-5120}
swap=1024
disk=${NOXIN_LXC_DISK_GIB:-20}

[[ $vmid =~ ^[1-9][0-9]{2,8}$ && $memory =~ ^[1-9][0-9]{3,4}$ && $disk =~ ^[1-9][0-9]$ ]]
[[ $storage =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]
[[ $template =~ ^[a-zA-Z0-9_.-]+:vztmpl/debian-13-standard_[a-zA-Z0-9_.+-]+_amd64\.tar\.(zst|gz|xz)$ ]]
python3 - "$address" "$gateway" <<'PY'
from ipaddress import IPv4Interface, IPv4Address
import sys
address, gateway = IPv4Interface(sys.argv[1]), IPv4Address(sys.argv[2])
if gateway not in address.network or gateway in {
    address.ip, address.network.network_address, address.network.broadcast_address
} or address.ip in {address.network.network_address, address.network.broadcast_address}:
    sys.exit("Podaj adres LXC i odrębną bramę w tej samej podsieci IPv4.")
PY
ip link show "$bridge" >/dev/null
[[ $(nproc) -ge $cores ]] || { echo "Host ma mniej niż 4 dostępne rdzenie." >&2; exit 1; }
if ! pvesh get /cluster/nextid --vmid "$vmid" >/dev/null; then
    echo "Identyfikator $vmid jest zajęty lub niedostępny." >&2
    exit 1
fi
[[ -r $(pvesm path "$template") ]] || { echo "Brak lokalnego szablonu Debian 13." >&2; exit 1; }
available=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)
if (( available < memory + 768 )); then
    echo "Host ma ${available} MiB dostępnej RAM. Potrzeba limitu LXC i 768 MiB rezerwy." >&2
    exit 1
fi
available_disk=$(pvesm status --storage "$storage" --content rootdir | awk -v name="$storage" '$1 == name && $3 == "active" {print $6}')
if [[ ! $available_disk =~ ^[0-9]+$ ]] || (( available_disk < (disk + 2) * 1024 * 1024 )); then
    echo "Składowisko rootdir musi być aktywne i mieć ${disk} GiB plus 2 GiB zapasu." >&2
    exit 1
fi

pct create "$vmid" "$template" +    --hostname noxin-ai --ostype debian --unprivileged 1 --onboot 1 +    --cores "$cores" --memory "$memory" --swap "$swap" --rootfs "$storage:$disk" +    --net0 "name=eth0,bridge=$bridge,ip=$address,gw=$gateway,type=veth"
pct start "$vmid"
pct config "$vmid"
