# Arsitektur Sistem

## 1. Gambaran besar

```
                        ┌──────────────────────── CLOUD ────────────────────────┐
                        │                                                       │
  Owner (browser) ───▶  │  Studio (Next.js)  ──▶  Postgres (Supabase)           │
                        │        │                    ▲                         │
                        │        ▼                    │                         │
                        │  API (Hono) ◀── webhook ── Midtrans                   │
                        │   │   │  ▲                                            │
                        │   │   │  └── short link /s/:code ◀── HP pembeli       │
                        │   │   ▼                                               │
                        │   │  Object storage (Supabase Storage)                │
                        │   │   │                                               │
                        │   │   ▼                                               │
                        │   │  Worker (BullMQ, sharp, ffmpeg) ──▶ Google Drive  │
                        │   │                                     (milik owner) │
                        └───┼───────────────────────────────────────────────────┘
                            │ HTTPS + realtime (config sync, payment status, heartbeat, upload)
            ┌───────────────┼──────────── BOOTH (LAN) ─────────────┐
            │               ▼                                       │
            │   Kiosk (Tauri + React) ◀──▶ Local Agent (Node)       │
            │        ▲   layar pembeli        │  SQLite, disk,       │
            │        │                         │  print queue,        │
            │        │ WebRTC preview          │  upload queue        │
            │        │                         ▼                      │
            │   Camera App (tablet) ──HTTP foto full-res──▶ Agent     │
            │                                  │                      │
            │                                  └──▶ Printer (CUPS)    │
            └─────────────────────────────────────────────────────────┘
```

## 2. Komponen

### 2.1 Studio (`apps/studio`)
- Next.js App Router. Auth Supabase (email + Google).
- Modul: Booth, Editor (halaman + frame), Filter, Harga, Voucher, Device, Integrasi (Midtrans, Google Drive), Rekap, Log, Langganan, Pengaturan organisasi.
- Editor memakai `packages/renderer` untuk menggambar elemen persis seperti di Kiosk, dengan lapisan interaksi `react-moveable` + `selecto` di atasnya.
- Publish: menyimpan versi config baru (immutable, bernomor), menandai sebagai aktif untuk booth, lalu memberi sinyal realtime ke device.

### 2.2 API (`apps/api`)
- Hono di Node, di-deploy terpisah dari Studio agar webhook dan endpoint kiosk tidak tergantung siklus deploy Studio.
- Kelompok endpoint:
  - `/device/*` — pairing, ambil config aktif, heartbeat, upload sesi/file, buat & cek pembayaran, sinkron voucher. Auth: device token.
  - `/webhooks/midtrans/:orgId` — notifikasi pembayaran pembeli (per owner).
  - `/webhooks/billing` — notifikasi pembayaran langganan (akun platform).
  - `/s/:code` — short link sesi (halaman "sedang diproses" atau redirect ke folder Drive).
  - `/oauth/google/*` — callback koneksi Google Drive.
