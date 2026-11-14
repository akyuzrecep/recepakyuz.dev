# recepakyuz.dev

My personal portfolio and SSH key site. A single Go binary serves two sites, picked by the request's host:

- **[recepakyuz.dev](https://recepakyuz.dev):** a terminal-style portfolio in front of a live, spinning globe
- **[ssh.recepakyuz.dev](https://ssh.recepakyuz.dev):** a page that adds my public keys to a server's `authorized_keys` with one command

## Features

- **Globe:** 86k dots rendered on the GPU with WebGL, draggable, with a 2D canvas fallback. Land data is stored as varint-encoded deltas between Fibonacci-sphere sample indices (~13 KB gzipped); the browser rebuilds the coordinates from the indices.
- **Terminal:** tabs (keys 1–7), typed commands (`help`, `cd`, `cv`, `theme`, `lang`…), Turkish/English, light/dark theme.
- **Visitors:** people currently on the site show up as pulses at their city, and a new visitor draws an arc to home. No IP addresses are stored: the city comes from a local database (DB-IP Lite), only time, city and country are written to disk, and data is kept for 7 days. A password-protected `/stats` page.
- **SSH page:** browsers get a page, tools like `curl`/`wget` get the plain key list. `curl -fsSL ssh.recepakyuz.dev/sh | sh` adds each key only if it's missing; there is a PowerShell script for Windows too.
- **No frameworks:** plain HTML/CSS/JS on the pages. The only Go dependency is `maxminddb-golang`.

## Layout

```
main.go          server, host routing, SSH endpoints
visitors.go      visitor tracking (ping), /stats
web/portfolio.html
web/templates/   ssh.html, stats.html, install scripts (sh, ps)
web/static/      globe.js, style.css, content.json (all portfolio text), land.idx, icons/
keys/            published public keys (<location>.pub)
deploy/          systemd unit, nginx config, deploy script
```

## Running

```sh
go build -o bin/site . && ./bin/site -dev
# http://localhost:8080       portfolio
# http://ssh.localhost:8080   ssh page
```

With `-dev`, `web/` is read from disk; without it the files are embedded in the binary.

### SSH endpoints

| Path | Returns |
|---|---|
| `/`, `/<location>` | A page for browsers, the plain key list for everything else |
| `/sh`, `/sh/<location>` | POSIX sh install script |
| `/ps`, `/ps/<location>` | PowerShell install script |

`keys/main.pub` is served at the root, `keys/<location>.pub` at `/<location>`. Key files are read on every request, so changing them needs no restart.

## Deployment

Runs as a systemd service on an Ubuntu VM behind nginx + Let's Encrypt (`deploy/`). `./deploy/deploy.sh` sends the sources to the server, builds there and restarts the service. Connection details live in `deploy/.env`, which is not committed:

```sh
DEPLOY_HOST=user@your-server
DEPLOY_KEY=$HOME/.ssh/id_ed25519
DEPLOY_DIR=/home/user/website
DEPLOY_URL=https://your-domain
```

The visitor feature needs a `data/` directory on the server with `dbip-city.mmdb` (the DB-IP Lite city database) and `stats.pass` (the `/stats` password). It is not part of the repository.

---

Location data: [DB-IP](https://db-ip.com) Lite (CC BY 4.0). Logos: [Simple Icons](https://simpleicons.org) (CC0).
