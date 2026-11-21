# Gowes — PWA analisis ride dari Garmin Edge

PWA pribadi untuk menarik ride dari **Garmin Connect Personal API**, menganalisis file .FIT,
dan memantau perawatan sepeda. Data disimpan di **Supabase Ayyubi** dan bisa ditanyakan ke **Jarwo** di SiMAB.

```
Garmin Connect ──(Personal API, pull)──► Edge Function "gowes" ──► tabel gowes_* (Supabase Ayyubi)
                                              ▲        ▲
                            PWA Gowes (kode akses)     Jarwo di SiMAB (token login NIP Anda)
```

File .FIT diunduh lewat Edge Function, tapi **dibuka & dianalisis di HP/laptop** (bukan di server),
karena Edge Function Supabase hanya diberi waktu CPU ±2 detik per permintaan.

## Isi folder

| Path | Fungsi |
|---|---|
| `index.html`, `css/`, `js/`, `manifest.json`, `sw.js`, `icons/` | PWA (unggah ke GitHub Pages) |
| `js/config.js` | **Isi URL & anon key Supabase Ayyubi** |
| `js/fit-analyze.js` | Analisis FIT: berhenti, segmen, lap, best effort, zona HR |
| `supabase/schema.sql` | Tabel `gowes_*` + jadwal sinkron tiap jam |
| `supabase/functions/gowes/index.ts` | Edge Function (Garmin, data, Jarwo) |
| `js/saran.js` | Saran otomatis (pacing, berhenti, HR drift, volume, perawatan) |

## Langkah pemasangan

### 1. Buat API key Garmin
1. Buka Garmin Connect di browser → **Settings → Personal API** (`connect.garmin.com/app/settings/personalApiToken`).
2. **Create Key**, setujui syarat, pilih masa berlaku (disarankan **1 tahun**), lalu salin key-nya.
   Key hanya ditampilkan **sekali**.
3. Catat tanggal kedaluwarsanya. Bila habis, buat key baru lalu ulangi `secrets set` di langkah 3.

### 2. Buat tabel di Supabase Ayyubi
SQL Editor → tempel isi `supabase/schema.sql` → Run (bagian cron biarkan dulu).

### 3. Deploy Edge Function
Dari laptop Linux (butuh Supabase CLI, `supabase login` sekali):

```bash
cd gowes
supabase link --project-ref alkpmwowhlyffdwfvyeu
supabase secrets set \
  GARMIN_API_KEY='<key Garmin>' \
  GOWES_PIN='<kode akses PWA, min 6 karakter>' \
  GOWES_CRON_SECRET='<string acak panjang>' \
  SIMAB_SUPABASE_URL='https://iqedxrjcosorjwsawowk.supabase.co' \
  SIMAB_ANON_KEY='<anon key SiMAB>' \
  SIMAB_OWNER_EMAIL='<NIP Anda>@simab.local' \
  GEMINI_KEYS='<key1>,<key2>' GROQ_KEYS='<key1>' OPENROUTER_KEYS='<key1>'
supabase functions deploy gowes --no-verify-jwt
```

`--no-verify-jwt` wajib: keamanan diatur sendiri oleh fungsi (kode akses, secret cron, atau token SiMAB milik Anda).

Tanpa CLI: Dashboard → Edge Functions → **Deploy a new function** → nama `gowes` → tempel `index.ts`,
matikan **Verify JWT**, lalu isi secrets di Edge Functions → Secrets.

### 4. Sinkron otomatis tiap jam
Database → Extensions → aktifkan **pg_cron** dan **pg_net**. Lalu jalankan blok `cron.schedule`
di akhir `schema.sql` setelah mengganti `<CRON_SECRET>`.

### 5. Pasang PWA
1. `js/config.js` sudah berisi Project URL & publishable key Ayyubi.
2. Buat repo baru (mis. `gowes`) di akun `chabibachmad-dev`, commit semua file lewat GitHub Desktop,
   lalu aktifkan GitHub Pages (branch `main`, folder root).
3. Buka `https://chabibachmad-dev.github.io/gowes/`, masukkan kode akses → **Setelan → Sinkron penuh**
   untuk menarik seluruh riwayat. App lalu otomatis mengunduh & menganalisis file FIT satu per satu.
4. Di iPhone: Safari → Bagikan → *Add to Home Screen*.

### 6. Jarwo (SiMAB)
Jarwo memakai tool `data_gowes` di Edge Function `jarwo` (repo SiMAB) yang memanggil fungsi `gowes` ini
dengan token login SiMAB pengguna. Fungsi `gowes` hanya melayani akun yang emailnya = `SIMAB_OWNER_EMAIL`.
Opsional: secret `GOWES_FN_URL` di project SiMAB bila URL fungsi berubah.

## Fitur
- **Chat Jarwo** (tombol J oranye): tanya apa saja soal data gowes; di halaman detail ride, Jarwo otomatis membaca ride itu.
  Butuh secret `GEMINI_KEYS` dan/atau `GROQ_KEYS` / `OPENROUTER_KEYS` (dipisah koma, boleh sama dengan Jarwo SiMAB).
- **Beranda**: total minggu/bulan/tahun, grafik jarak 12 minggu / 12 bulan / tahunan, rekor pribadi,
  peringatan komponen yang mendekati batas ganti.
- **Detail ride**: peta rute + titik berhenti, profil elevasi & kecepatan (per jarak atau waktu), HR/kadens/power,
  tabel berhenti, segmen per 5/10/25 km (dengan perbandingan paruh pertama vs kedua), lap dari Edge,
  best effort (5–300 km & power), zona HR.
- **Event / COT**: tandai ride sebagai brevet/ultra, isi COT & jarak resmi → sisa waktu di finish,
  titik paling mepet, dan grafik jarak Anda vs garis batas COT.
- **Garasi**: beberapa sepeda, komponen (rantai, ban, kampas, dst.) dengan km otomatis dari ride, tombol "Ganti baru",
  riwayat penggantian.
- **Impor .FIT manual** (Setelan): bila API bermasalah, ambil file langsung dari folder `Garmin/Activity` di Edge.

## Catatan
- Personal API hanya **pull**: ride baru muncul setelah sinkron (tiap jam via cron, atau tombol ⟳, atau saat app dibuka).
- Garmin menyebut beberapa metrik (VO2max, recovery time, training effect) mungkin tidak ikut di FIT dari API.
- Endpoint yang dipakai: `/activitylist-service/activities/search/activities` dan
  `/download-service/files/activity/{id}` di `personal.connectapi.garmin.com`. Bila sinkron gagal,
  pesan error Garmin terakhir tampil di Setelan.