- Studio juga memanggil API untuk aksi sensitif (simpan kredensial, tes koneksi).
- Sudah ada (F2): `POST /pair/start`, `POST /pair/status` (tanpa auth; Kiosk membuktikan token lewat hash), `GET /device/config` (ETag/304, 204 = belum ada publish), `GET /device/stream` (SSE `config` saat booth dipublish, dari `LISTEN pb_booth_config`), `POST /device/heartbeat`, `POST /studio/pairing/claim` (token user; owner/manager). CORS terbuka untuk `/device/*` dan `/pair/*` (auth token, tanpa cookie).
  - Ditambah F3: `POST /device/events` (outbox agent: `device_events` + `print_jobs`, idempotent per id, balasan = id yang tersimpan), `printerStatus` di `POST /device/heartbeat`. Sejak F3 pemanggil `/pair/*` dan `/device/*` adalah Local Agent, bukan Kiosk.
  - Ditambah F4: `POST /device/payments` (id percobaan dari agent, idempotent; nominal dicek terhadap harga frame di versi config), `GET /device/payments/:id` (polling; API menanyakan provider ≤ 1×/3 dtk), `POST /device/payments/:id/cancel`, `GET /device/vouchers` (hash voucher booth), `POST /device/vouchers/redeem`; `POST /device/events` menerima `voucherUses`, `cashApprovals`, `sessions`; `/device/stream` mengirim event `payment` (`{paymentId, status}`). `POST /webhooks/midtrans/:orgId`. Studio: `GET|PUT /studio/orgs/:orgId/integrations/midtrans`, `POST …/midtrans/test` (owner/manager). Dev (`PB_PAYMENT_PROVIDER=mock`): `POST /dev/payments/:id/simulate-paid`. Respons ke device hanya `{id, status, amount, qrString, expiresAt, paidAt}`.
  - Env API F4: `SECRET_MASTER_KEY` (wajib di production), `PB_PUBLIC_API_URL` (URL webhook per transaksi), `PB_PAYMENT_PROVIDER=mock|midtrans`.
  - Ditambah F5: `PUT /device/sessions/:id/files/:fileId` (raw bytes; header `x-pb-kind`, `x-pb-name`, `x-pb-sha256`, `x-pb-slot`; sha256 isi diverifikasi; maks. 60 MB; idempotent), `POST /device/sessions/:id/complete` (manifest; 409 `missing_files` / `session_unknown`). Publik: `GET /s/:code` (halaman proses / 302 ke Drive / 404), `GET /oauth/google/callback`. Studio (user token, owner/manager): `GET|DELETE /studio/orgs/:orgId/integrations/google-drive`, `POST …/connect` (balas URL consent Google), `GET …/folders`, `PUT …/root-folder` (`create` | `existing`), `POST …/test`; semua anggota org: `POST /studio/orgs/:orgId/sessions/:sessionId/retry-upload`.
  - Env API/worker F5: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (default `<PB_PUBLIC_API_URL>/oauth/google/callback`), `PB_STUDIO_URL`, `PB_STORAGE` (+ `SUPABASE_*`), `REDIS_URL` (opsional), `FFMPEG_PATH`, `PB_STORAGE_RETENTION_DAYS`, `PB_GOOGLE_BASE_URL` (hanya dev/test: Google tiruan).
  - Ditambah F6: `POST /webhooks/billing` (notifikasi akun Midtrans **platform**; verifikasi dengan server key platform). Studio (user token): `GET /studio/orgs/:orgId/billing` (hak akses, paket + harga, tagihan; semua anggota), `POST …/billing/checkout` `{planCode}` (owner/manager; membuat invoice + QRIS), `GET …/billing/invoices/:id` (polling; menanyakan penyedia ≤ 1×/3 dtk), `POST …/billing/invoices/:id/pay` (QR baru), `GET …/sessions/:id/thumbnail` (strip dari storage privat). Admin platform (token user + e-mail di `PB_PLATFORM_ADMINS`): `GET /admin/orgs`, `PUT /admin/orgs/:orgId/subscription`, `PUT /admin/plans/:code/price`, `POST /admin/billing/run-lifecycle`. Respons `POST /device/heartbeat` membawa `entitlements` (flag paket tanpa data uang); heartbeat menerima `outboxPending`, `uploadsPending`. Dev (`PB_BILLING_PROVIDER=mock`): `POST /dev/billing/invoices/:id/simulate-paid`.
  - Env API/worker F6: `PB_BILLING_MIDTRANS_SERVER_KEY`, `PB_BILLING_MIDTRANS_ENV`, `PB_BILLING_PROVIDER=mock`, `PB_PLATFORM_ADMINS` (API dan Studio).

