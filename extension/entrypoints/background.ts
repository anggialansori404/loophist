import { defineBackground } from 'wxt/sandbox';

// Background Service Worker LoopHist
const DAEMON_WS_URL = 'ws://127.0.0.1:8765/ws';
const BROWSER_TYPE = navigator.userAgent.includes('Firefox') ? 'firefox' : navigator.userAgent.includes('Edg') ? 'edge' : 'brave' in navigator ? 'brave' : 'chrome';

interface OutboxEntry {
  url: string;
  title: string;
  visit_time: number;
  ts: number;
}

// In-memory set untuk menyaring loop sinkronisasi
const recentlySyncedUrls = new Set<string>();

let socket: WebSocket | null = null;
let clientId: string | null = null;
let flushing = false;

// Debounce SYNC_REQUEST: in-memory + persisten (reload tak spam)
let lastSyncRequestAt = 0;
const SYNC_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;

async function maybeSendSyncRequest() {
  if (!clientId) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (now - lastSyncRequestAt < SYNC_REQUEST_COOLDOWN_MS) return;
  const stored = await chrome.storage.local.get(['lastSyncRequest']);
  const last = typeof stored.lastSyncRequest === 'number' ? stored.lastSyncRequest : 0;
  if (now - last < SYNC_REQUEST_COOLDOWN_MS) {
    lastSyncRequestAt = last;
    return;
  }
  lastSyncRequestAt = now;
  await chrome.storage.local.set({ lastSyncRequest: now });
  socket.send(JSON.stringify({
    type: 'SYNC_REQUEST',
    client_id: clientId,
    browser: BROWSER_TYPE,
    request: {
      requestor_id: clientId,
      since_ms: now - 7 * 864e5,
      max_items: 200,
    },
  }));
}

async function getClientId(): Promise<string> {
  if (clientId) return clientId;
  const stored = await chrome.storage.local.get(['clientId']);
  if (typeof stored.clientId === 'string' && stored.clientId) {
    clientId = stored.clientId;
  } else {
    clientId = 'client_' + Math.random().toString(36).substring(2, 10);
    await chrome.storage.local.set({ clientId });
  }
  return clientId;
}

function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  // clientId mungkin belum termuat saat SW baru bangun; ambil async lalu sambung
  if (!clientId) {
    getClientId().then(() => connectWebSocket());
    return;
  }

  const endpoint = `${DAEMON_WS_URL}?client_id=${clientId}&browser=${BROWSER_TYPE}`;
  socket = new WebSocket(endpoint);

  socket.onopen = () => {
    console.log(`[Sync] Connected to local daemon as ${clientId} (${BROWSER_TYPE})`);
    flushOutbox();
    maybeSendSyncRequest();
  };

  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'HISTORY_VISITED' && data.payload?.url) {
        const targetUrl = data.payload.url;

        // Cegah event 'onVisited' lokal men-trigger pengiriman balik
        recentlySyncedUrls.add(targetUrl);

        // Injeksi URL ke browser lokal
        await chrome.history.addUrl({ url: targetUrl });
        console.log(`[Sync] Injected URL from peer: ${targetUrl}`);

        // Bersihkan cache loop setelah buffer window
        setTimeout(() => {
          recentlySyncedUrls.delete(targetUrl);
        }, 5000);
      } else if (data.type === 'SYNC_REQUEST' && data.client_id !== clientId) {
        // Peer minta riwayat: jawab SYNC_RESPONSE langsung via socket, tanpa outbox
        try {
          const maxItems = typeof data.request?.max_items === 'number' ? Math.min(data.request.max_items, 200) : 200;
          const since = typeof data.request?.since_ms === 'number' ? data.request.since_ms : Date.now() - 7 * 864e5;
          const results = await chrome.history.search({ text: '', maxResults: maxItems, startTime: since });
          const items = results
            .filter((r) => r.url && (r.url.startsWith('http://') || r.url.startsWith('https://')))
            .filter((r) => !r.url!.includes('127.0.0.1') && !r.url!.includes('localhost'))
            .slice(0, 200)
            .map((r) => ({ url: r.url!, title: r.title || '', visit_time: r.lastVisitTime || Date.now() }));
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'SYNC_RESPONSE',
              client_id: clientId,
              browser: BROWSER_TYPE,
              response: { requestor_id: data.client_id, items },
            }));
          }
        } catch (err) {
          console.error('[Sync] SYNC_REQUEST handler error:', err);
        }
      } else if (data.type === 'SYNC_RESPONSE' && data.response?.requestor_id === clientId && Array.isArray(data.response?.items)) {
        // Jawaban atas request kita: injeksi sunyi, tanpa forward/balas
        for (const item of data.response.items.slice(0, 200)) {
          const targetUrl = item?.url;
          if (typeof targetUrl !== 'string' || !targetUrl) continue;
          if (recentlySyncedUrls.has(targetUrl)) continue;
          // Tandai SEBELUM addUrl agar onVisited lokal tak enqueue balik
          recentlySyncedUrls.add(targetUrl);
          try {
            await chrome.history.addUrl({ url: targetUrl });
          } catch {
            // abaikan item gagal, cache tetap expire via timeout
          }
          setTimeout(() => {
            recentlySyncedUrls.delete(targetUrl);
          }, 5000);
        }
      }
    } catch (err) {
      console.error('[Sync] Error parsing incoming WS message:', err);
    }
  };

  socket.onclose = () => {
    console.warn('[Sync] Disconnected from daemon. Reconnecting in 3s via alarm...');
    scheduleReconnect();
  };

  socket.onerror = () => {
    console.warn('[Sync] Daemon socket error. Will retry...');
    socket?.close();
  };
}

