# Schema

Dua bagian: (A) **config booth** dalam JSON yang dibaca Kiosk, dan (B) **database**. Definisi resmi ada di `packages/schema` (zod) dan `packages/db` (Drizzle); dokumen ini adalah spesifikasinya.

---

## A. Config booth (JSON)

Satu booth punya satu `BoothConfig` aktif. Setiap Publish membuat versi baru yang immutable.

```ts
type BoothConfig = {
  schemaVersion: 1;
  configVersion: number;          // naik setiap publish
  boothId: string;
  locale: 'id' | 'en';
  timezone: string;               // 'Asia/Jakarta'
  artboard: Artboard;
  flow: FlowConfig;
  pricing: Pricing;
  pages: Record<PageType, Page>;  // satu halaman per tipe
  frames: Frame[];
  filters: Filter[];
  printProfile: PrintProfile;
  output: OutputConfig;
  assets: AssetRef[];             // semua file yang perlu di-cache device
  admin: { pinHash: string };
};

type Artboard = {
  width: number;                  // mis. 1920
  height: number;                 // mis. 1080
  orientation: 'landscape' | 'portrait';
  scaleMode: 'fit';               // letterbox; mode lain menyusul
  letterboxColor: string;
};
```

### A.1 Flow, harga, output

```ts
type FlowConfig = {
  tutorialEnabled: boolean;
  reviewEnabled: boolean;
  eventMode: boolean;             // true = tanpa payment
  paymentMethods: ('qris' | 'voucher' | 'cash')[];
  shotCountdownSec: number;       // default 3
  autoAdvanceBetweenShots: boolean;
  maxRetakesPerShot: number | null; // null = tanpa batas
  idleTimeoutSec: Partial<Record<PageType, number>>;
  resultAutoReturnSec: number;
  qrisExpirySec: number;          // default 300
};

type Pricing = {
  currency: 'IDR';
  basePrice: number;              // dipakai bila frame tidak punya harga sendiri
  includedPrints: number;         // default 1 lembar (= 2 strip)
  extraPrintPrice: number | null; // null = tidak dijual
  maxExtraPrints: number;
};

type OutputConfig = {
  gif: { enabled: boolean; frameDelayMs: number; width: number };
  video: {
    enabled: boolean;
    photoPick: 'random' | 'first' | 'buyer';
    photoCount: 3;
    secondsPerPhoto: number;
    resolution: { width: 1080; height: 1920 };
    backgroundAssetId?: string;   // latar di belakang foto 16:9
    musicAssetId?: string;
  };
  driveRootFolderName: string;    // default: nama booth
  watermark: boolean;             // dikontrol plan
};
```

### A.2 Halaman dan elemen

```ts
type PageType =
  | 'cover' | 'tutorial' | 'framePick' | 'payment'
  | 'capture' | 'review' | 'processing' | 'result' | 'error';

type Page = {
  type: PageType;
  background: Background;
  elements: Element[];            // urutan array = z-order (bawah → atas)
  slides?: Slide[];               // khusus 'tutorial'
  transitionIn?: Transition;
};

type Background =
  | { kind: 'color'; color: string }
  | { kind: 'gradient'; css: string }
  | { kind: 'image'; assetId: string; fit: 'cover' | 'contain' }
  | { kind: 'video'; assetId: string; loop: true; muted: true };

type Slide = { id: string; elements: Element[]; background?: Background; durationSec?: number };

type BaseElement = {
  id: string;
  name: string;                   // label di layer panel
  x: number; y: number;           // koordinat artboard, titik kiri atas
  width: number; height: number;
  rotation: number;               // derajat
  opacity: number;                // 0..1
  visible: boolean;
  locked: boolean;
  groupId?: string;
  style?: BoxStyle;
  animation?: ElementAnimation;   // entrance, pulse, dll.
};

type BoxStyle = {
  fill?: string;
  borderColor?: string; borderWidth?: number; borderRadius?: number;
  shadow?: { x: number; y: number; blur: number; color: string };
};
```

#### Elemen statis & interaktif
| `type` | Properti tambahan |
|---|---|
| `image` | `assetId`, `fit` |
| `text` | `content`, `fontFamily`, `fontSize`, `fontWeight`, `color`, `align`, `lineHeight`, `letterSpacing`; mendukung token `{{price}}`, `{{boothName}}`, `{{date}}`, `{{paymentHint}}` (petunjuk bayar sesuai metode yang bisa dipakai saat itu: tanpa QRIS bila booth offline atau Midtrans belum diatur) |
| `shape` | `shape: 'rect' \| 'ellipse' \| 'line'` |
| `video` | `assetId`, `loop`, `muted` |
| `button` | `action: ButtonAction`, `label?`, `assetId?` (tombol gambar), state `pressed` |

```ts
type ButtonAction =
  | { kind: 'start' } | { kind: 'next' } | { kind: 'back' }
  | { kind: 'retake'; shotIndex?: number } | { kind: 'retakeAll' }
  | { kind: 'confirm' } | { kind: 'selectFilter'; filterId: string }
  | { kind: 'addPrint' } | { kind: 'removePrint' }
  | { kind: 'selectPayment'; method: 'qris' | 'voucher' | 'cash' }
  | { kind: 'finish' };
```