### 2.3 Worker (`apps/worker`)
- BullMQ + Redis. Job:
  - `process-session`: dari foto original → mirrored, filtered, composite (jika belum dari booth), GIF, video 9:16.
  - `upload-drive`: buat folder, unggah per subfolder, set permission "anyone with link: reader", simpan URL folder ke sesi.
  - `billing-*`: buat tagihan bulanan, tandai jatuh tempo, terapkan downgrade.
- Retry dengan exponential backoff; job gagal permanen muncul di log operasional owner.
- Implementasi F6 (`apps/worker/src/main.ts`): `REFRESH MATERIALIZED VIEW CONCURRENTLY daily_booth_stats` tiap menit dan `runBillingLifecycle` tiap jam (periode habis → `past_due` + masa tenggang 7 hari → turun ke Starter; invoice perpanjangan 3 hari sebelum jatuh tempo). Hak akses (batas + fitur) dihitung lazy dari jam oleh `resolveEntitlements` (`@pb/db`), sehingga aturan tetap berlaku walau job belum jalan.
- Implementasi F5 (`apps/worker`): antrian sebenarnya = tabel `upload_jobs` (atomik, `FOR UPDATE SKIP LOCKED`, backoff 15 dtk × 2ⁿ maks. 15 menit, 8 percobaan). BullMQ (`REDIS_URL`) hanya membangunkan worker; tanpa Redis worker polling tiap 3 dtk. Job `storage` (`process-session`) → job `drive` (`upload-drive`). Error yang butuh owner (`drive_revoked`, `drive_quota`, `drive_folder_missing`, `drive_not_connected`) tidak di-retry otomatis; Studio menampilkan pesan dan tombol Coba lagi, dan menghubungkan ulang Drive menjalankan ulang job itu sendiri. Pembersihan: storage platform dihapus 30 hari setelah Drive selesai. Output turunan dibuat oleh `@pb/compositor` (`mirrorPhoto`, `filterPhoto`, `buildGif`, `applyWatermark`, `buildVideoFrame`) + ffmpeg. Paket baru: `@pb/storage` (object storage + manifest sesi), `@pb/drive` (klien Drive `drive.file`, OAuth, `FakeGoogle` untuk test).

### 2.4 Kiosk (`apps/kiosk`)
- Vite + React, dibungkus **Tauri** (ringan, jalan di Windows/macOS/Linux; Raspberry Pi nanti via build Linux ARM).
- Mode fullscreen, kursor disembunyikan, cegah sleep layar.
- Menjalankan `packages/flow` (XState). State machine memanggil renderer untuk halaman aktif.
- Berkomunikasi dengan Agent lewat `http://127.0.0.1:47810` + WebSocket `/ws`. Tidak pernah memegang secret (token device pun dipegang agent sejak F3).
- Config + aset (gambar, font, video) di-cache lewat Agent (`GET /config/state`, `/assets/<sha256>`); Kiosk tetap jalan saat offline.
- Tanpa agent (mode browser/dev, `?agent=0`) Kiosk berjalan seperti F1: foto di IndexedDB, cetak disimulasikan.
- Tauri (F3): `apps/kiosk/src-tauri` membuka satu jendela fullscreen tanpa dekorasi dan menjalankan agent sebagai sidecar (runtime Node + bundel agent + modul native `sharp`/`@napi-rs/canvas` sebagai resource), me-restart agent bila berhenti. CSP hanya mengizinkan `127.0.0.1:47810`. Installer: NSIS/MSI (Windows), DMG/app (macOS) lewat workflow CI.

### 2.5 Local Agent (`apps/agent`)
- Node service yang dipasang bersama Kiosk (sidecar Tauri).
- Tanggung jawab:
  - Penyimpanan lokal: SQLite (sesi, pembayaran offline, voucher terpakai, antrian) + folder file.
  - Sinkron config & aset dari API; simpan versi terakhir yang valid.
  - Compositing strip cetak memakai `packages/compositor`.
  - Print via driver OS (CUPS `lp` di macOS/Linux, spooler di Windows).
  - Antrian upload ke API, retry saat online.
  - **Server LAN** untuk Camera App: signaling WebRTC + endpoint terima foto.
  - Heartbeat dan event log ke API.
  - Nanti: kontrol DSLR (`gphoto2` / Canon EDSDK).
