// jarwo-gowes.js — jembatan Jarwo (SiMAB) → data Gowes.
// Taruh di simab/js/ dan muat SETELAH supabase-config.js, SEBELUM jarwo.js.
// Hanya akun SiMAB yang emailnya = SIMAB_OWNER_EMAIL (di secret Edge Function) yang dilayani;
// rekan kantor lain akan mendapat 403 dan Jarwo menjawab seperti biasa.
//
// Cara pakai di jarwo.js (detail penyambungannya menyesuaikan isi jarwo.js):
//   if (window.JarwoGowes.isGowesQuestion(teks)) {
//     const ctx = await window.JarwoGowes.context(teks);
//     if (ctx) promptTambahan = window.JarwoGowes.toPrompt(ctx);
//   }

(function () {
  const GOWES_FN = 'https://GANTI-PROJECT-REF-AYYUBI.supabase.co/functions/v1/gowes';

  const KATA = /\b(gowes|sepeda|bersepeda|ride|riding|garmin|edge|km|kilometer|elevasi|tanjakan|cadence|kadens|power|watt|ftp|hr|detak jantung|brevet|audax|ultra|cot|cp|checkpoint|rantai|ban|kampas|sprocket|cassette|servis sepeda)\b/i;
  const ANGGARAN = /\b(pagu|pok|mak|spby|spm|sp2d|kuitansi|perjadin|realisasi|rpd|sbm|anggaran|kegiatan)\b/i;

  function isGowesQuestion(text) {
    if (!text) return false;
    if (ANGGARAN.test(text) && !/\bgowes|sepeda\b/i.test(text)) return false; // istilah anggaran didahulukan
    return KATA.test(text);
  }

  // rentang tanggal sederhana dari kalimat: "bulan lalu", "oktober", "2025", "minggu lalu"
  function rangeFrom(text) {
    const t = text.toLowerCase();
    const now = new Date(Date.now() + 8 * 3600e3);
    const y = now.getUTCFullYear(), m = now.getUTCMonth();
    const iso = (d) => d.toISOString().slice(0, 10);
    const BLN = ['januari', 'februari', 'maret', 'april', 'mei', 'juni', 'juli', 'agustus', 'september', 'oktober', 'november', 'desember'];
    if (/bulan lalu/.test(t)) return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
    if (/minggu lalu|pekan lalu/.test(t)) {
      const dow = (now.getUTCDay() + 6) % 7;
      const s = new Date(now - (dow + 7) * 864e5);
      return { from: iso(s), to: iso(new Date(s.getTime() + 6 * 864e5)) };
    }
    const bi = BLN.findIndex((b) => t.includes(b));
    const ym = t.match(/\b(20\d\d)\b/);
    if (bi >= 0) {
      const yy = ym ? Number(ym[1]) : (bi > m ? y - 1 : y);
      return { from: iso(new Date(Date.UTC(yy, bi, 1))), to: iso(new Date(Date.UTC(yy, bi + 1, 0))) };
    }
    if (ym) return { from: `${ym[1]}-01-01`, to: `${ym[1]}-12-31` };
    return {};
  }

  async function context(text) {
    try {
      const { data } = await sb.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) return null;
      const res = await fetch(GOWES_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-simab-token': token },
        body: JSON.stringify({ action: 'jarwo_context', ...rangeFrom(text || '') }),
      });
      if (!res.ok) return null; // 403 = bukan pemilik → abaikan diam-diam
      return await res.json();
    } catch (e) {
      console.warn('[JarwoGowes]', e);
      return null;
    }
  }

  function toPrompt(ctx) {
    return [
      'DATA GOWES PRIBADI PENGGUNA (dari Garmin Edge, satuan km, km/j, meter, WITA).',
      'Gunakan data ini hanya untuk pertanyaan tentang bersepeda. Jangan mengarang angka yang tidak ada di data.',
      'Kecepatan "bergerak" tidak termasuk waktu berhenti; "waktu total" termasuk berhenti.',
      JSON.stringify(ctx),
    ].join('\n');
  }

  window.JarwoGowes = { isGowesQuestion, context, toPrompt, rangeFrom };
})();
