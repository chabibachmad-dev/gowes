// Supabase Edge Function "gowes"
// Satu pintu untuk PWA Gowes, jadwal sinkron (pg_cron), dan Jarwo (SiMAB).
// Deploy:  supabase functions deploy gowes --no-verify-jwt
//
// Secrets (supabase secrets set ...):
//   GARMIN_API_KEY      key dari Garmin Connect → Settings → Personal API
//   GOWES_PIN           kode akses PWA (min. 6 karakter, bebas)
//   GOWES_CRON_SECRET   string acak untuk pg_cron
//   SIMAB_SUPABASE_URL  https://iqedxrjcosorjwsawowk.supabase.co
//   SIMAB_ANON_KEY      anon key project SiMAB
//   SIMAB_OWNER_EMAIL   <NIP Anda>@simab.local  (hanya akun ini yang boleh)
//   GEMINI_KEYS / GROQ_KEYS / OPENROUTER_KEYS  (untuk chat Jarwo di PWA; dipisah koma,
//                       boleh sama dengan yang dipakai Jarwo SiMAB. Minimal salah satu.)
//   Opsional: GEMINI_MODEL, GROQ_MODEL, OPENROUTER_MODEL (dipisah koma, dicoba berurutan)
//   (SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY otomatis tersedia)

import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});
const GBASE = "https://personal.connectapi.garmin.com";
const TOKEN_URL = `${GBASE}/personalapitoken-service/personal-api/personal-api-key/token`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "content-type, authorization, apikey, x-client-info, x-gowes-pin, x-cron-secret, x-simab-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

// ---------------------------------------------------------------- auth
function safeEq(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function whoAmI(req: Request): Promise<"owner" | "cron" | "jarwo" | null> {
  const pin = req.headers.get("x-gowes-pin") ?? "";
  if (pin && safeEq(pin, env("GOWES_PIN"))) return "owner";
  const cron = req.headers.get("x-cron-secret") ?? "";
  if (cron && safeEq(cron, env("GOWES_CRON_SECRET"))) return "cron";
  const simab = req.headers.get("x-simab-token") ?? "";
  if (simab && env("SIMAB_SUPABASE_URL")) {
    // Verifikasi token login SiMAB langsung ke Supabase SiMAB
    const r = await fetch(`${env("SIMAB_SUPABASE_URL")}/auth/v1/user`, {
      headers: { apikey: env("SIMAB_ANON_KEY"), Authorization: `Bearer ${simab}` },
    });
    if (r.ok) {
      const u = await r.json();
      if ((u?.email ?? "").toLowerCase() === env("SIMAB_OWNER_EMAIL").toLowerCase()) return "jarwo";
    }
  }
  return null;
}
const need = (role: string | null, allowed: string[]) => {
  if (!role || !allowed.includes(role)) throw new HttpError(403, "Tidak diizinkan");
};

// ---------------------------------------------------------------- kv
async function kvGet<T = any>(key: string): Promise<T | null> {
  const { data } = await sb.from("gowes_kv").select("value").eq("key", key).maybeSingle();
  return (data?.value as T) ?? null;
}
async function kvSet(key: string, value: unknown) {
  await sb.from("gowes_kv").upsert({ key, value, updated_at: new Date().toISOString() });
}

// ---------------------------------------------------------------- Garmin
function jwtExp(tok: string): number {
  try {
    const p = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4))).exp ?? 0;
  } catch { return Math.floor(Date.now() / 1000) + 20 * 3600; }
}

