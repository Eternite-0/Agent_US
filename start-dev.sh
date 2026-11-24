#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
VAR_DIR="${BACKEND_DATA:-$BACKEND_DIR/var}"
TOKEN_FILE="$VAR_DIR/.dev-token"

mkdir -p "$VAR_DIR"

if [ -n "${BACKEND_TOKEN:-}" ] && [ "${#BACKEND_TOKEN}" -ge 24 ]; then
  TOKEN="$BACKEND_TOKEN"
elif [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d '\r\n[:space:]' < "$TOKEN_FILE")"
  if [ "${#TOKEN}" -lt 24 ]; then
    TOKEN="$(node -e "import('node:crypto').then(c => process.stdout.write(c.randomBytes(32).toString('hex')))")"
    printf '%s' "$TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE" 2>/dev/null || true
  fi
else
  TOKEN="$(node -e "import('node:crypto').then(c => process.stdout.write(c.randomBytes(32).toString('hex')))")"
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE" 2>/dev/null || true
fi

PORT="${PORT:-8787}"
BACKEND_URL="http://127.0.0.1:$PORT"

export BACKEND_TOKEN="$TOKEN"
export BACKEND_DATA="$VAR_DIR"
export PORT="$PORT"
export BACKEND_URL="$BACKEND_URL"

CONFIG_FILE="$VAR_DIR/config.json"
if [ -z "${BACKEND_CONFIG:-}" ] && [ -f "$CONFIG_FILE" ]; then
  export BACKEND_CONFIG="$CONFIG_FILE"
fi

PROVIDER_ENV_FILE="$VAR_DIR/.provider-env.json"
if [ -f "$PROVIDER_ENV_FILE" ]; then
  while IFS= read -r -d '' env_key && IFS= read -r -d '' env_val; do
    export "$env_key=$env_val"
  done < <(
    node -e "
      import('node:fs').then(({ readFileSync }) => {
        try {
          const parsed = JSON.parse(readFileSync(process.argv[1], 'utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
          for (const [k, v] of Object.entries(parsed)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
            if (v === null || v === undefined) continue;
            if (process.env[k]) continue;
            process.stdout.write(k + '\0' + String(v) + '\0');
          }
        } catch {}
      });
    " "$PROVIDER_ENV_FILE"
  )
fi

BACKEND_PID=""
FRONTEND_PID=""
CLEANED_UP=0

cleanup() {
  if [ "$CLEANED_UP" -eq 1 ]; then
    return
  fi
  CLEANED_UP=1

  if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
    wait "$FRONTEND_PID" 2>/dev/null || true
  fi

  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "[Agent_US] Stopping backend (PID $BACKEND_PID) ..."
    kill "$BACKEND_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        break
      fi
      sleep 0.1 2>/dev/null || sleep 1
    done
    if kill -0 "$BACKEND_PID" 2>/dev/null; then
      kill -9 "$BACKEND_PID" 2>/dev/null || true
    fi
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}

on_signal() {
  local sig="$1"
  cleanup
  if [ "$sig" = "INT" ]; then
    exit 130
  fi
  exit 143
}

trap cleanup EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

echo "[Agent_US] Starting backend on $BACKEND_URL ..."
(
  cd "$BACKEND_DIR"
  exec node src/main.js
) &
BACKEND_PID=$!

READY=0
for _ in $(seq 1 30); do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "[Agent_US] Backend process exited prematurely." >&2
    exit 1
  fi
  if node -e "
    fetch(process.argv[1], { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => process.exit(j && j.ok === true ? 0 : 1))
      .catch(() => process.exit(1));
  " "$BACKEND_URL/health" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 0.3 2>/dev/null || sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "[Agent_US] Backend failed to become healthy at $BACKEND_URL/health" >&2
  exit 1
fi

echo "[Agent_US] Backend healthy! Starting frontend on http://127.0.0.1:5173 (proxied -> $BACKEND_URL) ..."
(
  cd "$FRONTEND_DIR"
  exec npm run dev
) &
FRONTEND_PID=$!
wait "$FRONTEND_PID"
