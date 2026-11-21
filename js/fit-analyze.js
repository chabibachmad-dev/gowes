// fit-analyze.js — mengolah pesan FIT (hasil @garmin/fitsdk Decoder) menjadi
// ringkasan, daftar berhenti, segmen, best effort, histogram HR, dan stream ringkas.
// Murni (tanpa DOM/CDN) supaya bisa diuji di Node.

const SC = 180 / 2147483648; // semicircle -> derajat
const GAP_S = 15;            // jeda antar-record > 15 dtk dianggap berhenti (auto-pause)
const STOP_SPD = 0.6;        // < 0,6 m/s (~2 km/j) dianggap diam
const MIN_STOP_S = 60;       // berhenti >= 1 menit masuk daftar
const MERGE_S = 45;          // dua berhenti berjarak < 45 dtk digabung
const MAX_POINTS = 3000;     // titik stream yang disimpan

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const r = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

function pickRecords(messages) {
  const recs = (messages.recordMesgs || []).filter((m) => m.timestamp);
  const out = [];
  for (const m of recs) {
    const t = new Date(m.timestamp).getTime() / 1000;
    if (out.length && t <= out[out.length - 1].t) continue; // buang timestamp mundur/duplikat
    out.push({
      t,
      lat: num(m.positionLat) != null ? m.positionLat * SC : null,
      lng: num(m.positionLong) != null ? m.positionLong * SC : null,
      dist: num(m.distance),
      alt: num(m.enhancedAltitude) ?? num(m.altitude),
      spd: num(m.enhancedSpeed) ?? num(m.speed),
      hr: num(m.heartRate),
      cad: num(m.cadence),
      pwr: num(m.power),
      temp: num(m.temperature),
    });
  }
  // isi jarak yang hilang dari GPS bila perlu
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    if (p.dist == null) {
      if (i > 0 && p.lat != null && out[i - 1].lat != null) last += haversine(out[i - 1], p);
      p.dist = last;
    } else last = p.dist;
    if (p.spd == null && i > 0) {
      const dt = p.t - out[i - 1].t;
      p.spd = dt > 0 && dt <= GAP_S ? (p.dist - out[i - 1].dist) / dt : 0;
    }
  }
  return out;
}

function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// elevasi naik/turun dengan histeresis supaya noise barometer tidak terhitung
function climb(alts, th = 3) {
  let up = 0, down = 0, ref = null;
  for (const a of alts) {
    if (a == null) continue;
    if (ref == null) { ref = a; continue; }
    if (a - ref >= th) { up += a - ref; ref = a; }
    else if (ref - a >= th) { down += ref - a; ref = a; }
  }
  return { up, down };
}