async function garminToken(force = false): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (!force) {
    const c = await kvGet<{ token: string; exp: number }>("garmin_token");
    if (c?.token && c.exp - now > 3600) return c.token;
  }
  if (!env("GARMIN_API_KEY")) throw new HttpError(500, "Secret GARMIN_API_KEY belum diisi");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `ApiKey ${env("GARMIN_API_KEY")}`, Accept: "application/json, text/plain" },
  });
  const body = (await r.text()).trim();
  if (!r.ok) {
    await kvSet("garmin_error", { at: new Date().toISOString(), status: r.status, body: body.slice(0, 300) });
    throw new HttpError(502, r.status === 401 || r.status === 403
      ? "API key Garmin ditolak (mungkin kedaluwarsa). Buat key baru di Garmin Connect lalu perbarui secret GARMIN_API_KEY."
      : `Gagal minta token Garmin (${r.status})`);
  }
  // Respons bisa berupa JWT mentah, string ber-kutip, atau JSON
  let token = body.replace(/^"|"$/g, "");
  if (body.startsWith("{")) {
    try {
      const j = JSON.parse(body);
      token = j.access_token ?? j.accessToken ?? j.token ?? j.bearerToken ?? token;
    } catch { /* biarkan */ }
  }
  await kvSet("garmin_token", { token, exp: jwtExp(token) });
  return token;
}

async function garmin(path: string, params: Record<string, string | number | undefined> = {}, binary = false) {
  const u = new URL(GBASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await garminToken(attempt > 0);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}`, Accept: binary ? "*/*" : "application/json" } });
    if (r.status === 401 && attempt === 0) continue;
    if (!r.ok) throw new HttpError(502, `Garmin ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return binary ? new Uint8Array(await r.arrayBuffer()) : await r.json();
  }
}

// ---------------------------------------------------------------- mapping
const CYCLING = /cycl|bik|ride|bmx|velo/i;
const n = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);

function toLocalTs(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  return s.replace(" ", "T").replace(/\.\d+$/, "").slice(0, 19);
}
function toUtc(a: any): string | null {
  const g = a.startTimeGMT ?? a.startTimeGmt;
  if (typeof g === "string") return g.replace(" ", "T").slice(0, 19) + "Z";
  if (n(a.beginTimestamp)) return new Date(a.beginTimestamp).toISOString();
  if (n(a.startTimeInSeconds)) return new Date(a.startTimeInSeconds * 1000).toISOString();
  return null;
}
function mapActivity(a: any) {
  const typeKey = a.activityType?.typeKey ?? a.activityType ?? a.activityTypeDTO?.typeKey ?? "";
  return {
    id: Number(a.activityId ?? a.activityID ?? a.id),
    name: a.activityName ?? a.name ?? null,
    type_key: String(typeKey),
    start_time: toUtc(a),
    start_local: toLocalTs(a.startTimeLocal),
    distance_m: n(a.distance) ?? n(a.distanceInMeters),
    duration_s: n(a.duration) ?? n(a.durationInSeconds),
    moving_s: n(a.movingDuration),
    elapsed_s: n(a.elapsedDuration),
    elev_gain: n(a.elevationGain) ?? n(a.totalElevationGainInMeters),
    elev_loss: n(a.elevationLoss),
    avg_speed: n(a.averageSpeed) ?? n(a.averageSpeedInMetersPerSecond),
    max_speed: n(a.maxSpeed),
    avg_hr: n(a.averageHR) ?? n(a.averageHeartRateInBeatsPerMinute),
    max_hr: n(a.maxHR),
    avg_cad: n(a.averageBikingCadenceInRevPerMinute) ?? n(a.averageBikeCadenceInRoundsPerMinute),
    avg_power: n(a.avgPower) ?? n(a.averagePower),
    max_power: n(a.maxPower),
    norm_power: n(a.normPower),
    calories: n(a.calories) ?? n(a.activeKilocalories),
    avg_temp: null,
    max_temp: n(a.maxTemperature),
    location: a.locationName ?? null,
    start_lat: n(a.startLatitude),
    start_lng: n(a.startLongitude),
    raw: a,
    synced_at: new Date().toISOString(),
  };
}

