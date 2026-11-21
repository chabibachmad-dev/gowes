import { FN_URL, SUPABASE_ANON_KEY } from './config.js';

const PIN_KEY = 'gowes_pin';
export const getPin = () => { try { return localStorage.getItem(PIN_KEY) || ''; } catch { return ''; } };
export const setPin = (p) => { try { p ? localStorage.setItem(PIN_KEY, p) : localStorage.removeItem(PIN_KEY); } catch {} };

export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export async function call(action, payload = {}, { binary = false, pin } = {}) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'x-gowes-pin': pin ?? getPin(),
    },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new ApiError(res.status, msg);
  }
  return binary ? new Uint8Array(await res.arrayBuffer()) : res.json();
}