export function analyzeFit(messages) {
  const recs = pickRecords(messages);
  if (recs.length < 2) throw new Error('File FIT tidak berisi data rekaman (record) yang cukup.');
  const ses = (messages.sessionMesgs || [])[0] || {};
  const t0 = recs[0].t;
  const n = recs.length;

  // --- waktu bergerak & berhenti ---
  const moving = new Float64Array(n); // waktu bergerak kumulatif (dtk)
  const stopsRaw = [];
  let cur = null;
  for (let i = 1; i < n; i++) {
    const a = recs[i - 1], b = recs[i];
    const dt = b.t - a.t;
    const still = dt > GAP_S || (b.spd ?? 0) < STOP_SPD;
    moving[i] = moving[i - 1] + (still ? 0 : dt);
    if (still) {
      if (cur && a.t - cur.end <= MERGE_S) cur.end = b.t;
      else { cur = { start: a.t, end: b.t, i: i - 1 }; stopsRaw.push(cur); }
    }
  }
  const elapsed = recs[n - 1].t - t0;
  const movingS = moving[n - 1];
  const stops = stopsRaw
    .map((s) => ({ ...s, dur: s.end - s.start }))
    .filter((s) => s.dur >= MIN_STOP_S)
    .map((s) => {
      const p = recs[s.i];
      return {
        at: r(s.start - t0, 0),            // detik sejak start
        clock: new Date(s.start * 1000).toISOString(),
        dur: r(s.dur, 0),
        km: r(p.dist / 1000, 2),
        lat: r(p.lat, 5), lng: r(p.lng, 5),
      };
    });

  // --- ringkasan ---
  const dist = recs[n - 1].dist;
  const ce = climb(recs.map((p) => p.alt));
  const avgOf = (key, weightMoving = true) => {
    let s = 0, w = 0;
    for (let i = 1; i < n; i++) {
      const v = recs[i][key];
      const dt = recs[i].t - recs[i - 1].t;
      if (v == null || dt > GAP_S) continue;
      if (weightMoving && (recs[i].spd ?? 0) < STOP_SPD) continue;
      s += v * dt; w += dt;
    }
    return w ? s / w : null;
  };
  const maxOf = (key) => recs.reduce((m, p) => (p[key] != null && p[key] > m ? p[key] : m), -Infinity);
  const has = (key) => recs.some((p) => p[key] != null && p[key] > 0);

  const sesNum = (k) => num(ses[k]);
  const summary = {
    start_time: new Date(t0 * 1000).toISOString(),
    distance_m: r(sesNum('totalDistance') ?? dist, 1),
    elapsed_s: r(sesNum('totalElapsedTime') ?? elapsed, 0),
    moving_s: r(movingS, 0),
    timer_s: r(sesNum('totalTimerTime'), 0),
    stopped_s: r(Math.max(0, (sesNum('totalElapsedTime') ?? elapsed) - movingS), 0),
    elev_gain: r(sesNum('totalAscent') ?? ce.up, 0),
    elev_loss: r(sesNum('totalDescent') ?? ce.down, 0),
    avg_speed: r(movingS ? dist / movingS : null, 3),
    max_speed: r(sesNum('enhancedMaxSpeed') ?? sesNum('maxSpeed') ?? maxOf('spd'), 3),
    avg_hr: has('hr') ? r(sesNum('avgHeartRate') ?? avgOf('hr', false), 0) : null,
    max_hr: has('hr') ? r(sesNum('maxHeartRate') ?? maxOf('hr'), 0) : null,
    avg_cad: has('cad') ? r(sesNum('avgCadence') ?? avgOf('cad'), 0) : null,
    avg_power: has('pwr') ? r(sesNum('avgPower') ?? avgOf('pwr'), 0) : null,
    max_power: has('pwr') ? r(sesNum('maxPower') ?? maxOf('pwr'), 0) : null,
    norm_power: has('pwr') ? r(sesNum('normalizedPower') ?? normPower(recs), 0) : null,
    calories: r(sesNum('totalCalories'), 0),
    avg_temp: has('temp') || recs.some((p) => p.temp != null) ? r(sesNum('avgTemperature') ?? avgOf('temp', false), 0) : null,
    max_temp: recs.some((p) => p.temp != null) ? r(sesNum('maxTemperature') ?? maxOf('temp'), 0) : null,
    start_lat: r(recs.find((p) => p.lat != null)?.lat, 5),
    start_lng: r(recs.find((p) => p.lng != null)?.lng, 5),
    sport: ses.sport ?? null,
    sub_sport: ses.subSport ?? null,
  };

  // --- segmen ---
  const km = dist / 1000;
  const segLen = km < 60 ? 5 : km < 150 ? 10 : 25; // km
  const segments = [];
  let si = 0;
  for (let edge = segLen; si < n - 1; edge += segLen) {
    let j = si;
    while (j < n - 1 && recs[j].dist < edge * 1000) j++;
    const a = recs[si], b = recs[j];
    const d = b.dist - a.dist;
    if (d < 200) break;
    const mt = moving[j] - moving[si];
    const slice = recs.slice(si, j + 1);
    const avg = (k) => {
      let s = 0, w = 0;
      for (let q = 1; q < slice.length; q++) {
        const v = slice[q][k], dt = slice[q].t - slice[q - 1].t;
        if (v == null || dt > GAP_S || (slice[q].spd ?? 0) < STOP_SPD) continue;
        s += v * dt; w += dt;
      }
      return w ? s / w : null;
    };
    segments.push({
      from: r(a.dist / 1000, 1), to: r(b.dist / 1000, 1),
      elapsed: r(b.t - a.t, 0), moving: r(mt, 0),
      speed: r(mt ? (d / mt) * 3.6 : null, 1), // km/j bergerak
      gain: r(climb(slice.map((p) => p.alt)).up, 0),
      hr: r(avg('hr'), 0), pwr: r(avg('pwr'), 0), cad: r(avg('cad'), 0),
      clock: new Date(a.t * 1000).toISOString(),
    });
    si = j;
  }

  // --- lap dari file ---
  const laps = (messages.lapMesgs || []).map((l, i) => ({
    no: i + 1,
    start: l.startTime ? new Date(l.startTime).toISOString() : null,
    dist: r(num(l.totalDistance) / 1000, 2),
    timer: r(num(l.totalTimerTime), 0),
    elapsed: r(num(l.totalElapsedTime), 0),
    speed: (() => {
      const s = num(l.enhancedAvgSpeed) ?? num(l.avgSpeed);
      if (s != null) return r(s * 3.6, 1);
      const d = num(l.totalDistance), tt = num(l.totalTimerTime);
      return d != null && tt ? r((d / tt) * 3.6, 1) : null;
    })(),
    gain: r(num(l.totalAscent), 0),
    hr: r(num(l.avgHeartRate), 0),
    pwr: r(num(l.avgPower), 0),
  })).filter((l) => l.dist != null);

  // --- best effort jarak (berdasarkan waktu bergerak) ---
  const bestDist = {};
  for (const X of [5, 10, 20, 40, 50, 100, 160, 200, 300]) {
    if (X * 1000 > dist) continue;
    let best = Infinity, j = 0;
    for (let i = 0; i < n; i++) {
      if (j < i) j = i;
      while (j < n && recs[j].dist - recs[i].dist < X * 1000) j++;
      if (j >= n) break;
      const mt = moving[j] - moving[i];
      if (mt > 0 && mt < best) best = mt;
    }
    if (isFinite(best)) bestDist[X] = { s: r(best, 0), kmh: r((X / best) * 3600, 1) };
  }

  // --- best power (rata-rata berdasarkan waktu) ---
  const bestPower = {};
  if (has('pwr')) {
    const E = new Float64Array(n); // energi kumulatif (J)
    for (let i = 1; i < n; i++) {
      const dt = Math.min(recs[i].t - recs[i - 1].t, GAP_S);
      E[i] = E[i - 1] + (recs[i].pwr ?? 0) * dt;
    }
    const T = recs.map((p) => p.t);
    for (const W of [5, 60, 300, 1200, 3600]) {
      if (elapsed < W) continue;
      let best = 0, j = 0;
      for (let i = 0; i < n; i++) {
        if (j < i) j = i;
        while (j < n && T[j] - T[i] < W) j++;
        if (j >= n) break;
        const p = (E[j] - E[i]) / (T[j] - T[i]);
        if (p > best) best = p;
      }
      if (best) bestPower[W] = r(best, 0);
    }
  }

  // --- histogram HR (detik per 5 bpm, hanya saat rekaman kontinu) ---
  const hrHist = {};
  for (let i = 1; i < n; i++) {
    const hr = recs[i].hr, dt = recs[i].t - recs[i - 1].t;
    if (hr == null || dt > GAP_S) continue;
    const b = Math.floor(hr / 5) * 5;
    hrHist[b] = (hrHist[b] || 0) + dt;
  }

  // --- stream ringkas untuk grafik & peta ---
  const step = Math.max(1, Math.ceil(n / MAX_POINTS));
  const idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  const col = (f) => idx.map((i) => f(recs[i], i));
  const anyOf = (k) => recs.some((p) => p[k] != null);
  const streams = {
    t: col((p) => Math.round(p.t - t0)),
    mt: col((_, i) => Math.round(moving[i])),
    d: col((p) => r(p.dist / 1000, 3)),
    lat: anyOf('lat') ? col((p) => r(p.lat, 5)) : null,
    lng: anyOf('lng') ? col((p) => r(p.lng, 5)) : null,
    alt: anyOf('alt') ? col((p) => r(p.alt, 1)) : null,
    spd: col((p) => r((p.spd ?? 0) * 3.6, 1)),
    hr: anyOf('hr') ? col((p) => p.hr) : null,
    cad: anyOf('cad') ? col((p) => p.cad) : null,
    pwr: anyOf('pwr') ? col((p) => p.pwr) : null,
    temp: anyOf('temp') ? col((p) => p.temp) : null,
  };

  const analysis = {
    v: 1,
    seg_len_km: segLen,
    stops,
    stop_count: stops.length,
    longest_stop_s: stops.reduce((m, s) => Math.max(m, s.dur), 0),
    segments,
    laps,
    best: { dist: bestDist, power: bestPower },
    hr_hist: hrHist,
    points: n,
  };
  return { summary, analysis, streams };
}

function normPower(recs) {
  // rolling 30 dtk berbasis waktu
  const vals = [];
  let j = 0, s = 0;
  const q = [];
  for (let i = 0; i < recs.length; i++) {
    const p = recs[i].pwr ?? 0;
    q.push({ t: recs[i].t, p }); s += p;
    while (q.length && recs[i].t - q[0].t > 30) { s -= q.shift().p; }
    if (recs[i].t - recs[0].t >= 30) vals.push(s / q.length);
    j++;
  }
  if (!vals.length) return null;
  const m4 = vals.reduce((a, v) => a + v ** 4, 0) / vals.length;
  return m4 ** 0.25;
}