const SUMMARY_COLS =
  "id,name,type_key,start_time,start_local,distance_m,duration_s,moving_s,elapsed_s,elev_gain,elev_loss,avg_speed,max_speed,avg_hr,max_hr,avg_cad,avg_power,max_power,norm_power,calories,avg_temp,max_temp,location,start_lat,start_lng,bike_id,note,event,analyzed_at,source";

// ---------------------------------------------------------------- sync
async function defaultBikeId(): Promise<string | null> {
  const { data } = await sb.from("gowes_bikes").select("id").eq("is_default", true).eq("active", true).limit(1);
  return data?.[0]?.id ?? null;
}

async function sync(opts: { full?: boolean; start?: number }, source: string) {
  const deadline = Date.now() + 100_000;
  const PAGE = 100;
  const last = await kvGet<{ date: string }>("last_sync");
  let startDate: string | undefined;
  if (!opts.full && last?.date) {
    const d = new Date(last.date); d.setDate(d.getDate() - 7);
    startDate = d.toISOString().slice(0, 10);
  }
  let start = opts.start ?? 0, fetched = 0, cycling = 0, inserted = 0, more = false;
  const bike = await defaultBikeId();

  while (true) {
    if (Date.now() > deadline) { more = true; break; }
    const res = await garmin("/activitylist-service/activities/search/activities", {
      start, limit: PAGE, startDate,
      endDate: startDate ? new Date(Date.now() + 86400_000).toISOString().slice(0, 10) : undefined, // besok (aman untuk WITA)
    });
    const list: any[] = Array.isArray(res) ? res : res?.activityList ?? res?.activities ?? [];
    if (!list.length) break;
    fetched += list.length;
    const rows = list.filter((a) => CYCLING.test(String(a.activityType?.typeKey ?? a.activityType ?? ""))).map(mapActivity)
      .filter((r) => Number.isFinite(r.id));
    cycling += rows.length;
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      const { data: existing } = await sb.from("gowes_rides").select("id").in("id", ids);
      const have = new Set((existing ?? []).map((e: any) => Number(e.id)));
      const fresh = ids.filter((id) => !have.has(id));
      const { error } = await sb.from("gowes_rides").upsert(rows, { onConflict: "id" });
      if (error) throw new HttpError(500, "Gagal simpan: " + error.message);
      if (bike && fresh.length) await sb.from("gowes_rides").update({ bike_id: bike }).in("id", fresh).is("bike_id", null);
      inserted += fresh.length;
    }
    if (list.length < PAGE) break;
    start += PAGE;
  }
  const result = { fetched, cycling, inserted, more, next_start: more ? start : null, mode: opts.full ? "full" : "incremental" };
  if (!more) await kvSet("last_sync", { date: new Date().toISOString(), result });
  await sb.from("gowes_sync_log").insert({ source, result });
  return result;
}

// ---------------------------------------------------------------- parts
async function partsStatus() {
  const { data: bikes } = await sb.from("gowes_bikes").select("*").order("created_at");
  const { data: parts } = await sb.from("gowes_parts").select("*").order("created_at");
  const { data: rides } = await sb.from("gowes_rides").select("bike_id,start_time,start_local,distance_m").not("bike_id", "is", null);
  const out = (parts ?? []).map((p: any) => {
    const since = p.installed_at;
    const until = p.replaced_at;
    let km = Number(p.offset_km) || 0;
    for (const r of rides ?? []) {
      if (r.bike_id !== p.bike_id) continue;
      const d = (r.start_local ?? r.start_time ?? "").slice(0, 10);
      if (d >= since && (!until || d < until)) km += (r.distance_m ?? 0) / 1000;
    }
    const pct = p.limit_km ? km / p.limit_km : null;
    return { ...p, km: Math.round(km * 10) / 10, pct: pct == null ? null : Math.round(pct * 1000) / 1000 };
  });
  const bikeKm: Record<string, number> = {};
  for (const r of rides ?? []) bikeKm[r.bike_id] = (bikeKm[r.bike_id] ?? 0) + (r.distance_m ?? 0) / 1000;
  return {
    bikes: (bikes ?? []).map((b: any) => ({ ...b, km: Math.round((bikeKm[b.id] ?? 0) * 10) / 10 })),
    parts: out,
  };
}

