// Ziyaretçiler: IP → şehir (DB-IP Lite, yerel), şu an sitede olanlar (30 sn ping), 7 günlük kayıt ve özel /stats sayfası.
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
	"html/template"
	"log"
	"math"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
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

// Şu an sitede olan bir sekme. Kimlik: tarayıcının ürettiği rastgele oturum kodu (IP değil).
type session struct {
	geo  *Geo
	seen time.Time
}

const sessionTTL = 70 * time.Second // ping 30 sn'de bir; iki ping kaçarsa çıkmış sayılır

type Visitors struct {
	mu      sync.Mutex
	db      *maxminddb.Reader
	file    string
	visits  []Visit
	day     string
	salt    []byte
	seen    map[string]bool
	live    map[string]*session
	statsPw string
}

func NewVisitors(dataDir string) *Visitors {
	v := &Visitors{file: filepath.Join(dataDir, "visits.jsonl"), live: map[string]*session{}}
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

type point struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
	ID  string  `json:"id,omitempty"`
}

var sidRe = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)

// POST /api/ping?sid=…&page=… — sayfa açıkken 30 sn'de bir çağrılır.
// İlk pingte ziyaret (günde bir kez) kaydedilir; yanıt şu an sitede olanların listesidir.
func (v *Visitors) handlePing(w http.ResponseWriter, r *http.Request) {
	sid, page := r.URL.Query().Get("sid"), r.URL.Query().Get("page")
	if !sidRe.MatchString(sid) || isBot(r.UserAgent()) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if len(page) > 40 {
		page = page[:40]
	}
	now := time.Now()
	// istemciye giden kimlik: oturum kodunun kısaltılmış hash'i (başkasının kodu görünmesin)
	pub := func(id string) string { h := sha256.Sum256([]byte(id)); return hex.EncodeToString(h[:6]) }

	v.mu.Lock()
	s, ok := v.live[sid]
	if !ok {
		ip := clientIP(r)
		s = &session{geo: v.lookup(ip)}
		v.live[sid] = s
		if g := s.geo; g != nil && v.firstToday(ip, r.UserAgent()) {
			x := Visit{T: now.UTC(), City: g.City, Country: g.Country, CC: g.CC, Lat: g.Lat, Lon: g.Lon, Page: page}
			v.visits = append(v.visits, x)
			if f, err := os.OpenFile(v.file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
				json.NewEncoder(f).Encode(x)
				f.Close()
			}
		}
	}
	s.seen = now
	online := []point{}
	for id, o := range v.live {
		if now.Sub(o.seen) > sessionTTL {
			delete(v.live, id)
			continue
		}
		if o.geo != nil && id != sid {
			online = append(online, point{Lat: o.geo.Lat, Lon: o.geo.Lon, ID: pub(id)})
		}
	}
	resp := map[string]any{"online": online}
	if s.geo != nil {
		resp["self"] = point{Lat: s.geo.Lat, Lon: s.geo.Lon}
	}
	v.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(resp)
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
	now := time.Now()
	for id, o := range v.live {
		if now.Sub(o.seen) > sessionTTL {
			delete(v.live, id)
		}
	}
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