#### Elemen khusus
| `type` | Halaman | Properti tambahan |
|---|---|---|
| `camera-view` | capture | `mirror: boolean`, `fit: 'cover' \| 'contain'`, `cropAspect?` (tampilkan area crop slot aktif), `overlayFrame: boolean` |
| `photo-slot` | capture, review | `slotIndex`, `emptyStyle` (warna, angka, font), `filledStyle`, `activeStyle`, `showRetakeButton` |
| `countdown` | capture | `fontFamily`, `fontSize`, `color`, `variant: 'number' \| 'ring'` |
| `frame-picker` | framePick | `layout: 'grid' \| 'carousel'`, `columns`, `gap`, `itemStyle`, `selectedStyle`, `showPrice` |
| `frame-preview` | framePick, review | menampilkan frame terpilih + foto (di review) |
| `filter-picker` | review | `layout`, `itemSize`, `showLabel`, `selectedStyle` |
| `qris` | payment | `padding`, `background`, `showLogo` |
| `price-label` | framePick, payment, review | gaya teks (`TextStyle`); `format: 'idr' \| 'number'` |
| `payment-timer` | payment | `variant: 'text' \| 'bar'`, `textStyle?`, `barColor?`, `trackColor?` |
| `voucher-input` | payment | `variant: 'keypad' \| 'field'`, `textStyle`, `keyStyle?` (`field` = kolom kode saja sejak schema v2) |
| `voucher-keypad` | payment | `textStyle`, `keyStyle?`, `gap` — keypad 3×4 terpisah (schema v2), maksimal satu per halaman |
| `download-qr` | result | `padding`, `foreground`, `background` |
| `progress` | processing | `variant: 'bar' \| 'spinner' \| 'steps'`, `color`, `trackColor?` |
| `print-copies` | review | stepper jumlah cetak: `textStyle`, `buttonStyle?` |
| `consent-checkbox` | cover, framePick, review | `label` (pernyataan), `required`, `textStyle`, `boxSize`, `boxStyle`, `checkedStyle`, `checkColor` — schema v3, lihat A.10 |
| `survey-question` | cover, framePick, review | `question`, `options[]` (`id`, `label`, 1–12), `multiple`, `required`, `layout: 'row' \| 'grid' \| 'column'`, `columns`, `gap`, `questionStyle?`, `optionTextStyle`, `optionStyle`, `selectedStyle` — schema v3, lihat A.10 |

> Catatan F0: properti pilihan tampilan bernama `variant` (bukan `style`) karena `style` sudah dipakai `BaseElement` untuk `BoxStyle`. Detail lengkap ada di bagian A.6.

**Validasi wajib di editor & saat publish:**
- `capture`: tepat satu `camera-view`; jumlah `photo-slot` = jumlah slot terbanyak di frame aktif; satu `countdown`.
- `payment`: satu `qris` jika `qris` aktif; `voucher-input` jika voucher aktif; `voucher-keypad` opsional, maksimal satu.
- `framePick`: satu `frame-picker`.
- `review`: `filter-picker` jika ada > 1 filter.
- `result`: satu `download-qr`.
- Setiap halaman selain `processing` dan `result` harus punya jalan keluar (tombol atau auto-advance).

### A.3 Frame dan cetak

```ts
type Frame = {
  id: string;
  name: string;
  thumbnailAssetId: string;
  overlayAssetId: string;         // PNG transparan, ukuran = printProfile.stripPx
  underlayAssetId?: string;       // latar di bawah foto (opsional)
  price?: number;                 // override basePrice
  slots: PhotoSlot[];
  dynamicElements: Element[];     // text {{date}}, image logo, download-qr
  enabled: boolean;
  sortOrder: number;
};

type PhotoSlot = {
  index: number;                  // 1..n, urutan pengambilan
  x: number; y: number; width: number; height: number; // px strip
  rotation: number;
  borderRadius: number;
};

type PrintProfile = {
  id: 'strip-2x6';                // MVP
  paper: { widthIn: 4; heightIn: 6 };
  dpi: 300;
  stripPx: { width: 600; height: 1800 };
  layout: 'two-strips-side-by-side';
  cutMarks: boolean;
  bleedPx: number;
};
```
- Aspect ratio foto mengikuti slot. Kamera mengambil foto penuh; compositor melakukan crop tengah (dengan offset opsional) sesuai slot.
- `camera-view` dapat menampilkan panduan crop sesuai slot yang sedang diambil.

### A.4 Filter

```ts
type Filter = {
  id: string;
  name: string;
  thumbnailAssetId?: string;
  params: {
    brightness: number;   // 1 = normal
    contrast: number;     // 1 = normal
    saturation: number;   // 1 = normal, 0 = hitam putih
    hueRotate: number;    // derajat
    warmth: number;       // -1..1 (tint oranye/biru)
    sepia: number;        // 0..1
    grain: number;        // 0..1
    vignette: number;     // 0..1
  };
  enabled: boolean;
  isDefault: boolean;
};
```
Diterjemahkan ke CSS `filter` + overlay di renderer, dan ke operasi `sharp` di compositor. Test snapshot memastikan selisih visual di bawah ambang.

**Definisi numerik (ditetapkan di F1, `packages/schema/src/filter-math.ts`):**
- Warna: satu transformasi afin pada nilai sRGB 0..1, `out = M·rgb + offset`, di-clamp ke 0..1 sekali di akhir. `M`/`offset` = komposisi berurutan: brightness `diag(b)` → contrast `c·(v−0,5)+0,5` → saturation (matriks `saturate` Filter Effects) → hueRotate (matriks `hue-rotate`) → sepia (matriks `sepia`, jumlah = `sepia`) → warmth `diag(1+0,15w, 1+0,03w, 1−0,15w)`. Fungsi: `filterColorMatrix(params)`.
- Vignette: overlay hitam, alpha = `vignette × clamp((d − 0,45) / 0,55, 0, 1)`, `d` = jarak eliptis dari pusat (1 di sudut; CSS `ellipse farthest-corner`).
- Grain: noise monokrom (rata-rata 0,5), blend `overlay`, opacity `grain × 0,5`. Tidak identik per piksel; dibandingkan secara statistik.
- Renderer: SVG `feColorMatrix` (`color-interpolation-filters: sRGB`) + dua overlay. Compositor (F3): matriks yang sama diterapkan per piksel di JS (`applyFilter`, hasil identik dengan `applyFilterColorMatrix`) setelah `sharp` mendekode/crop; vignette dan grain dengan rumus di atas. Tidak memakai `sharp.recomb` + `linear` karena sharp meng-clamp ke 8 bit di antara keduanya, sedangkan definisi hanya meng-clamp sekali.

