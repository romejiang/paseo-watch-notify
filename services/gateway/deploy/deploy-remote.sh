#!/usr/bin/env bash
#
# Deploy the Paseo Watch Notify gateway to a remote host and run it under PM2.
#
#   ./deploy-remote.sh
#   SSH_HOST=root@1.2.3.4 REMOTE_DIR=/srv/paseo-notify NODE_BIN=/usr/bin/node ./deploy-remote.sh
#
# Requirements:
#   - local:  bash, rsync, npm
#   - remote: Node.js >= 20 and PM2 (already installed), plus your own reverse proxy
#
# The service has zero runtime dependencies, so we build locally and ship `dist/` only.
# Non-interactive SSH has no nvm PATH, so node/pm2 are addressed by absolute path.

set -euo pipefail

SSH_HOST="${SSH_HOST:-yang}"
REMOTE_DIR="${REMOTE_DIR:-/root/paseo-notify-gateway}"
APP_NAME="${APP_NAME:-paseo-notify-gateway}"

# Absolute paths avoid the missing PATH in non-interactive SSH. Override if your layout differs.
NODE_BIN="${NODE_BIN:-/root/.nvm/versions/node/v20.20.2/bin/node}"
PM2_BIN="${PM2_BIN:-/root/.nvm/versions/node/v20.20.2/bin/pm2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "==> target ${SSH_HOST}:${REMOTE_DIR}  (pm2 app ${APP_NAME})"
echo "==> node ${NODE_BIN}"

echo "==> building locally"
cd "${GATEWAY_DIR}"
npm ci --ignore-scripts
npm run build

echo "==> syncing dist/ and templates"
ssh "${SSH_HOST}" "mkdir -p '${REMOTE_DIR}/dist' '${REMOTE_DIR}/secrets'"
rsync -az --delete "${GATEWAY_DIR}/dist/" "${SSH_HOST}:${REMOTE_DIR}/dist/"
rsync -az "${GATEWAY_DIR}/package.json" "${SSH_HOST}:${REMOTE_DIR}/package.json"
rsync -az "${SCRIPT_DIR}/gateway.env.example" "${SSH_HOST}:${REMOTE_DIR}/gateway.env.example"

echo "==> preparing and (re)starting on the remote host"
ssh "${SSH_HOST}" \
  "REMOTE_DIR='${REMOTE_DIR}' APP_NAME='${APP_NAME}' NODE_BIN='${NODE_BIN}' PM2_BIN='${PM2_BIN}' bash -s" <<'REMOTE'
set -euo pipefail

cd "${REMOTE_DIR}"
# Make node and pm2 resolvable inside this non-interactive session.
export PATH="$(dirname "${NODE_BIN}"):${PATH}"

if [ ! -x "${NODE_BIN}" ]; then
  echo "!! node not found at ${NODE_BIN}. Set NODE_BIN=... and re-run." >&2
  exit 5
fi

node_major="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]')"
if [ "${node_major}" -lt 20 ]; then
  echo "!! Node.js ${node_major} found; >= 20 is required." >&2
  exit 5
fi
echo "node $("${NODE_BIN}" -v) | pm2 $("${PM2_BIN}" -v)"

if [ ! -f .env ]; then
  cp gateway.env.example .env
  chmod 600 .env
  echo
  echo "!! ${REMOTE_DIR}/.env was created from the template."
  echo "   1) edit it: set APNS_KEY_ID and APNS_TEAM_ID (no token needed)"
  echo "   2) upload your APNs key to ${REMOTE_DIR}/secrets/AuthKey.p8"
  echo "   3) re-run this script"
  exit 3
fi

if [ ! -f secrets/AuthKey.p8 ]; then
  echo "!! ${REMOTE_DIR}/secrets/AuthKey.p8 is missing. Upload your APNs .p8 key, then re-run." >&2
  exit 4
fi
chmod 600 secrets/AuthKey.p8 || true

# Export .env so PM2 starts the process with these variables.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

if "${PM2_BIN}" describe "${APP_NAME}" >/dev/null 2>&1; then
  "${PM2_BIN}" reload "${APP_NAME}" --update-env
else
  # Pin the interpreter so the app runs on the intended Node version regardless of the daemon's.
  "${PM2_BIN}" start dist/index.js --name "${APP_NAME}" --interpreter "${NODE_BIN}" --update-env
fi

"${PM2_BIN}" save >/dev/null

sleep 2
echo "--- pm2 status ---"
"${PM2_BIN}" describe "${APP_NAME}" | sed -n '1,14p'

echo "--- health check ---"
curl -s -o /dev/null -w "GET http://127.0.0.1:${PORT:-8787}/healthz -> HTTP %{http_code}\n" \
  --max-time 5 "http://127.0.0.1:${PORT:-8787}/healthz"
REMOTE

echo
echo "==> done."
echo "    Reverse proxy should forward https://<your-domain> -> 127.0.0.1:${PORT:-8787}"
echo "    Logs: ssh ${SSH_HOST} '\"${PM2_BIN}\" logs ${APP_NAME} --lines 50'"
