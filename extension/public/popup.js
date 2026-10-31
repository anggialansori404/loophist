const DAEMON = 'http://127.0.0.1:8765';
const POLL_MS = 3000;
let pollTimer = null;
const $ = (id) => document.getElementById(id);
const hero = $('hero'), stitle = $('stitle'), ssub = $('ssub'),
  latencyEl = $('latency'), alist = $('alist'), actcount = $('actcount');

const STR = {
  id: {
    checking: 'Memeriksa…', checking_sub: 'Menghubungi daemon lokal',
    connected: 'Terhubung', connected_sub: 'Daemon menjawab, dicek otomatis',
    disconnected: 'Terputus', disconnected_sub: 'Daemon tidak menjawab',
    latency: (ms) => 'Latensi ' + ms + ' ms', latency_off: 'Latensi -',
    subtitle: 'Riwayat menyatu otomatis', retry: 'Cek ulang', checking_btn: 'Mengecek...',
    open_history: 'Buka riwayat', conn_label: 'Koneksi browser ini', copy: 'Salin',
    recent: 'Aktivitas terakhir', count: (n) => n + ' item',
    poll_every: 'Cek tiap <b>3 dtk</b>',
    dead: 'Daemon belum jalan. Nyalakan daemon lokal di port <b>8765</b>, lalu klik <b>Cek ulang</b>.',
    empty_title: 'Belum ada aktivitas', empty_sub: 'Jelajahi web, riwayat terbaru muncul di sini.',
    no_perm: 'Izin riwayat tidak tersedia.',
    just_now: 'baru saja', min_ago: (n) => n + ' mnt lalu',
    hr_ago: (n) => n + ' jam lalu', days_ago: (n) => n + ' hari lalu',
    copied_id: 'ID disalin', copied_info: 'Info koneksi disalin',
    open_hint: 'Buka dengan Ctrl+H',
    local_only: '● Data lokal saja', no_cloud: 'Tanpa cloud',
    lang_label: 'Bahasa / Language',
  },
  en: {
    checking: 'Checking…', checking_sub: 'Contacting local daemon',
    connected: 'Connected', connected_sub: 'Daemon responding, auto-checked',
    disconnected: 'Disconnected', disconnected_sub: 'Daemon not responding',
    latency: (ms) => 'Latency ' + ms + ' ms', latency_off: 'Latency -',
    subtitle: 'History synced automatically', retry: 'Retry', checking_btn: 'Checking...',
    open_history: 'Open history', conn_label: 'This browser connection', copy: 'Copy',
    recent: 'Recent activity', count: (n) => n + (n === 1 ? ' item' : ' items'),
    poll_every: 'Check every <b>3s</b>',
    dead: 'Daemon is not running. Start the local daemon on port <b>8765</b>, then click <b>Retry</b>.',
    empty_title: 'No activity yet', empty_sub: 'Browse the web, recent history shows up here.',
    no_perm: 'History permission unavailable.',
    just_now: 'just now', min_ago: (n) => n + ' min ago',
    hr_ago: (n) => n + ' hr ago', days_ago: (n) => n + ' days ago',
    copied_id: 'ID copied', copied_info: 'Connection info copied',
    open_hint: 'Open with Ctrl+H',
    local_only: '● Local data only', no_cloud: 'No cloud',
    lang_label: 'Bahasa / Language',
  },
};
let lang = 'id';
const T = (k, ...a) => { const v = STR[lang][k] ?? STR.id[k]; return typeof v === 'function' ? v(...a) : v; };
let lastState = 'checking';

function applyLang(l) {
  lang = STR[l] ? l : 'id';
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = STR[lang][el.dataset.i18n] ?? STR.id[el.dataset.i18n];
    if (typeof v === 'string') el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const v = STR[lang][el.dataset.i18nHtml] ?? STR.id[el.dataset.i18nHtml];
    if (typeof v === 'string') el.innerHTML = v;
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const v = STR[lang][el.dataset.i18nAria] ?? STR.id[el.dataset.i18nAria];
    if (typeof v === 'string') el.setAttribute('aria-label', v);
  });
  $('lang-id').classList.toggle('on', lang === 'id');
  $('lang-en').classList.toggle('on', lang === 'en');
  $('lang-id').setAttribute('aria-pressed', String(lang === 'id'));
  $('lang-en').setAttribute('aria-pressed', String(lang === 'en'));
  // Re-render dynamic strings (status, retry button, count) without touching logic
  if (lastState === 'on') { stitle.textContent = T('connected'); ssub.textContent = T('connected_sub'); }
  else if (lastState === 'off') { stitle.textContent = T('disconnected'); ssub.textContent = T('disconnected_sub'); }
  refreshActivityStrings();
}

