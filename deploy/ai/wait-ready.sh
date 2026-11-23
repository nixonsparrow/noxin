#!/usr/bin/env bash
set -euo pipefail
for _ in {1..60}; do
    if curl --silent --fail --max-time 2 --unix-socket /run/noxin-ai-gateway/http.sock \
        http://localhost/api/ai/health | python3 -c 'import json,sys; sys.exit(not json.load(sys.stdin)["ready"])' 2>/dev/null; then
        echo "Model i API Noxin odpowiadają."
        exit 0
    fi
    sleep 2
done
systemctl --no-pager status noxin-ai-model noxin-ai-gateway || true
exit 1
