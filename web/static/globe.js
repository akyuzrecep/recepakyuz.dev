// Noktalı, dönen, parlayan dünya. Bağımlılık yok — canvas 2D.
// Konum/boyut CSS değişkenlerinden okunur: --globe-x, --globe-y (0..1), --globe-r (kısa kenara oran).
(() => {
  const canvas = document.getElementById("globe");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dots = document.createElement("canvas");
  const dctx = dots.getContext("2d");
  // parıltı: noktalar 1/4 çözünürlükte çizilip büyütülür (tam ekran blur'dan ~16 kat ucuz)
  const glow = document.createElement("canvas");
  const gctx = glow.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const DEG = Math.PI / 180;

  // Ev konumu (nabız atan nokta + kuyruklu yıldızların hedefi)
  // (sayfa data-home'u sonradan set edebilir, o yüzden her seferinde okunur)
  const homeOf = () => (canvas.dataset.home || "41.01,28.98").split(",").map(Number);

  let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, R = 0;
  let lambda = -(homeOf()[1] + 10) * DEG; // ev biraz sağda başlasın, dönerek gelsin
  // eğim: kuzey izleyiciye doğru (CSS --globe-tilt, derece). Yakın görünümde 0'a yakın: Avrupa/Türkiye ekranın ortasına gelir
  let phi = (parseFloat(getComputedStyle(canvas).getPropertyValue("--globe-tilt")) || 22) * DEG;
  let spin = reduced ? 0.01 : 0.06;   // rad/sn
  let vel = spin;
  let P = null;                       // Float32Array [x,y,z,b, ...]
  let stars = [];
  let comet = null, nextComet = 2.5, pulses = [];
  let meteors = [], nextMeteor = 0.3;

  // renkler temadan (CSS değişkenleri) okunur; tema değişince yenilenir
  let T = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    T = {
      dot: v("--g-dot"), body1: v("--g-body-1"), body2: v("--g-body-2"),
      halo: v("--g-halo"), haloA: parseFloat(v("--g-halo-a")) || 0.2, rim: v("--g-rim"),
      star: v("--g-star"), meteor: v("--g-meteor"), home: v("--g-home"),
      glow: parseFloat(v("--g-glow")) || 0, shade: v("--g-planet-shade"), visit: v("--g-visit") || "94,234,212",
    };
  }
  readTheme();
  new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", readTheme);

  // ---- WebGL: dünyanın kendisi (gövde, hale, noktalar + ışıltı, kenar) ekran kartında çizilir.
  // 2D tuval bunun ÜSTÜNDE durur (yıldızlar, gezegenler, kayan yıldızlar, işaretler). WebGL yoksa eski 2D yol.
  const glc = document.createElement("canvas");
  glc.id = "globe-gl"; glc.setAttribute("aria-hidden", "true");
  canvas.before(glc);
  let gl = null, glDpr = 1, progQ = null, progP = null, quadBuf = null, ptBuf = null, ptCount = 0;
  try { gl = glc.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false }); } catch {}
  const uni = new Map();
  const U = (p, n) => { const k = (p === progQ ? "q:" : "p:") + n; if (!uni.has(k)) uni.set(k, gl.getUniformLocation(p, n)); return uni.get(k); };
  function program(vs, fs) {
    const mk = (type, src) => {
      const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  if (gl) {
    try {
      // tam ekran dörtgen: mode 0 = hale + gövde (noktaların altı), mode 1 = kenar parlaması (üstü)
      progQ = program("attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }", `
        precision mediump float;
        uniform vec3 geo; uniform vec2 res; uniform float dpr, mode, haloA;
        uniform vec3 body1, body2, halo, rim;
        void main() {
          vec2 p = vec2(gl_FragCoord.x, res.y * dpr - gl_FragCoord.y) / dpr;
          float d = distance(p, geo.xy) / geo.z;
          if (mode < 0.5) {
            if (d < 1.0) {
              float t = clamp(distance(p, geo.xy + vec2(-0.35, -0.4) * geo.z) / (1.3 * geo.z), 0.0, 1.0);
              gl_FragColor = vec4(mix(body1, body2, t), 1.0);
            } else {
              float u = (d - 0.9) / 0.45;
              float a = u < 0.35 ? mix(haloA, haloA * 0.36, u / 0.35) : mix(haloA * 0.36, 0.0, clamp((u - 0.35) / 0.65, 0.0, 1.0));
              gl_FragColor = vec4(halo * a, a);
            }
          } else {
            float u = (d - 0.82) / 0.2;
            float a = (u < 0.0 || u > 1.0) ? 0.0 : (u < 0.85 ? 0.10 * u / 0.85 : mix(0.10, 0.28, (u - 0.85) / 0.15));
            gl_FragColor = vec4(rim * a, a);
          }
        }`);
      // noktalar: döndürme ve izdüşüm köşe gölgelendiricide; arka yüz atılır
      progP = program(`
        attribute vec4 a;
        uniform vec4 cs; uniform vec3 geo; uniform vec2 res; uniform float size, glowPass;
        varying float va, vg;
        void main() {
          float x1 = a.x * cs.x + a.z * cs.y, z1 = -a.x * cs.y + a.z * cs.x;
          float y2 = a.y * cs.z - z1 * cs.w, z2 = a.y * cs.w + z1 * cs.z;
          vg = glowPass;
          if (z2 <= 0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; va = 0.0; return; }
          float al = a.w * (0.15 + 0.85 * pow(z2, 0.7)); // kenara doğru sönümlen
          vec2 p = vec2(geo.x + x1 * geo.z, geo.y - y2 * geo.z);
          gl_Position = vec4(p.x / res.x * 2.0 - 1.0, 1.0 - p.y / res.y * 2.0, 0.0, 1.0);
          gl_PointSize = size * (al >= 0.9 ? 1.5 : 1.0) * (glowPass > 0.5 ? 3.0 : 1.0);
          va = min(al, 0.95);
        }`, `
        precision mediump float;
        uniform vec3 col; uniform float glowA;
        varying float va, vg; // vg: ışıltı geçişi mi (uniform iki gölgelendiricide paylaşılmaz: hassasiyet farkı)
        void main() {
          if (vg > 0.5) { // ışıltı: noktanın etrafında yumuşak hale (blur yerine)
            float f = max(0.0, 1.0 - length(gl_PointCoord - 0.5) * 2.0);
            float a = va * f * f * glowA * 0.35;
            gl_FragColor = vec4(col * a, a);
          } else gl_FragColor = vec4(col * va, va);
        }`);
      quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      ptBuf = gl.createBuffer();
      gl.enable(gl.BLEND);
    } catch (e) {
      console.warn("globe: WebGL kullanılamadı, 2D çizime geçiliyor", e);
      gl = null;
    }
  }
  if (!gl) glc.remove();
  const rgbOf = (s) => (s || "0,0,0").split(",").map((v) => +v / 255);
  const hexOf = (h) => { const n = parseInt((h || "#000").replace("#", ""), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
  function uploadPoints() {
    gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf);
    gl.bufferData(gl.ARRAY_BUFFER, P, gl.STATIC_DRAW);
    ptCount = P.length / 4;
  }
  function drawGL() {
    gl.viewport(0, 0, glc.width, glc.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // ön-çarpımlı alfa
    const quad = (mode) => {
      gl.useProgram(progQ);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      const loc = gl.getAttribLocation(progQ, "a");
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform3f(U(progQ, "geo"), cx, cy, R); gl.uniform2f(U(progQ, "res"), W, H);
      gl.uniform1f(U(progQ, "dpr"), glDpr); gl.uniform1f(U(progQ, "mode"), mode); gl.uniform1f(U(progQ, "haloA"), T.haloA);
      gl.uniform3fv(U(progQ, "body1"), hexOf(T.body1)); gl.uniform3fv(U(progQ, "body2"), hexOf(T.body2));
      gl.uniform3fv(U(progQ, "halo"), rgbOf(T.halo)); gl.uniform3fv(U(progQ, "rim"), rgbOf(T.rim));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    quad(0);
    if (ptCount) {
      gl.useProgram(progP);
      gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf);
      const loc = gl.getAttribLocation(progP, "a");
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
      gl.uniform4f(U(progP, "cs"), Math.cos(lambda), Math.sin(lambda), Math.cos(phi), Math.sin(phi));
      gl.uniform3f(U(progP, "geo"), cx, cy, R); gl.uniform2f(U(progP, "res"), W, H);
      gl.uniform1f(U(progP, "size"), Math.max(1.1, Math.min(2.2, R / 330)) * glDpr);
      gl.uniform3fv(U(progP, "col"), rgbOf(T.dot)); gl.uniform1f(U(progP, "glowA"), T.glow);
      if (T.glow > 0) {
        gl.uniform1f(U(progP, "glowPass"), 1);
        gl.blendFunc(gl.ONE, gl.ONE); // ışıltı eklenir
        gl.drawArrays(gl.POINTS, 0, ptCount);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      gl.uniform1f(U(progP, "glowPass"), 0);
      gl.drawArrays(gl.POINTS, 0, ptCount);
    }
    quad(1);
  }

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, gl ? 1.5 : 2); // 2D katman WebGL varken hafif tutulur
    if (gl) {
      glDpr = Math.min(devicePixelRatio || 1, 2);
      glc.width = Math.round(canvas.clientWidth * glDpr); glc.height = Math.round(canvas.clientHeight * glDpr);
    }
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = dots.width = Math.round(W * dpr);
    canvas.height = dots.height = Math.round(H * dpr);
    glow.width = Math.max(1, Math.round((W * dpr) / 4)); glow.height = Math.max(1, Math.round((H * dpr) / 4));
    const cs = getComputedStyle(canvas);
    const fx = parseFloat(cs.getPropertyValue("--globe-x")) || 0.5;
    const fy = parseFloat(cs.getPropertyValue("--globe-y")) || 0.5;
    const fr = parseFloat(cs.getPropertyValue("--globe-r")) || 0.38;
    cx = W * fx; cy = H * fy; R = Math.min(W, H) * fr;
    stars = Array.from({ length: Math.round((W * H) / 1700) }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() < 0.08 ? 1.3 : 0.7,
      a: 0.15 + Math.random() * 0.55, t: Math.random() * 6.28, s: 0.5 + Math.random() * 1.5,
    }));
  }

  function vec(lat, lon) {
    const la = lat * DEG, lo = lon * DEG;
    return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
  }

  // dünya koordinatı → ekran; z>0 ise ön yüzde
  function project(x, y, z) {
    const cl = Math.cos(lambda), sl = Math.sin(lambda), cp = Math.cos(phi), sp = Math.sin(phi);
    const x1 = x * cl + z * sl, z1 = -x * sl + z * cl;
    const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    return [cx + x1 * R, cy - y2 * R, z2];
  }

  async function load() {
    // land.idx: 4 bayt N, sonra karadaki Fibonacci sıra numaralarının farkları (varint).
    // Koordinatlar sunucudaki üreticiyle aynı formülden hesaplanır.
    const buf = new Uint8Array(await (await fetch("/static/land.idx")).arrayBuffer());
    const N = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
    const golden = Math.PI * (3 - Math.sqrt(5)), ll = [];
    for (let p = 4, i = -1; p < buf.length; ) {
      let d = 0, sh = 1, b;
      do { b = buf[p++]; d += (b & 127) * sh; sh *= 128; } while (b & 128);
      i += d;
      const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = golden * i;
      ll.push(Math.asin(y) / DEG, Math.atan2(Math.sin(th) * r, Math.cos(th) * r) / DEG);
    }
    const n = ll.length / 2;
    P = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      // hafif titreşim: Fibonacci ızgarasının desenini kır
      const j = () => (Math.random() - 0.5) * 0.3;
      const [x, y, z] = vec(ll[2 * i] + j(), ll[2 * i + 1] + j());
      const r = Math.random();
      // çoğu sönük, azı parlak "şehir ışığı"
      const b = r > 0.985 ? 1.6 : 0.28 + 0.72 * Math.pow(Math.random(), 1.8);
      P.set([x, y, z, b], i * 4);
    }
    if (gl) uploadPoints();
  }

  const BUCKETS = 10;
  const buckets = Array.from({ length: BUCKETS }, () => []);

  function drawDots() {
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dctx.clearRect(0, 0, W, H);
    if (!P) return;
    for (const b of buckets) b.length = 0;
    const cl = Math.cos(lambda), sl = Math.sin(lambda), cp = Math.cos(phi), sp = Math.sin(phi);
    for (let i = 0; i < P.length; i += 4) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      const x1 = x * cl + z * sl, z1 = -x * sl + z * cl;
      const z2 = y * sp + z1 * cp;
      if (z2 <= 0.02) continue;
      const y2 = y * cp - z1 * sp;
      const sx = cx + x1 * R, sy = cy - y2 * R;
      if (sx < -4 || sx > W + 4 || sy < -4 || sy > H + 4) continue; // ekran dışı: çizme
      // kenara doğru sönümlen (limb darkening)
      const a = P[i + 3] * (0.15 + 0.85 * Math.pow(z2, 0.7));
      const k = Math.min(BUCKETS - 1, (a * BUCKETS) | 0);
      buckets[k].push(sx, sy);
    }
    const s = Math.max(1.1, Math.min(2.2, R / 330)); // nokta boyutu küreyle ölçeklenir (yakında sınırlı)
    for (let k = 0; k < BUCKETS; k++) {
      const arr = buckets[k];
      if (!arr.length) continue;
      dctx.fillStyle = `rgba(${T.dot},${((k + 0.5) / BUCKETS).toFixed(2)})`;
      const sz = k >= BUCKETS - 1 ? s * 1.5 : s;
      for (let j = 0; j < arr.length; j += 2) dctx.fillRect(arr[j] - sz / 2, arr[j + 1] - sz / 2, sz, sz);
    }
  }

  function drawStars(t, dt) {
    const drift = vel * 6 * dt; // yıldızlar dünyanın dönüşüyle hafifçe kayar
    ctx.fillStyle = `rgb(${T.star})`;
    for (const st of stars) {
      st.x -= drift * st.s;
      if (st.x < 0) st.x += W; else if (st.x > W) st.x -= W;
      ctx.globalAlpha = st.a * (0.6 + 0.4 * Math.sin(t * st.s + st.t));
      ctx.fillRect(st.x, st.y, st.r, st.r);
    }
    ctx.globalAlpha = 1;
  }

  // arka plandaki kayan yıldızlar (dünyanın ve yazıların arkasında)
  function spawnMeteor() {
    const ang = (195 + Math.random() * 50) * DEG; // çoğunlukla sağ üstten sol alta
    const speed = 500 + Math.random() * 900;
    const fromTop = Math.random() < 0.6;
    meteors.push({
      x: fromTop ? Math.random() * W * 1.2 : W + 20,
      y: fromTop ? -20 : Math.random() * H * 0.7,
      vx: Math.cos(ang) * speed, vy: -Math.sin(ang) * speed,
      len: 80 + Math.random() * 180, w: Math.random() < 0.2 ? 1.8 : 1,
      life: 0, max: 0.6 + Math.random() * 1.0, a: 0.35 + Math.random() * 0.6,
    });
  }
  function drawMeteors(dt) {
    if (reduced) return;
    nextMeteor -= dt;
    if (nextMeteor <= 0) {
      spawnMeteor();
      if (Math.random() < 0.22) { spawnMeteor(); spawnMeteor(); } // ara sıra yağmur
      nextMeteor = 0.12 + Math.random() * 0.55;
    }
    ctx.lineCap = "round";
    meteors = meteors.filter((m) => (m.life += dt) < m.max);
    for (const m of meteors) {
      m.x += m.vx * dt; m.y += m.vy * dt;
      const e = m.life / m.max, fade = Math.min(1, e * 6) * (1 - e) * m.a;
      const sp = Math.hypot(m.vx, m.vy), tx = m.x - (m.vx / sp) * m.len, ty = m.y - (m.vy / sp) * m.len;
      const g = ctx.createLinearGradient(tx, ty, m.x, m.y);
      g.addColorStop(0, `rgba(${T.meteor},0)`);
      g.addColorStop(1, `rgba(${T.meteor},${fade.toFixed(3)})`);
      ctx.strokeStyle = g; ctx.lineWidth = m.w;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(m.x, m.y); ctx.stroke();
      ctx.fillStyle = `rgba(${T.meteor},${fade.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(m.x, m.y, m.w, 0, 7); ctx.fill();
    }
  }

  // arka plandaki küçük gezegenler: konum ekran oranı, boyut piksel (ekranla ölçeklenir)
  const PLANETS = [
    { fx: 0.94, fy: 0.14, r: 20, c: [212, 172, 124], ring: true, tilt: -0.38, ph: 0.0 }, // halkalı
    { fx: 0.975, fy: 0.56, r: 8, c: [200, 104, 78], ph: 1.7 },                           // kızıl
    { fx: 0.58, fy: 0.94, r: 12, c: [104, 168, 196], ph: 3.1 },                          // buz mavisi
    { fx: 0.035, fy: 0.95, r: 6, c: [160, 160, 172], ph: 4.4 },                          // gri, uzak
  ];
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  function drawPlanets(t) {
    const scale = Math.max(0.6, Math.min(1.2, Math.min(W, H) / 900));
    const shade = (T.shade || "4,7,20").split(",").map(Number);
    for (const p of PLANETS) {
      const r = p.r * scale;
      const x = W * p.fx + Math.cos(t * 0.05 + p.ph) * 3, y = H * p.fy + Math.sin(t * 0.07 + p.ph) * 4;
      const ring = (from, to) => {
        ctx.save();
        ctx.strokeStyle = `rgba(${mix(p.c, [255, 255, 255], 0.2)},0.55)`;
        ctx.lineWidth = Math.max(1, r * 0.16);
        ctx.beginPath(); ctx.ellipse(x, y, r * 2.05, r * 0.52, p.tilt, from, to); ctx.stroke();
        ctx.strokeStyle = `rgba(${p.c},0.35)`; ctx.lineWidth = Math.max(0.6, r * 0.06);
        ctx.beginPath(); ctx.ellipse(x, y, r * 2.45, r * 0.64, p.tilt, from, to); ctx.stroke();
        ctx.restore();
      };
      // hafif hale
      let g = ctx.createRadialGradient(x, y, r * 0.9, x, y, r * 1.8);
      g.addColorStop(0, `rgba(${p.c},0.16)`); g.addColorStop(1, `rgba(${p.c},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 1.8, 0, 7); ctx.fill();
      if (p.ring) ring(Math.PI, Math.PI * 2); // halkanın arka yarısı
      // gövde: sol üstten ışık alır
      g = ctx.createRadialGradient(x - r * 0.45, y - r * 0.45, r * 0.1, x, y, r * 1.05);
      g.addColorStop(0, `rgb(${mix(p.c, [255, 255, 255], 0.25)})`);
      g.addColorStop(0.55, `rgb(${p.c})`);
      g.addColorStop(1, `rgb(${mix(p.c, shade, 0.75)})`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      if (p.ring) ring(0, Math.PI); // ön yarısı gezegenin önünden geçer
    }
  }

  // ---- ziyaretçiler: şu an sitede olanlar (nabız), yeni gelen → ev arası yay ----
  const VIS = canvas.dataset.visitors === "1";
  let online = new Map(), self = null, arcs = [];
  const near = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > 0.99995;

  function projectFull(x, y, z) { // birim olmayan vektörler için (yay küreden yükselir)
    const cl = Math.cos(lambda), sl = Math.sin(lambda), cp = Math.cos(phi), sp = Math.sin(phi);
    const x1 = x * cl + z * sl, z1 = -x * sl + z * cl;
    const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    const visible = z2 > 0 || x1 * x1 + y2 * y2 > 1;
    return [cx + x1 * R, cy - y2 * R, visible];
  }
  function slerp(a, b, s) {
    const d = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const om = Math.acos(d);
    if (om < 1e-4) return a;
    const k1 = Math.sin((1 - s) * om) / Math.sin(om), k2 = Math.sin(s * om) / Math.sin(om);
    return [a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2];
  }
  function addArc(from) {
    const h = homeOf(), to = vec(h[0], h[1]);
    if (!near(from, to)) arcs.push({ a: from, b: to, t: 0 });
  }

  // 30 sn'de bir "buradayım" der, yanıtta şu an sitede olanları alır (sürekli bağlantı yok)
  function startVisitors() {
    let sid;
    try {
      sid = sessionStorage.getItem("sid");
      if (!sid) { sid = crypto.randomUUID(); sessionStorage.setItem("sid", sid); }
    } catch { sid = Math.random().toString(36).slice(2) + Date.now().toString(36); }
    const url = `/api/ping?sid=${encodeURIComponent(sid)}&page=${encodeURIComponent(canvas.dataset.page || location.pathname)}`;
    let first = true;
    async function ping() {
      if (document.hidden) return;
      try {
        const r = await fetch(url, { method: "POST" });
        if (r.status !== 200) return;
        const d = await r.json();
        const next = new Map(d.online.map((p) => [p.id, { v: vec(p.lat, p.lon) }]));
        if (!first) for (const [id, o] of next) if (!online.has(id)) addArc(o.v); // yeni gelen → eve yay
        online = next;
        if (d.self) {
          const v = vec(d.self.lat, d.self.lon);
          if (!self) setTimeout(() => addArc(v), 1500); // hoş geldin yayı
          self = { v };
        }
        first = false;
      } catch {}
    }
    setTimeout(ping, 800); // önce dünya yüklensin
    setInterval(ping, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) ping(); });
  }

  function drawVisitors(t, dt) {
    if (!VIS) return;
    const c = T.visit, k = Math.max(0.8, R / 300);
    // şu an sitede olanlar: sürekli nabız
    const pulseAt = (v, seed) => {
      const p = project(...v);
      if (p[2] <= 0.05) return null;
      const e = (t * 0.6 + seed) % 1;
      ctx.strokeStyle = `rgba(${c},${(1 - e) * 0.8})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p[0], p[1], 3 + e * 16 * k, 0, 7); ctx.stroke();
      ctx.fillStyle = `rgb(${c})`;
      ctx.beginPath(); ctx.arc(p[0], p[1], 2.4 * k, 0, 7); ctx.fill();
      return p;
    };
    for (const [id, o] of online) pulseAt(o.v, (id * 0.37) % 1);
    if (self) {
      const p = pulseAt(self.v, 0);
      if (p) {
        const label = document.documentElement.lang === "en" ? "you are here" : "sen buradasın";
        ctx.font = `500 11px "Geist Mono", ui-monospace, monospace`;
        ctx.fillStyle = `rgba(${c},${Math.min(1, p[2] * 2.5)})`;
        ctx.fillText(label, p[0] + 10, p[1] - 8);
      }
    }
    // yaylar: ziyaretçinin şehrinden eve, kürenin üstünden
    arcs = arcs.filter((a) => (a.t += dt) < 2.6);
    ctx.lineCap = "round";
    for (const a of arcs) {
      const head = Math.min(1, a.t / 1.8), ease = 1 - Math.pow(1 - head, 3);
      const tail = Math.max(0, ease - 0.45), fadeOut = a.t > 1.8 ? 1 - (a.t - 1.8) / 0.8 : 1;
      const N = 28;
      let prev = null;
      for (let i = 0; i <= N; i++) {
        const s = tail + (ease - tail) * (i / N);
        const lift = 1 + 0.18 * Math.sin(Math.PI * s);
        const v = slerp(a.a, a.b, s), q = projectFull(v[0] * lift, v[1] * lift, v[2] * lift);
        if (prev && q[2] && prev[2]) {
          ctx.strokeStyle = `rgba(${c},${(i / N) * 0.9 * fadeOut})`; ctx.lineWidth = 1.8;
          ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
        }
        prev = q;
      }
      if (head >= 1 && !a.done) {
        a.done = true;
        const hp = project(...a.b);
        if (hp[2] > 0) pulses.push({ x: hp[0], y: hp[1], t: 0 });
      }
    }
  }

  function drawAtmosphere() {
    // dış hale
    let g = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.35);
    g.addColorStop(0, `rgba(${T.halo},${T.haloA})`);
    g.addColorStop(0.35, `rgba(${T.halo},${T.haloA * 0.36})`);
    g.addColorStop(1, `rgba(${T.halo},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.35, 0, 7); ctx.fill();
    // kürenin gövdesi: yıldızları örter, hafif hacim verir
    g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    g.addColorStop(0, T.body1);
    g.addColorStop(1, T.body2);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();
  }

  function drawRim() {
    const g = ctx.createRadialGradient(cx, cy, R * 0.82, cx, cy, R * 1.02);
    g.addColorStop(0, `rgba(${T.rim},0)`);
    g.addColorStop(0.85, `rgba(${T.rim},0.10)`);
    g.addColorStop(1, `rgba(${T.rim},0.28)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.02, 0, 7); ctx.fill();
  }

  function visibleTarget() {
    const home = homeOf();
    const [hx, hy, hz] = vec(home[0], home[1]);
    const p = project(hx, hy, hz);
    if (p[2] > 0.25) return p;
    if (!P) return null;
    for (let tries = 0; tries < 40; tries++) {
      const i = ((Math.random() * P.length) / 4 | 0) * 4;
      const q = project(P[i], P[i + 1], P[i + 2]);
      if (q[2] > 0.35) return q;
    }
    return null;
  }

  function updateComet(dt) {
    if (reduced) return;
    if (!comet) {
      nextComet -= dt;
      if (nextComet > 0) return;
      const tgt = visibleTarget();
      nextComet = 7 + Math.random() * 6;
      if (!tgt) return;
      const ang = (-140 + (Math.random() - 0.5) * 40) * DEG; // sol üstten gelsin
      const dist = Math.min(R * 1.4, 420);
      comet = { sx: tgt[0] + Math.cos(ang) * dist, sy: tgt[1] + Math.sin(ang) * dist, tx: tgt[0], ty: tgt[1], t: 0, dur: 1.1 };
      return;
    }
    comet.t += dt;
    if (comet.t >= comet.dur) {
      pulses.push({ x: comet.tx, y: comet.ty, t: 0 });
      comet = null;
    }
  }

  function drawComet() {
    if (!comet) return;
    const e = comet.t / comet.dur;
    const k = 1 - Math.pow(1 - e, 2);
    const hx = comet.sx + (comet.tx - comet.sx) * k, hy = comet.sy + (comet.ty - comet.sy) * k;
    const tail = Math.max(0, k - 0.35);
    const tx = comet.sx + (comet.tx - comet.sx) * tail, ty = comet.sy + (comet.ty - comet.sy) * tail;
    const g = ctx.createLinearGradient(tx, ty, hx, hy);
    g.addColorStop(0, `rgba(${T.meteor},0)`);
    g.addColorStop(1, `rgba(${T.meteor},0.95)`);
    ctx.strokeStyle = g; ctx.lineWidth = 2.2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.fillStyle = `rgb(${T.meteor})`;
    ctx.beginPath(); ctx.arc(hx, hy, 2.4, 0, 7); ctx.fill();
  }

  function drawPulses(dt) {
    pulses = pulses.filter((p) => (p.t += dt) < 1.6);
    for (const p of pulses) {
      const e = p.t / 1.6;
      ctx.strokeStyle = `rgba(${T.home},${(1 - e) * 0.8})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 3 + e * 26, 0, 7); ctx.stroke();
    }
    // ev noktası
    const home = homeOf();
    const [hx, hy, hz] = vec(home[0], home[1]);
    const h = project(hx, hy, hz);
    if (h[2] > 0.05) {
      const a = Math.min(1, h[2] * 3);
      ctx.fillStyle = `rgba(${T.home},${a})`;
      ctx.shadowColor = `rgba(${T.home},0.9)`; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(h[0], h[1], 2.6, 0, 7); ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // sürükleyerek döndürme (ataletli)
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    const d = Math.hypot(e.clientX - cx, e.clientY - cy);
    if (d > R * 1.1) return;
    drag = { x: e.clientX, y: e.clientY, t: performance.now() };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const now = performance.now(), dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    lambda += dx / R;
    phi = Math.max(-10 * DEG, Math.min(50 * DEG, phi + dy / R));
    vel = (dx / R) / Math.max(0.008, (now - drag.t) / 1000);
    drag = { x: e.clientX, y: e.clientY, t: now };
  });
  const end = () => { drag = null; canvas.classList.remove("dragging"); };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  const hasFilter = "filter" in ctx;
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!drag) {
      vel += (spin - vel) * Math.min(1, dt * 1.5); // atalet → sabit dönüşe geri dön
      lambda += vel * dt;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (gl) {
      drawGL();
      // 2D katman dünyanın üstünde: arka plan öğeleri kürenin dışına kırpılır
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip("evenodd");
      drawStars(now / 1000, dt);
      drawMeteors(dt);
      drawPlanets(now / 1000);
      ctx.restore();
    } else {
    drawStars(now / 1000, dt);
    drawMeteors(dt);
    drawPlanets(now / 1000);
    drawAtmosphere();
    drawDots();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (T.glow > 0) { // parıltı katmanı (yalnızca koyu temada)
      gctx.clearRect(0, 0, glow.width, glow.height);
      if (hasFilter) gctx.filter = "blur(1px)";
      gctx.drawImage(dots, 0, 0, glow.width, glow.height);
      gctx.filter = "none";
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = T.glow;
      ctx.drawImage(glow, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(dots, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRim();
    }
    updateComet(dt);
    drawComet();
    drawPulses(dt);
    drawVisitors(now / 1000, dt);
    requestAnimationFrame(frame);
  }

  resize();
  addEventListener("resize", resize);
  load().catch((e) => console.error("globe:", e));
  if (VIS) startVisitors();
  requestAnimationFrame(frame);
})();
