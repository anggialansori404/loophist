# LoopHist — Local-First Cross-Browser History Sync

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.22-00ADD8?logo=go)](daemon/go.mod)
[![WXT](https://img.shields.io/badge/extension-WXT-green)](extension/wxt.config.ts)

> [🇮🇩 Bahasa Indonesia](#-bahasa-indonesia) | [🇺🇸 English](#-english)

---

## 🇮🇩 Bahasa Indonesia

LoopHist menyinkronkan riwayat browsing lintas browser (Chrome, Brave, Edge, Firefox) pada satu mesin lokal secara real-time — tanpa cloud, tanpa akun, tanpa server pihak ketiga.

Setiap browser menjalankan ekstensi yang terhubung via WebSocket ke daemon lokal Go (`127.0.0.1:8765`). Kunjungan baru di Browser A disiarkan ke daemon, diteruskan ke semua browser lain, lalu diinjeksi ke riwayat lokal via `chrome.history.addUrl`. Hasilnya: halaman yang dibuka di Chrome langsung muncul di `Ctrl+H` / address bar Firefox, dan sebaliknya.

### Daftar Isi

- [Fitur](#fitur)
- [Cara Kerja](#cara-kerja)
- [Arsitektur](#arsitektur)
- [Prasyarat](#prasyarat)
- [Menjalankan Daemon](#menjalankan-daemon)
- [Membangun & Memasang Ekstensi](#membangun--memasang-ekstensi)
- [Packing / Distribusi Ekstensi](#packing--distribusi-ekstensi)
- [Autostart](#autostart)
- [Konfigurasi](#konfigurasi)
- [Protokol WebSocket](#protokol-websocket)
- [Keamanan & Privasi](#keamanan--privasi)
- [Struktur Repo](#struktur-repo)
- [Perintah Lengkap](#perintah-lengkap)
- [Verifikasi & Kualitas](#verifikasi--kualitas)
- [Troubleshooting](#troubleshooting)
- [Keterbatasan & Rencana](#keterbatasan--rencana)
- [Kontribusi](#kontribusi)
- [Lisensi](#lisensi)

### Fitur

- **F-01 — Real-time broadcast:** `chrome.history.onVisited` → event JSON via WebSocket lokal, latensi target < 200 ms.
- **F-02 — Injeksi riwayat:** peer menerima `HISTORY_VISITED` lalu `chrome.history.addUrl()`, sehingga riwayat menyatu di tiap browser.
- **F-03 — Perisai loop:** pengirim dikecualikan di hub (sender-exclude) + `recentlySyncedUrls` Set TTL 5 detik di ekstensi. URL hasil injeksi tidak dipantulkan balik.
- **F-04 — Filter privasi/noise:** hanya `http://` dan `https://`, buang skema internal (`chrome://`, `chrome-extension://`, `moz-extension://`, `about:`, `file://`, `blob:`, `view-source:`) dan loopback (`127.0.0.1`, `localhost`). Batas 200 item per pesan backfill.
- **F-05 — Resiliensi:** outbox persisten `chrome.storage.local` (cap 200, drop tertua), flush oportunistik, alarm reconnect 3 detik + keepalive ~20 detik, `GET /health` untuk popup.
- **Backfill:** klien baru kirim `SYNC_REQUEST` (7 hari terakhir, maks 200), peer jawab `SYNC_RESPONSE` (injeksi sunyi, tanpa forward). Cooldown 5 menit di ekstensi, 30 detik di daemon per `client_id`.
- **Popup status:** `popup.html` + `public/popup.js` menampilkan status daemon, latensi, `client_id`, 5 riwayat terakhir. Poll `/health` tiap 3 detik.

### Cara Kerja

1. Pengguna membuka `https://contoh.id/artikel` di Chrome.
2. `onVisited` menyala → filter skema + loopback + `recentlySyncedUrls` → enqueue ke outbox → kirim `HISTORY_VISITED` via WS.
3. Daemon terima → log `[SYNC]` → broadcast ke semua klien kecuali pengirim.
4. Firefox terima → tandai URL di `recentlySyncedUrls` **sebelum** `addUrl` → injeksi.
5. `onVisited` lokal Firefox menyala akibat injeksi → cek Set → ketemu → buang. Loop putus.
6. Daemon mati lalu hidup lagi: outbox bertahan di storage, flush saat reconnect. Klien baru: `SYNC_REQUEST` → peer kirim `SYNC_RESPONSE` → injeksi sunyi.

### Arsitektur

```text
Chrome/Brave/Edge (background SW)     Firefox (background SW)
  onVisited → filter → outbox (200)      onVisited → filter → outbox (200)
        │ WebSocket JSON                       │
        └──────────────┬───────────────────────┘
                       ▼
            Daemon Go 127.0.0.1:8765
            ┌ Hub pub/sub (sender-exclude) ─┐
            │ register / unregister /       │
            │ broadcast, evict klien lambat │
            └───────────────────────────────┘
            GET /health → {"status":"ok",...}
```

Komponen:

| Komponen | Lokasi | Peran |
|---|---|---|
| Entry daemon | `daemon/cmd/daemon/main.go` | Flag `-addr`, route `/health` + `/ws`, upgrade WS, reader pump, filter `SYNC_RESPONSE`, cooldown backfill |
| Hub | `daemon/internal/hub/hub.go` | `Register/Unregister/Broadcast/Run`, fan-out kecuali pengirim, tendang klien lambat (chan `Send` 128, `broadcast` 256) |
| Model | `daemon/pkg/model/event.go` | `SyncMessage`, `HistoryPayload` (`visit_time` fleksibel int/float/string/null), `SyncRequestPayload`, `SyncResponsePayload` |
| Background SW | `extension/entrypoints/background.ts` | `clientId` stabil, konek WS + query `client_id&browser`, deteksi `BROWSER_TYPE` via UA, outbox, loop Set, backfill, alarm |
| Popup | `extension/entrypoints/popup.html`, `extension/public/popup.js` | UI status + aktivitas, health poll, salin info koneksi |
| Manifest | `extension/wxt.config.ts` | MV3 + MV2 (Firefox), `history/storage/alarms`, host `127.0.0.1`, ikon |

### Prasyarat

- Go 1.22+ (`go version`)
- Node.js 18+ + npm (`node -v`, `npm -v`)
- Satu atau lebih browser: Chrome / Brave / Edge / Firefox
- OS: Windows (skrip PS1), Linux (systemd unit). macOS ikut jalur manual `go run`.

### Menjalankan Daemon

```bash
cd daemon
go mod tidy
go run ./cmd/daemon -addr 127.0.0.1:8765
```

Cek sehat:

```bash
curl http://127.0.0.1:8765/health
# {"status":"ok","service":"loophist-daemon"}
```

Build biner:

```bash
cd daemon
go build -ldflags="-s -w" -o ../bin/loophist-daemon ./cmd/daemon
# Windows: go build -ldflags="-s -w" -o ..\bin\loophist-daemon.exe .\cmd\daemon
./../bin/loophist-daemon -addr 127.0.0.1:8765
```

Log daemon memakai stdout/stderr standar (`log` paket). Skrip Windows meng-append ke `logs/daemon.log` dengan rotasi 5 MB, simpan 7 arsip.

### Membangun & Memasang Ekstensi

```bash
cd extension
npm install
npm run build          # Chromium: Chrome / Brave / Edge
npm run build:firefox  # Firefox
```

Hasil:

- `.output/chrome-mv3/` — `manifest.json` MV3 (`service_worker`), `background.js`, `popup.html`, `popup.js`
- `.output/firefox-mv2/` — `manifest.json` MV2 (`background.scripts`), `background.js`, `popup.html`

Pasang unpacked:

- Chrome/Brave/Edge: buka `chrome://extensions` → Developer Mode ON → Load unpacked → pilih `.output/chrome-mv3`.
- Firefox: buka `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pilih file manifest di `.output/firefox-mv2`.
- Ulangi di tiap browser yang ingin disinkronkan, pastikan daemon jalan dulu.
- Klik ikon ekstensi untuk popup: status Terhubung/Terputus, latensi, ID klien, aktivitas terakhir.

Mode dev (opsional):

```bash
npm run dev            # Chromium
npm run dev:firefox    # Firefox
```

### Packing / Distribusi Ekstensi

Hasil `build` di atas adalah folder unpacked siap load. Untuk distribusi store:

```bash
cd extension
npm run zip          # ZIP Chromium siap Chrome Web Store / Edge Add-ons
npm run zip:firefox  # ZIP Firefox siap addons.mozilla.org (AMO)
```

Catatan store:

- Ikon sudah terdaftar (`public/icon-16/32/48/128.png`, dideklarasikan di `wxt.config.ts` sebagai `icons` + `action.default_icon`). Saat ini placeholder solid — ganti PNG dengan logo final sebelum submit.
- Permission: `history`, `storage`, `alarms` + host `ws://127.0.0.1:*/*`, `http://127.0.0.1:*/*`. Justifikasi review: akses riwayat hanya dibaca/ditulis lokal, jaringan hanya loopback.
- Firefox memakai MV2 (`browser_action`), Chromium MV3 (`action` + service worker). Dua artefak build terpisah, jangan tertukar saat upload.
- Daemon tidak ikut ZIP ekstensi — distribusikan terpisah sebagai exe/biner + skrip autostart.

### Autostart

Linux (systemd user):

```bash
cp bin/loophist-daemon ~/.local/bin/
cp scripts/loophist.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now loophist.service
```

Windows (PowerShell, tanpa admin):

```powershell
.\scripts\start-daemon-background.ps1   # jalan hidden + cek health + rotasi log
.\scripts\install-autostart.ps1         # Task Scheduler LoopHistDaemon tiap logon
.\scripts\stop-daemon.ps1               # hentikan
.\scripts\uninstall.ps1                 # hentikan + hapus task
```

### Konfigurasi

| Knob | Lokasi | Nilai | Keterangan |
|---|---|---|---|
| Alamat daemon | `main.go: -addr`, skrip PS1/service | `127.0.0.1:8765` | Jangan bind selain loopback |
| Outbox cap | `background.ts: enqueueVisit` | 200 | Drop tertua bila penuh |
| Loop TTL | `background.ts: setTimeout` | 5000 ms | Jendela `recentlySyncedUrls` |
| Backfill window | `background.ts: maybeSendSyncRequest` | 7 hari, maks 200 | `since_ms`, `max_items` |
| Cooldown ekstensi | `background.ts` | 5 menit (memori + storage) | Anti spam `SYNC_REQUEST` |
| Cooldown daemon | `main.go` | 30 detik per `client_id` | Anti spam server-side |
| Reconnect | `background.ts` | alarm 3 dtk + keepalive ~20 dtk | Fixed delay, bukan backoff |
| Health poll popup | `public/popup.js` | 3000 ms | `POLL_MS` |
| Chan hub | `hub.go` | `Send` 128, `broadcast` 256 | Klien lambat di-evict |
| Log rotasi | `start-daemon-background.ps1` | 5 MB, 7 arsip | `logs/daemon-*.log` |

### Protokol WebSocket

Endpoint: `ws://127.0.0.1:8765/ws?client_id={id}&browser={chrome|firefox|brave|edge}`

`HISTORY_VISITED` (ekstensi → daemon → peer):

```json
{
  "type": "HISTORY_VISITED",
  "client_id": "client_ab12cd34",
  "browser": "chrome",
  "payload": { "url": "https://go.dev/doc/effective_go", "title": "Effective Go", "visit_time": 1730350800000 }
}
```

`HEARTBEAT` (daemon jawab `{"type":"HEARTBEAT","client_id":"server","browser":"daemon"}`):

```json
{ "type": "HEARTBEAT", "client_id": "client_ab12cd34" }
```

`SYNC_REQUEST` (bentuk kanonis — field `request`):

```json
{
  "type": "SYNC_REQUEST",
  "client_id": "client_baru",
  "browser": "firefox",
  "request": { "requestor_id": "client_baru", "since_ms": 1730000000000, "max_items": 200 }
}
```

`SYNC_RESPONSE` (bentuk kanonis — field `response`, maks 200, hanya `http(s)`):

```json
{
  "type": "SYNC_RESPONSE",
  "client_id": "client_lama",
  "browser": "chrome",
  "response": {
    "requestor_id": "client_baru",
    "items": [{ "url": "https://...", "title": "...", "visit_time": 1730350800000 }]
  }
}
```

Kompatibilitas: daemon menoleransi pengirim lama yang menaruh `requestor_id/since_ms/max_items` atau `requestor_id/items` di dalam `payload`, lalu menyiarkan ulang dalam bentuk kanonis `request`/`response`. Ekstensi baru selalu kirim kanonis. `HISTORY_VISITED`/`HEARTBEAT` tetap memakai `payload`.

### Keamanan & Privasi

- **Local-first:** tidak ada endpoint eksternal, telemetri, atau API pihak ketiga. Data tidak keluar dari mesin.
- **Bind loopback:** daemon hanya mendengar `127.0.0.1`. Jangan ubah ke `0.0.0.0` tanpa autentikasi.
- **Validasi origin:** `CheckOrigin` (`main.go`) mengizinkan origin kosong, `chrome-extension://`, `moz-extension://`, `http://127.0.0.1`, `http://localhost`; selain itu ditolak + log `[WS] Origin ditolak`. Ini lapis kedua setelah bind loopback.
- **Filter URL dua sisi:** ekstensi (`onVisited` + handler `SYNC_REQUEST`) dan daemon (`isHTTPURL` untuk `SYNC_RESPONSE`) sama-sama membuang non-`http(s)` dan loopback.
- **Idempoten:** duplikat payload tidak merusak apa pun — tidak ada DB, injeksi `addUrl` aman diulang, loop Set membuat re-entry jadi no-op.

### Struktur Repo

```text
.
├── daemon/
│   ├── cmd/daemon/main.go        # /health, /ws, CheckOrigin, cooldown, filter
│   ├── internal/hub/hub.go       # pub/sub sender-exclude + evict lambat
│   ├── internal/hub/hub_test.go  # test sender-exclude
│   └── pkg/model/event.go        # SyncMessage + payload fleksibel
├── extension/
│   ├── entrypoints/background.ts # SW: outbox, loop Set, backfill, alarm
│   ├── entrypoints/popup.html    # UI status (vanilla, tanpa framework)
│   ├── public/popup.js           # logika popup (health poll, aktivitas)
│   ├── public/icon-*.png         # ikon placeholder 16/32/48/128
│   ├── wxt.config.ts             # manifest MV3/MV2, permission, ikon
│   ├── tsconfig.json             # strict typecheck
│   └── .output/                  # hasil build (gitignore)
├── scripts/
│   ├── loophist.service          # systemd user unit (Linux)
│   ├── start-daemon-background.ps1
│   ├── install-autostart.ps1     # Task Scheduler AtLogOn
│   ├── stop-daemon.ps1
│   └── uninstall.ps1
├── docs/
│   ├── agent.md                  # aturan operasional AI & developer
│   ├── products.md               # PRD F-01..F-05
│   └── architect.md              # arsitektur + protokol
├── bin/                          # biner hasil build (gitignore)
├── logs/                         # log daemon Windows (gitignore)
├── Makefile
└── README.md
```

### Perintah Lengkap

Daemon (`cd daemon`):

```bash
go mod tidy
go run ./cmd/daemon -addr 127.0.0.1:8765
go vet ./...      # harus exit 0
go build ./...    # harus exit 0
go test ./...     # hub_test harus lolos
```

Ekstensi (`cd extension`):

```bash
npm install
npm run dev / dev:firefox
npm run build / build:firefox
npm run typecheck   # tsc --noEmit, harus exit 0
npm run zip / zip:firefox
```

Makefile:

```bash
make build-daemon   # go build ke bin/
make run-daemon     # go run
make install-service # systemd user (Linux)
```

### Verifikasi & Kualitas

- Go: `go vet ./...`, `go build ./...`, `go test ./...` — ketiganya exit 0 (terakhir diverifikasi setelah fix origin + backfill).
- Extension: `npx tsc --noEmit` exit 0 via `npm run typecheck`; `npm run build` lolos (30,63 kB, ikon terbundel).
- Aturan repo: Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `perf:`), komentar/dokumen Bahasa Indonesia, diff minimal, stdlib dulu sebelum dependensi baru.

### Troubleshooting

| Gejala | Penyebab umum | Perbaikan |
|---|---|---|
| Popup "Terputus" | Daemon belum jalan | Jalankan daemon, cek `curl localhost:8765/health` → `{"status":"ok",...}` |
| Riwayat tidak menyebar | Salah satu sisi belum pasang ekstensi / WS putus | Pasang di tiap browser, lihat log `[Sync] Connected`, `[SYNC]` di daemon |
| Backfill kosong | Peer tidak punya riwayat 7 hari / cooldown 5 mnt | Tunggu cooldown, atau kunjungi halaman dulu di peer |
| Port bentrok | 8765 dipakai aplikasi lain | Jalankan dengan `-addr 127.0.0.1:PORT` lain + sesuaikan `DAEMON_WS_URL`/`DAEMON` |
| Firefox "Buka riwayat" aneh | `chrome://history` khusus Chromium | Sudah dicabang ke `about:history` di Firefox; fallback toast `Ctrl+H` |
| Build WXT gagal | `node_modules` korup | Hapus `node_modules`, `npm install` ulang |
| SmartScreen warning | Biner tak ditandatangani | Klik More info → Run anyway (dev), tandatangani sebelum distribusi publik |

### Keterbatasan & Rencana

- **Reconnect fixed-delay**, bukan exponential backoff. Bagus untuk LAN, tapi bisa ditambah jitter bila ribut.
- **Tanpa persistensi daemon** — restart daemon = status koneksi hilang, riwayat tetap aman di tiap browser + outbox. Rencana: SQLite `modernc.org/sqlite` atau ring buffer.
- **Ikon placeholder** — ganti dengan logo final sebelum submit store.
- **Tanpa installer/auto-update daemon** — masih exe mentah + Task Scheduler/systemd.
- **Makefile** — di Windows lebih aman pakai perintah `go`/`npm` langsung daripada `make`.

### Kontribusi

1. Ikuti `docs/agent.md`: tanpa cloud, cek loop wajib (`recentlySyncedUrls`), filter `http(s)` + loopback.
2. Commit format Conventional Commits.
3. Sebelum selesai: `go vet` + `go test` (daemon), `npm run typecheck` + `npm run build` (extension).
4. Jangan tambah dependensi tanpa alasan kuat — stdlib/native dulu.

### Lisensi

MIT — lihat [LICENSE](LICENSE). Copyright (c) 2026 anggialansori404.

---

## 🇺🇸 English

LoopHist syncs browsing history across browsers (Chrome, Brave, Edge, Firefox) on a single local machine in real time — no cloud, no account, no third-party server.

Each browser runs an extension connected via WebSocket to a local Go daemon (`127.0.0.1:8765`). A new visit in Browser A is broadcast to the daemon, forwarded to every other browser, then injected into local history via `chrome.history.addUrl`. Result: a page opened in Chrome instantly shows up in Firefox's `Ctrl+H` / address bar, and vice versa.

### Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Running the Daemon](#running-the-daemon)
- [Building & Installing the Extension](#building--installing-the-extension)
- [Packing / Distributing the Extension](#packing--distributing-the-extension)
- [Autostart](#autostart-1)
- [Configuration](#configuration)
- [WebSocket Protocol](#websocket-protocol)
- [Security & Privacy](#security--privacy)
- [Repo Layout](#repo-layout)
- [Full Command Reference](#full-command-reference)
- [Verification & Quality](#verification--quality)
- [Troubleshooting](#troubleshooting-1)
- [Limitations & Roadmap](#limitations--roadmap)
- [Contributing](#contributing)
- [License](#license)

### Features

- **F-01 — Real-time broadcast:** `chrome.history.onVisited` → JSON event over local WebSocket, target latency < 200 ms.
- **F-02 — History injection:** peers receive `HISTORY_VISITED` then call `chrome.history.addUrl()`, unifying history in every browser.
- **F-03 — Loop shield:** sender-excluded hub fan-out + `recentlySyncedUrls` Set with 5 s TTL in the extension. Injected URLs are never echoed back.
- **F-04 — Privacy/noise filter:** `http://` and `https://` only; drops internal schemes (`chrome://`, `chrome-extension://`, `moz-extension://`, `about:`, `file://`, `blob:`, `view-source:`) and loopback (`127.0.0.1`, `localhost`). 200-item cap per backfill message.
- **F-05 — Resilience:** persistent outbox in `chrome.storage.local` (cap 200, drop oldest), opportunistic flush, 3 s reconnect alarm + ~20 s keepalive, `GET /health` for the popup.
- **Backfill:** new clients send `SYNC_REQUEST` (last 7 days, max 200); peers reply `SYNC_RESPONSE` (silent inject, no forward). 5 min client cooldown, 30 s daemon cooldown per `client_id`.
- **Status popup:** `popup.html` + `public/popup.js` show daemon status, latency, `client_id`, and the 5 most recent entries. Polls `/health` every 3 s.

### How It Works

1. The user opens `https://example.com/article` in Chrome.
2. `onVisited` fires → scheme + loopback + `recentlySyncedUrls` filter → enqueue to outbox → send `HISTORY_VISITED` over WS.
3. Daemon receives → logs `[SYNC]` → broadcasts to all clients except the sender.
4. Firefox receives → marks the URL in `recentlySyncedUrls` **before** `addUrl` → injects.
5. Local Firefox `onVisited` fires from the injection → Set hit → dropped. Loop broken.
6. Daemon restarts: outbox survives in storage, flushes on reconnect. New clients: `SYNC_REQUEST` → peers send `SYNC_RESPONSE` → silent inject.

### Architecture

```text
Chrome/Brave/Edge (background SW)     Firefox (background SW)
  onVisited → filter → outbox (200)      onVisited → filter → outbox (200)
        │ WebSocket JSON                       │
        └──────────────┬───────────────────────┘
                       ▼
            Go daemon 127.0.0.1:8765
            ┌ Hub pub/sub (sender-exclude) ─┐
            │ register / unregister /       │
            │ broadcast, evict slow clients │
            └───────────────────────────────┘
            GET /health → {"status":"ok",...}
```

Components:

| Component | Location | Role |
|---|---|---|
| Daemon entry | `daemon/cmd/daemon/main.go` | `-addr` flag, `/health` + `/ws` routes, WS upgrade, reader pump, `SYNC_RESPONSE` filter, backfill cooldown |
| Hub | `daemon/internal/hub/hub.go` | `Register/Unregister/Broadcast/Run`, fan-out minus sender, evict slow clients (`Send` chan 128, `broadcast` 256) |
| Model | `daemon/pkg/model/event.go` | `SyncMessage`, `HistoryPayload` (flexible `visit_time` int/float/string/null), `SyncRequestPayload`, `SyncResponsePayload` |
| Background SW | `extension/entrypoints/background.ts` | Stable `clientId`, WS connect + `client_id&browser` query, UA-based `BROWSER_TYPE`, outbox, loop Set, backfill, alarms |
| Popup | `extension/entrypoints/popup.html`, `extension/public/popup.js` | Status + activity UI, health poll, copy connection info |
| Manifest | `extension/wxt.config.ts` | MV3 + MV2 (Firefox), `history/storage/alarms`, `127.0.0.1` host, icons |

### Prerequisites

- Go 1.22+ (`go version`)
- Node.js 18+ + npm (`node -v`, `npm -v`)
- One or more browsers: Chrome / Brave / Edge / Firefox
- OS: Windows (PS1 scripts), Linux (systemd unit). macOS follows the manual `go run` path.

### Running the Daemon

```bash
cd daemon
go mod tidy
go run ./cmd/daemon -addr 127.0.0.1:8765
```

Health check:

```bash
curl http://127.0.0.1:8765/health
# {"status":"ok","service":"loophist-daemon"}
```

Build the binary:

```bash
cd daemon
go build -ldflags="-s -w" -o ../bin/loophist-daemon ./cmd/daemon
# Windows: go build -ldflags="-s -w" -o ..\bin\loophist-daemon.exe .\cmd\daemon
./../bin/loophist-daemon -addr 127.0.0.1:8765
```

The daemon logs to stdout/stderr (stdlib `log`). The Windows script appends to `logs/daemon.log` with 5 MB rotation, keeping 7 archives.

### Building & Installing the Extension

```bash
cd extension
npm install
npm run build          # Chromium: Chrome / Brave / Edge
npm run build:firefox  # Firefox
```

Outputs:

- `.output/chrome-mv3/` — MV3 `manifest.json` (`service_worker`), `background.js`, `popup.html`, `popup.js`
- `.output/firefox-mv2/` — MV2 `manifest.json` (`background.scripts`), `background.js`, `popup.html`

Load unpacked:

- Chrome/Brave/Edge: open `chrome://extensions` → Developer Mode ON → Load unpacked → pick `.output/chrome-mv3`.
- Firefox: open `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick the manifest inside `.output/firefox-mv2`.
- Repeat in every browser you want synced; make sure the daemon runs first.
- Click the extension icon for the popup: Connected/Disconnected status, latency, client ID, recent activity.

Dev mode (optional):

```bash
npm run dev            # Chromium
npm run dev:firefox    # Firefox
```

### Packing / Distributing the Extension

The `build` output above is a load-ready unpacked folder. For store distribution:

```bash
cd extension
npm run zip          # Chromium ZIP for Chrome Web Store / Edge Add-ons
npm run zip:firefox  # Firefox ZIP for addons.mozilla.org (AMO)
```

Store notes:

- Icons registered (`public/icon-16/32/48/128.png`, declared in `wxt.config.ts` as `icons` + `action.default_icon`). Currently solid placeholders — replace with the final logo before submitting.
- Permissions: `history`, `storage`, `alarms` + hosts `ws://127.0.0.1:*/*`, `http://127.0.0.1:*/*`. Review justification: history is only read/written locally, network is loopback-only.
- Firefox uses MV2 (`browser_action`), Chromium MV3 (`action` + service worker). Two separate build artifacts — don't mix them up on upload.
- The daemon is not part of the extension ZIP — distribute it separately as exe/binary + autostart scripts.

### Autostart

Linux (systemd user):

```bash
cp bin/loophist-daemon ~/.local/bin/
cp scripts/loophist.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now loophist.service
```

Windows (PowerShell, no admin):

```powershell
.\scripts\start-daemon-background.ps1   # hidden run + health check + log rotation
.\scripts\install-autostart.ps1         # LoopHistDaemon Task Scheduler on every logon
.\scripts\stop-daemon.ps1               # stop
.\scripts\uninstall.ps1                 # stop + remove task
```

### Configuration

| Knob | Location | Value | Notes |
|---|---|---|---|
| Daemon address | `main.go: -addr`, PS1/service scripts | `127.0.0.1:8765` | Never bind beyond loopback |
| Outbox cap | `background.ts: enqueueVisit` | 200 | Drop oldest when full |
| Loop TTL | `background.ts: setTimeout` | 5000 ms | `recentlySyncedUrls` window |
| Backfill window | `background.ts: maybeSendSyncRequest` | 7 days, max 200 | `since_ms`, `max_items` |
| Client cooldown | `background.ts` | 5 min (memory + storage) | Anti-spam `SYNC_REQUEST` |
| Daemon cooldown | `main.go` | 30 s per `client_id` | Server-side anti-spam |
| Reconnect | `background.ts` | 3 s alarm + ~20 s keepalive | Fixed delay, not backoff |
| Popup health poll | `public/popup.js` | 3000 ms | `POLL_MS` |
| Hub chans | `hub.go` | `Send` 128, `broadcast` 256 | Slow clients evicted |
| Log rotation | `start-daemon-background.ps1` | 5 MB, 7 archives | `logs/daemon-*.log` |

### WebSocket Protocol

Endpoint: `ws://127.0.0.1:8765/ws?client_id={id}&browser={chrome|firefox|brave|edge}`

`HISTORY_VISITED` (extension → daemon → peers) and `HEARTBEAT` use the `payload` shape; `SYNC_REQUEST` uses the canonical `request` field and `SYNC_RESPONSE` the canonical `response` field (max 200 items, `http(s)` only). The daemon tolerates legacy senders that nest backfill data under `payload` and re-broadcasts in canonical form. See the Indonesian section above for full JSON examples.

### Security & Privacy

- **Local-first:** no external endpoints, telemetry, or third-party APIs. Data never leaves the machine.
- **Loopback bind:** the daemon listens on `127.0.0.1` only. Never change to `0.0.0.0` without authentication.
- **Origin validation:** `CheckOrigin` (`main.go`) allows empty origins, `chrome-extension://`, `moz-extension://`, `http://127.0.0.1`, `http://localhost`; everything else is rejected + logged as `[WS] Origin ditolak`. Second layer after the loopback bind.
- **Two-sided URL filter:** the extension (`onVisited` + `SYNC_REQUEST` handler) and the daemon (`isHTTPURL` for `SYNC_RESPONSE`) both drop non-`http(s)` and loopback URLs.
- **Idempotent:** duplicate payloads are harmless — no DB, `addUrl` is safe to repeat, the loop Set makes re-entry a no-op.

### Repo Layout

Same layout as documented in the Indonesian section: `daemon/` (entry, hub + test, model), `extension/` (background SW, popup, icons, WXT config, tsconfig), `scripts/` (`loophist.service` + 4 PS1 scripts), `docs/`, `bin/`, `logs/`, `Makefile`, `LICENSE`, `README.md`.

### Full Command Reference

Daemon (`cd daemon`):

```bash
go mod tidy
go run ./cmd/daemon -addr 127.0.0.1:8765
go vet ./...      # must exit 0
go build ./...    # must exit 0
go test ./...     # hub_test must pass
```

Extension (`cd extension`):

```bash
npm install
npm run dev / dev:firefox
npm run build / build:firefox
npm run typecheck   # tsc --noEmit, must exit 0
npm run zip / zip:firefox
```

Makefile:

```bash
make build-daemon   # go build into bin/
make run-daemon     # go run
make install-service # systemd user (Linux)
```

### Verification & Quality

- Go: `go vet ./...`, `go build ./...`, `go test ./...` — all exit 0.
- Extension: `npx tsc --noEmit` exit 0 via `npm run typecheck`; `npm run build` passes (30.63 kB, icons bundled).
- Repo rules: Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `perf:`), minimal diffs, stdlib before new dependencies.

### Troubleshooting

| Symptom | Common cause | Fix |
|---|---|---|
| Popup shows "Disconnected" | Daemon not running | Start the daemon, check `curl localhost:8765/health` → `{"status":"ok",...}` |
| History not spreading | Extension missing on one side / WS down | Install in every browser, watch `[Sync] Connected` and daemon `[SYNC]` logs |
| Empty backfill | Peer has no 7-day history / 5 min cooldown | Wait out the cooldown, or browse something on the peer first |
| Port conflict | 8765 taken by another app | Run with `-addr 127.0.0.1:OTHER_PORT` + update `DAEMON_WS_URL`/`DAEMON` |
| Odd "open history" in Firefox | `chrome://history` is Chromium-only | Branched to `about:history` on Firefox; falls back to a `Ctrl+H` toast |
| WXT build fails | Corrupt `node_modules` | Delete `node_modules`, `npm install` again |
| SmartScreen warning | Unsigned binary | More info → Run anyway (dev), sign before public distribution |

### Limitations & Roadmap

- **Fixed-delay reconnect**, not exponential backoff. Fine on LAN, jitter can be added if noisy.
- **No daemon persistence** — a restart drops connection state; history stays safe in each browser + outbox. Planned: SQLite `modernc.org/sqlite` or a ring buffer.
- **Placeholder icons** — replace with the final logo before store submission.
- **No daemon installer/auto-update** — still a raw exe + Task Scheduler/systemd.
- **Makefile** — on Windows prefer direct `go`/`npm` commands over `make`.

### Contributing

1. Follow `docs/agent.md`: no cloud, mandatory loop check (`recentlySyncedUrls`), `http(s)` + loopback filter.
2. Conventional Commits format.
3. Before finishing: `go vet` + `go test` (daemon), `npm run typecheck` + `npm run build` (extension).
4. No new dependencies without good reason — stdlib/native first.

### License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 anggialansori404.

---

Repo: https://github.com/anggialansori404/loophist.git
