# AGENT.MD - AI & Engineering Collaboration Guide

Panduan operasional untuk AI Agent, Developer, dan Kontributor dalam memelihara dan mengembangkan proyek **LoopHist**.

---

## 1. Project Overview & Philosophy
- **Tujuan Utama:** Sinkronisasi riwayat browsing (*browsing history*) secara real-time antar browser berbeda (Chrome, Brave, Edge, Firefox) pada lingkungan lokal tanpa server cloud pihak ketiga.
- **Filosofi Arsitektur:**
  - **Zero-Cloud / Local-First:** Data privasi browsing tidak boleh keluar dari localhost (`127.0.0.1`).
  - **Minimal Resource Footprint:** Daemon harus hemat memori (< 20MB RAM) dan CPU idle sub-1%.
  - **Fail-Safe & Idempotent:** Gangguan koneksi websocket atau duplikasi payload tidak boleh merusak database atau menyebabkan *infinite sync loop*.

---

## 2. Technical Stack & Standards
- **Local Daemon:** Go (Golang) 1.22+
  - Modul WebSocket: `github.com/gorilla/websocket`
  - Local Storage (Rencana, belum implementasi): `modernc.org/sqlite` (CGO-free)
  - Arsitektur: Clean Architecture (Hub, Connection Handler, Ring Buffer Store)
  - Dedup saat ini: `Set` in-memory + outbox cap 200 (sisi ekstensi); belum ada ring buffer CRC32/MD5 maupun SQLite (`go.mod` hanya `gorilla/websocket`).
- **Browser Extension:** TypeScript + WXT / Plasmo (Manifest V3)
  - API Utama: `chrome.history` / `browser.history`
  - Local State: In-memory `Set` untuk loop filtering & `chrome.storage.local` untuk konfigurasi token/port.

---

## 3. Rules of Engagement for AI Agent
1. **Never Introduce Cloud Dependencies:** Jangan tambahkan endpoint eksternal, telemetry analitik, atau API pihak ketiga tanpa konfirmasi pengguna.
2. **Infinite Loop Prevention:**
   - Setiap perubahan pada listener `chrome.history.onVisited` wajib memverifikasi deduplikasi lokal (`recentlySyncedUrls` cache).
   - Event yang di-push oleh daemon ke browser target tidak boleh dipancarkan kembali ke hub WebSocket.
3. **Strict URL Filtering:**
   - Selalu validasi scheme URL (`http://` dan `https://` saja).
   - Filter skema privat/internal: `chrome://`, `chrome-extension://`, `moz-extension://`, `about:`, `file://`, `blob:`, `view-source:`.
4. **Clean Git & Commit Standards:**
   - Format commit mengikuti Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `perf:`).
