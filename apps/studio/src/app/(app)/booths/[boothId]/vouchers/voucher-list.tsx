'use client';

import { Alert, Button } from '@pb/ui';
import { useState, useTransition } from 'react';
import { revealVoucherCodesAction, setVoucherOfflineAction } from './actions';

export type VoucherRowView = {
  id: string;
  last4: string;
  valueLabel: string;
  expiresLabel: string;
  statusLabel: string;
  status: 'available' | 'used' | 'expired';
  usedOffline: boolean;
  note: string;
  revealable: boolean;
};

const masked = (last4: string) => `····-${last4}`;

function csvDownload(name: string, rows: string[][]) {
  const csv = rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(
    new Blob([String.fromCharCode(0xfeff) + csv], { type: 'text/csv;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Voucher list. Codes are masked until the owner asks for them (one row or all); the API decrypts
 * and audits each request. Vouchers made before the 8-digit change have no stored code.
 */
export function VoucherList({
  boothId,
  boothName,
  rows,
  canReveal,
}: {
  boothId: string;
  boothName: string;
  rows: VoucherRowView[];
  canReveal: boolean;
}) {
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const reveal = (ids: string[] | null, then?: (found: Record<string, string>) => void) =>
    start(async () => {
      setError(null);
      const r = await revealVoucherCodesAction(boothId, ids);
      if (!r.ok) return setError(r.message);
      const found: Record<string, string> = {};
      for (const c of r.codes) if (c.formatted) found[c.id] = c.formatted;
      setCodes((prev) => ({ ...prev, ...found }));
      then?.(found);
    });

  const copy = async (id: string, code: string) => {
    await navigator.clipboard.writeText(code.replace(/-/g, ''));
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
  };

  const downloadAll = () =>
    reveal(null, (found) =>
      csvDownload(`voucher-${boothName.replace(/\W+/g, '-')}.csv`, [
        ['kode', 'nilai', 'masa_berlaku', 'status', 'catatan'],
        ...rows
          .filter((r) => found[r.id])
          .map((r) => [found[r.id]!, r.valueLabel, r.expiresLabel, r.statusLabel, r.note]),
      ]),
    );

  const anyRevealable = rows.some((r) => r.revealable);
  return (
    <div className="space-y-3">
      {canReveal && anyRevealable && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => reveal(null)}
            data-testid="voucher-reveal-all"
          >
            Tampilkan semua kode
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={downloadAll}
          >
            Unduh CSV semua
          </Button>
        </div>
      )}
      {error && <Alert variant="destructive">{error}</Alert>}
      <ul className="divide-y rounded border text-sm" data-testid="voucher-list">
        {rows.map((v) => {
          const code = codes[v.id];
          return (
            <li
              key={v.id}
              data-testid={`voucher-${v.last4}`}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 p-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="font-mono text-base tracking-wider"
                    data-testid={code ? 'voucher-code-shown' : undefined}
                  >
                    {code ?? masked(v.last4)}
                  </span>
                  {canReveal && v.revealable && !code && (
                    <button
                      type="button"
                      className="text-xs text-primary underline"
                      disabled={pending}
                      onClick={() => reveal([v.id])}
                    >
                      Tampilkan
                    </button>
                  )}
                  {code && (
                    <button
                      type="button"
                      className="text-xs text-primary underline"
                      onClick={() => void copy(v.id, code)}
                    >
                      {copied === v.id ? 'Tersalin' : 'Salin'}
                    </button>
                  )}
                  {!v.revealable && (
                    <span className="text-xs text-muted-foreground">
                      format lama, kode tidak tersimpan
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {v.valueLabel} · {v.expiresLabel}
                  {v.note ? ` · ${v.note}` : ''}
                </div>
              </div>
              <span
                className={
                  v.status === 'available'
                    ? 'text-xs text-success'
                    : 'text-xs text-muted-foreground'
                }
              >
                {v.statusLabel}
                {v.usedOffline && (
                  <span className="ml-1 rounded-full bg-warning-soft px-2 font-medium text-warning">
                    offline
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Owner choice per booth: vouchers while offline (the device then keeps the hash list). */
export function VoucherOfflineToggle({
  boothId,
  enabled,
  canEdit,
}: {
  boothId: string;
  enabled: boolean;
  canEdit: boolean;
}) {
  const [on, setOn] = useState(enabled);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1"
          checked={on}
          disabled={!canEdit || pending}
          data-testid="voucher-offline-toggle"
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            start(async () => {
              const r = await setVoucherOfflineAction(boothId, next);
              if (!r.ok) {
                setOn(!next);
                setMessage(r.message ?? 'Gagal menyimpan.');
              } else
                setMessage(next ? 'Voucher bisa dipakai saat offline.' : 'Voucher butuh internet.');
            });
          }}
        />
        <span>
          <b>Voucher tetap bisa dipakai saat booth offline</b>
          <span className="block text-muted-foreground">
            Bila aktif, laptop booth menyimpan daftar voucher (bentuk acak/hash) agar bisa memeriksa
            kode tanpa internet. Kode 8 digit relatif pendek: orang yang bisa menyalin file dari
            laptop booth bisa menebak kode yang valid dalam hitungan menit. Aktifkan hanya bila
            laptop booth selalu dalam pengawasan Anda. Bila tidak aktif, voucher hanya diterima saat
            booth online.
          </span>
        </span>
      </label>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
