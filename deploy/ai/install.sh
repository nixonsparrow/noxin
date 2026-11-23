#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# != 4 || $EUID != 0 ]]; then
    echo 'Użycie w LXC: bash install.sh KATALOG_DIST IPv4 CIDR_LAN UŻYTKOWNIK_CADDY' >&2
    exit 1
fi
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
dist=$1 site_ip=$2 lan=$3 username=$4
state=/etc/noxin-ai
app=/opt/noxin-ai
model_name=Qwen3.5-0.8B-Q4_0.gguf
model_sha=57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf
model_url="https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/9447f74101aeb4e93621884dfa36ee8effb8831b/$model_name"

. /etc/os-release
if [[ $ID != debian || $VERSION_ID != 13 || $(systemd-detect-virt --container) != lxc || $(hostname -s) != noxin-ai ]]; then
    echo "Uruchom instalator wewnątrz dedykowanego LXC noxin-ai z Debianem 13." >&2
    exit 1
fi
[[ $(dpkg --print-architecture) == amd64 ]]
[[ $(awk '/^flags[[:space:]]*:/ { print; exit }' /proc/cpuinfo) =~ (^|[[:space:]])sse4_2([[:space:]]|$) ]]
[[ -f $dist/index.html && -d $dist/assets && $username =~ ^[a-zA-Z0-9_.-]+$ ]]
if [[ -e $state/installed ]]; then
    echo "Usługa jest już zainstalowana. Użyj procedury aktualizacji." >&2
    exit 1
fi
if [[ ! -e $state/managed ]] && { [[ -e /etc/caddy/Caddyfile || -e $app ]] || command -v caddy >/dev/null; }; then
    echo "Wykryto istniejące pliki Caddy lub Noxin AI. Wybierz osobny, świeży LXC." >&2
    exit 1
fi

install -d -m 0700 "$state"
touch "$state/managed"
install -d -m 0755 "$app" "$app/app" "$app/models" "$app/site"
systemctl mask caddy.service
apt-get update
apt-get install -y --no-install-recommends build-essential cmake git curl ca-certificates openssl \
    caddy gunicorn python3 poppler-utils libreoffice-writer-nogui ocrmypdf \
    tesseract-ocr-pol tesseract-ocr-eng fonts-dejavu-core

python3 - "$site_ip" "$lan" <<'PY'
from ipaddress import IPv4Address, IPv4Network
import subprocess
import sys

ip, lan = IPv4Address(sys.argv[1]), IPv4Network(sys.argv[2])
ranges = [IPv4Network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]
interfaces = subprocess.check_output(["ip", "-br", "-4", "address"], text=True).split()
if ip not in lan or not any(lan.subnet_of(net) for net in ranges):
    sys.exit("Adres LXC i zaufana podsieć muszą należeć do tej samej prywatnej sieci IPv4.")
if not any(value.split("/", 1)[0] == str(ip) for value in interfaces):
    sys.exit("Podany adres nie należy do kontenera.")
PY

getent group noxin-ai >/dev/null || groupadd --system noxin-ai
for user in noxin-ai noxin-llama noxin-documents; do
    id "$user" >/dev/null 2>&1 || useradd --system --gid noxin-ai --no-create-home --shell /usr/sbin/nologin "$user"
done
usermod -aG noxin-ai caddy

if [[ ! -e $app/llama-server ]]; then
    bash "$source_dir/build-llama.sh" b12244 "$app/llama-server"
fi
model="$app/models/$model_name"
if [[ ! -e $model ]]; then
    curl --fail --location --retry 2 --proto '=https' --proto-redir '=https' --output "$model.part" "$model_url"
    printf '%s  %s\n' "$model_sha" "$model.part" | sha256sum --check
    chmod 0644 "$model.part"
    mv -T -- "$model.part" "$model"
fi
printf '%s  %s\n' "$model_sha" "$model" | sha256sum --check

if [[ ! -e $state/runtime.env ]]; then
    cat > "$state/runtime.env" <<EOF
NOXIN_AI_MODEL=$model
NOXIN_AI_CONTEXT=2048
NOXIN_AI_PUBLIC_WEB=0
EOF
fi
install -m 0644 "$source_dir"/{gateway,documents,public_web}.py "$app/app/"
install -m 0644 "$source_dir"/noxin-ai-*.service /etc/systemd/system/
cp -a -- "$dist/." "$app/site/"
chmod -R a+rX,go-w "$app/site"
systemctl daemon-reload
systemctl enable --now noxin-ai-model.service noxin-ai-documents.service
systemctl enable noxin-ai-gateway.service
systemctl restart noxin-ai-gateway.service
bash "$source_dir/wait-ready.sh"
runuser -u caddy -- curl --fail --silent --compressed \
    --unix-socket /run/noxin-ai-model/http.sock http://localhost/ >/dev/null
curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8090/api/ai/health \
    | python3 -c 'import json,sys; sys.exit(not json.load(sys.stdin)["ready"])'
tesseract --list-langs | grep -Fx eng
tesseract --list-langs | grep -Fx pol

if [[ ! -e /etc/caddy/noxin-agent.caddy ]]; then
    install -o root -g caddy -m 0640 "$source_dir/noxin-agent.caddy" /etc/caddy/
fi
if ! grep -q '^# Managed by Noxin AI$' /etc/caddy/Caddyfile; then
    read -r -s -p "Nowe hasło HTTPS dla $username (12–72 bajtów): " password
    printf '\n'
    read -r -s -p "Powtórz hasło: " confirmation
    printf '\n'
    [[ $password == "$confirmation" ]]
    bytes=$(printf '%s' "$password" | wc -c)
    (( bytes >= 12 && bytes <= 72 ))
    hash=$(printf '%s\n' "$password" | caddy hash-password)
    unset password confirmation
    next=$(mktemp "$state/Caddyfile.XXXXXXXX")
    printf '%s\n' "$hash" | python3 -c '
import sys
from pathlib import Path
template, ip, lan, user = sys.argv[1:]
config = Path(template).read_text()
for key, value in zip(("SITE_IP", "LAN_CIDR", "USER", "PASSWORD_HASH"), (ip, lan, user, input())):
    config = config.replace(f"__{key}__", value)
sys.stdout.write("# Managed by Noxin AI\n" + config)
' "$source_dir/Caddyfile.template" "$site_ip" "$lan" "$username" > "$next"
    unset hash
    caddy validate --config "$next" --adapter caddyfile
    install -o root -g caddy -m 0640 "$next" /etc/caddy/Caddyfile
    rm -- "$next"
fi
systemctl unmask caddy.service
systemctl enable --now caddy.service

ca=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
for _ in {1..15}; do
    if [[ -s $ca ]] &&
        [[ $(curl --silent --max-time 3 --cacert "$ca" -o /dev/null -w '%{http_code}' "https://$site_ip/api/ai/health") == 401 ]] &&
        [[ $(curl --silent --max-time 3 --cacert "$ca" -o /dev/null -w '%{http_code}' "https://$site_ip:8443/") == 401 ]]; then
        touch "$state/installed"
        echo "Noxin https://$site_ip/#/moduly/ai"
        echo "Llama Chat https://$site_ip:8443/"
        openssl x509 -in "$ca" -noout -fingerprint -sha256
        exit 0
    fi
    sleep 1
done
echo "HTTPS lub ochrona hasłem nie przeszły weryfikacji. Sprawdź journalctl -u caddy." >&2
exit 1
