// Ziyaretçiler: IP → şehir (DB-IP Lite, yerel), son 7 gün geçmiş, canlı akış (SSE), özel /stats sayfası.
// Gizlilik: IP yalnızca o anki şehir araması ve günlük tekrar sayımını engellemek için (tuzlu hash, bellekte) kullanılır;
// diske yalnızca zaman, şehir, ülke ve ~10 km'ye yuvarlanmış koordinat yazılır.
package main

import (
	"bufio"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html/template"
	"log"
	"math"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/oschwald/maxminddb-golang/v2"
)

const retention = 7 * 24 * time.Hour

type Visit struct {
	T       time.Time `json:"t"`
	City    string    `json:"city"`
	Country string    `json:"country"`
	CC      string    `json:"cc"`
	Lat     float64   `json:"lat"`
	Lon     float64   `json:"lon"`
	Page    string    `json:"page"`
}

type Geo struct {
	City, Country, CC string
	Lat, Lon          float64
}

type liveConn struct {
	id  int
	geo *Geo
	ch  chan []byte
}

type Visitors struct {
	mu      sync.Mutex
	db      *maxminddb.Reader
	file    string
	visits  []Visit
	day     string
	salt    []byte
	seen    map[string]bool
	live    map[int]*liveConn
	nextID  int
	statsPw string
}

func NewVisitors(dataDir string) *Visitors {
	v := &Visitors{file: filepath.Join(dataDir, "visits.jsonl"), live: map[int]*liveConn{}}
	if db, err := maxminddb.Open(filepath.Join(dataDir, "dbip-city.mmdb")); err == nil {
		v.db = db
	} else {
		log.Printf("ziyaretçi: geo veritabanı yok, konum bulunamayacak (%v)", err)
	}
	if b, err := os.ReadFile(filepath.Join(dataDir, "stats.pass")); err == nil {
		v.statsPw = strings.TrimSpace(string(b))
	}
	v.load()
	go func() {
		for range time.Tick(time.Hour) {
			v.mu.Lock()
			v.prune()
			v.rewrite()
			v.mu.Unlock()
		}
	}()
	return v
}

func (v *Visitors) load() {
	f, err := os.Open(v.file)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var x Visit
		if json.Unmarshal(sc.Bytes(), &x) == nil {
			v.visits = append(v.visits, x)
		}
	}
	v.prune()
}

func (v *Visitors) prune() {
	cut := time.Now().Add(-retention)
	i := sort.Search(len(v.visits), func(i int) bool { return v.visits[i].T.After(cut) })
	v.visits = append([]Visit(nil), v.visits[i:]...)
}

func (v *Visitors) rewrite() {
	tmp := v.file + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		log.Print(err)
		return
	}
	enc := json.NewEncoder(f)
	for _, x := range v.visits {
		enc.Encode(x)
	}
	f.Close()
	os.Rename(tmp, v.file)
}

// İstemci IP'si: yalnızca localhost'tan gelen istekte nginx'in X-Real-IP başlığına güvenilir.
func clientIP(r *http.Request) netip.Addr {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	addr, _ := netip.ParseAddr(host)
	if addr.IsLoopback() {
		if x, err := netip.ParseAddr(strings.TrimSpace(r.Header.Get("X-Real-IP"))); err == nil {
			return x
		}
	}
	return addr
}

func (v *Visitors) lookup(ip netip.Addr) *Geo {
	if v.db == nil || !ip.IsValid() || ip.IsPrivate() || ip.IsLoopback() {
		return nil
	}
	var rec struct {
		City struct {
			Names map[string]string `maxminddb:"names"`
		} `maxminddb:"city"`
		Country struct {
			ISO   string            `maxminddb:"iso_code"`
			Names map[string]string `maxminddb:"names"`
		} `maxminddb:"country"`
		Location struct {
			Lat float64 `maxminddb:"latitude"`
			Lon float64 `maxminddb:"longitude"`
		} `maxminddb:"location"`
	}
	if err := v.db.Lookup(ip.Unmap()).Decode(&rec); err != nil || (rec.Location.Lat == 0 && rec.Location.Lon == 0) {
		return nil
	}
	round := func(f float64) float64 { return math.Round(f*10) / 10 } // ~10 km
	return &Geo{
		City: rec.City.Names["en"], Country: rec.Country.Names["en"], CC: rec.Country.ISO,
		Lat: round(rec.Location.Lat), Lon: round(rec.Location.Lon),
	}
}

var botUA = []string{"bot", "crawl", "spider", "slurp", "headless", "preview", "facebookexternalhit", "curl", "wget", "python", "go-http"}

func isBot(ua string) bool {
	ua = strings.ToLower(ua)
	if ua == "" {
		return true
	}
	for _, b := range botUA {
		if strings.Contains(ua, b) {
			return true
		}
	}
	return false
}

// Aynı kişi gün içinde bir kez sayılır. Tuz her gün yenilenir, eski günün hash'leri silinir.
func (v *Visitors) firstToday(ip netip.Addr, ua string) bool {
	today := time.Now().UTC().Format("2006-01-02")
	if v.day != today {
		v.day, v.salt, v.seen = today, make([]byte, 32), map[string]bool{}
		rand.Read(v.salt)
	}
	h := sha256.Sum256(append(append(append([]byte{}, v.salt...), ip.AsSlice()...), ua...))
	k := hex.EncodeToString(h[:12])
	if v.seen[k] {
		return false
	}
	v.seen[k] = true
	return true
}

func (v *Visitors) broadcast(msg []byte, except int) {
	for id, c := range v.live {
		if id == except {
			continue
		}
		select {
		case c.ch <- msg:
		default: // yavaş istemciyi bekletme
		}
	}
}

