# ARCHITECT.MD - System Architecture & Engineering Design

Dokumen arsitektur teknis dan protokol komunikasi data.

---

## 1. High-Level System Architecture

```text
┌─────────────────────────┐               ┌─────────────────────────┐
│     Chrome / Brave      │               ┌─────────────────────────┐
│  (Extension Background) │               │         Firefox         │
└────────────┬────────────┘               │  (Extension Background) │
             │                            └────────────▲────────────┘
    WebSocket Event (JSON)                    WebSocket Event (JSON)
             │                                         │
             ▼                                         │
    ┌──────────────────────────────────────────────────┴──────────┐
    │                      Local Daemon Hub                       │
    │                   (Golang - 127.0.0.1:8765)                 │
    │                                                             │
    │   ┌─────────────────────────────────────────────────────┐   │
    │   │               WebSocket Hub (Pub/Sub)               │   │
    │   │   - Manages active client connections               │   │
    │   │   - Broadcasts events excluding sender origin       │   │
    │   └──────────────────────────┬──────────────────────────┘   │
    │                              │                              │
    │   ┌──────────────────────────▼──────────────────────────┐   │
    │   │             Local Store / Dedup Buffer                │   │
    │   │   - Rencana: ring buffer hash URL (CRC32/MD5)         │   │
    │   │   - Rencana: log SQLite ~/.local/share/loophist.db    │   │
    │   │   - Saat ini: Set in-memory + outbox cap 200          │   │
    │   └─────────────────────────────────────────────────────┘   │
    └─────────────────────────────────────────────────────────────┘
```

---

## 2. Sequence Diagram (Sync Flow & Loop Prevention)

```text
Browser A (Chrome)          Local Daemon (Go)          Browser B (Firefox)
       │                            │                            │
[Visits Page]                       │                            │
       │                            │                            │
`onVisited` Fires                   │                            │
Check loop cache (Not found)        │                            │
       │                            │                            │
       ├──── WS Event (JSON) ──────►│                            │
       │     client_id: "chrome_1"  │                            │
       │                            ├──── WS Broadcast ─────────►│
       │                            │     (Exclude "chrome_1")   │
       │                            │                            │
       │                            │                   Receive Event
       │                            │                   Add URL to `recentlySynced` Set
       │                            │                   Call `browser.history.addUrl()`
       │                            │                            │
       │                            │                   `onVisited` Fires in Browser B
       │                            │                   Check `recentlySynced` Set
       │                            │                   -> FOUND! Drop event (Break Loop)
```

---

## 3. Communication Protocol (WebSocket Specs)

### Connection
- **Endpoint:** `ws://127.0.0.1:8765/ws?client_id={UUID}&browser={chrome|firefox|brave|edge}`

### Payload Formats

#### 1. History Visited Event (`HISTORY_VISITED`)
Dikirim oleh ekstensi saat user membuka halaman baru:
```json
{
  "type": "HISTORY_VISITED",
  "client_id": "c9a4b2a8-1a52-4740-a111-28564b123456",
  "browser": "chrome",
  "payload": {
    "url": "https://go.dev/doc/effective_go",
    "title": "Effective Go - The Go Programming Language",
    "visit_time": 1730350800000
  }
}
```

#### 2. Ping / Heartbeat
```json
{
  "type": "HEARTBEAT",
  "client_id": "c9a4b2a8-1a52-4740-a111-28564b123456"
}
```

---

## 4. Key Security & Sandbox Constraints
- Daemon dikonfigurasi hanya mengikat antarmuka loopback `127.0.0.1`.
- Ekstensi Chrome MV3 mematuhi Content Security Policy tanpa dependensi script eksternal remote.
- Validasi origin AKTIF: `CheckOrigin` (`main.go`) mengizinkan origin kosong, `chrome-extension://`, `moz-extension://`, `http://127.0.0.1`, `http://localhost`; selain itu ditolak + log `[WS] Origin ditolak`.
