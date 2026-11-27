'use client';

import type { ElementOf } from '@pb/schema';
import type { CSSProperties } from 'react';
import { useRenderer } from '../context';
import { boxStyleToCss, textStyleToCss } from '../styles';
import type { ContactRuntimeStatus } from '../types';

const fill = { position: 'absolute', inset: 0 } as const;

type Key = { key: string; label?: string; span?: number; kind?: 'char' | 'back' | 'submit' };

const WHATSAPP_KEYS: Key[][] = [
  [{ key: '1' }, { key: '2' }, { key: '3' }],
  [{ key: '4' }, { key: '5' }, { key: '6' }],
  [{ key: '7' }, { key: '8' }, { key: '9' }],
  [{ key: '⌫', kind: 'back' }, { key: '0' }, { key: 'submit', kind: 'submit' }],
];

const row = (chars: string): Key[] => [...chars].map((key) => ({ key }));
const EMAIL_KEYS: Key[][] = [
  row('1234567890'),
  row('qwertyuiop'),
  row('asdfghjkl@'),
  row('zxcvbnm._-'),
  [
    { key: '@gmail.com', span: 3 },
    { key: '.com', span: 2 },
    { key: '⌫', kind: 'back', span: 2 },
    { key: 'submit', kind: 'submit', span: 3 },
  ],
];

const SAMPLE = { whatsapp: '0812 3456 7890', email: 'nama@gmail.com' } as const;

function statusText(channel: 'whatsapp' | 'email', status: ContactRuntimeStatus): string {
  switch (status) {
    case 'invalid':
      return channel === 'whatsapp' ? 'Nomor WhatsApp belum benar' : 'Alamat e-mail belum benar';
    case 'sending':
      return 'Mengirim…';
    case 'sent':
      return 'Terkirim! Link sampai dalam beberapa menit.';
    case 'error':
      return 'Gagal mengirim, coba lagi.';
    case 'limit':
      return 'Batas kirim untuk sesi ini sudah tercapai.';
    case 'idle':
      return '';
  }
}

/** WhatsApp digits grouped for reading: 0812 3456 7890 (same as formatContact in @pb/flow). */
const grouped = (channel: 'whatsapp' | 'email', v: string) =>
  channel === 'whatsapp' ? v.replace(/(\d{4})(?=\d)/g, '$1 ') : v;

/**
 * Field + status line + keyboard (3×4 for WhatsApp, 10 columns for e-mail) in one box. Editor:
 * sample text, keys inert.
 */
export function ContactInputElementView({ el }: { el: ElementOf<'contact-input'> }) {
  const { mode, runtime, onAction } = useRenderer();
  const live = mode === 'live';
  const state = runtime.contacts?.[el.id] ?? { value: '', status: 'idle' as const };
  const value = live ? grouped(el.channel, state.value) : SAMPLE[el.channel];
  const status = live ? state.status : 'idle';
  const busy = status === 'sending';
  const fieldHeight = el.textStyle.fontSize * 2.2;
  const statusHeight = el.textStyle.fontSize * 1.5;
  const rows = el.channel === 'whatsapp' ? WHATSAPP_KEYS : EMAIL_KEYS;
  const columns = el.channel === 'whatsapp' ? 3 : 10;

  const press = (k: Key) => {
    if (!live || busy) return;
    if (k.kind === 'back') onAction({ kind: 'contactBackspace', elementId: el.id });
    else if (k.kind === 'submit') onAction({ kind: 'contactSubmit', elementId: el.id });
    else onAction({ kind: 'contactKey', elementId: el.id, key: k.key });
  };

  const keyCss = (k: Key): CSSProperties => ({
    gridColumn: k.span ? `span ${k.span}` : undefined,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
    padding: 0,
    border: 'none',
    background: 'transparent',
    cursor: live && !busy ? 'pointer' : 'default',
    opacity: busy ? 0.5 : 1,
    ...textStyleToCss({ ...el.keyTextStyle, align: 'center' }),
    ...boxStyleToCss(k.kind === 'submit' ? el.submitStyle : el.keyStyle),
  });

  return (
    <div
      data-pb-contact={el.channel}
      data-pb-contact-status={status}
      style={{ ...fill, display: 'flex', flexDirection: 'column', ...boxStyleToCss(el.style) }}
    >
      <div
        data-pb-contact-value={live ? state.value : ''}
        style={{
          flex: 'none',
          height: fieldHeight,
          display: 'flex',
          alignItems: 'center',
          padding: `0 ${el.textStyle.fontSize * 0.6}px`,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          ...boxStyleToCss(el.fieldStyle),
        }}
      >
        <span
          style={{
            ...textStyleToCss(el.textStyle),
            width: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            opacity: value ? 1 : 0.5,
          }}
        >
          {value || el.placeholder}
        </span>
      </div>
      <div
        role="status"
        style={{
          flex: 'none',
          height: statusHeight,
          display: 'flex',
          alignItems: 'center',
          ...textStyleToCss({ ...el.textStyle, fontSize: el.textStyle.fontSize * 0.6 }),
        }}
      >
        {statusText(el.channel, status)}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridAutoRows: '1fr',
          gap: el.gap,
        }}
      >
        {rows.flat().map((k) => (
          <button
            key={k.key}
            type="button"
            data-pb-contact-key={k.kind ?? k.key}
            aria-label={k.kind === 'back' ? 'Hapus' : k.kind === 'submit' ? el.submitLabel : k.key}
            tabIndex={live ? 0 : -1}
            onClick={live ? () => press(k) : undefined}
            style={keyCss(k)}
          >
            {k.kind === 'submit' ? el.submitLabel : (k.label ?? k.key)}
          </button>
        ))}
      </div>
    </div>
  );
}
