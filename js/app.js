import { call, getPin, setPin, ApiError } from './api.js';
import { rideTips, homeTips, tipsHtml } from './saran.js';
import { initChat } from './chat.js';

// ============================================================ state & util
const S = { rides: [], garage: { bikes: [], parts: [] }, settings: { hr_max: 185, ftp: null }, lastSync: null, busy: false };
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
let charts = [], maps = [];

const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const BULAN_P = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const HARI = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (v, d = 1) => (v == null || !isFinite(v) ? '–' : Number(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }));
const km = (m, d = 1) => (m == null ? '–' : nf(m / 1000, d));
const kmh = (ms) => (ms == null ? '–' : nf(ms * 3.6, 1));
function dur(s, withSec = false) {
  if (s == null || !isFinite(s)) return '–';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (withSec && h === 0) return `${m}:${String(sec).padStart(2, '0')}`;
  return `${h}:${String(m).padStart(2, '0')}`;
}
const durWords = (s) => {
  if (s == null) return '–';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} j ${m} m` : `${m} m`;
};
function rideDate(r) {
  const s = r.start_local || r.start_time;
  if (!s) return new Date(NaN);
  if (r.start_local) {
    const [d, t = '00:00:00'] = s.split('T');
    const [y, mo, da] = d.split('-').map(Number);
    const [h, mi] = t.split(':').map(Number);
    return new Date(y, mo - 1, da, h, mi);
  }
  return new Date(s);
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDate = (d) => `${HARI[d.getDay()]}, ${d.getDate()} ${BULAN[d.getMonth()]} ${d.getFullYear()}`;
const fmtTime = (d) => `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
function weekStart(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function cleanup() { charts.forEach((c) => c.destroy()); charts = []; maps.forEach((m) => m.remove()); maps = []; }
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function setTitle(t, back = false) { $('#title').textContent = t; $('#btnBack').hidden = !back; }

// ============================================================ nonaktifkan zoom halaman
// iOS Safari mengabaikan user-scalable=no, jadi cubit-zoom halaman dicegat di sini.
// Peta (Leaflet) tetap bisa di-zoom karena memakai event touch sendiri.
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 && !e.target.closest('.map')) e.preventDefault(); }, { passive: false });
document.addEventListener('wheel', (e) => { if (e.ctrlKey && !e.target.closest('.map')) e.preventDefault(); }, { passive: false });

// ============================================================ theme
function applyTheme() {
  let t = 'dark'; try { t = localStorage.getItem('gowes_theme') || 'dark'; } catch {}
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#0f1115' : '#f4f5f7';
}
applyTheme();

// ============================================================ data
async function loadAll() {
  const [r, g, st] = await Promise.all([call('rides'), call('garage'), call('settings')]);
  S.rides = r.rides || [];
  S.garage = g;
  S.settings = { hr_max: 185, ftp: null, ...(st.settings || {}) };
}
const pending = () => S.rides.filter((r) => !r.analyzed_at && r.source !== 'fit' && r.id > 0);

function updateSyncLabel() {
  const el = $('#syncStatus');
  if (!S.lastSync) { el.textContent = ''; return; }
  const d = new Date(S.lastSync);
  const mins = Math.round((Date.now() - d) / 60000);
  el.textContent = mins < 1 ? 'baru saja' : mins < 60 ? `${mins} mnt lalu` : mins < 1440 ? `${Math.round(mins / 60)} jam lalu` : `${d.getDate()} ${BULAN[d.getMonth()]}`;
}

function banner(html, pct) {
  const b = $('#banner');
  if (!html) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = html + (pct != null ? `<div class="bar"><i style="width:${Math.round(pct * 100)}%"></i></div>` : '');
}

async function doSync(full = false) {
  if (S.busy) return;
  S.busy = true; $('#btnSync').classList.add('spin');
  try {
    let start = 0, total = { inserted: 0, cycling: 0 };
    for (let round = 0; round < 40; round++) {
      banner(full ? `Mengambil riwayat dari Garmin… (${total.cycling} ride ditemukan)` : 'Sinkron dengan Garmin…');
      const res = await call('sync', { full, start });
      total.inserted += res.inserted; total.cycling += res.cycling;
      if (!res.more) break;
      start = res.next_start;
    }
    S.lastSync = new Date().toISOString(); updateSyncLabel();
    await loadAll();
    toast(total.inserted ? `${total.inserted} ride baru dari Garmin` : 'Sudah terbaru');
    banner(null);
    S.busy = false; $('#btnSync').classList.remove('spin');
    render();
    processPending();
  } catch (e) {
    banner(null); toast('Sinkron gagal: ' + e.message, 5000);
  } finally {
    S.busy = false; $('#btnSync').classList.remove('spin');
  }
}

let processing = false;
async function processPending() {
  if (processing) return;
  const list = pending();
  if (!list.length) return;
  processing = true;
  const { decodeAndAnalyze } = await import('./fit-load.js');
  let done = 0, failed = 0;
  for (const r of list) {
    banner(`Menganalisis file FIT… ${done + 1}/${list.length} — ${esc(r.name || '')}`, done / list.length);
    try {
      const bytes = await call('fit', { id: r.id }, { binary: true });
      const res = decodeAndAnalyze(bytes);
      await call('save_analysis', { id: r.id, ...res });
      r.analyzed_at = new Date().toISOString();
    } catch (e) {
      failed++; console.warn('analisis gagal', r.id, e);
      if (e instanceof ApiError && e.status >= 500 && /API key/.test(e.message)) { toast(e.message, 6000); break; }
    }
    done++;
  }
  banner(null);
  processing = false;
  await loadAll();
  if (failed) toast(`${failed} ride gagal dianalisis (lihat Setelan → Analisis ulang)`, 4500);
  render();
}