- Implementasi F3 (`apps/agent`): Hono + `ws`, SQLite `node:sqlite` (lihat `docs/schema.md` C.1).
  - API Kiosk di `127.0.0.1:47810` (cek Host anti DNS-rebinding + daftar origin: Tauri dan dev server): `/status`, `/config/state`, `/config/refresh`, `/device/reset`, `/assets/:sha256`, `/sessions/:id/shots` (foto webcam), `/sessions/:id/capture` (foto tablet), `/files/:id`, `/process` (compose + cetak), `/sessions`, `/printers`, `/printer`, `/print/test`, `/camera`, `/camera/pairing`, `/settings`; WebSocket `/ws` (status kamera, versi config, status printer, progres processing, relay signaling WebRTC).
  - F4 (API lokal): `POST /payments`, `GET /payments/:id`, `POST /payments/:id/cancel` (diteruskan ke API; offline → 503 `offline` / cancel ke outbox), `POST /vouchers/redeem` (online: API otoritatif; offline: validasi hash lokal), `POST /vouchers/sync`, `POST /cash-approvals` (PIN admin diverifikasi ulang), `GET /network`; WebSocket menambah `{type:'network', online}` dan `{type:'payment', paymentId, status}`. Kode di `apps/agent/src/money.ts`.
  - Server LAN `0.0.0.0:47811` khusus Camera App: `/camera/ping`, `/camera/pair` (kode sekali pakai → token kamera), `/camera/shots?requestId=` (Bearer token kamera, maks. 60 MB), WebSocket `/camera/ws` (pesan pertama `hello` + token). Protokol: `packages/capture/src/tablet-protocol.ts`.
  - Tablet putus: ping tiap 2 dtk, tanpa pong 5 dtk → dianggap putus (Wi-Fi mati tidak menutup TCP dengan cepat). Permintaan capture menunggu sampai 60 dtk dan dikirim ulang saat tablet tersambung lagi; upload idempotent per `requestId`; upload yang terlambat tetap disimpan.
  - Cetak: Windows = PowerShell `System.Drawing.Printing` (spooler, tanpa dialog, kertas 4×6 driver bila ada, gambar full page); macOS/Linux = `lp -o media=w288h432 -o fit-to-page`. Printer virtual (file) untuk dev/test. Job `done` = diterima spooler/CUPS.

### 2.6 Camera App (`apps/camera`)
- React + **Capacitor** (iOS dan Android).
- Alasan tidak memakai web biasa:
  1. `getUserMedia` mewajibkan secure context (HTTPS). Halaman yang dibuka dari IP LAN (`http://192.168.x.x`) tidak dianggap aman, sehingga kamera ditolak.
  2. Safari iPad tidak mendukung API pengambilan foto resolusi penuh (`ImageCapture.takePhoto`).
  Capacitor menjalankan app dari origin lokal yang dianggap aman dan memberi akses plugin kamera native.
- Alur:
  1. Kiosk menampilkan QR pairing (berisi IP Agent, port, token sekali pakai).
  2. Camera App memindai QR, terhubung ke Agent via WebSocket.
  3. Preview: WebRTC peer-to-peer tablet → Kiosk (resolusi sedang, ±720p, latensi rendah).
  4. Saat `capture`: Kiosk → Agent → Camera App. Camera App mengambil foto resolusi penuh dengan kamera native, lalu `POST` ke Agent. Agent membalas setelah file tersimpan.
