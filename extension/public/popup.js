const DAEMON = 'http://127.0.0.1:8765';
const POLL_MS = 3000;
let pollTimer = null;
const $ = (id) => document.getElementById(id);
const hero = $('hero'), stitle = $('stitle'), ssub = $('ssub'),
  latencyEl = $('latency'), alist = $('alist'), actcount = $('actcount');

function toast(m) {
  const t = $('toast');
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2200);
}

async function detectBrowser() {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'firefox';
  if (ua.includes('Edg')) return 'edge';
  try {
    if (navigator.brave && await navigator.brave.isBrave()) return 'brave';
  } catch { /* abaikan */ }
  if ('brave' in navigator) return 'brave';
  return 'chrome';
}

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  return Math.floor(s / 86400) + ' hari lalu';
}

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); }
  catch { return u; }
}

const TONES = [['#D3E3FD', '#0B57D0'], ['#C2F0C6', '#146C2E'], ['#FDECC8', '#7A4A00'], ['#E8DEF8', '#4F378B'], ['#D9ECFA', '#00639B']];

async function checkHealth() {
  const t0 = performance.now();
  try {
    const r = await fetch(DAEMON + '/health', { cache: 'no-store' });
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) throw new Error('bad');
    hero.classList.remove('off');
    hero.classList.add('on');
    stitle.textContent = 'Terhubung';
    ssub.textContent = 'Daemon menjawab, dicek otomatis';
    latencyEl.textContent = 'Latensi ' + ms + ' ms';
  } catch {
    hero.classList.add('off');
    hero.classList.remove('on');
    stitle.textContent = 'Terputus';
    ssub.textContent = 'Daemon tidak menjawab';
    latencyEl.textContent = 'Latensi -';
  }
}

function schedulePoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(checkHealth, POLL_MS);
}

function renderActivity(items) {
  alist.innerHTML = '';
  if (!items || !items.length) {
    actcount.textContent = '';
    alist.innerHTML = '<li><div class="emptybox"><div class="e-ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div><p><b>Belum ada aktivitas</b></p><p>Jelajahi web, riwayat terbaru muncul di sini.</p></div></li>';
    return;
  }
  actcount.textContent = items.length + ' item';
  items.forEach((it, i) => {
    const d = domainOf(it.url || '');
    const li = document.createElement('li');
    li.className = 'aitem';
    const av = document.createElement('div');
    av.className = 'av';
    const tone = TONES[i % TONES.length];
    av.style.background = tone[0];
    av.style.color = tone[1];
    av.textContent = (d[0] || '?').toUpperCase();
    const t = document.createElement('div');
    t.className = 't';
    const ti = document.createElement('p');
    ti.className = 'ti';
    ti.textContent = it.title || d;
    ti.title = it.title || it.url || '';
    const ur = document.createElement('p');
    ur.className = 'ur';
    ur.textContent = d;
    ur.title = it.url || '';
    t.append(ti, ur);
    const tm = document.createElement('time');
    tm.textContent = it.lastVisitTime ? ago(it.lastVisitTime) : '';
    li.append(av, t, tm);
    alist.append(li);
  });
}

async function loadActivity() {
  try {
    if (!chrome.history || !chrome.history.search) throw new Error('no api');
    const items = await chrome.history.search({ text: '', maxResults: 5, startTime: Date.now() - 7 * 864e5 });
    renderActivity(items);
  } catch {
    alist.innerHTML = '<li><div class="emptybox"><p>Izin riwayat tidak tersedia.</p></div></li>';
  }
}

async function copyInfo() {
  let extra = '';
  try {
    const s = await chrome.storage.local.get(['clientId']);
    extra = s.clientId || '';
  } catch { /* abaikan */ }
  const label = $('blabel').textContent;
  const text = extra ? ('client_id=' + extra + ' browser=' + label) : ('browser=' + label + ' daemon=127.0.0.1:8765');
  try {
    await navigator.clipboard.writeText(text);
    toast(extra ? 'ID disalin' : 'Info koneksi disalin');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* abaikan */ }
    ta.remove();
    toast('Info koneksi disalin');
  }
}

$('retrybtn').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.textContent = 'Mengecek...';
  await checkHealth();
  schedulePoll();
  b.textContent = 'Cek ulang';
});
$('histbtn').addEventListener('click', async () => {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) {
    try {
      const b = globalThis.browser ?? globalThis.chrome;
      if (b?.tabs?.create) { await b.tabs.create({ url: 'about:history' }); return; }
    } catch { /* abaikan, jatuh ke toast */ }
    toast('Buka dengan Ctrl+H');
    return;
  }
  try {
    if (chrome?.tabs?.create) { chrome.tabs.create({ url: 'chrome://history' }); return; }
  } catch { /* abaikan */ }
  toast('Buka dengan Ctrl+H');
});
$('copybtn').addEventListener('click', copyInfo);

(async () => {
  const label = await detectBrowser();
  $('blabel').textContent = label;
  $('bcolor').classList.add(label);
  $('idval').textContent = label + ' - 127.0.0.1:8765';
  await checkHealth();
  schedulePoll();
  await loadActivity();
})();
