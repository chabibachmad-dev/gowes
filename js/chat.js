// chat.js — chat Jarwo di dalam PWA Gowes (AI lewat Edge Function "gowes", aksi "chat")
import { call } from './api.js';

const KEY = 'gowes_chat';
let msgs = [];
let busy = false;
let getRideId = () => null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function md(t) {
  // markdown ringan: **tebal**, *miring*, daftar "- " / "1. ", baris baru
  const lines = esc(t).split('\n');
  let html = '', list = null;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const ln of lines) {
    const ul = ln.match(/^\s*[-•*]\s+(.*)/), ol = ln.match(/^\s*\d+[.)]\s+(.*)/);
    const want = ul ? 'ul' : ol ? 'ol' : null;
    if (list && want !== list) { html += `</${list}>`; list = null; }
    if (want) { if (!list) { html += `<${want}>`; list = want; } html += `<li>${inline((ul || ol)[1])}</li>`; continue; }
    const h = ln.match(/^#{1,4}\s+(.*)/);
    html += h ? `<p><b>${inline(h[1])}</b></p>` : ln.trim() ? `<p>${inline(ln)}</p>` : '';
  }
  if (list) html += `</${list}>`;
  return html;
}

function load() { try { msgs = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { msgs = []; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(msgs.slice(-40))); } catch {} }

const SUGGEST_HOME = ['Rekap gowesku minggu ini', 'Bagaimana tren latihanku sebulan terakhir?', 'Komponen apa yang perlu diganti?', 'Saran latihan untuk brevet 300 km'];
const SUGGEST_RIDE = ['Analisis ride ini', 'Bagaimana pacing-ku di ride ini?', 'Kenapa paruh kedua lebih lambat?', 'Apa yang bisa diperbaiki di ride berikutnya?'];

function render() {
  const box = document.getElementById('chatMsgs');
  const rid = getRideId();
  const sugg = rid ? SUGGEST_RIDE : SUGGEST_HOME;
  box.innerHTML = (msgs.length ? '' : `<div class="chat-hello"><div class="avatar">J</div><p>Halo, saya <b>Jarwo</b>. Saya bisa membaca data gowes Anda dari Garmin.${rid ? ' Anda sedang membuka satu ride — tanyakan apa saja tentang ride ini.' : ''}</p></div>`)
    + msgs.map((m) => `<div class="msg ${m.role}${m.err ? ' err' : ''}">${m.role === 'assistant' ? md(m.content) : esc(m.content)}</div>`).join('')
    + (busy ? '<div class="msg assistant typing"><i></i><i></i><i></i></div>' : '');
  document.getElementById('chatSugg').innerHTML = busy ? '' : sugg.map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join('');
  document.getElementById('chatCtx').textContent = rid ? '📍 konteks: ride yang sedang dibuka' : '';
  box.scrollTop = box.scrollHeight;
}

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  msgs.push({ role: 'user', content: text });
  busy = true; render(); save();
  try {
    const hist = msgs.filter((m) => !m.err).slice(-12).map(({ role, content }) => ({ role, content }));
    const r = await call('chat', { messages: hist, ride_id: getRideId() });
    msgs.push({ role: 'assistant', content: r.reply || '(tidak ada jawaban)' });
  } catch (e) {
    msgs.push({ role: 'assistant', content: 'Maaf, gagal menghubungi Jarwo: ' + e.message, err: true });
  }
  busy = false; save(); render();
}

export function initChat(rideIdFn) {
  getRideId = rideIdFn;
  load();
  const sheet = document.getElementById('chat'), fab = document.getElementById('fabJarwo');
  const open = () => { sheet.hidden = false; document.body.classList.add('chat-open'); render(); setTimeout(() => document.getElementById('chatIn').focus(), 50); };
  const close = () => { sheet.hidden = true; document.body.classList.remove('chat-open'); };
  fab.hidden = false;
  fab.onclick = open;
  document.getElementById('chatClose').onclick = close;
  document.getElementById('chatClear').onclick = () => { if (confirm('Hapus riwayat chat?')) { msgs = []; save(); render(); } };
  document.getElementById('chatSugg').onclick = (e) => { const b = e.target.closest('button'); if (b) send(b.textContent); };
  const inp = document.getElementById('chatIn');
  document.getElementById('chatForm').onsubmit = (e) => { e.preventDefault(); const t = inp.value; inp.value = ''; inp.style.height = ''; send(t); };
  inp.oninput = () => { inp.style.height = ''; inp.style.height = Math.min(inp.scrollHeight, 120) + 'px'; };
  inp.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer:fine)').matches) { e.preventDefault(); document.getElementById('chatForm').requestSubmit(); } };
  return { open, close };
}