// ---------------------------------------------------------------- Jarwo context
function brief(r: any) {
  const a = r.analysis ?? {};
  return {
    id: r.id,
    tanggal: (r.start_local ?? r.start_time ?? "").slice(0, 16).replace("T", " "),
    nama: r.name,
    km: r.distance_m != null ? +(r.distance_m / 1000).toFixed(1) : null,
    waktu_bergerak_jam: r.moving_s != null ? +(r.moving_s / 3600).toFixed(2) : null,
    waktu_total_jam: r.elapsed_s != null ? +(r.elapsed_s / 3600).toFixed(2) : null,
    elevasi_m: r.elev_gain != null ? Math.round(r.elev_gain) : null,
    kecepatan_rata_kmj: r.avg_speed != null ? +(r.avg_speed * 3.6).toFixed(1) : null,
    hr_rata: r.avg_hr, power_rata: r.avg_power, kadens_rata: r.avg_cad,
    event: r.event ?? undefined,
    jumlah_berhenti: a.stop_count ?? undefined,
    berhenti_terlama_menit: a.longest_stop_s ? Math.round(a.longest_stop_s / 60) : undefined,
    segmen_kmj: a.segments ? a.segments.map((s: any) => `${s.from}-${s.to}km:${s.speed}`) : undefined,
  };
}

async function jarwoContext(p: { from?: string; to?: string }) {
  const { data: all } = await sb.from("gowes_rides")
    .select("id,name,start_time,start_local,distance_m,moving_s,elapsed_s,elev_gain,avg_speed,avg_hr,avg_power,avg_cad,event,analysis")
    .order("start_time", { ascending: false });
  const rides = all ?? [];
  const now = new Date(Date.now() + 8 * 3600_000); // WITA
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const dow = (now.getUTCDay() + 6) % 7;
  const weekStart = ymd(new Date(now.getTime() - dow * 86400_000));
  const monthStart = ymd(now).slice(0, 8) + "01";
  const yearStart = ymd(now).slice(0, 5) + "01-01";
  const d30 = ymd(new Date(now.getTime() - 30 * 86400_000));
  const day = (r: any) => (r.start_local ?? r.start_time ?? "").slice(0, 10);
  const tot = (since: string) => {
    const rs = rides.filter((r) => day(r) >= since);
    return {
      ride: rs.length,
      km: +(rs.reduce((s, r) => s + (r.distance_m ?? 0), 0) / 1000).toFixed(1),
      jam_bergerak: +(rs.reduce((s, r) => s + (r.moving_s ?? 0), 0) / 3600).toFixed(1),
      elevasi_m: Math.round(rs.reduce((s, r) => s + (r.elev_gain ?? 0), 0)),
    };
  };
  const top = (k: string) => rides.reduce((m: any, r: any) => (r[k] != null && (!m || r[k] > m[k]) ? r : m), null);
  const ranged = p.from || p.to
    ? rides.filter((r) => (!p.from || day(r) >= p.from) && (!p.to || day(r) <= p.to)).slice(0, 100).map(brief)
    : undefined;
  const parts = await partsStatus();
  return {
    zona_waktu: "WITA",
    hari_ini: ymd(now),
    sinkron_terakhir: (await kvGet<any>("last_sync"))?.date ?? null,
    total: { minggu_ini: tot(weekStart), bulan_ini: tot(monthStart), tahun_ini: tot(yearStart), "30_hari": tot(d30), semua: tot("0000") },
    rekor: {
      terjauh: top("distance_m") && brief(top("distance_m")),
      elevasi_terbanyak: top("elev_gain") && brief(top("elev_gain")),
    },
    ride_terbaru: rides.slice(0, 10).map(brief),
    ride_rentang: ranged,
    perawatan: parts.parts.filter((x: any) => x.active).map((x: any) => {
      const bike = parts.bikes.find((b: any) => b.id === x.bike_id);
      return { sepeda: bike?.name, komponen: x.name, km_terpakai: x.km, batas_km: x.limit_km, persen: x.pct != null ? Math.round(x.pct * 100) : null };
    }),
  };
}


