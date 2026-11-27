'use client';

import { Button } from '@pb/ui';
import Link from 'next/link';
import { useEffect } from 'react';
import { AlertIcon } from '@/components/icons';

/** Unexpected server/render error inside Studio: keep the shell, offer retry. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="flex flex-col items-center rounded-lg border bg-background px-6 py-16 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-destructive-soft text-destructive">
        <AlertIcon className="size-6" />
      </div>
      <h1 className="text-lg font-semibold">Terjadi kesalahan</h1>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Halaman ini gagal dimuat. Coba lagi; bila masih gagal, hubungi dukungan dan sebutkan kode
        berikut.
      </p>
      {error.digest && (
        <code className="mt-3 rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
          {error.digest}
        </code>
      )}
      <div className="mt-6 flex gap-2">
        <Button onClick={reset}>Coba lagi</Button>
        <Button variant="outline" asChild>
          <Link href="/booths">Ke daftar booth</Link>
        </Button>
      </div>
    </div>
  );
}
