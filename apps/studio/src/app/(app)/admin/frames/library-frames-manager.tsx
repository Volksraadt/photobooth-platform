'use client';

import type { PhotoSlot } from '@pb/schema';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  EmptyState,
} from '@pb/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { detectSlots, readAlpha, STRIP_PX } from '@/lib/detect-slots';
import {
  createLibraryFrameAction,
  deleteLibraryFrameAction,
  updateLibraryFrameAction,
} from './actions';

export type AdminLibraryFrame = {
  id: string;
  name: string;
  url: string;
  width: number | null;
  height: number | null;
  slots: PhotoSlot[];
  sortOrder: number;
  isPublished: boolean;
};

/** Overlay image with its photo slots outlined (slots are in strip px). */
export function FrameWithSlots({
  url,
  slots,
  className = 'h-56',
}: {
  url: string;
  slots: PhotoSlot[];
  className?: string;
}) {
  return (
    <div
      className={`relative aspect-[1/3] ${className} overflow-hidden rounded border bg-[repeating-conic-gradient(#e5e7eb_0%_25%,#fff_0%_50%)] bg-[length:16px_16px]`}
    >
      <img src={url} alt="" className="absolute inset-0 h-full w-full" />
      {slots.map((s) => (
        <div
          key={s.index}
          className="absolute flex items-center justify-center border-2 border-dashed border-pink-500 bg-pink-500/15 text-xs font-semibold text-pink-700"
          style={{
            left: `${(s.x / STRIP_PX.width) * 100}%`,
            top: `${(s.y / STRIP_PX.height) * 100}%`,
            width: `${(s.width / STRIP_PX.width) * 100}%`,
            height: `${(s.height / STRIP_PX.height) * 100}%`,
          }}
        >
          {s.index}
        </div>
      ))}
    </div>
  );
}

type Pending = {
  file: File;
  preview: string;
  width: number;
  height: number;
  slots: PhotoSlot[];
};

function UploadCard() {
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [name, setName] = useState('');
  const [publish, setPublish] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File | undefined) => {
    setError(null);
    setPending(null);
    if (!file) return;
    try {
      const img = await readAlpha(file);
      const slots = detectSlots(img);
      setPending({
        file,
        preview: URL.createObjectURL(file),
        width: img.width,
        height: img.height,
        slots,
      });
      if (!name) setName(file.name.replace(/\.[^.]+$/, '').slice(0, 120));
    } catch {
      setError('Gambar tidak bisa dibaca. Pakai PNG, WebP, atau SVG.');
    }
  };

  const save = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('file', pending.file);
      const res = await fetch('/api/library-frames', { method: 'POST', body: form });
      const stored = (await res.json().catch(() => ({}))) as {
        url?: string;
        sha256?: string;
        bytes?: number;
        mimeType?: string;
        error?: string;
      };
      if (!res.ok || !stored.url) throw new Error(stored.error ?? `Unggah gagal (${res.status}).`);
      const result = await createLibraryFrameAction({
        name: name.trim() || 'Frame',
        url: stored.url,
        sha256: stored.sha256!,
        bytes: stored.bytes!,
        mimeType: stored.mimeType!,
        width: pending.width,
        height: pending.height,
        slots: pending.slots,
        isPublished: publish,
      });
      if (!result.ok) throw new Error(result.message);
      URL.revokeObjectURL(pending.preview);
      setPending(null);
      setName('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan.');
    } finally {
      setBusy(false);
    }
  };

  const ratio = pending ? pending.height / pending.width : 3;
  const ratioOff = pending && Math.abs(ratio - 3) > 0.03;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Tambah frame</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="lib-file">File overlay</Label>
          <Input
            id="lib-file"
            type="file"
            accept=".png,.webp,.svg,image/png,image/webp,image/svg+xml"
            data-testid="library-file"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
        </div>
        {pending && (
          <div className="flex flex-wrap gap-6">
            <FrameWithSlots url={pending.preview} slots={pending.slots} className="h-72" />
            <div className="min-w-60 flex-1 space-y-3 text-sm">
              <p>
                {pending.width}×{pending.height} px ·{' '}
                <b data-testid="library-slot-count">{pending.slots.length} slot foto</b> terdeteksi
              </p>
              {ratioOff && (
                <Alert>
                  Rasio gambar bukan 1:3; frame akan diregangkan ke strip 600×1800 saat dicetak.
                </Alert>
              )}
              {pending.slots.length === 0 && (
                <Alert variant="destructive">
                  Tidak ada area transparan tertutup. Lubang foto harus transparan dan tidak
                  menyentuh tepi gambar.
                </Alert>
              )}
              <div className="space-y-1">
                <Label htmlFor="lib-name">Nama</Label>
                <Input
                  id="lib-name"
                  value={name}
                  maxLength={120}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={publish}
                  onChange={(e) => setPublish(e.target.checked)}
                />
                Langsung tampil untuk owner
              </label>
              <Button
                type="button"
                disabled={busy || pending.slots.length === 0}
                onClick={() => void save()}
                data-testid="library-save"
              >
                {busy ? 'Menyimpan…' : 'Simpan ke pustaka'}
              </Button>
            </div>
          </div>
        )}
        {error && <Alert variant="destructive">{error}</Alert>}
      </CardContent>
    </Card>
  );
}

function FrameItem({ frame }: { frame: AdminLibraryFrame }) {
  const router = useRouter();
  const [name, setName] = useState(frame.name);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.message ?? 'Gagal.');
      else router.refresh();
    });

  return (
    <li className="flex gap-4 rounded-lg border bg-background p-3" data-testid="library-item">
      <FrameWithSlots url={frame.url} slots={frame.slots} className="h-40" />
      <div className="min-w-0 flex-1 space-y-2 text-sm">
        <div className="flex gap-2">
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          <Button
            type="button"
            variant="outline"
            disabled={busy || name.trim() === frame.name || !name.trim()}
            onClick={() => run(() => updateLibraryFrameAction(frame.id, { name: name.trim() }))}
          >
            Simpan
          </Button>
        </div>
        <p className="text-muted-foreground">
          {frame.slots.length} slot ·{' '}
          {frame.isPublished ? (
            <span className="text-success">tampil untuk owner</span>
          ) : (
            <span>disembunyikan</span>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(() => updateLibraryFrameAction(frame.id, { isPublished: !frame.isPublished }))
            }
          >
            {frame.isPublished ? 'Sembunyikan' : 'Tampilkan'}
          </Button>
          {confirmDelete ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => run(() => deleteLibraryFrameAction(frame.id))}
              >
                Ya, hapus dari pustaka
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConfirmDelete(false)}
              >
                Batal
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              Hapus
            </Button>
          )}
        </div>
        {error && <Alert variant="destructive">{error}</Alert>}
      </div>
    </li>
  );
}

export function LibraryFramesManager({ frames }: { frames: AdminLibraryFrame[] }) {
  return (
    <div className="space-y-6">
      <UploadCard />
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Isi pustaka ({frames.length})</h2>
        {frames.length === 0 ? (
          <EmptyState size="compact" title="Belum ada frame di pustaka." />
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {frames.map((f) => (
              <FrameItem key={f.id} frame={f} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
