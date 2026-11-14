#!/bin/sh
# Refreshes the DB-IP Lite city database once a month and restarts the service (cron, as the deploy user).
set -eu
cd /home/ubuntu/recep/website/data
curl -fsSL "https://download.db-ip.com/free/dbip-city-lite-$(date +%Y-%m).mmdb.gz" | gunzip > dbip-city.mmdb.new
[ -s dbip-city.mmdb.new ] && mv dbip-city.mmdb.new dbip-city.mmdb
pkill -x site || true # systemd (Restart=always) brings it back
