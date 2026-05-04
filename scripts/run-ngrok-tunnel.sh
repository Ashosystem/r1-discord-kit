#!/usr/bin/env bash
# ngrok HTTP tunnel — exposes local Discord API to HTTPS for R1 / Netlify.
# Requires: `ngrok config add-authtoken <token>` once (https://dashboard.ngrok.com/get-started/your-authtoken).
# Polls the local agent API (127.0.0.1:4040) and writes:
#   - .tunnel-url (repo root, for /health and /auto-backend.json)
#   - BACKEND_PUBLIC_URL=... in .env (if present)
#
# Optional: set NGROK_DOMAIN (hostname only) so ngrok uses a stable endpoint (ngrok v3: `--url https://…`).
# Random subdomain: leave NGROK_DOMAIN unset.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${NGROK_LOCAL_PORT:-3002}"
TUNNEL_FILE="$REPO_ROOT/.tunnel-url"
ENV_FILE="$REPO_ROOT/.env"

# Read NGROK_DOMAIN from .env if not already exported (systemd typically does not load .env).
load_ngrok_domain_from_dotenv() {
  [[ -n "${NGROK_DOMAIN:-}" ]] && return 0
  [[ ! -f "$ENV_FILE" ]] && return 0
  local line
  line="$(grep -E '^[[:space:]]*NGROK_DOMAIN=' "$ENV_FILE" | tail -1)" || return 0
  [[ -z "$line" ]] && return 0
  NGROK_DOMAIN="${line#NGROK_DOMAIN=}"
  NGROK_DOMAIN="${NGROK_DOMAIN#"${NGROK_DOMAIN%%[![:space:]]*}"}"
  NGROK_DOMAIN="${NGROK_DOMAIN%"${NGROK_DOMAIN##*[![:space:]]}"}"
  NGROK_DOMAIN="${NGROK_DOMAIN#\"}"
  NGROK_DOMAIN="${NGROK_DOMAIN%\"}"
  NGROK_DOMAIN="${NGROK_DOMAIN#\'}"
  NGROK_DOMAIN="${NGROK_DOMAIN%\'}"
  export NGROK_DOMAIN
}

load_ngrok_domain_from_dotenv

load_ngrok_authtoken_from_dotenv() {
  [[ -n "${NGROK_AUTHTOKEN:-}" ]] && return 0
  [[ ! -f "$ENV_FILE" ]] && return 0
  local line
  line="$(grep -E '^[[:space:]]*NGROK_AUTHTOKEN=' "$ENV_FILE" | tail -1)" || return 0
  [[ -z "$line" ]] && return 0
  NGROK_AUTHTOKEN="${line#NGROK_AUTHTOKEN=}"
  NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN#"${NGROK_AUTHTOKEN%%[![:space:]]*}"}"
  NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN%"${NGROK_AUTHTOKEN##*[![:space:]]}"}"
  NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN#\"}"
  NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN%\"}"
  NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN#\'}"
  NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN%\'}"
  [[ -z "$NGROK_AUTHTOKEN" ]] && return 0
  export NGROK_AUTHTOKEN
}

load_ngrok_authtoken_from_dotenv

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

https_public_url_from_ngrok_api() {
  local raw j
  raw="$(curl -fsS http://127.0.0.1:4040/api/tunnels 2>/dev/null)" || return 1
  j="$(printf '%s' "$raw" | tr -d '\r')"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; d=json.loads(sys.stdin.read()); ts=d.get('tunnels') or []; print(next((t['public_url'] for t in ts if t.get('proto')=='https'), ''))" <<<"$j" 2>/dev/null
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    node -e "const d=JSON.parse(process.argv[1]); const t=(d.tunnels||[]).find(x=>x.proto==='https'); console.log(t?t.public_url:'');" "$j" 2>/dev/null
    return 0
  fi
  echo "r1-discord-kit: install python3 or node to parse ngrok's /api/tunnels JSON." >&2
  return 1
}

if ! command -v ngrok >/dev/null 2>&1; then
  echo "r1-discord-kit: install ngrok and add your authtoken:" >&2
  echo "  https://ngrok.com/download" >&2
  echo "  ngrok config add-authtoken <token>" >&2
  exit 1
fi

if [[ -z "${NGROK_AUTHTOKEN:-}" ]] && ! ngrok config check >/dev/null 2>&1; then
  echo "r1-discord-kit: add your ngrok authtoken — either put NGROK_AUTHTOKEN in .env or run:" >&2
  echo "  ngrok config add-authtoken <token>   # https://dashboard.ngrok.com/get-started/your-authtoken" >&2
  exit 1
fi

ngrok_args=(http "127.0.0.1:${PORT}" --log=stdout)
if [[ -n "${NGROK_DOMAIN:-}" ]]; then
  ngrok_args+=(--url="https://${NGROK_DOMAIN}")
fi

ngrok "${ngrok_args[@]}" &
NGROK_PID=$!

u=""
stable_url=""
[[ -n "${NGROK_DOMAIN:-}" ]] && stable_url="https://${NGROK_DOMAIN}"

for _ in $(seq 1 90); do
  u="$(https_public_url_from_ngrok_api || true)"
  [[ -n "${u:-}" ]] && break
  sleep 1
done

if [[ -n "${u:-}" ]]; then
  persist_tunnel_url "$u"
  printf 'r1-discord-kit: ngrok public URL -> %s\n' "$u"
elif [[ -n "${stable_url:-}" ]]; then
  persist_tunnel_url "$stable_url"
  printf 'r1-discord-kit: ngrok public URL (from NGROK_DOMAIN) -> %s\n' "$stable_url"
else
  echo "r1-discord-kit: warning: could not read HTTPS URL from ngrok (http://127.0.0.1:4040)." >&2
fi

wait "$NGROK_PID"
exit_code=$?
exit "$exit_code"
