# recepakyuz.dev

Kişisel portfolyo ve SSH anahtar sitesi. Tek bir Go programı, gelen isteğin adresine göre iki siteyi birden sunar:

- **[recepakyuz.dev](https://recepakyuz.dev):** terminal görünümlü portfolyo, arkada canlı dönen bir dünya
- **[ssh.recepakyuz.dev](https://ssh.recepakyuz.dev):** public key'lerimi tek komutla bir sunucunun `authorized_keys` dosyasına ekleten sayfa

## Özellikler

- **Dünya:** 86 bin noktadan oluşan, WebGL ile ekran kartında çizilen, sürükleyerek çevrilebilen küre. WebGL yoksa 2D canvas'a düşer. Kara verisi, Fibonacci küre örneklemesindeki sıra numaralarının varint farkları olarak saklanıyor (sıkıştırılmış hâliyle ~13 KB).
- **Terminal:** sekmeler (1–7 tuşları), elle yazılan komutlar (`help`, `cd`, `cv`, `theme`, `lang`…), TR/EN, açık/koyu tema.
- **Ziyaretçiler:** şu an sitede olanlar dünyada şehirlerinde nabız olarak görünür, yeni gelenden eve bir yay çizilir. IP saklanmaz: şehir yerel bir veritabanından (DB-IP Lite) bulunur, diske sadece zaman, şehir ve ülke yazılır, 7 gün tutulur. Şifreli `/stats` sayfası.
- **SSH sayfası:** tarayıcıya sayfa, `curl`/`wget` gibi araçlara düz metin key listesi döner. `curl -fsSL ssh.recepakyuz.dev/sh | sh` her anahtarı yalnızca yoksa ekler; Windows için PowerShell betiği de var.
- **Bağımlılık yok:** sayfalarda framework yok, saf HTML/CSS/JS. Go tarafında tek bağımlılık `maxminddb-golang`.

## Yapı

```
main.go          sunucu, host'a göre yönlendirme, SSH uç noktaları
visitors.go      ziyaretçi takibi (ping), /stats
web/portfolio.html
web/templates/   ssh.html, stats.html, kurulum betikleri (sh, ps)
web/static/      globe.js, style.css, content.json (tüm portfolyo metni), land.idx, icons/
keys/            yayınlanan public key'ler (<konum>.pub)
deploy/          systemd servisi, nginx ayarı, deploy betiği
```

## Çalıştırma

```sh
go build -o bin/site . && ./bin/site -dev
# http://localhost:8080       portfolyo
# http://ssh.localhost:8080   ssh sayfası
```

`-dev` ile `web/` diskten okunur; olmadan dosyalar programın içine gömülür.

### SSH uç noktaları

| Yol | Ne döner |
|---|---|
| `/`, `/<konum>` | Tarayıcıya sayfa, diğer istemcilere düz metin key listesi |
| `/sh`, `/sh/<konum>` | POSIX sh kurulum betiği |
| `/ps`, `/ps/<konum>` | PowerShell kurulum betiği |

`keys/main.pub` kökte, `keys/<konum>.pub` → `/<konum>` adresinde sunulur. Key dosyaları her istekte okunur; değiştirince yeniden başlatmak gerekmez.

## Yayın

Ubuntu VM üzerinde systemd servisi olarak çalışır, önünde nginx + Let's Encrypt var (`deploy/`). `./deploy/deploy.sh` kaynakları sunucuya gönderir, sunucuda derler ve servisi yeniden başlatır.

Ziyaretçi özelliği için sunucuda `data/` dizini gerekir: `dbip-city.mmdb` (DB-IP Lite şehir veritabanı) ve `/stats` şifresi için `stats.pass`. Bu dizin depoda yoktur.

---

Konum verisi: [DB-IP](https://db-ip.com) Lite (CC BY 4.0). Logolar: [Simple Icons](https://simpleicons.org) (CC0).
