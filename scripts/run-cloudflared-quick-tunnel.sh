#!/usr/bin/env bash
# Quick Try tunnel (no Cloudflare account) — README Step 6.
# Persisted via systemd user service (requires user linger if you want it at boot without login).
# Streams cloudflared logs; when Cloudflare prints a *.trycloudflare.com URL, writes:
#   - .tunnel-url (repo root, for /health etc.)
#   - BACKEND_PUBLIC_URL=... in .env (if present) for copy/paste convenience
#
# Quick hostnames rotate when cloudflared restarts; use a Cloudflare named tunnel for a stable URL.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${CLOUDFLARED_LOCAL_PORT:-3002}"
TUNNEL_FILE="$REPO_ROOT/.tunnel-url"
ENV_FILE="$REPO_ROOT/.env"

persist_tunnel_url() {
  local u="$1"
  [[ -z "$u" ]] && return 0
  printf '%s\n' "$u" >"$TUNNEL_FILE"
  [[ ! -f "$ENV_FILE" ]] && return 0

  local tmp
  tmp="$(mktemp)"
  local found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^BACKEND_PUBLIC_URL= ]]; then
      printf '%s\n' "BACKEND_PUBLIC_URL=${u}"
      found=1
    else
      printf '%s\n' "$line"
    fi
  done <"$ENV_FILE" >"$tmp"
  [[ "$found" -eq 0 ]] && printf '\nBACKEND_PUBLIC_URL=%s\n' "$u" >>"$tmp"
  mv "$tmp" "$ENV_FILE"
}

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "r1-discord-kit: install cloudflared and ensure it is on PATH." >&2
  echo "  Linuxbrew: brew install cloudflare/cloudflare/cloudflared" >&2
  echo "  Docs: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/" >&2
  exit 1
fi

if ! command -v stdbuf >/dev/null 2>&1; then
  exec cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}"
fi

coproc CLOUDPIPE { stdbuf -oL -eL cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" 2>&1; }
CLOUD_PID=$!

while IFS= read -r line <&"${CLOUDPIPE[0]}"; do
  printf '%s\n' "$line"
  [[ "$line" == *trycloudflare.com* ]] || continue
  u="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' <<<"$line" | head -n1 || true)"
  [[ -n "${u:-}" ]] && persist_tunnel_url "$u" || true
done

wait "$CLOUD_PID"
exit_code=$?

exit "$exit_code"
