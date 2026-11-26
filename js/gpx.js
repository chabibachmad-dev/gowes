// gpx.js — parse file GPX (rute/track) jadi ringkasan rencana ride:
// jarak, elevasi naik/turun, profil elevasi, tanjakan, titik tertinggi/terendah,
// dan estimasi waktu berdasarkan kecepatan datar + penalti tanjakan.
// Murni (tanpa DOM) supaya bisa diuji di Node. Parsing XML via regex ringan
// (GPX sederhana) agar tak perlu DOMParser di luar browser.

const R = 6371000, toR = Math.PI / 180;
const rnd = (v, d = 1) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

function haversine(a, b) {
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Ambil titik dari <trkpt>/<rtept lat=.. lon=..> dengan <ele> opsional.
export function parseGpxPoints(xml) {
  const text = String(xml || "");
  const name = (text.match(/<name>\s*([^<]+?)\s*<\/name>/i) || [])[1] || null;
  const pts = [];
  const re = /<(?:trkpt|rtept)\b[^>]*?\blat="([-\d.]+)"[^>]*?\blon="([-\d.]+)"[^>]*?>([\s\S]*?)<\/(?:trkpt|rtept)>/gi;
  const reSelf = /<(?:trkpt|rtept)\b[^>]*?\blat="([-\d.]+)"[^>]*?\blon="([-\d.]+)"[^>]*?\/>/gi;
  let m;
  while ((m = re.exec(text))) {
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    const ele = (m[3].match(/<ele>\s*([-\d.]+)\s*<\/ele>/i) || [])[1];
    if (isFinite(lat) && isFinite(lng)) pts.push({ lat, lng, ele: ele != null ? parseFloat(ele) : null });
  }
  if (!pts.length) {
    while ((m = reSelf.exec(text))) {
      const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (isFinite(lat) && isFinite(lng)) pts.push({ lat, lng, ele: null });
    }
  }
  return { name, pts };
}

// elevasi naik/turun dengan histeresis supaya noise tidak terhitung
function climb(eles, th = 3) {
  let up = 0, down = 0, ref = null;
  for (const a of eles) {
    if (a == null) continue;
    if (ref == null) { ref = a; continue; }
    if (a - ref >= th) { up += a - ref; ref = a; }
    else if (ref - a >= th) { down += ref - a; ref = a; }
  }
  return { up, down };
}

// kecepatan efektif (km/j) pada gradient g (%) dari kecepatan datar flat (km/j)
function speedAt(flat, g) {
  if (g <= 0) return Math.min(flat * 1.5, flat + -g * 0.7); // turunan: lebih cepat, dibatasi
  return Math.max(4, flat / (1 + g * 0.22));                 // tanjakan: makin curam makin lambat, min 4
}

const MAX_POINTS = 1500;

export function analyzeGpx(xml, { flatSpeedKmh = 20 } = {}) {
  const { name, pts } = parseGpxPoints(xml);
  if (pts.length < 2) throw new Error("File GPX tidak berisi jalur (trkpt/rtept) yang cukup.");

  // jarak kumulatif
  let dist = 0;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) { dist += haversine(pts[i - 1], pts[i]); cum.push(dist); }

  const hasEle = pts.some((p) => p.ele != null);
  // isi elevasi yang bolong dengan interpolasi sederhana (bawa nilai terakhir)
  let last = null;
  const eles = pts.map((p) => { if (p.ele != null) last = p.ele; return last; });

  const ce = climb(eles);
  const elevs = eles.filter((e) => e != null);
  const hi = hasEle ? Math.max(...elevs) : null;
  const lo = hasEle ? Math.min(...elevs) : null;
  const hiIdx = hasEle ? eles.indexOf(hi) : -1;
  const loIdx = hasEle ? eles.indexOf(lo) : -1;

  // estimasi waktu bergerak per segmen berdasarkan gradient
  let movS = 0;
  for (let i = 1; i < pts.length; i++) {
    const dd = cum[i] - cum[i - 1];
    if (dd < 0.5) continue;
    const de = hasEle && eles[i] != null && eles[i - 1] != null ? eles[i] - eles[i - 1] : 0;
    const g = (de / dd) * 100;
    const v = speedAt(flatSpeedKmh, Math.max(-20, Math.min(25, g))); // km/j
    movS += dd / (v / 3.6);
  }

  // deteksi tanjakan: segmen naik beruntun dengan gain >= 15 m & panjang >= 300 m
  const climbs = [];
  if (hasEle) {
    let s = null;
    for (let i = 1; i < pts.length; i++) {
      const de = (eles[i] ?? eles[i - 1]) - (eles[i - 1] ?? eles[i]);
      if (de > 0) { if (!s) s = { i0: i - 1, gain: 0 }; s.gain += de; s.i1 = i; }
      else if (s && (eles[i - 1] - (eles[i] ?? eles[i - 1])) > 8) {
        // turunan cukup → tutup tanjakan
        pushClimb(s);
        s = null;
      }
    }
    if (s) pushClimb(s);
    function pushClimb(s) {
      const len = cum[s.i1] - cum[s.i0];
      if (s.gain >= 15 && len >= 300) {
        const grade = (s.gain / len) * 100;
        climbs.push({
          from_km: rnd(cum[s.i0] / 1000, 1), to_km: rnd(cum[s.i1] / 1000, 1),
          len_m: rnd(len, 0), gain_m: rnd(s.gain, 0), avg_grade: rnd(grade, 1),
          cat: grade >= 9 ? "berat" : grade >= 6 ? "sedang" : "ringan",
        });
      }
    }
  }
  climbs.sort((a, b) => b.gain_m - a.gain_m);

  // profil ringkas untuk peta & grafik
  const step = Math.max(1, Math.ceil(pts.length / MAX_POINTS));
  const idx = [];
  for (let i = 0; i < pts.length; i += step) idx.push(i);
  if (idx[idx.length - 1] !== pts.length - 1) idx.push(pts.length - 1);
  const geo = {
    lat: idx.map((i) => rnd(pts[i].lat, 5)),
    lng: idx.map((i) => rnd(pts[i].lng, 5)),
    d: idx.map((i) => rnd(cum[i] / 1000, 3)),
    ele: hasEle ? idx.map((i) => rnd(eles[i], 1)) : null,
  };

  const summary = {
    name: name || null,
    distance_m: rnd(dist, 0),
    elev_gain: rnd(ce.up, 0),
    elev_loss: rnd(ce.down, 0),
    est_moving_s: rnd(movS, 0),
    flat_speed_kmh: rnd(flatSpeedKmh, 1),
    has_ele: hasEle,
    ele_min: rnd(lo, 0), ele_max: rnd(hi, 0),
    hi_lat: hiIdx >= 0 ? rnd(pts[hiIdx].lat, 5) : null, hi_lng: hiIdx >= 0 ? rnd(pts[hiIdx].lng, 5) : null,
    hi_km: hiIdx >= 0 ? rnd(cum[hiIdx] / 1000, 1) : null,
    lo_km: loIdx >= 0 ? rnd(cum[loIdx] / 1000, 1) : null,
    start_lat: rnd(pts[0].lat, 5), start_lng: rnd(pts[0].lng, 5),
    points: pts.length,
  };
  return { summary, analysis: { climbs, climb_count: climbs.length }, geo };
}
