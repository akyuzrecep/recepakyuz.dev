# recepakyuz.dev

Tek Go binary, iki site (Host başlığına göre):

- `recepakyuz.dev` → portfolyo (`web/portfolio.html`, içerik `web/static/content.json`)
- `ssh.recepakyuz.dev` → SSH anahtar sayfası (`keys/*.pub`)

## Local

```sh
go build -o bin/site . && ./bin/site -dev
# http://localhost:8080        portfolyo
# http://ssh.localhost:8080    ssh sayfası (Chrome/Firefox *.localhost'u kendisi çözer)
curl --resolve ssh.localhost:8080:127.0.0.1 http://ssh.localhost:8080/   # düz anahtar listesi
```

`-dev`: `web/` diskten okunur, değişiklik için yeniden derlemek gerekmez. Anahtarlar her istekte `keys/` dizininden okunur.

## SSH uç noktaları

| yol | ne döner |
|---|---|
| `/` , `/<konum>` | tarayıcıya HTML, diğer her şeye (`Accept: text/html` yoksa) düz anahtar listesi |
| `/sh` , `/sh/<konum>` | POSIX sh kurulum betiği (`curl -fsSL ssh.recepakyuz.dev/sh \| sh`) |
| `/ps` , `/ps/<konum>` | PowerShell kurulum betiği (`irm https://ssh.recepakyuz.dev/ps \| iex`) |

`keys/main.pub` kökte, `keys/<konum>.pub` → `/<konum>` adresinde sunulur.
