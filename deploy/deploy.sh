#!/bin/sh
# Kaynakları VM'e gönder → VM'de derle → servisi yeniden başlat → kontrol et.
# Derleme sunucuda yapılır: yerelden yalnızca küçük kaynak dosyalar gider.
# Kullanım: ./deploy/deploy.sh
set -eu
cd "$(dirname "$0")/.."

HOST=${DEPLOY_HOST:?set DEPLOY_HOST}
KEY=${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}
DIR=/home/ubuntu/recep/website
SSH="ssh -i $KEY -o BatchMode=yes $HOST"

tar -czf - web go.mod go.sum *.go deploy | $SSH "cd $DIR && tar -xzf -"

# Çalışan binary'nin üzerine yazılamaz ("Text file busy"): yeni adla derle, sonra taşı.
# Servis ubuntu kullanıcısıyla çalışıyor: süreci durdurmak yeterli, systemd (Restart=always) 2 sn içinde kaldırır.
$SSH "cd $DIR && ~/.local/go/bin/go build -trimpath -ldflags='-s -w' -o bin/site.new . && sha256sum bin/site.new | cut -c1-12 && mv bin/site.new bin/site && pkill -x site; for i in \$(seq 20); do curl -fs localhost:8787/healthz >/dev/null && exit 0; sleep 0.5; done; echo 'servis kalkmadı' >&2; exit 1"

echo "✓ deploy tamam"
curl -fsS https://recepakyuz.dev | head -3
