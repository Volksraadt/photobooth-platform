# F9 — Kirim hasil lewat WhatsApp / e-mail

Tujuan: pembeli bisa mengetik nomor WhatsApp atau alamat e-mail di halaman Hasil dan menerima tautan unduhan (`/s/:code`). Paket kedua dari studi clean room fitur pembanding. Pengirimnya akun milik platform (keputusan 2026-11-27): owner tidak perlu menyiapkan apa pun.

## Task
- [x] Schema v4: elemen `contact-input` (kanal `whatsapp` / `email`, hanya di Hasil, maksimal satu per kanal), migrasi 3 → 4, `docs/schema.md` A.11.
- [x] Normalisasi + validasi penerima (`normalizeWhatsapp`, `normalizeEmail`), penyamaran (`maskRecipient`), `DeliveryRequestSchema`, batas `MAX_DELIVERIES_PER_SESSION` = 3.
- [x] Flow: ketikan di konteks (`contacts`), event `CONTACT.KEY` / `CONTACT.BACKSPACE` / `CONTACT.SUBMIT`, state `result.sending` memanggil `deliverResult`; mengetik memperpanjang timer halaman Hasil.
- [x] Renderer: kolom + keypad angka (WhatsApp) / keyboard huruf dengan `@gmail.com` dan `.com` (e-mail), status dalam Bahasa Indonesia.
- [x] Kiosk → agent `POST /deliveries` → outbox `delivery` (menunggu saat offline) → API `/device/events` `deliveries`.
- [x] DB: tabel `deliveries` (migrasi `0011`), penerima terenkripsi SecretBox + petunjuk tersamar, RLS baca anggota org.
- [x] `packages/messaging`: WhatsApp Cloud API (template), e-mail Resend, mode `log` untuk dev.
- [x] Worker: kirim antrean `deliveries`, coba lagi dengan jeda untuk gangguan sementara, hapus penerima setelah final.
- [x] Studio: elemen "Kirim hasil" di editor (Hasil), kartu "Kirim hasil" di detail sesi.

## Acceptance criteria
- Nomor `0812…` dikirim sebagai `62812…`; nomor/e-mail tidak valid ditolak di Kiosk tanpa memanggil agent. (`packages/schema` session-response test, `packages/flow` test F9)
- Lebih dari 3 kiriman per sesi ditolak di Kiosk dan di API. (`packages/flow` test F9, `packages/db` delivery-repo test)
- Permintaan saat offline menunggu di outbox agent lalu sampai ke API; kiriman ulang batch tidak membuat antrean ganda. (`apps/agent` test F9, `packages/db` delivery-repo test)
- Satu penerima rusak di batch outbox tidak membuat batch ditolak. (`apps/api` payments test F9)
- Nomor/e-mail tidak pernah tersimpan polos di DB dan dihapus setelah terkirim atau gagal final; Studio hanya melihat petunjuk tersamar milik org sendiri. (`packages/db` delivery-repo test)
- Worker mengirim tautan `/s/:code` dengan nama booth; 429/5xx/jaringan dicoba lagi, penolakan lain gagal final dengan pesan yang terbaca owner. (`apps/worker` deliveries test, `packages/messaging` test)

## Sebelum dipakai di booth (lihat open-questions #59–#62)
- Template WhatsApp disetujui Meta dan env `WHATSAPP_*` diisi; domain pengirim e-mail diverifikasi di Resend.
- Worker sebaiknya tidak di laptop booth bila token pengirim platform dipasang (#55, #61).
