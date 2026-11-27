'use client';

import { Alert, Button, Input, EmptyState } from '@pb/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteTemplateAction, updateTemplateAction } from './actions';

export type AdminTemplate = {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  isPublic: boolean;
  createdAt: string;
};

function TemplateItem({ t }: { t: AdminTemplate }) {
  const router = useRouter();
  const [name, setName] = useState(t.name);
  const [description, setDescription] = useState(t.description ?? '');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.message ?? 'Gagal.');
      else router.refresh();
    });
  const changed = name.trim() !== t.name || description.trim() !== (t.description ?? '');

  return (
    <li
      className="space-y-2 rounded-lg border bg-background p-3 text-sm"
      data-testid="template-item"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-muted px-1.5 text-[11px]">
          {t.key ? 'Bawaan' : 'Dari booth'}
        </span>
        <span className={t.isPublic ? 'text-success' : 'text-muted-foreground'}>
          {t.isPublic ? 'tampil untuk owner' : 'disembunyikan'}
        </span>
      </div>
      <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      <Input
        value={description}
        maxLength={200}
        placeholder="Deskripsi singkat"
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !changed || !name.trim()}
          onClick={() =>
            run(() =>
              updateTemplateAction(t.id, {
                name: name.trim(),
                description: description.trim() || null,
              }),
            )
          }
        >
          Simpan
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => run(() => updateTemplateAction(t.id, { isPublic: !t.isPublic }))}
        >
          {t.isPublic ? 'Sembunyikan' : 'Tampilkan'}
        </Button>
        {!t.key &&
          (confirm ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => run(() => deleteTemplateAction(t.id))}
              >
                Ya, hapus template
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Batal
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirm(true)}
            >
              Hapus
            </Button>
          ))}
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
    </li>
  );
}

export function TemplatesManager({ templates }: { templates: AdminTemplate[] }) {
  if (templates.length === 0) return <EmptyState size="compact" title="Belum ada template." />;
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {templates.map((t) => (
        <TemplateItem key={t.id} t={t} />
      ))}
    </ul>
  );
}
