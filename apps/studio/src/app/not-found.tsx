import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-2xl font-semibold">Halaman tidak ditemukan</h1>
      <p className="text-sm text-muted-foreground">
        Halaman ini tidak ada atau Anda tidak punya akses.
      </p>
      <Link href="/booths" className="mt-2 text-sm font-medium text-primary hover:underline">
        Kembali ke daftar booth
      </Link>
    </main>
  );
}