// ---------------------------------------------------------------- Chat Jarwo (di PWA)
const keyList = (k: string) => env(k).split(",").map((s) => s.trim()).filter(Boolean);
const modelList = (k: string, d: string) => (env(k) || d).split(",").map((s) => s.trim()).filter(Boolean);
const keyCursor: Record<string, number> = {};
async function withKeys<T>(name: string, fn: (key: string) => Promise<T>): Promise<T> {
  const list = keyList(name);
  if (!list.length) throw new Error(`${name} kosong`);
  let last: unknown;
  const start = (keyCursor[name] = ((keyCursor[name] ?? -1) + 1) % list.length);
  for (let i = 0; i < list.length; i++) { try { return await fn(list[(start + i) % list.length]); } catch (e) { last = e; } }
  throw last;
}
async function withModels<T>(list: string[], fn: (m: string) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const m of list) { try { return await fn(m); } catch (e) { last = e; } }
  throw last;
}
async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

function rideForAi(r: any) {
  if (!r) return null;
  const a = r.analysis ?? {};
  return {
    ...brief(r),
    kecepatan_maks_kmj: r.max_speed != null ? +(r.max_speed * 3.6).toFixed(1) : null,
    hr_maks: r.max_hr, np: r.norm_power, suhu_rata: r.avg_temp, suhu_maks: r.max_temp, catatan: r.note,
    berhenti: (a.stops ?? []).filter((s: any) => s.dur >= 120).map((s: any) => ({ jam: s.clock, km: s.km, menit: Math.round(s.dur / 60) })),
    segmen: a.segments, lap: (a.laps ?? []).length > 1 ? a.laps : undefined, best_effort: a.best,
  };
}