- Pengaturan di Camera App: kamera depan/belakang, kunci orientasi, kecerahan layar, cegah sleep.
- Implementasi F3 (`apps/camera`, Capacitor 8, proyek `android/` + `ios/`): pindai QR dengan jsQR, token kamera di Preferences, WebSocket dengan reconnect cepat (300 ms → 3 dtk, berganti host), WebRTC pengirim (H.264 diutamakan, ≤ 1280×720, 30 fps, 2,5 Mbps, `maintain-framerate`). Foto resolusi penuh: `ImageCapture.takePhoto` di ukuran maksimum sensor (Android WebView/Chromium); iOS: plugin `@capacitor-community/camera-preview` (track preview dilepas sebentar, foto native, preview dinyalakan lagi). Foto disimpan di IndexedDB sampai agent membalas 200 (bertahan walau Wi-Fi putus atau app ditutup). Kiosk adalah penerima WebRTC (offer recvonly, `jitterBufferTarget = 0`).

## 3. Abstraksi kunci

### 3.1 `CaptureSource` (`packages/capture`)
```ts
interface CaptureSource {
  id: 'webcam' | 'tablet' | 'dslr' | 'mock';
  connect(): Promise<void>;
  getPreviewStream(): Promise<MediaStream>;      // untuk camera-view
  capture(opts: { shotIndex: number }): Promise<CapturedImage>; // full-res
  startClip?(maxMs: number): Promise<void>;       // F7 live clip
  stopClip?(): Promise<Blob>;
  status(): CaptureStatus;                        // idle | connecting | connected | reconnecting | error
  lastError(): CaptureError | null;               // ditambah di F1
  onStatusChange(cb): () => void;                 // ditambah di F1: mis. webcam dicabut → 'error'
  disconnect(): Promise<void>;
}
```
- Mirror hanya diterapkan di tampilan (`camera-view`) dan di file `mirrored/`. File original disimpan tanpa mirror.
- Implementasi F1: `webcam` (getUserMedia; frame diambil dari track pada resolusi aslinya; event `ended` = dicabut) dan `mock` (pola uji/gambar statis, `simulateDisconnect()` untuk test).
- F3: `tablet` (`createTabletSource({ agent })`): status dari agent (`reconnecting` selama tablet putus ≤ 60 dtk, baru `error` setelahnya), preview WebRTC, `capture({ shotIndex, session })` → agent → tablet, mengembalikan `stored: { photoId, url }` (`blob: null`). `capture` menerima konteks sesi opsional; `onPreviewChange` opsional untuk stream baru setelah negosiasi ulang.

### 3.2 `PaymentProvider` (`packages/payments`)
```ts
interface PaymentProvider {
  id: 'midtrans' | 'xendit';
  createQris(input: { orderId: string; amount: number; expirySec: number }): Promise<QrisCharge>;
  getStatus(orderId: string): Promise<PaymentStatus>;
  cancel(orderId: string): Promise<void>;
  verifyWebhook(headers: Headers, body: unknown): Promise<WebhookEvent | null>;
  testConnection(): Promise<boolean>;
}
```
- `orderId` = ID pembayaran internal (idempotent). Satu sesi bisa punya beberapa percobaan pembayaran; hanya satu yang boleh `paid`.
- Midtrans: Core API charge `payment_type: qris`, notifikasi diarahkan per request ke `/webhooks/midtrans/:orgId`, verifikasi signature dengan server key owner.

### 3.3 Flow machine (`packages/flow`)
State: `cover → tutorial → framePick → payment → capture → review → processing → result → cover`, plus `error` dan `admin`.
- Guard dari `FlowConfig` (tutorial aktif? review aktif? mode event?).
- Context: sessionId, frameId, harga, paymentId, shots[], filterId, extraPrints.
- Timer idle per state; setelah `paid`, timeout tidak menghapus sesi.
- Implementasi (F1): `flowMachine` di `packages/flow`. Host menyediakan actor `connectCamera`, `captureShot`, `createPayment`, `processSession` dan action `cancelPayment`, `onSessionEnd` lewat `flowMachine.provide()`; Kiosk dan preview Studio memakai machine yang sama. Tombol renderer dipetakan ke event dengan `uiActionToEvent()`. Substate Capture: `connecting → countdown → shooting → shotPreview → waiting → done`.

