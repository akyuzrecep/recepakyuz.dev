// recepakyuz.dev + ssh.recepakyuz.dev tek binary.
// Host "ssh." ile başlıyorsa SSH anahtar sitesi, değilse portfolyo sunulur.
package main

import (
	"bufio"
	"bytes"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	ttemplate "text/template"
)

//go:embed web
var webFS embed.FS

var (
	addr    = flag.String("addr", ":8080", "dinlenecek adres")
	keysDir = flag.String("keys", "keys", "anahtar dosyalarının dizini (<konum>.pub)")
	dev     = flag.Bool("dev", false, "web/ dizinini diskten oku (her istekte yeniden yükler)")
	dataDir = flag.String("data", "data", "ziyaretçi verisi, geo veritabanı (dbip-city.mmdb) ve stats.pass dizini")
)

// Geçerli bir authorized_keys satırı: tip + base64 gövde + opsiyonel yorum.
var keyLine = regexp.MustCompile(`^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( .*)?$`)
var locName = regexp.MustCompile(`^[a-z0-9-]+$`)

type Key struct {
	Line, Type, Comment string
}

func (k Key) ID() string { // doğrulama komutlarında grep'lenecek ifade
	if k.Comment != "" {
		return k.Comment
	}
	f := strings.Fields(k.Line)
	return f[1][len(f[1])-16:]
}

func webRoot() fs.FS {
	if *dev {
		return os.DirFS("web")
	}
	sub, _ := fs.Sub(webFS, "web")
	return sub
}

// "main" konumu kök (/) adresinde, diğerleri /<konum> altında sunulur.
func loadKeys(loc string) ([]Key, error) {
	f, err := os.Open(filepath.Join(*keysDir, loc+".pub"))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var keys []Key
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !keyLine.MatchString(line) {
			log.Printf("keys/%s.pub: geçersiz satır atlandı: %.40s…", loc, line)
			continue
		}
		parts := strings.SplitN(line, " ", 3)
		k := Key{Line: line, Type: parts[0]}
		if len(parts) == 3 {
			k.Comment = parts[2]
		}
		keys = append(keys, k)
	}
	return keys, sc.Err()
}

func locations() []string {
	matches, _ := filepath.Glob(filepath.Join(*keysDir, "*.pub"))
	var out []string
	for _, m := range matches {
		name := strings.TrimSuffix(filepath.Base(m), ".pub")
		if locName.MatchString(name) {
			out = append(out, name)
		}
	}
	sort.Slice(out, func(i, j int) bool { // main her zaman başta
		if out[i] == "main" || out[j] == "main" {
			return out[i] == "main"
		}
		return out[i] < out[j]
	})
	return out
}

// Tarayıcı mı, yoksa curl/wget/python/openssl gibi bir araç mı?
func wantsHTML(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

func baseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func hostOnly(r *http.Request) string {
	h := r.Host
	if i := strings.LastIndex(h, ":"); i > strings.LastIndex(h, "]") {
		h = h[:i]
	}
	return h
}

func serveStatic(w http.ResponseWriter, r *http.Request) {
	if *dev {
		w.Header().Set("Cache-Control", "no-store")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}
	http.StripPrefix("/static/", http.FileServer(http.FS(mustSub(webRoot(), "static")))).ServeHTTP(w, r)
}

func mustSub(f fs.FS, dir string) fs.FS {
	s, err := fs.Sub(f, dir)
	if err != nil {
		panic(err)
	}
	return s
}

// ---------- SSH sitesi ----------

type sshPage struct {
	Base, Host, Loc, Path string
	Locations             []string
	Keys                  []Key
	KeysText              string
	Port                  string
	TLS                   bool
}

func handleSSH(w http.ResponseWriter, r *http.Request) {
	p := strings.Trim(r.URL.Path, "/")
	script := ""
	switch {
	case p == "sh" || strings.HasPrefix(p, "sh/"):
		script, p = "sh", strings.TrimPrefix(strings.TrimPrefix(p, "sh"), "/")
	case p == "ps" || strings.HasPrefix(p, "ps/"):
		script, p = "ps", strings.TrimPrefix(strings.TrimPrefix(p, "ps"), "/")
	}
	loc := p
	if loc == "" {
		loc = "main"
	}
	if !locName.MatchString(loc) {
		http.NotFound(w, r)
		return
	}
	keys, err := loadKeys(loc)
	if err != nil || len(keys) == 0 {
		http.NotFound(w, r)
		return
	}
	var buf strings.Builder
	for _, k := range keys {
		buf.WriteString(k.Line + "\n")
	}
	path := ""
	if loc != "main" {
		path = "/" + loc
	}
	port := "443"
	if !strings.HasPrefix(baseURL(r), "https") {
		port = "80"
	}
	if i := strings.LastIndex(r.Host, ":"); i > strings.LastIndex(r.Host, "]") {
		port = r.Host[i+1:]
	}
	data := sshPage{
		Base: baseURL(r), Host: hostOnly(r), Loc: loc, Path: path,
		Locations: locations(), Keys: keys, KeysText: buf.String(),
		Port: port, TLS: strings.HasPrefix(baseURL(r), "https"),
	}

	w.Header().Set("Cache-Control", "no-store")
	switch {
	case script != "":
		renderText(w, "templates/install."+script, data)
	case wantsHTML(r):
		renderHTML(w, "templates/ssh.html", data)
	default:
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprint(w, data.KeysText)
	}
}

// ---------- Portfolyo ----------

func handlePortfolio(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if wantsHTML(r) {
		b, err := fs.ReadFile(webRoot(), "portfolio.html")
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(b)
		return
	}
	// curl recepakyuz.dev → düz metin kartvizit
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprint(w, textCard())
}

func textCard() string {
	raw, err := fs.ReadFile(webRoot(), "static/content.json")
	if err != nil {
		return "recepakyuz.dev\n"
	}
	var c struct {
		Name  string `json:"name"`
		Title struct {
			TR string `json:"tr"`
		} `json:"title"`
		Location string `json:"location"`
		Links    []struct {
			Label, URL string
		} `json:"links"`
	}
	json.Unmarshal(raw, &c)
	var b bytes.Buffer
	fmt.Fprintf(&b, "\n  \x1b[1m%s\x1b[0m\n  %s · %s\n\n", c.Name, c.Title.TR, c.Location)
	for _, l := range c.Links {
		fmt.Fprintf(&b, "  %-10s %s\n", l.Label, l.URL)
	}
	b.WriteString("\n")
	return b.String()
}

// ---------- şablonlar ----------

func renderHTML(w http.ResponseWriter, name string, data any) {
	t, err := template.ParseFS(webRoot(), name)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := t.Execute(w, data); err != nil {
		log.Print(err)
	}
}

func renderText(w http.ResponseWriter, name string, data any) {
	t, err := ttemplate.ParseFS(webRoot(), name)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if err := t.Execute(w, data); err != nil {
		log.Print(err)
	}
}

func main() {
	flag.Parse()
	mux := http.NewServeMux()
	mux.HandleFunc("/static/", serveStatic)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { fmt.Fprintln(w, "ok") })
	vis := NewVisitors(*dataDir)
	mux.HandleFunc("POST /api/ping", vis.handlePing)
	mux.HandleFunc("GET /stats", vis.handleStats)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(hostOnly(r), "ssh.") {
			handleSSH(w, r)
		} else {
			handlePortfolio(w, r)
		}
	})
	log.Printf("dinleniyor %s (dev=%v)  →  http://localhost%[1]s  ·  http://ssh.localhost%[1]s", *addr, *dev)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
