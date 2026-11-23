#!/usr/bin/env bash
set -euo pipefail

for command in pveversion pvesm pct qm pvesh; do
    command -v "$command" >/dev/null || { echo "Uruchom ten audyt na hoście Proxmox VE." >&2; exit 1; }
done

echo "Wersja Proxmox VE"
pveversion
echo "Procesor i obciążenie"
lscpu
uptime
echo "Pamięć i swap"
free -m
echo "Dyski i systemy plików"
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS
df -hT
echo "Składowiska Proxmox"
pvesm status
echo "Kontenery i maszyny wirtualne"
pct list
qm list
echo "Limity i użycie zasobów przez gości"
pvesh get /cluster/resources --type vm --output-format json-pretty
echo "Sieć hosta"
ip -br -4 address
ip -4 route show default
ip -d link show vmbr0