## 4. Alur data penting

### 4.1 Pembayaran QRIS
1. Kiosk masuk `payment` → Agent → `POST /device/payments` (sessionId, amount).
2. API buat payment record, panggil provider owner, simpan QR string, balas ke Kiosk.
3. Kiosk render elemen `qris` + timer.
4. Pembeli bayar → provider kirim webhook → API verifikasi → update status → push realtime ke device (F4: event SSE `payment` di `/device/stream` → agent → WebSocket kiosk; bukan Supabase Realtime, lihat decisions F4).
5. Cadangan: Kiosk polling agent tiap 2 detik → `GET /device/payments/:id` (API menanyakan status ke provider bila webhook belum datang).
6. Kiosk lanjut ke `capture`.
7. Kembali ke `framePick` atau timeout → API `cancel`.

### 4.2 Sesi offline
1. Agent mendeteksi offline (heartbeat gagal) → Kiosk menyembunyikan QRIS, menampilkan voucher/cash.
2. Voucher divalidasi terhadap daftar voucher booth di SQLite; ditandai terpakai lokal.
3. Sesi berjalan, foto dan strip disimpan lokal, strip dicetak. QR di cetakan = short link (dibuat dari kode sesi lokal).
4. Saat online: Agent unggah sesi + pemakaian voucher + file; API menolak voucher ganda dan mencatat konflik.

### 4.3 Output
1. Setelah review, Agent compositing strip (untuk cetak cepat) dan mencetak.
2. Agent unggah original + composite + metadata ke object storage via API.
3. API membuat job `process-session` → worker membuat mirrored, filtered, GIF, video.
4. Job `upload-drive` → folder Drive owner. URL folder disimpan; `/s/:code` kini redirect.
5. File lokal di booth dihapus setelah semua upload terkonfirmasi (dengan retensi opsional N hari). Implementasi F5: agent `PUT` tiap file lalu `POST …/complete`; penghapusan lokal hanya setelah `complete` sukses (lihat decisions F5).

## 5. Keamanan
- Kredensial Midtrans owner dan refresh token Google: dienkripsi AES-256-GCM dengan master key dari environment (pindah ke KMS saat produksi).
- Device token: dibuat saat pairing, disimpan di keychain OS via Tauri, bisa dicabut dari Studio.
- Row Level Security Supabase per `org_id` untuk akses dari Studio; API memakai service role dengan filter `org_id` eksplisit.
- PIN admin Kiosk di-hash, disinkron sebagai bagian config.
- Link Drive bersifat "anyone with link"; short link memakai kode acak 8 karakter (cukup sulit ditebak). Opsi kedaluwarsa link per booth.
- F9: token pengirim WhatsApp/e-mail milik platform hanya di env worker. Nomor/e-mail pembeli dienkripsi seperti kredensial (AAD per baris) dan dihapus setelah pesan final; Studio hanya melihat versi tersamar.

## 6. Deployment (usulan awal)
- Studio: Vercel.
- API + Worker: satu VPS/container (Fly.io, Railway, atau VPS lokal Indonesia untuk latensi), Redis terkelola.
- Database, auth, storage, realtime: Supabase (region Singapura).
- Kiosk: installer Tauri + auto-update.
- Camera App: TestFlight / APK internal dulu, store setelahnya.

## 7. Kompatibilitas ke depan
- **Raspberry Pi**: Tauri build Linux ARM64; Agent Node ARM; compositing ringan di Pi, encode video tetap di worker cloud.
- **DSLR**: implementasi `CaptureSource` baru di Agent (`gphoto2` untuk Linux/macOS, EDSDK untuk Windows). Preview dari live view kamera.
- **Live clip**: rekam di sumber kamera, encode di worker.
- **Ukuran cetak lain**: tambah `PrintProfile` baru, engine tidak berubah.