func sse(event string, data any) []byte {
	b, _ := json.Marshal(data)
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, b))
}

type point struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
	N   int     `json:"n,omitempty"`
	ID  int     `json:"id,omitempty"`
}

// GET /api/live — sayfayı açan tarayıcı bağlanır: ziyaret sayılır, canlı listeye girer, olayları dinler.
func (v *Visitors) handleLive(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream yok", 500)
		return
	}
	ip, ua := clientIP(r), r.UserAgent()
	var geo *Geo
	if !isBot(ua) { // botlar ne kaydedilir ne de dünyada görünür
		geo = v.lookup(ip)
	}
	page := r.URL.Query().Get("page")
	if len(page) > 40 {
		page = page[:40]
	}

	c := &liveConn{geo: geo, ch: make(chan []byte, 16)}
	v.mu.Lock()
	v.nextID++
	c.id = v.nextID
	if geo != nil && v.firstToday(ip, ua) {
		x := Visit{T: time.Now().UTC(), City: geo.City, Country: geo.Country, CC: geo.CC, Lat: geo.Lat, Lon: geo.Lon, Page: page}
		v.visits = append(v.visits, x)
		if f, err := os.OpenFile(v.file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			json.NewEncoder(f).Encode(x)
			f.Close()
		}
	}
	online := []point{}
	for _, o := range v.live {
		if o.geo != nil {
			online = append(online, point{Lat: o.geo.Lat, Lon: o.geo.Lon, ID: o.id})
		}
	}
	v.live[c.id] = c
	if geo != nil {
		v.broadcast(sse("join", point{Lat: geo.Lat, Lon: geo.Lon, ID: c.id}), c.id)
	}
	v.mu.Unlock()

	defer func() {
		v.mu.Lock()
		delete(v.live, c.id)
		if geo != nil {
			v.broadcast(sse("leave", point{ID: c.id}), c.id)
		}
		v.mu.Unlock()
	}()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	hello := map[string]any{"online": online}
	if geo != nil {
		hello["self"] = point{Lat: geo.Lat, Lon: geo.Lon, ID: c.id}
	}
	w.Write(sse("hello", hello))
	fl.Flush()

	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-c.ch:
			w.Write(msg)
			fl.Flush()
		case <-ping.C:
			w.Write([]byte(": ping\n\n"))
			fl.Flush()
		}
	}
}

// GET /api/visitors — son 7 günün noktaları (aynı koordinatlar birleştirilir).
func (v *Visitors) handleHistory(w http.ResponseWriter, r *http.Request) {
	v.mu.Lock()
	v.prune()
	agg := map[[2]float64]int{}
	for _, x := range v.visits {
		agg[[2]float64{x.Lat, x.Lon}]++
	}
	v.mu.Unlock()
	out := make([]point, 0, len(agg))
	for k, n := range agg {
		out = append(out, point{Lat: k[0], Lon: k[1], N: n})
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(out)
}

// ---------- /stats (yalnızca Recep) ----------

type countRow struct {
	Name string
	N    int
}

type statsData struct {
	Total, Online int
	Days          []countRow
	Countries     []countRow
	Cities        []countRow
	Pages         []countRow
	Recent        []Visit
	OnlineCities  []string
}

func top(m map[string]int, n int) []countRow {
	rows := make([]countRow, 0, len(m))
	for k, c := range m {
		rows = append(rows, countRow{k, c})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].N != rows[j].N {
			return rows[i].N > rows[j].N
		}
		return rows[i].Name < rows[j].Name
	})
	if len(rows) > n {
		rows = rows[:n]
	}
	return rows
}

func (v *Visitors) handleStats(w http.ResponseWriter, r *http.Request) {
	user, pw, ok := r.BasicAuth()
	if v.statsPw == "" || !ok || user != "recep" || subtle.ConstantTimeCompare([]byte(pw), []byte(v.statsPw)) != 1 {
		w.Header().Set("WWW-Authenticate", `Basic realm="recepakyuz.dev stats", charset="UTF-8"`)
		http.Error(w, "yetkisiz", http.StatusUnauthorized)
		return
	}
	loc, _ := time.LoadLocation("Europe/Istanbul")
	if loc == nil {
		loc = time.UTC
	}
	v.mu.Lock()
	v.prune()
	d := statsData{Total: len(v.visits), Online: len(v.live)}
	days, countries, cities, pages := map[string]int{}, map[string]int{}, map[string]int{}, map[string]int{}
	for _, x := range v.visits {
		days[x.T.In(loc).Format("2006-01-02 Mon")]++
		countries[x.Country]++
		city := x.City
		if city == "" {
			city = "?"
		}
		cities[city+", "+x.CC]++
		pages[x.Page]++
	}
	for i := len(v.visits) - 1; i >= 0 && len(d.Recent) < 30; i-- {
		x := v.visits[i]
		x.T = x.T.In(loc)
		d.Recent = append(d.Recent, x)
	}
	for _, c := range v.live {
		if c.geo != nil {
			d.OnlineCities = append(d.OnlineCities, c.geo.City+", "+c.geo.CC)
		} else {
			d.OnlineCities = append(d.OnlineCities, "?")
		}
	}
	v.mu.Unlock()
	d.Days = top(days, 7)
	sort.Slice(d.Days, func(i, j int) bool { return d.Days[i].Name > d.Days[j].Name })
	d.Countries, d.Cities, d.Pages = top(countries, 15), top(cities, 20), top(pages, 10)
	sort.Strings(d.OnlineCities)

	t, err := template.ParseFS(webRoot(), "templates/stats.html")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Robots-Tag", "noindex")
	t.Execute(w, d)
}