function scheduleReconnect() {
  chrome.alarms.create('sync-reconnect', { when: Date.now() + 3000 });
}

async function enqueueVisit(url: string, title: string, visit_time: number) {
  const stored = await chrome.storage.local.get(['outbox']);
  const outbox: OutboxEntry[] = Array.isArray(stored.outbox) ? stored.outbox : [];
  outbox.push({ url, title, visit_time, ts: Date.now() });
  // cap 200, drop tertua
  while (outbox.length > 200) outbox.shift();
  await chrome.storage.local.set({ outbox });
}

async function flushOutbox() {
  if (flushing) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!clientId) return;
  flushing = true;
  try {
    const stored = await chrome.storage.local.get(['outbox']);
    const outbox: OutboxEntry[] = Array.isArray(stored.outbox) ? stored.outbox : [];
    while (outbox.length > 0) {
      if (!socket || socket.readyState !== WebSocket.OPEN) break;
      const entry = outbox[0];
      // Dedup: skip entri yang baru saja diinjeksi dari peer (jeda reload/rebuild)
      if (recentlySyncedUrls.has(entry.url)) {
        outbox.shift();
        continue;
      }
      const message = {
        type: 'HISTORY_VISITED',
        client_id: clientId,
        browser: BROWSER_TYPE,
        payload: {
          url: entry.url,
          title: entry.title || '',
          visit_time: entry.visit_time || Date.now()
        }
      };
      socket.send(JSON.stringify(message));
      outbox.shift();
      console.log(`[Sync] Dispatched visit event: ${entry.url}`);
    }
    await chrome.storage.local.set({ outbox });
  } catch (err) {
    console.error('[Sync] flushOutbox error:', err);
  } finally {
    flushing = false;
  }
}

function scheduleFlushNow() {
  chrome.alarms.create('flush-now', { when: Date.now() + 5000 });
}

export default defineBackground(() => {
  // Siapkan client_id stabil + alarm keepalive, lalu konek
  getClientId().then(() => connectWebSocket());
  chrome.alarms.create('sync-keepalive', { periodInMinutes: 0.33 });

  // Bangunkan SW secara berkala: reconnect + flush
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'sync-keepalive' || alarm.name === 'flush-now' || alarm.name === 'sync-reconnect') {
      connectWebSocket();
      flushOutbox();
    }
  });

  // Listener riwayat browsing lokal: SELALU enqueue, flush oportunistik
  chrome.history.onVisited.addListener((item) => {
    if (!item.url) return;

    // 1. Filter URL skema internal
    if (!item.url.startsWith('http://') && !item.url.startsWith('https://')) {
      return;
    }

    // 2. Filter localhost/loopback
    if (item.url.includes('127.0.0.1') || item.url.includes('localhost')) {
      return;
    }

    // 3. Loop check: Jika URL berasal dari remote injection, abaikan
    if (recentlySyncedUrls.has(item.url)) {
      return;
    }

    // 4. Enqueue persisten + flush oportunistik + alarm one-shot (jeda reload/rebuild)
    enqueueVisit(item.url, item.title || '', item.lastVisitTime || Date.now()).then(() => {
      flushOutbox();
      scheduleFlushNow();
    });
  });
});
