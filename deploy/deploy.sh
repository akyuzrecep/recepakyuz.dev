#!/bin/sh
# Derle → VM'e gönder → servisi yeniden başlat → kontrol et.
# Kullanım: ./deploy/deploy.sh
set -eu
cd "$(dirname "$0")/.."

HOST=${DEPLOY_HOST:?set DEPLOY_HOST}
KEY=${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}
DIR=/home/ubuntu/recep/website
SSH="ssh -i $KEY -o BatchMode=yes $HOST"

CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o bin/site-amd64 .
sum=$(sha256sum bin/site-amd64 | cut -c1-12)

# Çalışan binary'nin üzerine yazılamaz ("Text file busy"): yeni adla gönder, sonra taşı.
scp -q -i "$KEY" bin/site-amd64 "$HOST:$DIR/bin/site.new"
tar -czf - web go.mod go.sum *.go deploy | $SSH "cd $DIR && tar -xzf -"

# Servis ubuntu kullanıcısıyla çalışıyor: süreci durdurmak yeterli, systemd (Restart=always) 2 sn içinde kaldırır.
$SSH "cd $DIR && mv bin/site.new bin/site && pkill -x site; for i in \$(seq 20); do curl -fs localhost:8787/healthz >/dev/null && exit 0; sleep 0.5; done; echo 'servis kalkmadı' >&2; exit 1"

echo "✓ deploy tamam (binary $sum…)"
curl -fsS https://recepakyuz.dev | head -3
