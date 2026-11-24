#!/usr/bin/env bash
set -euo pipefail
umask 077

agent_only=false
upgrade_model=false
if [[ $# == 1 ]]; then
    case $1 in
        --agent-only) agent_only=true ;;
        --upgrade-model) upgrade_model=true ;;
    esac
fi
if [[ $EUID != 0 ]] || { ! "$agent_only" && ! "$upgrade_model" && [[ $# != 4 ]]; }; then
    echo 'Użycie jako root: bash install.sh --agent-only' >&2
    echo 'Zmiana modelu: bash install.sh --upgrade-model' >&2
    echo 'Świeży LXC: bash install.sh KATALOG_DIST IPv4 CIDR_LAN UŻYTKOWNIK_CADDY' >&2
    exit 1
fi
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
state=/etc/noxin-ai
app=/opt/noxin-ai
model_name=Qwen3.5-0.8B-Q4_0.gguf
model_sha=57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf
model_url="https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/9447f74101aeb4e93621884dfa36ee8effb8831b/$model_name"

. /etc/os-release
if [[ $ID != debian || $VERSION_ID != 13 || $(systemd-detect-virt --container) != lxc ]]; then
    echo "Uruchom instalator wewnątrz LXC z Debianem 13." >&2
    exit 1
fi
[[ $(dpkg --print-architecture) == amd64 ]]
[[ $(awk '/^flags[[:space:]]*:/ { print; exit }' /proc/cpuinfo) =~ (^|[[:space:]])sse4_2([[:space:]]|$) ]]

ensure_model() {
    local path=$1 url=$2 sha=$3
    if [[ -e $path ]]; then
        printf '%s  %s\n' "$sha" "$path" | sha256sum --check
    else
        curl --fail --location --retry 2 --proto '=https' --proto-redir '=https' --output "$path.part" "$url"
        printf '%s  %s\n' "$sha" "$path.part" | sha256sum --check
        chmod 0644 "$path.part"
        mv -T -- "$path.part" "$path"
    fi
}

if "$upgrade_model"; then
    runtime="$state/runtime.env"
    if [[ ! -e $state/managed || ! -f $runtime || ! -x $app/llama-server || ! -d $app/models ]]; then
        echo "Najpierw zainstaluj Agenta AI w tym kontenerze." >&2
        exit 1
    fi

    exec 9>"$state/model-upgrade.lock"
    flock 9
    model="$app/models/Qwen3.5-2B-Q4_K_M.gguf"
    ensure_model "$model" \
        'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/802854bfd388ed92748de119df31327962811548/Qwen3.5-2B-Q4_K_M.gguf' \
        'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223'

    next=$(mktemp "$state/runtime.env.XXXXXXXX")
    awk '! /^[[:space:]]*NOXIN_AI_(MODEL|CONTEXT)[[:space:]]*=/' "$runtime" > "$next"
    printf 'NOXIN_AI_MODEL=%s\nNOXIN_AI_CONTEXT=4096\n' "$model" >> "$next"
    if cmp -s "$runtime" "$next"; then
        rm -- "$next"
        bash "$source_dir/wait-ready.sh"
        exit 0
    fi

    backup=$(mktemp "$state/runtime.env.previous.XXXXXXXX")
    cp -- "$runtime" "$backup"
    mv -T -- "$next" "$runtime"
    if systemctl restart noxin-ai-model.service noxin-ai-gateway.service && bash "$source_dir/wait-ready.sh"; then
        printf 'Aktywny model Qwen3.5 2B. Kopia poprzedniej konfiguracji: %s\n' "$backup"
        exit 0
    fi

    mv -T -- "$backup" "$runtime"
    echo "Test nowego modelu nie przeszedł. Przywrócono poprzednią konfigurację." >&2
    systemctl restart noxin-ai-model.service noxin-ai-gateway.service
    bash "$source_dir/wait-ready.sh"
    exit 1
fi

if [[ ! -e $state/managed && -e $app ]]; then
    echo "Wykryto istniejący, niezarządzany katalog $app." >&2
    exit 1
fi
packages=(
    build-essential cmake git curl ca-certificates gunicorn python3 poppler-utils
    libreoffice-writer-nogui ocrmypdf tesseract-ocr-pol tesseract-ocr-eng fonts-dejavu-core
)
if ! "$agent_only"; then
    dist=$1 site_ip=$2 lan=$3 username=$4
    if [[ $(hostname -s) != noxin-ai ]]; then
        echo "Pełna instalacja wymaga dedykowanego LXC noxin-ai. Dla działającego Noxin użyj --agent-only." >&2
        exit 1
    fi
    [[ -f $dist/index.html && -d $dist/assets && $username =~ ^[a-zA-Z0-9_.-]+$ ]]
    if [[ -e $state/installed ]]; then
        echo "Usługa jest już zainstalowana. Użyj procedury aktualizacji." >&2
        exit 1
    fi
    if [[ ! -e $state/manages-caddy ]] && { [[ -e /etc/caddy/Caddyfile ]] || command -v caddy >/dev/null; }; then
        echo "Wykryto istniejącą instalację Caddy. Użyj --agent-only." >&2
        exit 1
    fi
    packages+=(caddy openssl)
fi

install -d -m 0700 "$state"
touch "$state/managed"
if ! "$agent_only"; then
    touch "$state/manages-caddy"
    systemctl mask caddy.service
fi
install -d -m 0755 "$app" "$app/app" "$app/models"
apt-get update
apt-get install -y --no-install-recommends "${packages[@]}"

if ! "$agent_only"; then
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
fi

getent group noxin-ai >/dev/null || groupadd --system noxin-ai
for user in noxin-ai noxin-llama noxin-documents; do
    id "$user" >/dev/null 2>&1 || useradd --system --gid noxin-ai --no-create-home --shell /usr/sbin/nologin "$user"
done

if [[ ! -e $app/llama-server ]]; then
    bash "$source_dir/build-llama.sh" b12244 "$app/llama-server"
fi
model="$app/models/$model_name"
ensure_model "$model" "$model_url" "$model_sha"

if [[ ! -e $state/runtime.env ]]; then
    cat > "$state/runtime.env" <<EOF
NOXIN_AI_MODEL=$model
NOXIN_AI_CONTEXT=2048
NOXIN_AI_PUBLIC_WEB=0
EOF
fi
install -m 0644 "$source_dir"/{gateway,documents,public_web}.py "$app/app/"
install -m 0644 "$source_dir"/noxin-ai-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now noxin-ai-model.service noxin-ai-documents.service
systemctl enable noxin-ai-gateway.service
systemctl restart noxin-ai-gateway.service
bash "$source_dir/wait-ready.sh"
curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8090/api/ai/health \
    | python3 -c 'import json,sys; sys.exit(not json.load(sys.stdin)["ready"])'
tesseract --list-langs | grep -Fx eng
tesseract --list-langs | grep -Fx pol

if "$agent_only"; then
    echo "Agent AI jest gotowy pod http://127.0.0.1:8090/api/ai/health."
    exit 0
fi

usermod -aG noxin-ai caddy
runuser -u caddy -- curl --fail --silent --compressed --unix-socket /run/noxin-ai-model/http.sock http://localhost/ >/dev/null
install -d -m 0755 "$app/site"
cp -a -- "$dist/." "$app/site/"
chmod -R a+rX,go-w "$app/site"

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
