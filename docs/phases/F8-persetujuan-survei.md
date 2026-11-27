# F8 — Persetujuan dan survei pembeli

Tujuan: owner bisa meminta pembeli mencentang persetujuan (penyimpanan foto, syarat) dan menjawab pertanyaan pilihan ganda, lalu melihat jawabannya per sesi. Paket pertama dari studi fitur pembanding (survei + disclaimer bawaan) dan langkah untuk open-questions #11 (UU PDP).

## Task
- [x] Schema v3: elemen `consent-checkbox` dan `survey-question` (Cover, Pilih Frame, Review), validasi id pilihan unik, migrasi 2 → 3, `docs/schema.md` A.10.
- [x] Flow: jawaban di konteks (`responses`), event `CONSENT.TOGGLE` / `SURVEY.SELECT`, guard `responsesComplete` pada tombol maju, jawaban ikut ke `processSession`, dihapus saat kembali ke Cover.
- [x] Renderer: tampilan centang + pilihan, aksi `toggleConsent` / `selectOption`, inert di editor.
- [x] Kiosk + pratinjau Studio: jawaban diteruskan ke renderer; tombol maju redup sampai lengkap.
- [x] Agent → API → DB: `responses` di `/process`, outbox `session`, `sessions.responses` (migrasi `0010`).
- [x] Studio editor: menu "Persetujuan & survei", panel properti (pernyataan, wajib, pilihan jawaban, susunan, gaya).
- [x] Studio: kartu jawaban di detail sesi; kolom Persetujuan + Survei di ekspor CSV/Excel.

## Acceptance criteria
- Persetujuan wajib di Cover: tombol Mulai tidak berfungsi sampai dicentang; batal centang mengunci lagi. (`packages/flow` test F8)
- Pertanyaan pilihan tunggal mengganti jawaban; pilihan ganda mencentang/membatalkan per pilihan, urutan mengikuti desain. (`packages/flow` test F8)
- Jawaban dari Cover dan Review sampai ke processing; pembeli berikutnya mulai kosong. (`packages/flow` test F8)
- Sesi berbayar yang idle di Review tetap diproses walau pertanyaan wajib belum dijawab. (`packages/flow` test F8)
- Elemen di halaman yang tidak diizinkan dan id pilihan ganda ditolak saat publish. (`packages/schema` test F8)
- Jawaban tersimpan di `sessions.responses`; kiriman ulang tanpa jawaban tidak menghapusnya; jawaban rusak ditolak. (`apps/api` payments test F8)

## Belum (lihat open-questions #57, #58)
- Jawaban teks bebas (butuh input di Kiosk, datang bersama F9).
- Ringkasan jumlah per pilihan di halaman Rekap.
- E2E Playwright Studio untuk elemen baru (Kiosk: `apps/kiosk/e2e/f8-responses.spec.ts`).