async function setLang(l) {
  applyLang(l);
  try { await chrome.storage.local.set({ lang }); } catch { /* abaikan */ }
}

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
  if (s < 60) return T('just_now');
  if (s < 3600) return T('min_ago', Math.floor(s / 60));
  if (s < 86400) return T('hr_ago', Math.floor(s / 3600));
  return T('days_ago', Math.floor(s / 86400));
}

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); }
  catch { return u; }
}

const TONES = [['#D3E3FD', '#0B57D0'], ['#C2F0C6', '#146C2E'], ['#FDECC8', '#7A4A00'], ['#E8DEF8', '#4F378B'], ['#D9ECFA', '#00639B']];
let lastItems = null;

async function checkHealth() {
  const t0 = performance.now();
  try {
    const r = await fetch(DAEMON + '/health', { cache: 'no-store' });
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) throw new Error('bad');
    hero.classList.remove('off');
    hero.classList.add('on');
    lastState = 'on';
    stitle.textContent = T('connected');
    ssub.textContent = T('connected_sub');
    latencyEl.textContent = T('latency', ms);
  } catch {
    hero.classList.add('off');
    hero.classList.remove('on');
    lastState = 'off';
    stitle.textContent = T('disconnected');
    ssub.textContent = T('disconnected_sub');
    latencyEl.textContent = T('latency_off');
  }
}

function schedulePoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(checkHealth, POLL_MS);
}

function renderActivity(items) {
  lastItems = items;
  alist.innerHTML = '';
  if (!items || !items.length) {
    actcount.textContent = '';
    alist.innerHTML = '<li><div class="emptybox"><div class="e-ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div><p><b>' + T('empty_title') + '</b></p><p>' + T('empty_sub') + '</p></div></li>';
    return;
  }
  actcount.textContent = T('count', items.length);
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
    tm.dataset.ts = it.lastVisitTime || '';
    li.append(av, t, tm);
    alist.append(li);
  });
}

function refreshActivityStrings() {
  if (lastItems === null) return;
  if (lastItems === 'noperm') { alist.innerHTML = '<li><div class="emptybox"><p>' + T('no_perm') + '</p></div></li>'; return; }
  if (!lastItems || !lastItems.length) { renderActivity(lastItems); return; }
  actcount.textContent = T('count', lastItems.length);
  alist.querySelectorAll('time[data-ts]').forEach((tm) => {
    const ts = Number(tm.dataset.ts);
    if (ts) tm.textContent = ago(ts);
  });
  const emptyB = alist.querySelector('.emptybox p');
  if (emptyB && emptyB.textContent === '') renderActivity(lastItems);
}

async function loadActivity() {
  try {
    if (!chrome.history || !chrome.history.search) throw new Error('no api');
    const items = await chrome.history.search({ text: '', maxResults: 5, startTime: Date.now() - 7 * 864e5 });
    renderActivity(items);
  } catch {
    lastItems = 'noperm';
    alist.innerHTML = '<li><div class="emptybox"><p>' + T('no_perm') + '</p></div></li>';
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
    toast(extra ? T('copied_id') : T('copied_info'));
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* abaikan */ }
    ta.remove();
    toast(T('copied_info'));
  }
}

$('retrybtn').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.textContent = T('checking_btn');
  await checkHealth();
  schedulePoll();
  b.textContent = T('retry');
});
$('histbtn').addEventListener('click', async () => {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) {
    try {
      const b = globalThis.browser ?? globalThis.chrome;
      if (b?.tabs?.create) { await b.tabs.create({ url: 'about:history' }); return; }
    } catch { /* abaikan, jatuh ke toast */ }
    toast(T('open_hint'));
    return;
  }
  try {
    if (chrome?.tabs?.create) { chrome.tabs.create({ url: 'chrome://history' }); return; }
  } catch { /* abaikan */ }
  toast(T('open_hint'));
});
$('copybtn').addEventListener('click', copyInfo);
$('lang-id').addEventListener('click', () => setLang('id'));
$('lang-en').addEventListener('click', () => setLang('en'));

(async () => {
  try {
    const s = await chrome.storage.local.get(['lang']);
    if (s.lang === 'id' || s.lang === 'en') lang = s.lang;
  } catch { /* abaikan, default id */ }
  applyLang(lang);
  // ponytail: no storage.onChanged listener; language refreshes on popup open + toggle click. Add listener when live cross-popup sync needed.
  const label = await detectBrowser();
  $('blabel').textContent = label;
  $('bcolor').classList.add(label);
  $('idval').textContent = label + ' - 127.0.0.1:8765';
  await checkHealth();
  schedulePoll();
  await loadActivity();
})();