### A.5 Aset
```ts
type AssetRef = { id: string; kind: 'image' | 'video' | 'font' | 'audio'; url: string; sha256: string; bytes: number };
```
Agent mengunduh semua aset sebelum mengaktifkan versi config baru. Jika ada aset gagal, versi lama tetap dipakai.

Ketetapan F2:
- Font yang diunggah dipakai lewat `fontFamily` berisi `pb-font-<assetId>` (mis. `"pb-font-abc123", sans-serif`); renderer memasang `@font-face` untuk setiap aset `font`.
- `referencedAssetIds(config)` = semua `assetId`/`*AssetId` + referensi `pb-font-…`. Saat publish, `pruneUnusedAssets()` membuang `AssetRef` yang tidak direferensikan.
- Di F2 (tanpa agent) Kiosk mengunduh aset dari `url`, memverifikasi `sha256`, menyimpannya di Cache Storage, dan merender dari salinan lokal. Aset `data:` (bawaan) dipakai langsung.

### A.6 Ketetapan detail (ditetapkan di F0)

Definisi resmi ada di `packages/schema/src`. Hal yang tidak dirinci di atas ditetapkan sebagai berikut:

```ts
type TextStyle = { fontFamily: string; fontSize: number; fontWeight: number /* 100..900 */;
  color: string; align: 'left' | 'center' | 'right'; lineHeight: number; letterSpacing: number };
type Transition = { kind: 'none' | 'fade' | 'slide-left' | 'slide-up' | 'zoom'; durationMs: number };
type ElementAnimation = {
  entrance?: { kind: 'none' | 'fade' | 'slide-up' | 'slide-left' | 'zoom'; delayMs: number; durationMs: number };
  loop?: 'none' | 'pulse' | 'bounce' | 'float';
};
```

