# LoopHist — Local-First Cross-Browser History Sync

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.22-00ADD8?logo=go)](daemon/go.mod)
[![WXT](https://img.shields.io/badge/extension-WXT-green)](extension/wxt.config.ts)

Sinkronisasi riwayat browsing lintas browser (Chrome, Brave, Edge, Firefox) pada satu mesin lokal secara real-time, tanpa cloud, tanpa akun, tanpa server pihak ketiga.

Setiap browser menjalankan ekstensi yang terhubung via WebSocket ke daemon lokal Go (`127.0.0.1:8765`). Kunjungan baru di Browser A disiarkan ke daemon, diteruskan ke semua browser lain, lalu diinjeksi ke riwayat lokal via `chrome.history.addUrl`. Hasilnya: halaman yang dibuka di Chrome langsung muncul di `Ctrl+H` / address bar Firefox, dan sebaliknya.

## Daftar Isi

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

## Fitur

- **F-01 — Real-time broadcast:** `chrome.history.onVisited` → event JSON via WebSocket lokal, latensi target < 200 ms.
- **F-02 — Injeksi riwayat:** peer menerima `HISTORY_VISITED` lalu `chrome.history.addUrl()`, sehingga riwayat menyatu di tiap browser.
- **F-03 — Perisai loop:** pengirim dikecualikan di hub (sender-exclude) + `recentlySyncedUrls` Set TTL 5 detik di ekstensi. URL hasil injeksi tidak dipantulkan balik.
- **F-04 — Filter privasi/noise:** hanya `http://` dan `https://`, buang skema internal (`chrome://`, `chrome-extension://`, `moz-extension://`, `about:`, `file://`, `blob:`, `view-source:`) dan loopback (`127.0.0.1`, `localhost`). Batas 200 item per pesan backfill.
- **F-05 — Resiliensi:** outbox persisten `chrome.storage.local` (cap 200, drop tertua), flush oportunistik, alarm reconnect 3 detik + keepalive ~20 detik, `GET /health` untuk popup.
- **Backfill:** klien baru kirim `SYNC_REQUEST` (7 hari terakhir, maks 200), peer jawab `SYNC_RESPONSE` (injeksi sunyi, tanpa forward). Cooldown 5 menit di ekstensi, 30 detik di daemon per `client_id`.
- **Popup status:** `popup.html` + `public/popup.js` menampilkan status daemon, latensi, `client_id`, 5 riwayat terakhir. Poll `/health` tiap 3 detik.

## Cara Kerja

1. Pengguna membuka `https://contoh.id/artikel` di Chrome.
2. `onVisited` menyala → filter skema + loopback + `recentlySyncedUrls` → enqueue ke outbox → kirim `HISTORY_VISITED` via WS.
3. Daemon terima → log `[SYNC]` → broadcast ke semua klien kecuali pengirim.
4. Firefox terima → tandai URL di `recentlySyncedUrls` **sebelum** `addUrl` → injeksi.
5. `onVisited` lokal Firefox menyala akibat injeksi → cek Set → ketemu → buang. Loop putus.
6. Daemon mati lalu hidup lagi: outbox bertahan di storage, flush saat reconnect. Klien baru: `SYNC_REQUEST` → peer kirim `SYNC_RESPONSE` → injeksi sunyi.

## Arsitektur

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

## Prasyarat

- Go 1.22+ (`go version`)
- Node.js 18+ + npm (`node -v`, `npm -v`)
- Satu atau lebih browser: Chrome / Brave / Edge / Firefox
- OS: Windows (skrip PS1), Linux (systemd unit). macOS ikut jalur manual `go run`.

## Menjalankan Daemon

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

## Membangun & Memasang Ekstensi

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

## Packing / Distribusi Ekstensi

Ya, ekstensi bisa di-pack. Hasil `build` di atas adalah folder unpacked siap load. Untuk distribusi store:

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

## Autostart

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

## Konfigurasi

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

## Protokol WebSocket

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

## Keamanan & Privasi

- **Local-first:** tidak ada endpoint eksternal, telemetri, atau API pihak ketiga. Data tidak keluar dari mesin.
- **Bind loopback:** daemon hanya mendengar `127.0.0.1`. Jangan ubah ke `0.0.0.0` tanpa autentikasi.
- **Validasi origin:** `CheckOrigin` (`main.go`) mengizinkan origin kosong, `chrome-extension://`, `moz-extension://`, `http://127.0.0.1`, `http://localhost`; selain itu ditolak + log `[WS] Origin ditolak`. Ini lapis kedua setelah bind loopback.
- **Filter URL dua sisi:** ekstensi (`onVisited` + handler `SYNC_REQUEST`) dan daemon (`isHTTPURL` untuk `SYNC_RESPONSE`) sama-sama membuang non-`http(s)` dan loopback.
- **Idempoten:** duplikat payload tidak merusak apa pun — tidak ada DB, injeksi `addUrl` aman diulang, loop Set membuat re-entry jadi no-op.

## Struktur Repo

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
│   ├── loophist.service              # systemd user unit (Linux)
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

## Perintah Lengkap

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

## Verifikasi & Kualitas

- Go: `go vet ./...`, `go build ./...`, `go test ./...` — ketiganya exit 0 (terakhir diverifikasi setelah fix origin + backfill).
- Extension: `npx tsc --noEmit` exit 0 via `npm run typecheck`; `npm run build` lolos (~1,6 dtk, 30,63 kB, ikon terbundel).
- Aturan repo: Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `perf:`), komentar/dokumen Bahasa Indonesia, diff minimal, stdlib dulu sebelum dependensi baru.

## Troubleshooting

| Gejala | Penyebab umum | Perbaikan |
|---|---|---|
| Popup "Terputus" | Daemon belum jalan | Jalankan daemon, cek `curl localhost:8765/health` → `{"status":"ok",...}` |
| Riwayat tidak menyebar | Salah satu sisi belum pasang ekstensi / WS putus | Pasang di tiap browser, lihat log `[Sync] Connected`, `[SYNC]` di daemon |
| Backfill kosong | Peer tidak punya riwayat 7 hari / cooldown 5 mnt | Tunggu cooldown, atau kunjungi halaman dulu di peer |
| Port bentrok | 8765 dipakai aplikasi lain | Jalankan dengan `-addr 127.0.0.1:PORT` lain + sesuaikan `DAEMON_WS_URL`/`DAEMON` |
| Firefox "Buka riwayat" aneh | `chrome://history` khusus Chromium | Sudah dicabang ke `about:history` di Firefox; fallback toast `Ctrl+H` |
| Build WXT gagal | `node_modules` korup | Hapus `node_modules`, `npm install` ulang |
| SmartScreen warning | Biner tak ditandatangani | Klik More info → Run anyway (dev), tandatangani sebelum distribusi publik |

## Keterbatasan & Rencana

- **Reconnect fixed-delay**, bukan exponential backoff (klaim lama di `products.md` belum sesuai kode). Bagus untuk LAN, tapi bisa ditambah jitter bila ribut.
- **Tanpa persistensi daemon** — restart daemon = status koneksi hilang, riwayat tetap aman di tiap browser + outbox. Rencana: SQLite `modernc.org/sqlite` atau ring buffer (dokumen menyebutnya, kode belum ada).
- **Ikon placeholder** — ganti dengan logo final sebelum submit store.
- **Tanpa installer/auto-update daemon** — masih exe mentah + Task Scheduler/systemd.
- **Makefile** — target `build-ext`/`clean` dan `.PHONY` belum sinkron penuh; di Windows lebih aman pakai perintah `go`/`npm` langsung.

## Kontribusi

1. Ikuti `docs/agent.md`: tanpa cloud, cek loop wajib (`recentlySyncedUrls`), filter `http(s)` + loopback.
2. Commit format Conventional Commits.
3. Sebelum selesai: `go vet` + `go test` (daemon), `npm run typecheck` + `npm run build` (extension).
4. Jangan tambah dependensi tanpa alasan kuat — stdlib/native dulu.

## Lisensi

MIT — lihat [LICENSE](LICENSE). Copyright (c) 2026 anggialansori404.

## Repo

https://github.com/anggialansori404/loophist.git
