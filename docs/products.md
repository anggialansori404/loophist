# PRODUCTS.MD - Product Specification & Requirements Document (PRD)

Dokumen kebutuhan produk **LoopHist** (sinkron riwayat lokal lintas browser).

---

## 1. Problem Statement
Pengguna aktif yang menggunakan beberapa browser sekaligus (misal Chrome untuk pekerjaan kantor dan Firefox untuk browsing harian) sering kehilangan konteks riwayat browsing. Ketika mencari artikel, dokumentasi teknis, atau referensi yang dibuka beberapa menit sebelumnya di browser lain, pengguna harus membuka browser sebelumnya secara manual atau mengulang pencarian. Solusi bawaan (Chrome Sync / Firefox Sync) terisolasi pada ekosistem masing-masing.

---

## 2. Product Objectives
- **Omnipresent History:** Riwayat halaman yang dikunjungi di Browser A langsung muncul di pencarian `Ctrl+H` / address bar autocomplete di Browser B.
- **Privacy Assurance:** Tidak ada data URL, query string, atau judul halaman yang dikirim ke internet publik.
- **Low-Friction Setup:** Sekali daemon lokal aktif, ekstensi otomatis terhubung (*zero configuration* selain memasukkan token/port default).

---

## 3. Core Features & Capabilities

### F-01: Real-Time History Broadcast
- Mendeteksi navigasi halaman sukses melalui `chrome.history.onVisited`.
- Memancarkan event JSON berlatensi rendah (< 100ms) melalui WebSocket lokal ke browser terdaftar lainnya.

### F-02: Target History Injection
- Menerima payload history dari WebSocket dan menginjeksinya ke browser tujuan menggunakan `chrome.history.addUrl()`.

### F-03: Infinite Loop Shielding
- Mencegah *ping-pong effect* di mana Browser B menganggap URL hasil injeksi sebagai kunjungan baru dan mengirimkannya kembali ke Browser A.

### F-04: Noise & Privacy Filtering
- Menyediakan *blacklist filter*:
  - URL internal browser (`about:*`, `chrome:*`).
  - IP Lokal & Sandbox (`127.0.0.1`, `localhost`, port daemon `8765`).
  - Parameter URL pembersih (misal: stripping token OAuth sensitif atau URL incognito).

### F-05: Connection Resilience & Tray/Daemon Indicator
- Ekstensi reconnect interval tetap (bukan exponential backoff): alarm `sync-reconnect` 3 detik + keepalive `sync-keepalive` tiap ~20 detik jika daemon mati atau mesin *sleep/wake*.
- Daemon memiliki healthcheck endpoint `GET http://127.0.0.1:8765/health`.

---

## 4. Non-Functional Requirements
- **Latency:** Propagasi history antar-browser < 200 ms.
- **Resource Limits:** Daemon Go idle memory < 20 MB, CPU < 0.2%.
- **Reliability:** Mampu menangani hingga 1,000 histori per jam tanpa kebocoran memori (memory leak).
