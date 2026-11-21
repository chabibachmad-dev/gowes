// saran.js — saran otomatis berbasis aturan (tanpa AI) dari data ride & garasi.
// Setiap saran: { ic, lvl: 'bad'|'warn'|'ok'|'info', t: judul, d: penjelasan, href? }

const fmt = (v, d = 1) => Number(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
const DAY = 86400000;

function halves(segs) {
  if (!segs || segs.length < 4) return null;
  const mid = Math.ceil(segs.length / 2);
  const agg = (l) => {
    const d = l.reduce((s, x) => s + (x.to - x.from), 0), t = l.reduce((s, x) => s + x.moving, 0);
    const hrW = l.filter((x) => x.hr), hr = hrW.length ? hrW.reduce((s, x) => s + x.hr * x.moving, 0) / hrW.reduce((s, x) => s + x.moving, 0) : null;
    return { spd: t ? (d / t) * 3600 : null, hr };
  };
  return [agg(segs.slice(0, mid)), agg(segs.slice(mid))];
}

// Saran untuk satu ride (dipakai di halaman detail & beranda)
export function rideTips(r) {
  const a = r.analysis || {};
  const out = [];
  const elapsed = r.elapsed_s ?? r.duration_s, moving = r.moving_s ?? r.duration_s;
  const km = (r.distance_m || 0) / 1000;

  const h = halves(a.segments);
  if (h && h[0].spd && h[1].spd) {
    const drop = (h[1].spd - h[0].spd) / h[0].spd * 100;
    if (drop <= -12) out.push({ ic: '📉', lvl: 'bad', t: `Kecepatan turun ${fmt(-drop, 0)}% di paruh kedua`, d: `${fmt(h[0].spd)} → ${fmt(h[1].spd)} km/j. Biasanya tanda start terlalu kencang atau asupan kurang. Coba tahan 1–2 km/j di 1/3 awal dan makan/minum tiap 30–45 menit.` });
    else if (drop <= -6) out.push({ ic: '📉', lvl: 'warn', t: `Kecepatan turun ${fmt(-drop, 0)}% di paruh kedua`, d: `${fmt(h[0].spd)} → ${fmt(h[1].spd)} km/j. Masih wajar untuk ride panjang; perhatikan pacing di awal.` });
    else if (drop >= 2 && km >= 40) out.push({ ic: '🚀', lvl: 'ok', t: 'Negative split', d: `Paruh kedua lebih cepat (${fmt(h[0].spd)} → ${fmt(h[1].spd)} km/j). Pacing terkontrol.` });

    // HR drift: HR naik sementara kecepatan tidak naik → kelelahan/dehidrasi/panas
    if (h[0].hr && h[1].hr) {
      const hrUp = (h[1].hr - h[0].hr) / h[0].hr * 100;
      const spdChg = (h[1].spd - h[0].spd) / h[0].spd * 100;
      if (hrUp >= 5 && spdChg <= 1) out.push({ ic: '❤️', lvl: hrUp >= 8 ? 'bad' : 'warn', t: `HR naik ${fmt(hrUp, 0)}% tanpa tambah kecepatan`, d: `Rata-rata ${fmt(h[0].hr, 0)} → ${fmt(h[1].hr, 0)} bpm (cardiac drift). Sering karena panas/kurang minum; tambah cairan & elektrolit, atau latih endurance Z2 lebih banyak.` });
    }
  }

  if (elapsed && moving && km >= 20) {
    const stopPct = (elapsed - moving) / elapsed * 100;
    if (stopPct >= 25) out.push({ ic: '⏸️', lvl: 'warn', t: `Waktu berhenti ${fmt(stopPct, 0)}% dari total`, d: `${Math.round((elapsed - moving) / 60)} menit berhenti${a.stop_count ? ` dalam ${a.stop_count} kali` : ''}. Untuk event ber-COT, memangkas berhenti sering lebih mudah daripada menambah kecepatan.` });
  }
  if (a.longest_stop_s >= 1800) out.push({ ic: '☕', lvl: 'info', t: `Berhenti terlama ${Math.round(a.longest_stop_s / 60)} menit`, d: 'Kalau ini di CP, siapkan daftar yang harus dikerjakan (isi botol, makan, toilet) agar singkat.' });
  if (r.avg_cad && r.avg_cad < 70 && km >= 20) out.push({ ic: '🔄', lvl: 'info', t: `Kadens rata-rata ${fmt(r.avg_cad, 0)} rpm`, d: 'Agak rendah. Gigi lebih ringan dengan kadens 80–90 rpm biasanya lebih hemat otot untuk jarak jauh.' });
  if (r.max_temp != null && r.max_temp >= 34) out.push({ ic: '🌡️', lvl: 'info', t: `Suhu sampai ${fmt(r.max_temp, 0)}°C`, d: 'Kondisi panas: target ±500–750 ml cairan per jam plus elektrolit.' });
  return out;
}

// Saran untuk beranda (lintas ride + garasi)
export function homeTips(rides, garage, rideDate, lastDetail) {
  const out = [];
  const now = new Date();
  // perawatan
  for (const p of (garage?.parts || []).filter((x) => x.active && x.pct != null)) {
    if (p.pct >= 1) out.push({ ic: '🔧', lvl: 'bad', t: `${p.name} sudah lewat batas`, d: `${fmt(p.km, 0)} km dari batas ${fmt(p.limit_km, 0)} km. Ganti, lalu tekan "Ganti baru" di Garasi.`, href: '#/garage' });
    else if (p.pct >= 0.9) out.push({ ic: '🔧', lvl: 'warn', t: `${p.name} hampir waktunya ganti`, d: `Sisa ±${fmt(p.limit_km - p.km, 0)} km.`, href: '#/garage' });
  }
  if (!rides.length) return out;

  // jeda tidak gowes
  const last = rideDate(rides[0]);
  const gap = Math.floor((now - last) / DAY);
  if (gap >= 7) out.push({ ic: '🚲', lvl: 'info', t: `${gap} hari belum gowes`, d: 'Ride ringan 1–2 jam di zona santai membantu menjaga kebugaran.' });

  // volume minggu ini vs rata-rata 8 minggu
  const ws = new Date(now.getFullYear(), now.getMonth(), now.getDate()); ws.setDate(ws.getDate() - ((ws.getDay() + 6) % 7));
  const wk = (from, to) => rides.filter((r) => { const d = rideDate(r); return d >= from && d < to; }).reduce((s, r) => s + (r.distance_m || 0) / 1000, 0);
  const thisW = wk(ws, new Date(ws.getTime() + 7 * DAY));
  let sum = 0;
  for (let i = 1; i <= 8; i++) sum += wk(new Date(ws.getTime() - i * 7 * DAY), new Date(ws.getTime() - (i - 1) * 7 * DAY));
  const avg = sum / 8;
  const dow = (now.getDay() + 6) % 7; // 0 = Senin
  if (avg >= 30) {
    if (thisW > avg * 1.5 && thisW - avg > 50) out.push({ ic: '📈', lvl: 'warn', t: `Volume minggu ini ${fmt(thisW, 0)} km`, d: `±${fmt(thisW / avg * 100, 0)}% dari rata-rata 8 minggu (${fmt(avg, 0)} km). Lonjakan besar menaikkan risiko cedera; sisipkan hari pemulihan.` });
    else if (dow >= 4 && thisW < avg * 0.4) out.push({ ic: '📅', lvl: 'info', t: `Minggu ini baru ${fmt(thisW, 0)} km`, d: `Rata-rata 8 minggu terakhir ${fmt(avg, 0)} km/minggu. Akhir pekan bisa jadi kesempatan ride panjang.` });
  }

  // ride terbaru yang sudah dianalisis
  const lastAn = lastDetail;
  if (lastAn && lastAn.analysis) {
    const tips = rideTips(lastAn).filter((t) => t.lvl === 'bad' || t.lvl === 'warn').slice(0, 2);
    for (const t of tips) out.push({ ...t, t: `${t.t} — ${lastAn.name || 'ride terakhir'}`, href: `#/ride/${lastAn.id}` });
  }
  const order = { bad: 0, warn: 1, info: 2, ok: 3 };
  return out.sort((a, b) => order[a.lvl] - order[b.lvl]).slice(0, 6);
}

export function tipsHtml(tips, esc) {
  const col = { bad: 'var(--bad)', warn: 'var(--warn)', ok: 'var(--ok)', info: 'var(--blue)' };
  return tips.map((x) => {
    const inner = `<div class="ic">${x.ic}</div><div class="t"><div style="color:${col[x.lvl]};font-weight:600;font-size:13px">${esc(x.t)}</div><div style="color:var(--tx);font-size:13px">${esc(x.d)}</div></div>`;
    return x.href ? `<a class="rec" href="${x.href}">${inner}</a>` : `<div class="rec">${inner}</div>`;
  }).join('');
}
