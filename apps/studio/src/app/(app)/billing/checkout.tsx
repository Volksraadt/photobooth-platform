'use client';

import { qrPath, QR_QUIET_ZONE } from '@pb/renderer/pure';
import { Alert, Button } from '@pb/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { pollInvoiceAction, renewQrAction, startCheckoutAction, type InvoiceView } from './actions';

const idr = (n: number) => `Rp${n.toLocaleString('id-ID')}`;

function Qr({ value }: { value: string }) {
  const q = useMemo(() => qrPath(value), [value]);
  const size = q.size + QR_QUIET_ZONE * 2;
  return (
    <svg
      viewBox={`${-QR_QUIET_ZONE} ${-QR_QUIET_ZONE} ${size} ${size}`}
      className="h-56 w-56 rounded border bg-white"
      role="img"
      aria-label="Kode QRIS pembayaran langganan"
      data-testid="billing-qr"
    >
      <path d={q.d} fill="#000" />
    </svg>
  );
}

/**
 * "Pilih paket" button → invoice + QRIS of the platform's Midtrans account → polls until paid.
 * The page refreshes itself when the payment arrives (plan, banner and limits change at once).
 */
export function PlanCheckout({
  planCode,
  label,
  disabled,
  openInvoice,
}: {
  planCode: 'pro' | 'business';
  label: string;
  disabled?: boolean;
  openInvoice?: InvoiceView | null;
}) {
  const router = useRouter();
  const [invoice, setInvoice] = useState<InvoiceView | null>(openInvoice ?? null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const waiting = invoice?.status === 'pending';

  useEffect(() => {
    if (!invoice || invoice.status !== 'pending') return;
    const id = setInterval(async () => {
      const r = await pollInvoiceAction(invoice.id);
      if (!r.ok) return;
      setInvoice(r.invoice);
      if (r.invoice.status === 'paid') router.refresh();
    }, 3000);
    return () => clearInterval(id);
  }, [invoice, router]);

  const begin = () =>
    start(async () => {
      setError(null);
      const r = await startCheckoutAction(planCode);
      if (r.ok) setInvoice(r.invoice);
      else setError(r.message);
    });
  const renew = () =>
    start(async () => {
      if (!invoice) return;
      const r = await renewQrAction(invoice.id);
      if (r.ok) setInvoice(r.invoice);
      else setError(r.message);
    });

  return (
    <div className="space-y-3">
      {!invoice && (
        <Button onClick={begin} disabled={disabled || pending} data-testid={`checkout-${planCode}`}>
          {pending ? 'Menyiapkan…' : label}
        </Button>
      )}
      {error && <Alert variant="destructive">{error}</Alert>}
      {invoice && waiting && (
        <div className="space-y-2" data-testid="checkout-panel">
          <div className="text-sm">
            Tagihan <b>{invoice.planName}</b>: <b>{idr(invoice.amount)}</b> untuk 1 bulan. Pindai
            dengan aplikasi e-wallet / mobile banking yang mendukung QRIS.
          </div>
          {invoice.qrString ? (
            <Qr value={invoice.qrString} />
          ) : (
            <div className="space-y-2">
              {invoice.qrExpired ? (
                <p className="text-sm text-warning">Kode QR sudah kedaluwarsa.</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Buat kode QR untuk membayar tagihan ini.
                </p>
              )}
              <Button onClick={renew} disabled={pending} variant="outline" data-testid="renew-qr">
                {invoice.qrExpired ? 'Buat kode QR baru' : 'Buat kode QR'}
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground" data-testid="checkout-waiting">
            Menunggu pembayaran… halaman ini diperbarui otomatis setelah lunas.
          </p>
        </div>
      )}
      {invoice?.status === 'paid' && (
        <Alert variant="success" data-testid="checkout-paid">
          Pembayaran diterima. Paket {invoice.planName} aktif.
        </Alert>
      )}
    </div>
  );
}