const AI_TOOLS = [
  { name: "daftar_ride", description: "Daftar ride pada rentang tanggal (YYYY-MM-DD, zona WITA): tanggal, nama, km, jam bergerak/total, elevasi, kecepatan, HR, power, jumlah berhenti, kecepatan per segmen. Maks 100 ride, terbaru dulu.",
    parameters: { type: "object", properties: { dari: { type: "string" }, sampai: { type: "string" } } } },
  { name: "detail_ride", description: "Detail satu ride berdasarkan id: daftar berhenti (jam, km, menit), segmen, lap, best effort, event/COT, catatan.",
    parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
];
async function runAiTool(name: string, a: any) {
  if (name === "daftar_ride") return (await jarwoContext({ from: a.dari, to: a.sampai })).ride_rentang ?? [];
  if (name === "detail_ride") {
    const { data } = await sb.from("gowes_rides").select(SUMMARY_COLS + ",analysis").eq("id", Number(a.id)).maybeSingle();
    return data ? rideForAi(data) : { error: "ride tidak ditemukan" };
  }
  return { error: "tool tidak dikenal" };
}

function systemPrompt(ctx: unknown, ride: unknown, settings: any) {
  return `Kamu Jarwo, asisten AI di aplikasi Gowes milik pengguna: pelatih & teman gowes yang membaca data Garmin Edge-nya.
Jawab dalam Bahasa Indonesia, ringkas, hangat, konkret. Satuan: km, km/j, meter, menit/jam, WITA. Jangan pakai LaTeX.
Pakai HANYA angka dari data di bawah atau dari tool (daftar_ride, detail_ride); jangan mengarang. Bila data tidak ada, katakan.
Berikan saran latihan, pacing, nutrisi/hidrasi, dan perawatan sepeda yang praktis berdasarkan angka. Untuk keluhan medis serius, sarankan ke tenaga kesehatan.
Jangan menyebut nama model/penyedia AI; kamu Jarwo.
Profil: HR maks ${settings?.hr_max ?? "tidak diisi"}, FTP ${settings?.ftp ?? "tidak diisi"}.
RINGKASAN DATA: ${JSON.stringify(ctx)}
${ride ? "RIDE YANG SEDANG DIBUKA PENGGUNA: " + JSON.stringify(ride) : ""}`;
}

async function chatGemini(sys: string, msgs: any[]) {
  const contents: any[] = msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content) }] }));
  for (let step = 0; step < 5; step++) {
    const r = await withModels(modelList("GEMINI_MODEL", "gemini-3.5-flash-lite,gemini-3.8-flash"), (mdl) => withKeys("GEMINI_KEYS", (key) =>
      postJson(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent`,
        { systemInstruction: { parts: [{ text: sys }] }, contents, tools: [{ functionDeclarations: AI_TOOLS }] }, { "x-goog-api-key": key })));
    const parts = r.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter((p: any) => p.functionCall);
    if (!calls.length) return parts.map((p: any) => p.text || "").join("").trim();
    contents.push({ role: "model", parts });
    const resp = [];
    for (const p of calls) {
      let out: unknown; try { out = await runAiTool(p.functionCall.name, p.functionCall.args || {}); } catch (e) { out = { error: String(e) }; }
      resp.push({ functionResponse: { name: p.functionCall.name, response: { result: out } } });
    }
    contents.push({ role: "user", parts: resp });
  }
  return "Maaf, saya belum bisa menyelesaikan itu.";
}
async function chatOpenAI(url: string, keyName: string, models: string[], sys: string, msgs: any[]) {
  const m: any[] = [{ role: "system", content: sys }, ...msgs.map((x) => ({ role: x.role, content: String(x.content) }))];
  const tools = AI_TOOLS.map((t) => ({ type: "function", function: t }));
  for (let step = 0; step < 5; step++) {
    const r = await withModels(models, (model) => withKeys(keyName, (key) => postJson(url, { model, messages: m, tools }, { Authorization: `Bearer ${key}` })));
    const msg = r.choices?.[0]?.message;
    if (!msg?.tool_calls?.length) return String(msg?.content || "").trim();
    m.push(msg);
    for (const tc of msg.tool_calls) {
      let out: unknown; try { out = await runAiTool(tc.function.name, JSON.parse(tc.function.arguments || "{}")); } catch (e) { out = { error: String(e) }; }
      m.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 12000) });
    }
  }
  return "Maaf, saya belum bisa menyelesaikan itu.";
}
async function chatJarwo(msgs: any[], rideId?: number) {
  const ctx = await jarwoContext({});
  let ride = null;
  if (rideId) {
    const { data } = await sb.from("gowes_rides").select(SUMMARY_COLS + ",analysis").eq("id", rideId).maybeSingle();
    ride = rideForAi(data);
  }
  const sys = systemPrompt(ctx, ride, await kvGet("settings"));
  const tries: [string, () => Promise<string>][] = [
    ["GEMINI_KEYS", () => chatGemini(sys, msgs)],
    ["GROQ_KEYS", () => chatOpenAI("https://api.groq.com/openai/v1/chat/completions", "GROQ_KEYS", modelList("GROQ_MODEL", "openai/gpt-oss-120b"), sys, msgs)],
    ["OPENROUTER_KEYS", () => chatOpenAI("https://openrouter.ai/api/v1/chat/completions", "OPENROUTER_KEYS", modelList("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct:free"), sys, msgs)],
  ];
  const errs: string[] = [];
  let any = false;
  for (const [k, f] of tries) {
    if (!keyList(k).length) continue;
    any = true;
    try { const reply = await f(); if (reply) return { reply }; } catch (e) { errs.push(`${k.split("_")[0].toLowerCase()}: ${String(e).slice(0, 100)}`); }
  }
  if (!any) throw new HttpError(500, "Belum ada API key AI. Isi secret GEMINI_KEYS (atau GROQ_KEYS / OPENROUTER_KEYS) di Supabase Ayyubi.");
  throw new HttpError(502, "Semua penyedia AI gagal: " + errs.join(" | "));
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const role = await whoAmI(req);
    if (!role) {
      await new Promise((r) => setTimeout(r, 800)); // perlambat tebak-tebakan PIN
      throw new HttpError(401, "Kode akses salah");
    }
    const body = await req.json().catch(() => ({}));
    const a = body.action as string;

    switch (a) {
      case "ping":
        return json({ ok: true, role, last_sync: await kvGet("last_sync"), garmin_error: await kvGet("garmin_error") });

      case "sync":
        need(role, ["owner", "cron"]);
        return json(await sync({ full: !!body.full, start: body.start }, role));

      case "fit": {
        need(role, ["owner"]);
        const id = Number(body.id);
        if (!(id > 0)) throw new HttpError(400, "id tidak valid");
        const bytes = await garmin(`/download-service/files/activity/${id}`, {}, true);
        return new Response(bytes as Uint8Array, { headers: { ...CORS, "Content-Type": "application/octet-stream" } });
      }

      case "save_analysis": {
        need(role, ["owner"]);
        const { id, summary = {}, analysis, streams, create, name } = body;
        const rid = Number(id);
        const patch: Record<string, unknown> = {
          analysis, analyzed_at: new Date().toISOString(),
          moving_s: summary.moving_s, elapsed_s: summary.elapsed_s,
        };
        // isi kolom yang kosong dari Garmin dengan nilai dari file FIT
        const fill = ["distance_m", "elev_gain", "elev_loss", "avg_speed", "max_speed", "avg_hr", "max_hr", "avg_cad",
          "avg_power", "max_power", "norm_power", "calories", "avg_temp", "max_temp", "start_lat", "start_lng"];
        const { data: cur } = await sb.from("gowes_rides").select(fill.join(",") + ",id").eq("id", rid).maybeSingle();
        if (!cur && !create) throw new HttpError(404, "Ride tidak ditemukan");
        for (const k of fill) if ((cur as any)?.[k] == null && summary[k] != null) patch[k] = summary[k];
        if (!cur) {
          Object.assign(patch, {
            id: rid, name: name ?? "Impor .FIT", type_key: "cycling", source: "fit",
            start_time: summary.start_time, start_local: new Date(new Date(summary.start_time).getTime() + 8 * 3600_000).toISOString().slice(0, 19),
            duration_s: summary.timer_s ?? summary.moving_s, bike_id: await defaultBikeId(),
          });
          for (const k of fill) if (summary[k] != null) patch[k] = summary[k];
          const { error } = await sb.from("gowes_rides").insert(patch);
          if (error) throw new HttpError(500, error.message);
        } else {
          const { error } = await sb.from("gowes_rides").update(patch).eq("id", rid);
          if (error) throw new HttpError(500, error.message);
        }
        if (streams) await sb.from("gowes_streams").upsert({ ride_id: rid, data: streams });
        return json({ ok: true });
      }

      case "rides": {
        need(role, ["owner", "jarwo"]);
        let q = sb.from("gowes_rides").select(SUMMARY_COLS + ",best:analysis->best").order("start_time", { ascending: false });
        if (body.from) q = q.gte("start_time", body.from);
        if (body.to) q = q.lte("start_time", body.to);
        const { data, error } = await q.limit(5000);
        if (error) throw new HttpError(500, error.message);
        return json({ rides: data });
      }

      case "ride": {
        need(role, ["owner", "jarwo"]);
        const id = Number(body.id);
        const { data: ride } = await sb.from("gowes_rides").select(SUMMARY_COLS + ",analysis").eq("id", id).maybeSingle();
        if (!ride) throw new HttpError(404, "Ride tidak ditemukan");
        const { data: st } = role === "owner"
          ? await sb.from("gowes_streams").select("data").eq("ride_id", id).maybeSingle()
          : { data: null };
        return json({ ride, streams: st?.data ?? null });
      }

      case "update_ride": {
        need(role, ["owner"]);
        const allowed = ["name", "bike_id", "note", "event"];
        const patch = Object.fromEntries(Object.entries(body.patch ?? {}).filter(([k]) => allowed.includes(k)));
        const { error } = await sb.from("gowes_rides").update(patch).eq("id", Number(body.id));
        if (error) throw new HttpError(500, error.message);
        return json({ ok: true });
      }

      case "delete_ride": {
        need(role, ["owner"]);
        await sb.from("gowes_rides").delete().eq("id", Number(body.id));
        return json({ ok: true });
      }

      case "garage":
        need(role, ["owner", "jarwo"]);
        return json(await partsStatus());

      case "save_bike": {
        need(role, ["owner"]);
        const b = body.bike ?? {};
        const row = { name: b.name, note: b.note ?? null, is_default: !!b.is_default, active: b.active ?? true };
        if (row.is_default) await sb.from("gowes_bikes").update({ is_default: false }).neq("id", b.id ?? "00000000-0000-0000-0000-000000000000");
        const { data, error } = b.id
          ? await sb.from("gowes_bikes").update(row).eq("id", b.id).select().single()
          : await sb.from("gowes_bikes").insert(row).select().single();
        if (error) throw new HttpError(500, error.message);
        return json({ bike: data });
      }

      case "delete_bike":
        need(role, ["owner"]);
        await sb.from("gowes_bikes").delete().eq("id", body.id);
        return json({ ok: true });

      case "save_part": {
        need(role, ["owner"]);
        const p = body.part ?? {};
        const row = {
          bike_id: p.bike_id, name: p.name, kind: p.kind ?? null, installed_at: p.installed_at,
          offset_km: Number(p.offset_km) || 0, limit_km: p.limit_km ? Number(p.limit_km) : null, note: p.note ?? null,
        };
        const { error } = p.id
          ? await sb.from("gowes_parts").update(row).eq("id", p.id)
          : await sb.from("gowes_parts").insert(row);
        if (error) throw new HttpError(500, error.message);
        return json({ ok: true });
      }

      case "replace_part": {
        need(role, ["owner"]);
        const today = body.date ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
        const { data: old } = await sb.from("gowes_parts").select("*").eq("id", body.id).single();
        if (!old) throw new HttpError(404, "Komponen tidak ditemukan");
        await sb.from("gowes_parts").update({ active: false, replaced_at: today }).eq("id", body.id);
        await sb.from("gowes_parts").insert({
          bike_id: old.bike_id, name: old.name, kind: old.kind, installed_at: today, offset_km: 0, limit_km: old.limit_km, note: body.note ?? null,
        });
        return json({ ok: true });
      }

      case "delete_part":
        need(role, ["owner"]);
        await sb.from("gowes_parts").delete().eq("id", body.id);
        return json({ ok: true });

      case "settings":
        need(role, ["owner"]);
        if (body.set) await kvSet("settings", body.set);
        return json({ settings: (await kvGet("settings")) ?? { hr_max: 185, ftp: null } });

      case "chat": {
        need(role, ["owner"]);
        const msgs = (Array.isArray(body.messages) ? body.messages : [])
          .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && m.content)
          .slice(-12).map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
        if (!msgs.length) throw new HttpError(400, "pesan kosong");
        return json(await chatJarwo(msgs, body.ride_id ? Number(body.ride_id) : undefined));
      }

      case "jarwo_context":
        need(role, ["owner", "jarwo"]);
        return json(await jarwoContext({ from: body.from, to: body.to }));

      default:
        throw new HttpError(400, "Aksi tidak dikenal: " + a);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
});
