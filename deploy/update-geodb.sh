#!/bin/sh
# Ayda bir DB-IP Lite şehir veritabanını yeniler ve servisi yeniden başlatır (cron, ubuntu kullanıcısı).
set -eu
cd /home/ubuntu/recep/website/data
curl -fsSL "https://download.db-ip.com/free/dbip-city-lite-$(date +%Y-%m).mmdb.gz" | gunzip > dbip-city.mmdb.new
[ -s dbip-city.mmdb.new ] && mv dbip-city.mmdb.new dbip-city.mmdb
pkill -x site || true # systemd (Restart=always) yeniden kaldırır