// ============================================================ router
const routes = [
  [/^#?\/?$/, pageHome, 'home'],
  [/^#\/rides$/, pageRides, 'rides'],
  [/^#\/ride\/(-?\d+)$/, pageRide, 'rides'],
  [/^#\/garage$/, pageGarage, 'garage'],
  [/^#\/settings$/, pageSettings, 'settings'],
];
async function render() {
  cleanup();
  const h = location.hash || '#/';
  for (const [re, fn, tab] of routes) {
    const m = h.match(re);
    if (m) {
      document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
      try { await fn(...m.slice(1)); } catch (e) { view.innerHTML = `<div class="empty"><b>Terjadi kesalahan</b>${esc(e.message)}</div>`; console.error(e); }
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
$('#btnBack').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/rides');
$('#btnSync').onclick = () => doSync(false);

// ============================================================ aggregations
function sumRides(rs) {
  return {
    n: rs.length,
    dist: rs.reduce((s, r) => s + (r.distance_m || 0), 0),
    mov: rs.reduce((s, r) => s + (r.moving_s ?? r.duration_s ?? 0), 0),
    gain: rs.reduce((s, r) => s + (r.elev_gain || 0), 0),
  };
}
function partClass(p) { return p.pct == null ? '' : p.pct >= 0.9 ? 'bad' : p.pct >= 0.7 ? 'warn' : ''; }

// ============================================================ HOME
async function pageHome() {
  setTitle('Gowes');
  const now = new Date();
  const ws = ymd(weekStart(now)), ms = ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ys = `${now.getFullYear()}-01-01`;
  const by = (since) => S.rides.filter((r) => ymd(rideDate(r)) >= since);
  const P = [['Minggu ini', sumRides(by(ws)), true], ['Bulan ini', sumRides(by(ms))], ['Tahun ' + now.getFullYear(), sumRides(by(ys))]];

  if (!S.rides.length) {
    view.innerHTML = `<div class="empty"><b>Belum ada ride</b>Tekan tombol sinkron di kanan atas untuk menarik ride dari Garmin,
      atau ambil seluruh riwayat lewat Setelan → Sinkron penuh.<br><br><button class="btn primary" id="first">Ambil seluruh riwayat</button></div>`;
    $('#first').onclick = () => doSync(true);
    return;
  }

  const recent = S.rides.slice(0, 5);
  view.innerHTML = `
    <div class="periods">${P.map(([l, s, now]) => `
      <div class="period ${now ? 'now' : ''}"><div class="p">${l}</div>
        <div class="km">${km(s.dist, 0)}<small> km</small></div>
        <div class="sub">${s.n} ride · ${dur(s.mov)} j · ${nf(s.gain, 0)} m</div></div>`).join('')}
    </div>
    <div class="card" id="tipsCard" hidden><h3>💡 Saran</h3><div id="tipsBody"></div></div>
    <div class="card">
      <h3><span>Jarak</span><span class="sp"></span>
        <span class="seg" id="segPer"><button data-v="w" class="on">12 minggu</button><button data-v="m">12 bulan</button><button data-v="y">Tahunan</button></span></h3>
      <div class="chart-box"><canvas id="cDist"></canvas></div>
    </div>
    <div class="card"><h3>Ride terbaru<span class="sp"></span><a class="btn sm" href="#/rides">Semua</a></h3>
      <div class="list">${recent.map(rideItem).join('')}</div></div>
    <div class="card"><h3>Rekor pribadi</h3>${records()}</div>`;
  const showTips = (detail) => {
    const tips = homeTips(S.rides, S.garage, rideDate, detail);
    const card = $('#tipsCard'); if (!card) return;
    card.hidden = !tips.length; $('#tipsBody').innerHTML = tipsHtml(tips, esc);
  };
  showTips(null);
  const lastAn = S.rides.find((r) => r.analyzed_at);
  if (lastAn) call('ride', { id: lastAn.id }).then((x) => showTips(x.ride)).catch(() => {});
  const draw = (mode) => {
    charts.forEach((c) => c.destroy()); charts = [];
    const { labels, data } = series(mode);
    charts.push(new Chart($('#cDist'), {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: data.map((_, i) => i === data.length - 1 ? cssVar('--acc') : cssVar('--acc') + '66'), borderRadius: 6 }] },
      options: chartOpts({ y: 'km', tooltip: (c) => `${nf(c.raw, 1)} km` }),
    }));
  };
  $('#segPer').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $('#segPer').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    draw(b.dataset.v);
  };
  await chartReady(); draw('w');
}

function series(mode) {
  const now = new Date();
  const buckets = new Map();
  const labels = [];
  if (mode === 'w') {
    const w0 = weekStart(now);
    for (let i = 11; i >= 0; i--) { const d = new Date(w0); d.setDate(d.getDate() - 7 * i); buckets.set(ymd(d), 0); labels.push(`${d.getDate()} ${BULAN[d.getMonth()]}`); }
    for (const r of S.rides) { const k = ymd(weekStart(rideDate(r))); if (buckets.has(k)) buckets.set(k, buckets.get(k) + (r.distance_m || 0) / 1000); }
  } else if (mode === 'm') {
    for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); buckets.set(ymd(d).slice(0, 7), 0); labels.push(`${BULAN[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`); }
    for (const r of S.rides) { const k = ymd(rideDate(r)).slice(0, 7); if (buckets.has(k)) buckets.set(k, buckets.get(k) + (r.distance_m || 0) / 1000); }
  } else {
    const years = [...new Set(S.rides.map((r) => rideDate(r).getFullYear()))].sort();
    for (const y of years) { buckets.set(String(y), 0); labels.push(String(y)); }
    for (const r of S.rides) { const k = String(rideDate(r).getFullYear()); buckets.set(k, buckets.get(k) + (r.distance_m || 0) / 1000); }
  }
  return { labels, data: [...buckets.values()].map((v) => Math.round(v * 10) / 10) };
}

function records() {
  const R = S.rides;
  if (!R.length) return '<p class="muted">Belum ada data.</p>';
  const top = (f, min = () => true) => R.filter(min).reduce((m, r) => (f(r) != null && (!m || f(r) > f(m)) ? r : m), null);
  const items = [
    ['📏', 'Ride terjauh', top((r) => r.distance_m), (r) => `${km(r.distance_m)} km`],
    ['⛰️', 'Elevasi terbanyak', top((r) => r.elev_gain), (r) => `${nf(r.elev_gain, 0)} m`],
    ['⏱️', 'Waktu bergerak terlama', top((r) => r.moving_s ?? r.duration_s), (r) => dur(r.moving_s ?? r.duration_s) + ' j'],
    ['⚡', 'Rata-rata tercepat (≥ 30 km)', top((r) => r.avg_speed, (r) => r.distance_m >= 30000), (r) => `${kmh(r.avg_speed)} km/j`],
  ];
  // best effort jarak lintas ride (dari analisis FIT)
  const best = {};
  for (const r of R) {
    const b = (r.best || r.analysis?.best)?.dist; if (!b) continue;
    for (const [k, v] of Object.entries(b)) if (!best[k] || v.s < best[k].v.s) best[k] = { v, r };
  }
  const effort = ['40', '100', '200'].filter((k) => best[k]).map((k) =>
    ['🏁', `${k} km tercepat (waktu bergerak)`, best[k].r, () => `${dur(best[k].v.s)} · ${nf(best[k].v.kmh, 1)}`]);
  return [...items, ...effort].filter((x) => x[2]).map(([ic, l, r, v]) => `
    <a class="rec" href="#/ride/${r.id}"><div class="ic">${ic}</div>
      <div class="t"><div>${l}</div><div>${esc(r.name || 'Ride')} · ${fmtDate(rideDate(r))}</div></div>
      <div class="val">${v(r)}</div></a>`).join('');
}

function rideItem(r) {
  const d = rideDate(r);
  return `<a class="ride-item" href="#/ride/${r.id}">
    <div class="d"><b>${d.getDate()}</b><span>${BULAN[d.getMonth()]}</span></div>
    <div style="min-width:0"><div class="n">${esc(r.name || 'Ride')}${r.event ? '<span class="tag">Event</span>' : ''}${!r.analyzed_at && r.id > 0 ? '<span class="tag grey">belum FIT</span>' : ''}</div>
      <div class="m">${HARI[d.getDay()]} ${fmtTime(d)} · ${dur(r.moving_s ?? r.duration_s)} · ${nf(r.elev_gain, 0)} m · ${kmh(r.avg_speed)} km/j</div></div>
    <div class="k">${km(r.distance_m)}<small>km</small></div></a>`;
}

// ============================================================ RIDES
let rideFilter = { year: null, q: '', event: false };
async function pageRides() {
  setTitle('Semua ride');
  const years = [...new Set(S.rides.map((r) => rideDate(r).getFullYear()))].sort((a, b) => b - a);
  if (rideFilter.year == null) rideFilter.year = years[0] ?? new Date().getFullYear();
  const drawList = () => {
    const q = rideFilter.q.toLowerCase();
    const rs = S.rides.filter((r) => (rideFilter.year === 'all' || rideDate(r).getFullYear() === rideFilter.year)
      && (!q || (r.name || '').toLowerCase().includes(q) || (r.location || '').toLowerCase().includes(q))
      && (!rideFilter.event || r.event));
    const groups = new Map();
    for (const r of rs) { const d = rideDate(r); const k = `${BULAN_P[d.getMonth()]} ${d.getFullYear()}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const tot = sumRides(rs);
    $('#rlist').innerHTML = `<p class="muted" style="margin:4px 2px">${rs.length} ride · ${km(tot.dist, 0)} km · ${dur(tot.mov)} jam · ${nf(tot.gain, 0)} m naik</p>` +
      ([...groups].map(([k, list]) => { const s = sumRides(list); return `<div class="month-h"><span>${k}</span><span>${km(s.dist, 0)} km</span></div><div class="list">${list.map(rideItem).join('')}</div>`; }).join('')
        || '<div class="empty">Tidak ada ride yang cocok.</div>');
  };
  view.innerHTML = `
    <input id="q" placeholder="Cari nama ride / lokasi…" value="${esc(rideFilter.q)}" style="margin-bottom:10px">
    <div class="chips">${years.map((y) => `<span class="chip ${rideFilter.year === y ? 'on' : ''}" data-y="${y}">${y}</span>`).join('')}
      <span class="chip ${rideFilter.year === 'all' ? 'on' : ''}" data-y="all">Semua</span>
      <span class="chip ${rideFilter.event ? 'on' : ''}" data-ev="1">🏁 Event</span></div>
    <div id="rlist"></div>`;
  $('#q').oninput = (e) => { rideFilter.q = e.target.value; drawList(); };
  view.querySelector('.chips').onclick = (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    if (c.dataset.ev) rideFilter.event = !rideFilter.event;
    else rideFilter.year = c.dataset.y === 'all' ? 'all' : Number(c.dataset.y);
    pageRides();
  };
  drawList();
}

// ============================================================ RIDE DETAIL
async function pageRide(id) {
  setTitle('Detail ride', true);
  view.innerHTML = '<div class="empty">Memuat…</div>';
  const { ride: r, streams: st } = await call('ride', { id: Number(id) });
  const a = r.analysis || {};
  const d = rideDate(r);
  setTitle(r.name || 'Ride', true);
  const moving = r.moving_s ?? r.duration_s, elapsed = r.elapsed_s ?? r.duration_s;
  const stopped = elapsed != null && moving != null ? Math.max(0, elapsed - moving) : null;
  const bikes = S.garage.bikes || [];

  view.innerHTML = `
    <div class="card">
      <div class="muted" style="font-size:13px">${fmtDate(d)} · ${fmtTime(d)} WITA${r.location ? ' · ' + esc(r.location) : ''}</div>
      <div class="inline" style="margin-top:8px">
        <select id="bikeSel"><option value="">— Tanpa sepeda —</option>${bikes.map((b) => `<option value="${b.id}" ${b.id === r.bike_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
        <button class="btn sm" id="btnEdit">Ubah</button>
      </div>
      <div class="grid g-auto" style="margin-top:12px">
        ${stat('Jarak', km(r.distance_m, 2), 'km', true)}
        ${stat('Waktu bergerak', dur(moving), 'j')}
        ${stat('Waktu total', dur(elapsed), 'j')}
        ${stat('Berhenti', durWords(stopped), '')}
        ${stat('Kec. bergerak', kmh(r.avg_speed), 'km/j')}
        ${stat('Kec. total', r.distance_m && elapsed ? nf(r.distance_m / elapsed * 3.6, 1) : '–', 'km/j')}
        ${stat('Kec. maks', kmh(r.max_speed), 'km/j')}
        ${stat('Elevasi', nf(r.elev_gain, 0) + ' / ' + nf(r.elev_loss, 0), 'm')}
        ${r.avg_hr ? stat('HR rata / maks', `${nf(r.avg_hr, 0)} / ${nf(r.max_hr, 0)}`, 'bpm') : ''}
        ${r.avg_cad ? stat('Kadens', nf(r.avg_cad, 0), 'rpm') : ''}
        ${r.avg_power ? stat('Power rata / NP', `${nf(r.avg_power, 0)} / ${nf(r.norm_power, 0)}`, 'W') : ''}
        ${r.calories ? stat('Kalori', nf(r.calories, 0), 'kkal') : ''}
        ${r.avg_temp != null ? stat('Suhu rata / maks', `${nf(r.avg_temp, 0)} / ${nf(r.max_temp, 0)}`, '°C') : ''}
      </div>
      ${r.note ? `<p style="margin:10px 0 0;white-space:pre-wrap">${esc(r.note)}</p>` : ''}
    </div>
    ${!st ? `<div class="card"><p class="muted" style="margin:0 0 10px">${r.id > 0 ? 'File FIT ride ini belum dianalisis.' : 'Data stream tidak tersedia.'}</p>
      ${r.id > 0 ? '<button class="btn primary" id="btnAnalyze">Analisis sekarang</button>' : ''}</div>` : `
    ${st.lat ? '<div class="card"><h3>Rute</h3><div class="map" id="map"></div></div>' : ''}
    <div class="card"><h3>Profil<span class="sp"></span><span class="seg" id="xAxis"><button data-v="d" class="on">Jarak</button><button data-v="t">Waktu</button></span></h3>
      <div class="chart-box"><canvas id="cProf"></canvas></div>
      ${st.hr || st.pwr || st.cad ? '<div class="chart-box sm" style="margin-top:10px"><canvas id="cBody"></canvas></div>' : ''}</div>
    <div class="card" id="eventCard"></div>
    ${(() => { const t = rideTips(r); return t.length ? `<div class="card"><h3>💡 Saran</h3>${tipsHtml(t, esc)}</div>` : ''; })()}
    ${stopsCard(a)}
    ${segmentsCard(a)}
    ${lapsCard(a)}
    ${bestCard(a)}
    ${hrZoneCard(a)}
    <div class="row-btns"><button class="btn" id="btnAnalyze">Analisis ulang FIT</button>${r.id < 0 ? '<button class="btn danger" id="btnDel">Hapus ride</button>' : ''}</div>`}`;

  $('#bikeSel').onchange = async (e) => {
    await call('update_ride', { id: r.id, patch: { bike_id: e.target.value || null } });
    const x = S.rides.find((q) => q.id === r.id); if (x) x.bike_id = e.target.value || null;
    S.garage = await call('garage'); toast('Sepeda disimpan');
  };
  $('#btnEdit').onclick = () => editRide(r);
  const an = $('#btnAnalyze');
  if (an) an.onclick = async () => {
    an.disabled = true; an.textContent = 'Menganalisis…';
    try {
      const { decodeAndAnalyze } = await import('./fit-load.js');
      const bytes = await call('fit', { id: r.id }, { binary: true });
      await call('save_analysis', { id: r.id, ...decodeAndAnalyze(bytes) });
      await loadAll(); toast('Analisis selesai'); render();
    } catch (e) { toast('Gagal: ' + e.message, 5000); an.disabled = false; an.textContent = 'Coba lagi'; }
  };
  const del = $('#btnDel');
  if (del) del.onclick = async () => {
    if (!confirm('Hapus ride impor ini?')) return;
    await call('delete_ride', { id: r.id }); await loadAll(); location.hash = '#/rides';
  };
  if (!st) return;

  await chartReady();
  if (st.lat) drawMap(st, a);
  let axis = 'd';
  const drawProf = () => {
    charts.forEach((c) => c.destroy()); charts = [];
    drawProfile(st, axis);
    if (st.hr || st.pwr || st.cad) drawBody(st, axis);
    drawEvent(r, st);
  };
  $('#xAxis').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    axis = b.dataset.v; $('#xAxis').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); drawProf();
  };
  drawProf();
}

const stat = (l, v, u, hl) => `<div class="stat ${hl ? 'hl' : ''}"><div class="l">${l}</div><div class="v">${v}<small>${u}</small></div></div>`;

function thin(st, max = 900) {
  const n = st.t.length, step = Math.max(1, Math.ceil(n / max)), idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return idx;
}
function xs(st, axis, i) { return axis === 'd' ? st.d[i] : st.t[i] / 3600; }
function xTitle(axis) { return axis === 'd' ? 'km' : 'jam sejak start'; }

function drawProfile(st, axis) {
  const idx = thin(st);
  const sets = [];
  if (st.alt) sets.push({ label: 'Elevasi (m)', data: idx.map((i) => ({ x: xs(st, axis, i), y: st.alt[i] })), yAxisID: 'y1',
    borderColor: cssVar('--mut'), backgroundColor: cssVar('--mut') + '33', fill: true, pointRadius: 0, borderWidth: 1, tension: .2 });
  // kecepatan dihaluskan (rata-rata bergulir 5 titik)
  const sp = idx.map((i) => st.spd[i]);
  const sm = sp.map((_, k) => { const w = sp.slice(Math.max(0, k - 2), k + 3); return w.reduce((a, b) => a + b, 0) / w.length; });
  sets.push({ label: 'Kecepatan (km/j)', data: idx.map((i, k) => ({ x: xs(st, axis, i), y: Math.round(sm[k] * 10) / 10 })), yAxisID: 'y',
    borderColor: cssVar('--acc'), pointRadius: 0, borderWidth: 1.6, tension: .25 });
  charts.push(new Chart($('#cProf'), { type: 'line', data: { datasets: sets }, options: lineOpts(axis, { y: 'km/j', y1: st.alt ? 'm' : null }) }));
}
function drawBody(st, axis) {
  const idx = thin(st, 700), sets = [];
  if (st.hr) sets.push({ label: 'HR (bpm)', data: idx.map((i) => ({ x: xs(st, axis, i), y: st.hr[i] })), borderColor: cssVar('--bad'), pointRadius: 0, borderWidth: 1.4, yAxisID: 'y' });
  if (st.cad) sets.push({ label: 'Kadens (rpm)', data: idx.map((i) => ({ x: xs(st, axis, i), y: st.cad[i] })), borderColor: cssVar('--blue'), pointRadius: 0, borderWidth: 1, yAxisID: 'y', hidden: !!st.hr });
  if (st.pwr) sets.push({ label: 'Power (W)', data: idx.map((i) => ({ x: xs(st, axis, i), y: st.pwr[i] })), borderColor: cssVar('--warn'), pointRadius: 0, borderWidth: 1, yAxisID: 'y1' });
  charts.push(new Chart($('#cBody'), { type: 'line', data: { datasets: sets }, options: lineOpts(axis, { y: '', y1: st.pwr ? 'W' : null }, true) }));
}

function drawMap(st, a) {
  const pts = [];
  for (let i = 0; i < st.lat.length; i++) if (st.lat[i] != null && st.lng[i] != null) pts.push([st.lat[i], st.lng[i]]);
  if (!pts.length) { $('#map').closest('.card').remove(); return; }
  const m = L.map('map', { zoomControl: true, attributionControl: true });
  maps.push(m);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(m);
  const line = L.polyline(pts, { color: cssVar('--acc'), weight: 4, opacity: .9 }).addTo(m);
  L.circleMarker(pts[0], { radius: 7, color: '#fff', weight: 2, fillColor: cssVar('--ok'), fillOpacity: 1 }).addTo(m).bindPopup('Start');
  L.circleMarker(pts[pts.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: cssVar('--bad'), fillOpacity: 1 }).addTo(m).bindPopup('Finish');
  for (const s of a.stops || []) {
    if (s.lat == null || s.dur < 180) continue;
    const c = new Date(s.clock);
    L.circleMarker([s.lat, s.lng], { radius: Math.min(12, 4 + s.dur / 600), color: cssVar('--warn'), weight: 2, fillOpacity: .35 })
      .addTo(m).bindPopup(`<b>Berhenti ${durWords(s.dur)}</b><br>km ${nf(s.km, 1)} · ${fmtTime(c)}`);
  }
  m.fitBounds(line.getBounds(), { padding: [16, 16] });
  setTimeout(() => m.invalidateSize(), 120);
}

function stopsCard(a) {
  const stops = a.stops || [];
  if (!stops.length) return '';
  const total = stops.reduce((s, x) => s + x.dur, 0);
  const shown = stops.filter((s) => s.dur >= 120);
  return `<div class="card"><h3>Berhenti<span class="sp"></span><span class="muted" style="text-transform:none">${stops.length}× · ${durWords(total)}</span></h3>
    <p class="muted" style="margin:0 0 6px;font-size:12px">Berhenti ≥ 1 menit (termasuk auto-pause). Kuning = ≥ 15 menit. Tabel menampilkan yang ≥ 2 menit.</p>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>#</th><th>Jam</th><th>Km</th><th>Lama</th><th>Sejak start</th></tr></thead><tbody>
    ${shown.map((s, i) => `<tr class="${s.dur >= 900 ? 'long' : ''}"><td>${i + 1}</td><td>${fmtTime(new Date(s.clock))}</td><td>${nf(s.km, 1)}</td><td>${durWords(s.dur)}</td><td>${dur(s.at)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

function segmentsCard(a) {
  const sg = a.segments || [];
  if (sg.length < 2) return '';
  const first = sg.slice(0, Math.ceil(sg.length / 2)), last = sg.slice(Math.ceil(sg.length / 2));
  const avg = (l) => { const d = l.reduce((s, x) => s + (x.to - x.from), 0), t = l.reduce((s, x) => s + x.moving, 0); return t ? d / t * 3600 : null; };
  const a1 = avg(first), a2 = avg(last), drop = a1 && a2 ? (a2 - a1) / a1 * 100 : null;
  return `<div class="card"><h3>Segmen per ${a.seg_len_km} km</h3>
    ${drop != null ? `<p style="margin:0 0 8px;font-size:13px">Paruh pertama <b class="num">${nf(a1, 1)}</b> km/j → paruh kedua <b class="num">${nf(a2, 1)}</b> km/j
      (<b style="color:${drop < -10 ? 'var(--bad)' : drop < -4 ? 'var(--warn)' : 'var(--ok)'}">${drop > 0 ? '+' : ''}${nf(drop, 1)}%</b>)</p>` : ''}
    <div class="scroll-x"><table class="tbl"><thead><tr><th>Km</th><th>Kec.</th><th>Bergerak</th><th>Total</th><th>Naik</th>${sg.some((s) => s.hr) ? '<th>HR</th>' : ''}${sg.some((s) => s.pwr) ? '<th>W</th>' : ''}</tr></thead><tbody>
    ${sg.map((s) => `<tr><td>${nf(s.from, 0)}–${nf(s.to, 0)}</td><td>${nf(s.speed, 1)}</td><td>${dur(s.moving)}</td><td>${dur(s.elapsed)}</td><td>${nf(s.gain, 0)}</td>${sg.some((x) => x.hr) ? `<td>${nf(s.hr, 0)}</td>` : ''}${sg.some((x) => x.pwr) ? `<td>${nf(s.pwr, 0)}</td>` : ''}</tr>`).join('')}
    </tbody></table></div></div>`;
}

function lapsCard(a) {
  const laps = a.laps || [];
  if (laps.length < 2) return '';
  return `<div class="card"><h3>Lap (dari Edge)</h3><div class="scroll-x"><table class="tbl"><thead><tr><th>#</th><th>Km</th><th>Waktu</th><th>Kec.</th><th>Naik</th><th>HR</th></tr></thead><tbody>
    ${laps.map((l) => `<tr><td>${l.no}</td><td>${nf(l.dist, 2)}</td><td>${dur(l.timer, true)}</td><td>${nf(l.speed, 1)}</td><td>${nf(l.gain, 0)}</td><td>${nf(l.hr, 0)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

function bestCard(a) {
  const bd = a.best?.dist || {}, bp = a.best?.power || {};
  if (!Object.keys(bd).length && !Object.keys(bp).length) return '';
  const pl = { 5: '5 dtk', 60: '1 mnt', 300: '5 mnt', 1200: '20 mnt', 3600: '60 mnt' };
  return `<div class="card"><h3>Best effort</h3><div class="grid g-auto">
    ${Object.entries(bd).map(([k, v]) => stat(`${k} km`, dur(v.s, true), `· ${nf(v.kmh, 1)} km/j`)).join('')}
    ${Object.entries(bp).map(([k, v]) => stat(`Power ${pl[k]}`, nf(v, 0), 'W')).join('')}
  </div></div>`;
}

function hrZoneCard(a) {
  const h = a.hr_hist; if (!h || !Object.keys(h).length) return '';
  const max = S.settings.hr_max || 185;
  const Z = [['Z1', 0, .6, '#7d8597'], ['Z2', .6, .7, '#4ea8ff'], ['Z3', .7, .8, '#43d17a'], ['Z4', .8, .9, '#ffc23d'], ['Z5', .9, 9, '#ff5468']];
  const secs = Z.map(() => 0);
  for (const [b, s] of Object.entries(h)) { const p = (Number(b) + 2.5) / max; const zi = Z.findIndex(([, lo, hi]) => p >= lo && p < hi); secs[zi < 0 ? 0 : zi] += s; }
  const tot = secs.reduce((a, b) => a + b, 0) || 1;
  return `<div class="card"><h3>Zona detak jantung<span class="sp"></span><span class="muted" style="text-transform:none">HR maks ${max}</span></h3>
    ${Z.map(([z, lo, hi, c], i) => `<div class="zone"><b>${z}</b><div class="zb"><i style="width:${secs[i] / tot * 100}%;background:${c}"></i></div><span class="num">${dur(secs[i])} · ${Math.round(secs[i] / tot * 100)}%</span></div>`).join('')}
    <p class="muted" style="font-size:11px;margin:6px 0 0">Z1 &lt;60% · Z2 60–70% · Z3 70–80% · Z4 80–90% · Z5 &gt;90% HR maks. Ubah HR maks di Setelan.</p></div>`;
}

// ---------- Event / COT
function drawEvent(r, st) {
  const card = $('#eventCard'); if (!card) return;
  const ev = r.event;
  if (!ev) {
    card.innerHTML = `<h3>Event / COT</h3><p class="muted" style="margin:0 0 10px">Tandai ride ini sebagai event (brevet, ultra, audax) untuk melihat pacing terhadap batas waktu (COT).</p>
      <button class="btn" id="btnEv">🏁 Tandai sebagai event</button>`;
    $('#btnEv').onclick = () => editEvent(r);
    return;
  }
  const target = ev.target_km || (r.distance_m || 0) / 1000;
  const cotS = ev.cot_h * 3600;
  const reqKmh = target / ev.cot_h;
  const finishS = st.t[st.t.length - 1];
  const doneKm = st.d[st.d.length - 1];
  const finished = doneKm >= target * 0.97;
  // buffer waktu di setiap titik: waktu "jatah" untuk jarak itu dikurangi waktu sebenarnya
  let minBuf = Infinity, minAt = 0;
  for (let i = 0; i < st.t.length; i++) {
    const buf = (st.d[i] / reqKmh) * 3600 - st.t[i];
    if (st.t[i] > 1800 && buf < minBuf) { minBuf = buf; minAt = i; }
  }
  const sisa = cotS - finishS;
  const ok = finished && sisa >= 0;
  card.innerHTML = `<h3>${esc(ev.label || 'Event')}<span class="sp"></span><button class="btn sm" id="btnEv">Ubah</button></h3>
    <div class="verdict ${ok ? 'ok' : 'bad'}"><div class="big">${finished ? (sisa >= 0 ? '−' + dur(sisa) : '+' + dur(-sisa)) : 'DNF?'}</div>
      <div style="font-size:13px">${finished
        ? (sisa >= 0 ? `Finish ${dur(finishS)} dari COT ${ev.cot_h} jam — sisa <b>${durWords(sisa)}</b>.` : `Melewati COT ${durWords(-sisa)}.`)
        : `Tercatat ${nf(doneKm, 1)} dari ${nf(target, 0)} km.`}
        <br><span class="muted">Pacing minimum ${nf(reqKmh, 1)} km/j (waktu total). Rata-rata total Anda ${nf(doneKm / finishS * 3600, 1)} km/j.</span></div></div>
    <p style="font-size:13px;margin:0 0 8px">Paling mepet: km <b class="num">${nf(st.d[minAt], 0)}</b> (jam ke-${nf(st.t[minAt] / 3600, 1)}), cadangan waktu
      <b class="num" style="color:${minBuf < 3600 ? 'var(--bad)' : minBuf < 7200 ? 'var(--warn)' : 'var(--ok)'}">${minBuf >= 0 ? durWords(minBuf) : '−' + durWords(-minBuf)}</b>.</p>
    <div class="chart-box"><canvas id="cEv"></canvas></div>
    <p class="muted" style="font-size:11px;margin:6px 0 0">Garis oranye = jarak Anda terhadap waktu sejak start. Garis putus-putus = jarak minimum agar finish tepat di COT. Jarak antar-garis = cadangan waktu.</p>`;
  $('#btnEv').onclick = () => editEvent(r);
  const idx = thin(st, 600);
  charts.push(new Chart($('#cEv'), {
    type: 'line',
    data: { datasets: [
      { label: 'Anda', data: idx.map((i) => ({ x: st.t[i] / 3600, y: st.d[i] })), borderColor: cssVar('--acc'), pointRadius: 0, borderWidth: 2 },
      { label: 'Batas COT', data: [{ x: 0, y: 0 }, { x: ev.cot_h, y: target }], borderColor: cssVar('--mut'), borderDash: [6, 5], pointRadius: 0, borderWidth: 1.5 },
    ] },
    options: lineOpts('t', { y: 'km' }, true),
  }));
}

function editEvent(r) {
  const ev = r.event || { label: r.name || '', cot_h: '', target_km: r.distance_m ? Math.round(r.distance_m / 1000) : '' };
  modal(`<h3>Event / COT</h3>
    <label class="f">Nama event</label><input name="label" value="${esc(ev.label)}" placeholder="mis. ROJ Ultra 300">
    <div class="grid g2"><div><label class="f">COT (jam)</label><input name="cot_h" type="number" step="0.5" min="1" value="${esc(ev.cot_h)}" required></div>
    <div><label class="f">Jarak resmi (km)</label><input name="target_km" type="number" step="1" min="1" value="${esc(ev.target_km)}" required></div></div>`,
  async (f) => {
    const event = f.get('cot_h') ? { label: f.get('label'), cot_h: Number(f.get('cot_h')), target_km: Number(f.get('target_km')) } : null;
    await call('update_ride', { id: r.id, patch: { event } });
    const x = S.rides.find((q) => q.id === r.id); if (x) x.event = event;
    render();
  }, r.event ? 'Hapus tanda event' : null, async () => {
    await call('update_ride', { id: r.id, patch: { event: null } });
    const x = S.rides.find((q) => q.id === r.id); if (x) x.event = null; render();
  });
}

function editRide(r) {
  modal(`<h3>Ubah ride</h3><label class="f">Nama</label><input name="name" value="${esc(r.name)}">
    <label class="f">Catatan</label><textarea name="note" rows="4" placeholder="Kondisi jalan, cuaca, makan di CP…">${esc(r.note)}</textarea>`,
  async (f) => {
    const patch = { name: f.get('name'), note: f.get('note') || null };
    await call('update_ride', { id: r.id, patch });
    const x = S.rides.find((q) => q.id === r.id); if (x) Object.assign(x, patch);
    render();
  });
}

// ============================================================ GARAGE
function partRow(p) {
  const bike = (S.garage.bikes || []).find((b) => b.id === p.bike_id);
  const pct = p.pct == null ? null : Math.min(1, p.pct);
  return `<div class="part"><div class="row"><span class="nm">${esc(p.name)}</span><span class="km">${nf(p.km, 0)}${p.limit_km ? ' / ' + nf(p.limit_km, 0) : ''} km</span></div>
    ${pct != null ? `<div class="pbar"><i class="${partClass(p)}" style="width:${pct * 100}%"></i></div>` : ''}
    <div class="muted" style="font-size:12px">${bike ? esc(bike.name) + ' · ' : ''}dipasang ${esc(p.installed_at)}${p.pct >= 1 ? ' · <b style="color:var(--bad)">waktunya ganti</b>' : ''}</div>
    <div class="acts"><button class="btn sm" data-replace="${p.id}">Ganti baru</button><button class="btn sm" data-edit="${p.id}">Ubah</button></div></div>`;
}
function bindPartActs(root) {
  root.querySelectorAll('[data-replace]').forEach((b) => b.onclick = async () => {
    const p = S.garage.parts.find((x) => x.id === b.dataset.replace);
    if (!confirm(`Catat "${p.name}" sudah diganti baru hari ini? Hitungan km dimulai dari 0.`)) return;
    await call('replace_part', { id: p.id }); S.garage = await call('garage'); toast('Komponen baru dicatat'); render();
  });
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => editPart(S.garage.parts.find((x) => x.id === b.dataset.edit)));
}

const PRESET = [['Rantai', 3000], ['Ban depan', 6000], ['Ban belakang', 4000], ['Kampas rem', 2500], ['Cassette / sprocket', 12000],
  ['Chainring', 20000], ['Kabel shifter', 8000], ['Bar tape / grip', 6000], ['Servis berkala', 1500], ['Lainnya', null]];

async function pageGarage() {
  setTitle('Garasi');
  S.garage = await call('garage');
  const { bikes, parts } = S.garage;
  view.innerHTML = `${bikes.map((b) => {
    const ps = parts.filter((p) => p.bike_id === b.id && p.active);
    return `<div class="card"><h3><span>${esc(b.name)}</span>${b.is_default ? '<span class="tag">utama</span>' : ''}<span class="sp"></span><button class="btn sm" data-bike="${b.id}">Ubah</button></h3>
      <div class="muted" style="font-size:13px;margin:-4px 0 6px">${b.note ? esc(b.note) + ' · ' : ''}<span class="num">${nf(b.km, 0)}</span> km tercatat</div>
      ${ps.map(partRow).join('') || '<p class="muted">Belum ada komponen yang dipantau.</p>'}
      <button class="btn sm" data-addpart="${b.id}" style="margin-top:8px">+ Komponen</button></div>`;
  }).join('')}
  <button class="btn block" id="addBike">+ Tambah sepeda</button>
  ${parts.some((p) => !p.active) ? `<div class="card" style="margin-top:12px"><h3>Riwayat penggantian</h3><div class="scroll-x"><table class="tbl"><thead><tr><th>Komponen</th><th>Dipasang</th><th>Diganti</th><th>Km</th></tr></thead><tbody>
    ${parts.filter((p) => !p.active).sort((a, b) => (b.replaced_at || '').localeCompare(a.replaced_at || '')).map((p) => `<tr><td style="font-family:var(--font)">${esc(p.name)}</td><td>${p.installed_at}</td><td>${p.replaced_at}</td><td>${nf(p.km, 0)}</td></tr>`).join('')}
  </tbody></table></div></div>` : ''}`;
  bindPartActs(view);
  view.querySelectorAll('[data-addpart]').forEach((b) => b.onclick = () => editPart({ bike_id: b.dataset.addpart }));
  view.querySelectorAll('[data-bike]').forEach((b) => b.onclick = () => editBike(bikes.find((x) => x.id === b.dataset.bike)));
  $('#addBike').onclick = () => editBike({});
}

function editBike(b) {
  modal(`<h3>${b.id ? 'Ubah' : 'Tambah'} sepeda</h3>
    <label class="f">Nama</label><input name="name" value="${esc(b.name)}" required>
    <label class="f">Keterangan</label><input name="note" value="${esc(b.note)}" placeholder="mis. frame besi, ban 700x45">
    <label class="inline" style="margin-top:12px;font-size:14px"><input type="checkbox" name="is_default" style="width:auto" ${b.is_default || !b.id ? 'checked' : ''}> Sepeda utama (ride baru otomatis ke sini)</label>`,
  async (f) => {
    await call('save_bike', { bike: { id: b.id, name: f.get('name'), note: f.get('note'), is_default: !!f.get('is_default') } });
    render();
  }, b.id ? 'Hapus sepeda' : null, async () => {
    if (!confirm('Hapus sepeda beserta daftar komponennya? Ride tetap ada.')) return;
    await call('delete_bike', { id: b.id }); render();
  });
}

function editPart(p) {
  const today = ymd(new Date());
  modal(`<h3>${p.id ? 'Ubah' : 'Tambah'} komponen</h3>
    ${p.id ? '' : `<label class="f">Pilih cepat</label><select id="preset">${PRESET.map(([n, l]) => `<option value="${n}" data-l="${l ?? ''}">${n}${l ? ` (${l} km)` : ''}</option>`).join('')}</select>`}
    <label class="f">Nama</label><input name="name" value="${esc(p.name ?? 'Rantai')}" required>
    <div class="grid g2"><div><label class="f">Dipasang tanggal</label><input name="installed_at" type="date" value="${esc(p.installed_at ?? today)}" required></div>
    <div><label class="f">Batas ganti (km)</label><input name="limit_km" type="number" min="0" value="${esc(p.limit_km ?? 3000)}"></div></div>
    <label class="f">Km yang sudah terpakai sebelum dicatat</label><input name="offset_km" type="number" min="0" value="${esc(p.offset_km ?? 0)}">
    <p class="muted" style="font-size:12px;margin:6px 0 0">Km dihitung dari ride sepeda ini sejak tanggal pasang, ditambah km awal di atas.</p>`,
  async (f) => {
    await call('save_part', { part: { id: p.id, bike_id: p.bike_id, name: f.get('name'), installed_at: f.get('installed_at'), limit_km: f.get('limit_km'), offset_km: f.get('offset_km') } });
    S.garage = await call('garage'); render();
  }, p.id ? 'Hapus komponen' : null, async () => {
    await call('delete_part', { id: p.id }); S.garage = await call('garage'); render();
  });
  const pre = $('#preset');
  if (pre) pre.onchange = () => {
    const o = pre.selectedOptions[0];
    $('#modalForm [name=name]').value = o.value === 'Lainnya' ? '' : o.value;
    $('#modalForm [name=limit_km]').value = o.dataset.l;
  };
}

// ============================================================ SETTINGS
async function pageSettings() {
  setTitle('Setelan');
  const ping = await call('ping').catch(() => ({}));
  const ls = ping.last_sync;
  const ge = ping.garmin_error;
  let theme = 'dark'; try { theme = localStorage.getItem('gowes_theme') || 'dark'; } catch {}
  view.innerHTML = `
    <div class="card"><h3>Garmin</h3>
      <p style="margin:0 0 4px">Sinkron terakhir: <b>${ls?.date ? fmtDate(new Date(ls.date)) + ' ' + fmtTime(new Date(ls.date)) : 'belum pernah'}</b></p>
      ${ls?.result ? `<p class="muted" style="margin:0 0 8px;font-size:13px">${ls.result.cycling} ride sepeda diperiksa, ${ls.result.inserted} baru.</p>` : ''}
      ${ge && (!ls?.date || ge.at > ls.date) ? `<p class="error" style="margin-bottom:8px">Error Garmin terakhir (${ge.status}) — ${esc(ge.body || '')}</p>` : ''}
      <p class="muted" style="font-size:13px">${S.rides.length} ride tersimpan · ${pending().length} belum dianalisis.</p>
      <div class="row-btns"><button class="btn primary" id="sFull">Sinkron penuh (seluruh riwayat)</button>
        ${pending().length ? '<button class="btn" id="sPend">Analisis yang tertunda</button>' : ''}</div>
      <label class="f" style="margin-top:14px">Impor file .FIT manual (langsung dari folder Garmin/Activity di Edge)</label>
      <input type="file" id="fitIn" accept=".fit,.zip" multiple>
    </div>
    <div class="card"><h3>Profil latihan</h3>
      <div class="grid g2"><div><label class="f">HR maksimum (bpm)</label><input id="hrMax" type="number" value="${esc(S.settings.hr_max)}"></div>
      <div><label class="f">FTP (W, opsional)</label><input id="ftp" type="number" value="${esc(S.settings.ftp)}"></div></div>
      <button class="btn" id="saveSet" style="margin-top:10px">Simpan</button></div>
    <div class="card"><h3>Tampilan</h3>
      <span class="seg" id="themeSeg"><button data-v="dark" class="${theme === 'dark' ? 'on' : ''}">Gelap</button><button data-v="light" class="${theme === 'light' ? 'on' : ''}">Terang</button></span></div>
    <div class="card"><h3>Akun</h3><p class="muted" style="font-size:13px;margin-top:0">Data disimpan di Supabase Ayyubi dan hanya bisa dibuka dengan kode akses. Jarwo di SiMAB membacanya lewat akun NIP Anda.</p>
      <button class="btn danger" id="logout">Keluar dari perangkat ini</button></div>`;
  $('#sFull').onclick = () => doSync(true);
  const sp = $('#sPend'); if (sp) sp.onclick = () => processPending();
  $('#saveSet').onclick = async () => {
    const set = { hr_max: Number($('#hrMax').value) || 185, ftp: Number($('#ftp').value) || null };
    const r = await call('settings', { set }); S.settings = r.settings; toast('Tersimpan');
  };
  $('#themeSeg').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try { localStorage.setItem('gowes_theme', b.dataset.v); } catch {}
    applyTheme(); render();
  };
  $('#logout').onclick = () => { setPin(''); location.reload(); };
  $('#fitIn').onchange = async (e) => {
    const files = [...e.target.files]; if (!files.length) return;
    const { decodeAndAnalyze } = await import('./fit-load.js');
    let ok = 0;
    for (const [i, f] of files.entries()) {
      banner(`Mengimpor ${i + 1}/${files.length}: ${esc(f.name)}`, i / files.length);
      try {
        const res = decodeAndAnalyze(new Uint8Array(await f.arrayBuffer()));
        const t = new Date(res.summary.start_time).getTime();
        // cocokkan dengan ride Garmin yang sudah ada (selisih start < 2 menit)
        const match = S.rides.find((r) => Math.abs(new Date(r.start_time).getTime() - t) < 120000);
        await call('save_analysis', { id: match ? match.id : -Math.floor(t / 1000), create: !match, name: f.name.replace(/\.(fit|zip)$/i, ''), ...res });
        ok++;
      } catch (err) { toast(`${f.name}: ${err.message}`, 5000); }
    }
    banner(null); await loadAll(); toast(`${ok} file diimpor`); e.target.value = '';
  };
}

// ============================================================ modal & chart helpers
function modal(inner, onSave, dangerLabel, onDanger) {
  const dlg = $('#modal'), form = $('#modalForm');
  form.innerHTML = inner + `<div class="row-btns" style="margin-top:16px;justify-content:flex-end">
    ${dangerLabel ? `<button type="button" class="btn danger" id="mDanger" style="margin-right:auto">${dangerLabel}</button>` : ''}
    <button type="button" class="btn" id="mCancel">Batal</button><button class="btn primary" type="submit">Simpan</button></div>`;
  $('#mCancel').onclick = () => dlg.close();
  if (dangerLabel) $('#mDanger').onclick = async () => { dlg.close(); await onDanger(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try { await onSave(new FormData(form)); dlg.close(); } catch (err) { toast(err.message, 4000); btn.disabled = false; }
  };
  dlg.showModal();
}

function chartReady() {
  return new Promise((res) => {
    const ok = () => window.Chart && window.L;
    if (ok()) return res();
    const t = setInterval(() => { if (ok()) { clearInterval(t); res(); } }, 50);
  });
}
function baseScales() {
  const g = cssVar('--line'), m = cssVar('--mut');
  return { grid: { color: g }, ticks: { color: m, font: { size: 11 } }, border: { color: g } };
}
function chartOpts({ y, tooltip }) {
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: tooltip } } },
    scales: { x: { ...baseScales(), grid: { display: false } }, y: { ...baseScales(), title: { display: !!y, text: y, color: cssVar('--mut') } } },
  };
}
function lineOpts(axis, { y, y1 }, legend = false) {
  const sc = {
    x: { type: 'linear', ...baseScales(), title: { display: true, text: xTitle(axis), color: cssVar('--mut') },
      ticks: { ...baseScales().ticks, callback: (v) => axis === 't' ? dur(v * 3600) : v } },
    y: { ...baseScales(), position: 'left', title: { display: !!y, text: y, color: cssVar('--mut') } },
  };
  if (y1) sc.y1 = { ...baseScales(), position: 'right', grid: { display: false }, title: { display: true, text: y1, color: cssVar('--mut') } };
  return {
    responsive: true, maintainAspectRatio: false, animation: false, parsing: false, normalized: true,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: legend, labels: { color: cssVar('--mut'), boxWidth: 12, font: { size: 11 } } },
      tooltip: { callbacks: { title: (it) => it.length ? (axis === 'd' ? `km ${nf(it[0].parsed.x, 1)}` : `jam ${dur(it[0].parsed.x * 3600)}`) : '' } } },
    scales: sc,
  };
}

// ============================================================ boot
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!getPin()) return showLogin();
  try {
    view.innerHTML = '<div class="empty">Memuat data…</div>';
    const p = await call('ping');
    initChat(() => { const m = (location.hash || '').match(/^#\/ride\/(-?\d+)$/); return m ? Number(m[1]) : null; });
    S.lastSync = p.last_sync?.date || null; updateSyncLabel(); setInterval(updateSyncLabel, 60000);
    await loadAll();
    render();
    // sinkron otomatis bila terakhir > 30 menit lalu, lalu analisis FIT yang tertunda
    if (!S.lastSync || Date.now() - new Date(S.lastSync) > 30 * 60000) doSync(false);
    else processPending();
  } catch (e) {
    if (e.status === 401) { setPin(''); return showLogin('Kode akses tidak berlaku.'); }
    view.innerHTML = `<div class="empty"><b>Tidak bisa terhubung</b>${esc(e.message)}<br><br><button class="btn" onclick="location.reload()">Coba lagi</button></div>`;
  }
}
function showLogin(msg = '') {
  $('#login').hidden = false; $('#loginErr').textContent = msg;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const pin = $('#pinInput').value.trim();
    const btn = e.target.querySelector('button'); btn.disabled = true; $('#loginErr').textContent = '';
    try { await call('ping', {}, { pin }); setPin(pin); $('#login').hidden = true; boot(); }
    catch (err) { $('#loginErr').textContent = err.status === 401 ? 'Kode akses salah' : err.message; }
    finally { btn.disabled = false; }
  };
}
boot();
