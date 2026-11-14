#!/bin/sh
# Send the sources to the server → build there → restart the service → check.
# The build runs on the server, so only small source files leave this machine.
#
# Connection details come from deploy/.env (not committed), e.g.:
#   DEPLOY_HOST=ubuntu@203.0.113.10
#   DEPLOY_KEY=$HOME/.ssh/id_ed25519
#   DEPLOY_DIR=/home/ubuntu/website
#   DEPLOY_URL=https://example.dev
#
# Usage: ./deploy/deploy.sh
set -eu
cd "$(dirname "$0")/.."
[ -f deploy/.env ] && . ./deploy/.env

HOST=${DEPLOY_HOST:?set DEPLOY_HOST in deploy/.env (user@host)}
KEY=${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}
DIR=${DEPLOY_DIR:?set DEPLOY_DIR in deploy/.env}
SSH="ssh -i $KEY -o BatchMode=yes $HOST"

tar -czf - --exclude=deploy/.env web go.mod go.sum *.go deploy | $SSH "cd $DIR && tar -xzf -"

# A running binary can't be overwritten ("Text file busy"): build under a new name, then move it.
# The service runs as the deploy user, so killing the process is enough: systemd (Restart=always) brings it back within 2 s.
$SSH "cd $DIR && ~/.local/go/bin/go build -trimpath -ldflags='-s -w' -o bin/site.new . && sha256sum bin/site.new | cut -c1-12 && mv bin/site.new bin/site && pkill -x site; for i in \$(seq 20); do curl -fs localhost:8787/healthz >/dev/null && exit 0; sleep 0.5; done; echo 'service did not come back up' >&2; exit 1"

echo "✓ deployed"
[ -n "${DEPLOY_URL:-}" ] && curl -fsS "$DEPLOY_URL" | head -3 || true