- `text` dan `price-label` membawa properti `TextStyle` secara datar (bukan nested).
- `image.fit`: `'cover' | 'contain' | 'fill'`. `button`: `textStyle?`, `pressedStyle?: BoxStyle`.
- `camera-view.cropAspect?: boolean`.
- `photo-slot.emptyStyle` = `BoxStyle` + `showNumber`, `numberColor`, `numberFontFamily`, `numberFontSize`; `filledStyle`/`activeStyle` = `BoxStyle`.
- `frame-picker`: tambah `showName: boolean`, `labelStyle?: TextStyle`. `filter-picker`: `layout: 'row' | 'grid'`, `labelStyle?`. `frame-preview`: `fit: 'contain' | 'cover'`.
- `configVersion: 0` = draft yang belum pernah dipublikasikan.
- `admin.pinHash: ''` = PIN belum diatur; Kiosk wajib menolak mode admin. Format (F1): `pbkdf2-sha256$<iterasi>$<salt base64url>$<hash base64url 32 byte>`, PIN 4–8 digit, dibuat dengan `hashAdminPin()` dan dicek dengan `verifyAdminPin()` (Web Crypto). zod menerima `''` atau format ini saja.
- `Frame.dynamicElements` hanya boleh `text`, `image`, `shape`, `download-qr` (koordinat px strip).
- `Slide.elements` hanya elemen statis (`image`, `text`, `shape`, `video`).
- Kode sesi: 8 karakter dari `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (`generateSessionCode()`).
- Aset bawaan `builtin-strip-overlay-4`: SVG 600×1800 sebagai data URL, dipakai frame default.
- `migrateBoothConfig()` menaikkan config lama ke `schemaVersion` terbaru sebelum validasi.

**Rincian aturan validasi** (`validateBoothConfig`, pesan berbahasa Indonesia, setiap isu punya `code`, `path`, `message`):
- Elemen khusus hanya boleh di halaman yang tercantum di tabel elemen khusus.
- Aturan elemen wajib dan jalan keluar hanya berlaku untuk halaman aktif: Tutorial (jika `tutorialEnabled`), Review (jika `reviewEnabled`), Payment (jika bukan `eventMode`).
- Jalan keluar per halaman: Cover = tombol `start`/`next`; Tutorial = tombol `next`/`start`/`confirm` atau semua slide punya `durationSec`; Pilih Frame = `next`/`confirm`; Payment = `back`/`confirm`/`selectPayment` atau ada `qris`/`voucher-input`; Capture = `next`/`confirm` atau `autoAdvanceBetweenShots`; Review = `confirm`/`next`/`finish`; Error = `start`/`finish`/`back`/`next` atau `idleTimeoutSec.error` diisi.
- `photo-slot` di Capture memakai `slotIndex` 1..n masing-masing sekali.
- Integritas: ID unik (aset, frame, filter, elemen per halaman), referensi aset ada dan jenisnya cocok, tepat satu filter default yang aktif, minimal satu frame dan satu filter aktif, slot frame bernomor 1..n dan berada dalam area strip, tombol `selectFilter` merujuk filter yang ada, tombol `selectPayment` merujuk metode yang aktif, `paymentMethods` tidak kosong kecuali mode event, `timezone` valid.

---

## B. Database (Postgres)

Semua tabel bisnis punya `org_id`, `created_at`, `updated_at`. ID memakai `cuid2`.

### B.1 Organisasi & langganan
| Tabel | Kolom utama |
|---|---|
| `orgs` | id, name, slug, timezone |
| `org_members` | org_id, user_id, role (`owner` \| `manager` \| `operator`) |
| `plans` | id, code (`starter`/`pro`/`business`), name, price_monthly, limits (jsonb: maxBooths, maxDevicesPerBooth, maxFrames), features (jsonb: dslr, liveClip, video, watermarkRemoval, customDomain, export, auditLog, staff) |
| `subscriptions` | org_id, plan_id, status (`trialing` \| `active` \| `past_due` \| `canceled`), current_period_start, current_period_end, grace_until |
| `billing_invoices` | org_id, subscription_id, amount, status, provider_ref, paid_at |

### B.2 Booth, device, config
| Tabel | Kolom utama |
|---|---|
| `booths` | org_id, name, timezone, active_config_id, status (`active` atau `inactive` = diarsipkan: tidak dihitung `maxBooths`, pairing ditolak), voucher_offline |
| `booth_configs` | booth_id, version, config (jsonb `BoothConfig`), published_by, published_at |
| `booth_drafts` | booth_id, config (jsonb), updated_by — draft editor sebelum publish |
| `devices` | org_id, booth_id, name, token_hash, platform, app_version, last_heartbeat_at, last_config_version, camera_status, printer_status, revoked_at |
| `pairing_codes` | code, device_fingerprint, expires_at, claimed_booth_id |
| `assets` | org_id, kind, storage_path, sha256, bytes, width, height |
| `templates` | id, name, preview, config (jsonb parsial), is_public |
| `library_frames` | id, name, description, url, sha256, bytes, mime_type, width, height, slots (jsonb `PhotoSlot[]`, px strip), sort_order, is_published, created_by — pustaka frame platform (2026-11-26), tanpa `org_id` |

### B.3 Sesi & pembayaran
| Tabel | Kolom utama |
|---|---|
| `sessions` | org_id, booth_id, device_id, code (8 karakter, unik), frame_id, filter_id, status (`started` \| `paid` \| `capturing` \| `completed` \| `abandoned` \| `failed`), payment_method, gross_amount, fee_amount, net_amount, extra_prints, responses (jsonb `SessionResponse[]`, F8), started_at, completed_at, synced_at, offline (bool), drive_folder_url |
| `session_shots` | session_id, slot_index, take_number, storage_path, width, height, selected (bool) |
| `session_outputs` | session_id, kind (`original` \| `mirrored` \| `filtered` \| `composite` \| `gif` \| `video` \| `clip`), storage_path, drive_file_id, status |
| `payments` | org_id, session_id, provider, order_id (unik), amount, status (`pending` \| `paid` \| `expired` \| `canceled` \| `failed` \| `paid_late`), qr_string, expires_at, paid_at, provider_ref, fee_amount, raw (jsonb) |
| `vouchers` | org_id, booth_id, code_hash, code_last4, code_encrypted, value_type (`full` \| `amount`), value, expires_at, used_at, used_session_id, used_device_id |
| `cash_approvals` | session_id, approved_by_pin_of (member id), amount |

### B.4 Integrasi
| Tabel | Kolom utama |
|---|---|
| `payment_credentials` | org_id, provider, env (`sandbox` \| `production`), encrypted_secret, merchant_id, status, last_tested_at |
| `drive_connections` | org_id, google_email, encrypted_refresh_token, root_folder_id, status |
| `fee_settings` | provider, method, percent, fixed, effective_from — nilai fee yang dipakai untuk menghitung `net_amount` |

### B.5 Log
| Tabel | Kolom utama |
|---|---|
| `device_events` | org_id, device_id, level, kind (`camera_disconnected`, `printer_error`, `payment_timeout`, `sync_failed`, `crash`, …), message, data (jsonb), occurred_at |
| `print_jobs` | org_id, device_id, session_id, sheets, status, occurred_at |
| `upload_jobs` | org_id, session_id, target (`storage` \| `drive`), status, attempts, last_error |
| `audit_logs` | org_id, actor_id, action, entity, entity_id, before (jsonb), after (jsonb), at — append-only |

### B.6 Rekap
Rekap dihitung dari `sessions` + `payments` + `print_jobs`. Untuk performa, buat materialized view harian per booth (`daily_booth_stats`) yang di-refresh berkala. Semua agregasi memakai zona waktu booth.

### B.7 Ketetapan F0 (implementasi di `packages/db`)
- `org_id` juga ada di `booth_configs`, `booth_drafts`, `session_shots`, `session_outputs`, `cash_approvals` agar RLS seragam. FK komposit `(parent_id, org_id)` memastikan baris anak tidak bisa menunjuk induk milik org lain.
- `org_members.user_id` / `published_by` / `updated_by` / `actor_id` = `uuid` dari `auth.users`.
- `plans.price_monthly` boleh `null` (harga belum ditentukan). `payment_method` punya nilai tambahan `free` (mode event).
- `payments`: indeks unik parsial `(session_id) WHERE status = 'paid'`: satu sesi hanya boleh punya satu pembayaran lunas.
- `vouchers`: unik `(booth_id, code_hash)`. `devices.token_hash` = sha256 token device (token asli hanya ditampilkan sekali).
- `audit_logs` hanya punya `at` (tanpa `updated_at`). Trigger menolak UPDATE/DELETE/TRUNCATE. `booth_configs` juga ditolak UPDATE (immutable).
- **RLS** (migrasi `0001_rls.sql`): anggota membaca data org-nya; owner/manager menulis tabel konfigurasi (booths, drafts, configs, assets, vouchers, devices); data operasional (sesi, pembayaran, log) hanya baca dari Studio, ditulis API/worker. `payment_credentials`, `drive_connections`, `pairing_codes` tertutup total untuk Studio. Org dibuat lewat `app.create_org()` (SECURITY DEFINER): org + owner + langganan trial.
- Studio mengakses DB lewat `withUserContext(db, userId, fn)`: transaksi dengan role `authenticated` dan `request.jwt.claims.sub = userId`, sehingga RLS berlaku. API/worker memakai koneksi owner dan wajib filter `org_id` eksplisit.

### B.8 Ketetapan F2 (migrasi `0002_f2_editor.sql`)
- `assets`: tambah `name` (nama file asli, default `''`) dan `mime_type`. `storage_path` berisi URL publik aset (media lokal atau Supabase Storage). Path penyimpanan: `<orgId>/<sha256>.<ext>`.
- `pairing_codes`: tambah `token_hash` = sha256 token yang dibuat Kiosk; saat diklaim menjadi `devices.token_hash`. Token asli tidak pernah disimpan di server. Kode 6 digit, berlaku 10 menit, sekali pakai.
- `templates`: tambah `key` (unik, untuk template bawaan) dan `description`. `config` berisi `BoothConfig` lengkap dengan `boothId: 'template'` dan judul `{{boothName}}`.
- Publish: versi = `max(version)+1` per booth, `config.configVersion` = versi, audit `booth.publish` / `booth.rollback`, lalu `pg_notify('pb_booth_config', boothId)`. Rollback = publish ulang config versi lama sebagai versi baru.
- Batas paket ditegakkan di server: `maxBooths` (buat booth), `maxFrames` (publish), `maxDevicesPerBooth` (klaim pairing, hanya device yang belum dicabut).

### B.9 Ketetapan F4 (migrasi `0003_f4_payments.sql`)
- `payment_credentials`: tambah `client_key` (bukan secret), `is_active` (indeks unik parsial `(org_id, provider) WHERE is_active`: satu env aktif), `last_test_message`. `encrypted_secret` = SecretBox dari JSON `{ "serverKey": … }`, AAD `org:<orgId>:payment:midtrans:<env>`. Tetap tanpa policy RLS (hanya API).
- `payments`: tambah `env` (env kredensial saat charge; webhook diverifikasi dengan key env ini), `device_id`, `last_checked_at` (batas query status ke provider saat polling, 3 dtk). `id` = `order_id` = cuid2 dari agent per percobaan. Indeks `(org_id, status)` untuk daftar `paid_late`.
- `vouchers`: tambah `batch_id`, `note`, `used_offline`. `code_hash` = hex PBKDF2-SHA256(kode 16 digit — sebelum audit 12 digit, salt `pb-voucher:v1:<boothId>`, 20.000 iterasi, 32 byte) — `hashVoucherCode()` di `@pb/crypto`. `code_last4` = 4 digit terakhir.
- `cash_approvals`: tambah `device_id`, `approved_at`; `id` = id outbox agent (idempotent). `approved_by_pin_of` `null` = PIN admin booth.
- `fee_settings`: seed `midtrans/qris 0.7000 %, fixed 0, effective_from 2024-01-01`.
- `sessions`: dibuat API saat kontak pertama (charge QRIS, redeem voucher, tunai, atau sinkron sesi) dengan `id` + `code` dari kiosk; `payment_method`, `gross/fee/net_amount` diisi oleh pembayaran (QRIS: nominal tagihan, fee dari `fee_settings`; voucher/tunai: harga frame, fee 0; free: 0). `offline` = dibayar saat device offline. `synced_at` = catatan sesi lengkap diterima.
- `device_events.kind` baru dari API: `voucher_conflict` (voucher dipakai dua sesi), `sync_conflict` (item outbox ditolak permanen). Dari agent: `voucher_offline`, `cash_approved`, `cash_pin_rejected`, `payment_failed`.
- Status `payments`: `pending → paid | expired | canceled | failed`; `paid_late` = settlement yang terlambat/ganda (kandidat refund manual). `paid` dan `paid_late` final.

### B.10 Ketetapan F5 (migrasi `0004_f5_output_drive.sql`)
- `session_outputs`: satu baris per file. Tambah `name` (nama file di Drive), `mime_type`, `bytes`, `sha256`, `slot_index`, `source_file_id` (id `local_files` agent; baris yang diunggah agent). Unik `(session_id, source_file_id)` (parsial, idempotensi unggahan) dan `(session_id, kind, name)`. `storage_path` = key object storage `<orgId>/sessions/<sessionId>/<kind>/<nama>` (null setelah retensi). `status`: `stored` (di storage) → `uploaded` (di Drive, `drive_file_id` terisi) / `failed`. File turunan worker tidak punya `source_file_id`.
- `sessions`: tambah `manifest` (jsonb, `SessionManifest` dari `@pb/storage`: `version`, `configVersion`, `frameId`, `filterId`, `downloadUrl`, `shots[{slotIndex, takeNumber, fileId}]`, `files[{id, kind, name, sha256, bytes, mimeType, slotIndex}]`), `files_complete_at` (semua file terkonfirmasi di storage), `drive_folder_id`; `drive_folder_url` baru diisi setelah file terakhir terunggah ke Drive.
- `upload_jobs`: unik `(session_id, target)`. `target = storage` = job `process-session` (agent → storage selesai saat `complete`; job membuat mirrored/filtered/composite/gif/video), `target = drive` = job `upload-drive` (dibuat saat job storage selesai). Tambah `error_code` (`drive_not_connected`, `drive_revoked`, `drive_quota`, `drive_folder_missing`, `storage_missing`, `config_missing`, `failed`), `next_attempt_at` (backoff), `finished_at`. `status`: `pending` (menunggu / menunggu backoff) → `running` → `done` | `failed` (butuh tindakan owner atau percobaan habis). RLS: anggota org membaca (Studio menampilkan status); hanya API/worker yang menulis.
- `drive_connections` (satu baris per org, tanpa RLS untuk Studio): tambah `root_folder_name`, `last_error` (pesan untuk owner, tanpa token), `connected_by`. `encrypted_refresh_token` = SecretBox, AAD `org:<orgId>:drive`. `status`: `ok` | `failed` | `revoked` | `untested`.
- Struktur Drive: `<root_folder_id>/<config.output.driveRootFolderName | nama booth>/<YYYY-MM-DD zona booth>/<KODE>/<original|mirrored|filtered|composite|gif|video>/`. Nama file: `original/<KODE>-fotoN.jpg`, `mirrored/<KODE>-fotoN-mirror.jpg`, `filtered/<KODE>-fotoN-filter.jpg`, `composite/<KODE>-strip.jpg`, `gif/<KODE>.gif`, `video/<KODE>.mp4`.

### B.11 Ketetapan F6 (migrasi `0005_f6_reports_billing.sql`)
- `billing_invoices`: tambah `plan_id` (paket yang dibeli/diperpanjang), `kind` (`upgrade` = ganti paket / pembelian pertama setelah trial, periode mulai saat dibayar; `renewal` = periode berikutnya paket yang sama, mulai di akhir periode lama), `period_start/period_end`, `due_at`, `attempts` (order id penyedia = `<invoice id>-<attempts>`), `qr_string`, `qr_expires_at`, `env` (env Midtrans platform), `last_checked_at`. `status`: `pending` → `paid` | `void` (diganti pilihan lain, dilunasi invoice lain, atau paket diturunkan/diubah admin). Hanya satu invoice `pending` per org yang relevan; checkout membatalkan yang lain.
- `subscriptions`: satu baris per org, diubah di tempat. `status`: `trialing` → (periode habis) `past_due` + `grace_until` → (masa tenggang habis) paket Starter `active`; `active` setelah dibayar. Hak akses efektif dihitung dari jam (`resolveEntitlements`), kolom status hanya catatan terakhir siklus.
- `plans.limits.recapDays` (opsional): hari riwayat rekap; Starter 30. `plans.price_monthly` diisi admin platform (seed tetap `null`).
- `devices`: tambah `outbox_pending`, `uploads_pending` (dari heartbeat), `paper_capacity`, `paper_loaded_at`.
- View `daily_booth_stats` (materialized): `org_id, booth_id, day (tanggal zona booth), sessions, gross, fee, net, extra_prints, offline_sessions, {qris,voucher,cash}_{sessions,gross}, free_sessions` untuk `sessions.payment_method IS NOT NULL`. Indeks unik `(booth_id, day)`; akses langsung ditutup; Studio memakai `daily_booth_stats_v` (lihat decisions F6).
- Sumber agregasi rekap: `getReport()` (`packages/db/src/report-repo.ts`): hari < hari ini booth dari view, hari ini dan filter perangkat dari `sessions`; jam/frame/filter/lembar cetak selalu dari `sessions`/`print_jobs` dengan zona booth.

### B.12 Ketetapan audit MVP (migrasi `0006_audit_hardening.sql`, `docs/audit-mvp.md`)
- Trigger `devices_guard_identity` (`app.guard_device_identity()`): `devices.token_hash` dan `devices.org_id` tidak bisa diubah; `revoked_at` yang sudah terisi tidak bisa dikosongkan atau diganti. Berlaku untuk semua koneksi (Studio, Data API, service). Pairing ulang selalu membuat baris device baru.
- `payments.raw`: `signature_key` notifikasi tidak disimpan lagi; migrasi menghapusnya dari baris lama.
- Kandidat tindak lanjut (`listRefundCandidates`) kini juga memuat payment `paid` yang sesinya belum `completed` 30 menit setelah lunas (`reason: 'incomplete'`), selain `paid_late` (`reason: 'late'`). Tanpa kolom baru.
- `AssetRef.url` (A): bentuk zod tidak berubah, tetapi Studio menolak simpan/publish dan worker menolak mengambil URL di luar penyimpanan aset platform (`isAllowedAssetUrl`, `PB_ASSET_URL_PREFIXES`; `data:` bawaan tetap boleh). Worker juga mencocokkan sha256 + batas 100 MB. Tidak perlu kenaikan `schemaVersion`.
- `admin.pinHash` (A): format tetap; Studio hanya menerima PIN baru 6–8 digit (`NEW_ADMIN_PIN_RE`), booth tetap menerima PIN lama 4 digit (`ADMIN_PIN_RE`).
- Supabase: Data API (PostgREST) dimatikan (`supabase/config.toml` `[api] enabled = false`; proyek hosted lewat dashboard). Studio tidak pernah memakainya.

---

## C. Penyimpanan lokal (Agent, SQLite)

| Tabel | Isi |
|---|---|
| `config_cache` | versi config aktif + path aset lokal |
| `local_sessions` | salinan sesi + status sinkron |
| `local_files` | path file, jenis, status upload |
| `local_vouchers` | code_hash, booth_id, used_at, synced |
| `outbox` | event yang menunggu dikirim (heartbeat tertunda, device_events, pemakaian voucher) |

### C.1 Ketetapan F3 (`apps/agent/src/store.ts`, `node:sqlite`)
File `agent.sqlite` di folder data agent (Windows `%APPDATA%\photobooth-agent`, macOS `~/Library/Application Support/photobooth-agent`, Linux `$XDG_DATA_HOME/photobooth-agent`; installer: folder data aplikasi Tauri `…/agent`; dev dari repo: `.data/agent`). Migrasi lewat `pragma user_version`. Waktu = ISO 8601 UTC.

| Tabel | Kolom |
|---|---|
| `meta` | key, value — pengaturan lokal: `agent.id`, `camera.source` (`webcam`\|`tablet`), `printer.name` |
| `config_cache` | version (PK), config_id, etag, config (JSON), asset_paths (JSON assetId → path), activated_at |
| `local_sessions` | id, code (unik), booth_id, config_version, frame_id, filter_id, payment_method, amount, extra_prints, status (`capturing`\|`completed`\|`failed`), download_url, data (JSON), started_at, completed_at, sync_status, created_at, updated_at |
| `local_files` | id, session_id, kind (`original`\|`composite`\|`print`), slot_index, take_number, path, mime_type, width, height, bytes, sha256, source (`tablet`\|`webcam`\|`mock`\|`agent`), selected, captured_at, upload_status, created_at |
| `local_vouchers` | code_hash, booth_id, used_at, synced (dipakai F4) |
| `outbox` | id (cuid2, juga id baris di API), kind (`device_event`\|`print_job`), payload (JSON), created_at, attempts, next_attempt_at, last_error |
| `camera_pairings` | id, name, platform, token_hash (sha256 token kamera), created_at, last_seen_at, revoked_at |
| `print_jobs` | id, session_id, sheets, printer, status (`queued`\|`printing`\|`done`\|`failed`), file_path, os_job_id, error, created_at, updated_at |

- File sesi: `sessions/<YYYY-MM-DD UTC>/<KODE>/original|composite|print/`, ditulis dengan fsync. Tidak ada penghapusan di F3 (upload = F5). Aset config: `assets/<sha256>` (content-addressed, diverifikasi). Token device: file `device-token` (mode 0600).
- Outbox: dikirim per 100 ke `POST /device/events`; API menyimpan dengan id yang sama (`on conflict do nothing`) dan membalas id yang tersimpan → pengiriman ulang tidak menggandakan baris. Gagal → backoff 10 dtk × 2ⁿ (maks. 10 menit).
- `print_jobs` di API: `session_id` diisi hanya bila sesi dengan kode tersebut sudah ada di org (sesi baru diunggah di F5); `sheets` tetap tercatat untuk estimasi kertas.
- Heartbeat F3 menambah `printerStatus` (`ok`\|`warning`\|`error`\|`disconnected`\|`unknown`) → `devices.printer_status`. Tanpa migrasi DB (kolom sudah ada sejak F0).

### C.2 Ketetapan F4 (SQLite `user_version` 2)
| Tabel | Kolom |
|---|---|
| `local_vouchers` (dibuat ulang) | code_hash, booth_id (PK bersama), value_type (`full`\|`amount`), value, expires_at, remote_used_at (terpakai menurut API), used_at, used_session_id (terpakai di device ini), synced |
| `cash_approvals` (baru) | id (= id outbox), session_id, amount, approved_at, offline |
| `local_sessions` (+kolom) | offline (dibayar saat offline), payment_id |

- Daftar voucher di-replace dari `GET /device/vouchers` saat start, tiap 60 dtk, saat config siap, dan saat kembali online; pemakaian lokal yang belum tersinkron (`synced = 0`) tidak pernah dihapus.
- `outbox.kind` baru: `voucher_use` (payload: codeHash, session {id, code, startedAt}, amount, usedAt, offline), `cash_approval` (session, amount, approvedAt, offline), `session` (catatan sesi setelah processing), `payment_cancel` (paymentId; dikirim ke `POST /device/payments/:id/cancel`). `voucher_use`, `cash_approval`, `session` ikut batch `POST /device/events` (field `voucherUses`, `cashApprovals`, `sessions`).
- Kode voucher tidak pernah disimpan di agent; hanya hash (lihat B.9).

### A.7 Ketetapan F4 (renderer, tanpa perubahan schema)
- (Schema v1; sejak v2 keypad varian `field` adalah elemen `voucher-keypad`, lihat A.8.) `voucher-input` varian `keypad`: baris tampilan kode/status + keypad 3×4. Varian `field`: kolom setinggi `min(height, fontSize × 2,4)`; sisa tinggi kotak berisi keypad 3×4 ala telepon (1-2-3 / 4-5-6 / 7-8-9 / ⌫-0-✓; sejak 2026-11-25, sebelumnya 6×2), rata kiri, lebar tombol maks. 2,4 × tingginya, ukuran angka mengecil bila kotak pendek; tanpa keypad bila tinggi baris < 20 px (editor dan kiosk sama). Keduanya menerima keyboard/scanner di mode live. Kode ditampilkan `1234-5678` (8 digit sejak 2026-11-25). Bila kotak lebar dan pendek, keypad diletakkan di samping kolom (`data-pb-voucher-keypad="3x4-side"`). Status baru `needs_online` ("Voucher butuh internet") dan `locked` ("Terlalu banyak percobaan"). Di mode live, `voucher-input` dan tombol `selectPayment` untuk metode yang tidak aktif tidak digambar; di editor tampil redup.
- `qris` dan `payment-timer` tidak digambar di mode live bila `runtime.qrisHidden` (device offline atau QRIS tidak aktif).

### C.3 Ketetapan F5 (SQLite `user_version` 3)
| Tabel | Perubahan |
|---|---|
| `local_sessions` (+kolom) | `upload_attempts`, `upload_next_at` (backoff), `upload_error`, `uploaded_at`. `sync_status`: `pending` → `uploaded` (API mengonfirmasi `complete`) → `purged` (file lokal dihapus) |
| `local_files.upload_status` | `pending` → `uploaded` (storage menerima file dengan hash yang sama) → `deleted` |

- Yang diunggah: foto `selected = 1` (`original`) + `composite`. Take yang di-retake dan lembar cetak (`print`) tidak diunggah, dihapus bersama sesi.
- File lokal dan baris metadata tidak dihapus sebelum `POST /device/sessions/:id/complete` sukses. Dengan `PB_LOCAL_RETENTION_DAYS = N > 0`, penghapusan menunggu `uploaded_at + N hari`. Baris `local_sessions`/`local_files` dipertahankan (riwayat); hanya file di disk yang dihapus.
- Backoff unggah: 10 dtk × 2ⁿ, maks. 10 menit; kembali online mengosongkan backoff. 401 (perangkat dicabut) menghentikan antrian sampai pairing ulang.

### B.13 Voucher 8 digit (migrasi `0007_voucher_8_digit.sql`, 2026-11-25)
- `booths.voucher_offline` (boolean, default `false`): owner mengizinkan voucher saat booth offline. Hanya bila `true` `GET /device/vouchers` mengirim daftar hash (hanya voucher belum terpakai dan belum kedaluwarsa); bila `false` balasan `{ offlineAllowed: false, vouchers: [] }` dan agent mengosongkan daftarnya. Diubah lewat API Studio `PUT /studio/orgs/:orgId/booths/:boothId/voucher-offline` (audit `booth.voucher_offline`).
- `vouchers.code_hash` = hex scrypt(kode 8 digit, salt `pb-voucher:v2:<boothId>`, N=2^14, r=8, p=1, 32 byte) — `hashVoucherCode()` di `@pb/crypto`. Hash v1 (PBKDF2, 16 digit) tidak cocok lagi.
- `vouchers.code_encrypted` = SecretBox kode lengkap, AAD `voucher:<boothId>`; dibuat dan dibuka hanya oleh API (`POST …/vouchers`, `GET …/vouchers/codes`, audit `voucher.reveal`). `null` = voucher lama (kode tidak tersimpan). Agent tetap hanya menerima hash.
- Migrasi menandai voucher lama yang belum terpakai sebagai kedaluwarsa (`expires_at = now()`); tidak ada yang dihapus.
- API membatasi kode salah per device: 10 per 10 menit (redeem online → 429 `too_many_attempts` + `retryAfterSec`; `voucherUses` dari outbox ditunda, tidak dibuang). Agent: hasil `locked` dan `needs_online`; meta SQLite `voucher.offlineAllowed`.

### A.8 Schema v2: keypad voucher terpisah (2026-11-26)
- `CURRENT_SCHEMA_VERSION` 1 → **2**. Elemen baru `voucher-keypad` (`textStyle`, `keyStyle?`, `gap`): 12 tombol 3×4 (1-2-3 / 4-5-6 / 7-8-9 / ⌫-0-✓) mengisi kotaknya, ukuran angka `min(fontSize, tinggi baris × 0,6)`, atribut `data-pb-voucher-keypad="3x4"`. Disembunyikan di Kiosk bila voucher tidak aktif, redup di editor.
- `voucher-input` varian `field` kini hanya kolom kode (tinggi `min(height, fontSize × 2,4)`); varian `keypad` (kolom + keypad dalam satu kotak) tidak berubah. Keyboard/scanner tetap ditangani `voucher-input`.
- Migrasi 1 → 2 (`migrate.ts`): setiap `voucher-input` `field` yang di v1 menggambar keypad dipecah menjadi kolom + `voucher-keypad` (id `<id>-keypad`) dengan geometri v1 persis (keypad di bawah atau di samping, celah 8 px, ukuran angka v1), dibulatkan 2 desimal. Kotak yang di v1 terlalu kecil untuk keypad tetap satu elemen. Config lama dimigrasi saat dibaca (editor, Kiosk, agent, worker, halaman booth Studio, rollback, kartu Pembayaran).
- Template bawaan: kolom 700×96 di (960, 420) + keypad 440×248 di (960, 532).

### Migrasi DB 0008–0009 (2026-11-26)
- `0008_library_frames`: tabel global `library_frames`. RLS: `authenticated` hanya membaca baris `is_published`; tulis lewat API admin platform (`/admin/library-frames`, koneksi istimewa). URL file wajib lolos `isAllowedAssetUrl`.
- `0009_assets_bucket`: bucket Supabase Storage publik `assets` + policy `storage.objects`: anggota org membaca/menulis/menimpa hanya di folder `<org_id>/…`. Dilewati di database tanpa Supabase Storage (PGlite tes).
- Frame dari pustaka yang dipakai booth disalin ke config: `AssetRef` dengan id `lib-<libraryFrameId>` (url, sha256, bytes) + slot. Bentuk `BoothConfig` tidak berubah, tanpa migrasi config.

### A.9 Cetak tambahan dibeli sebelum Pembayaran (2026-11-26)
- `print-copies` boleh di halaman `framePick` dan `review`. Tambah/kurangi hanya aktif di Pilih Frame; di Review (sudah dibayar) elemen hanya menampilkan jumlah lembar, tanpa tombol.
- Nominal Pembayaran (QRIS, voucher, tunai) = harga frame + cetak tambahan × `extraPrintPrice`. Mode event: tidak ada cetak tambahan, harga frame 0.
- Template bawaan: `print-copies` + label di Pilih Frame (daftar frame 1600×560 di y 190); Review tanpa jumlah cetak dan total. Bentuk config tidak berubah (tanpa migrasi); booth lama yang menjual cetak tambahan tanpa `print-copies` di Pilih Frame mendapat peringatan saat publish dan tidak menjual cetak tambahan.

### A.10 Schema v3: persetujuan dan survei pembeli (F8, 2026-11-27)
- `CURRENT_SCHEMA_VERSION` 2 → **3**. Elemen baru `consent-checkbox` dan `survey-question` (tabel elemen khusus di A.2), boleh di Cover, Pilih Frame, dan Review. Migrasi 2 → 3 tidak mengubah isi config; kenaikan versi hanya agar Kiosk lama menolak desain yang tidak bisa digambarnya.
- Elemen `required: true` yang tampil di halaman aktif mengunci tombol maju halaman itu (`start`/`next` di Cover, `next`/`confirm` di Pilih Frame, `confirm`/`next`/`finish` di Review) sampai dicentang/dijawab; tombol tampil redup lewat `canAction`. Idle di Review setelah bayar tetap lanjut ke Processing walau belum dijawab (sesi berbayar tidak boleh tertahan).
- Ketuk di mana saja pada `consent-checkbox` = centang/batal. `survey-question` `multiple: false` berlaku seperti radio (ketuk pilihan yang sama tidak membatalkan); `multiple: true` = centang/batal per pilihan. Id pilihan unik per pertanyaan (`survey-question.option-ids`). Tidak ada jawaban teks bebas (Kiosk tanpa keyboard layar).
- Jawaban (`SessionResponse` di `packages/schema/src/session-response.ts`, sama dengan `FlowResponse` di `@pb/flow`): `{ kind: 'consent', elementId, page, label, answeredAt }` atau `{ kind: 'survey', elementId, page, question, optionIds, optionLabels, answeredAt }`. Teks disalin dari desain saat menjawab, jadi rekap tetap terbaca walau owner mengubah desain. Persetujuan yang tidak dicentang dan pertanyaan kosong tidak dicatat. Jawaban disimpan di konteks flow (Cover terjadi sebelum sesi dibuat), dihapus setiap kembali ke Cover, dan ikut ke `processSession` → agent (`/process`, disimpan di `data` sesi lokal) → outbox `session` → API → `sessions.responses` (migrasi `0010_f8_session_responses.sql`, default `[]`). Kiriman ulang tanpa `responses` (agent lama) tidak menghapus jawaban yang sudah tersimpan.
- Studio: detail sesi menampilkan kartu "Persetujuan dan survei"; ekspor CSV/Excel transaksi menambah kolom **Persetujuan** dan **Survei** (satu baris per item di dalam sel).
