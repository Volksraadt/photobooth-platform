import { createId } from '@paralleldrive/cuid2';
import type {
  BaseElement,
  BoothConfig,
  BoxStyle,
  Element,
  ElementOf,
  ElementType,
  TextStyle,
} from '@pb/schema';

export const ELEMENT_LABEL: Record<ElementType, string> = {
  image: 'Gambar',
  text: 'Teks',
  shape: 'Bentuk',
  video: 'Video',
  button: 'Tombol',
  'camera-view': 'Layar kamera',
  'photo-slot': 'Slot foto',
  countdown: 'Hitung mundur',
  'frame-picker': 'Pilihan frame',
  'frame-preview': 'Pratinjau frame',
  'filter-picker': 'Pilihan filter',
  qris: 'QRIS',
  'price-label': 'Harga',
  'payment-timer': 'Timer pembayaran',
  'voucher-input': 'Kolom voucher',
  'voucher-keypad': 'Keypad voucher',
  'download-qr': 'QR unduh',
  progress: 'Progres',
  'print-copies': 'Jumlah cetak',
  'consent-checkbox': 'Persetujuan',
  'survey-question': 'Pertanyaan survei',
  'contact-input': 'Kirim hasil',
};

const FONT = 'Inter, system-ui, sans-serif';

export function defaultTextStyle(fontSize = 48, extra: Partial<TextStyle> = {}): TextStyle {
  return {
    fontFamily: FONT,
    fontSize,
    fontWeight: 400,
    color: '#ffffff',
    align: 'center',
    lineHeight: 1.2,
    letterSpacing: 0,
    ...extra,
  };
}

const SIZE: Record<ElementType, [number, number]> = {
  image: [400, 300],
  text: [600, 80],
  shape: [300, 200],
  video: [640, 360],
  button: [360, 110],
  'camera-view': [1280, 720],
  'photo-slot': [330, 220],
  countdown: [300, 300],
  'frame-picker': [1200, 600],
  'frame-preview': [260, 780],
  'filter-picker': [1000, 280],
  qris: [500, 500],
  'price-label': [400, 90],
  'payment-timer': [400, 60],
  'voucher-input': [600, 100],
  'voucher-keypad': [440, 248],
  'download-qr': [360, 360],
  progress: [800, 24],
  'print-copies': [400, 100],
  'consent-checkbox': [900, 90],
  'survey-question': [1000, 200],
  'contact-input': [560, 520],
};

/**
 * A new element with sensible defaults, centered at `center` (artboard px).
 * `slotIndex` is the next free one for photo slots.
 */
export function createElement(
  type: ElementType,
  config: BoothConfig,
  opts: { center: { x: number; y: number }; slotIndex?: number; assetId?: string; scale?: number },
): Element {
  const [w0, h0] = SIZE[type];
  const s = opts.scale ?? 1;
  const width = Math.round(w0 * s);
  const height = Math.round(h0 * s);
  const base: BaseElement = {
    id: createId(),
    name: ELEMENT_LABEL[type],
    x: Math.round(opts.center.x - width / 2),
    y: Math.round(opts.center.y - height / 2),
    width,
    height,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
  };
  const accent: BoxStyle = { fill: '#ec4899', borderRadius: 999 };
  const make = <T extends ElementType>(
    props: Omit<ElementOf<T>, keyof BaseElement | 'type'> & Partial<BaseElement>,
  ) => ({ ...base, type, ...props }) as unknown as Element;

  switch (type) {
    case 'image':
      return make<'image'>({ assetId: opts.assetId ?? '', fit: 'contain' });
    case 'video':
      return make<'video'>({ assetId: opts.assetId ?? '', loop: true, muted: true });
    case 'text':
      return make<'text'>({ content: 'Teks baru', ...defaultTextStyle(Math.round(48 * s)) });
    case 'shape':
      return make<'shape'>({ shape: 'rect', style: { fill: '#334155', borderRadius: 16 } });
    case 'button':
      return make<'button'>({
        action: { kind: 'next' },
        label: 'Lanjut',
        textStyle: defaultTextStyle(40, { fontWeight: 700 }),
        style: accent,
        pressedStyle: { ...accent, fill: '#be185d' },
      });
    case 'camera-view':
      return make<'camera-view'>({
        mirror: true,
        fit: 'cover',
        cropAspect: true,
        overlayFrame: false,
        style: { borderRadius: 24 },
      });
    case 'photo-slot': {
      const slotIndex = opts.slotIndex ?? 1;
      return make<'photo-slot'>({
        name: `Slot ${slotIndex}`,
        slotIndex,
        emptyStyle: {
          fill: '#1e293b',
          borderRadius: 16,
          showNumber: true,
          numberColor: '#cbd5e1',
          numberFontFamily: FONT,
          numberFontSize: 72,
        },
        filledStyle: { borderRadius: 16 },
        activeStyle: { borderColor: '#ec4899', borderWidth: 6, borderRadius: 16 },
        showRetakeButton: true,
      });
    }
    case 'countdown':
      return make<'countdown'>({
        fontFamily: FONT,
        fontSize: 220,
        color: '#ffffff',
        variant: 'number',
      });
    case 'frame-picker':
      return make<'frame-picker'>({
        layout: 'grid',
        columns: 4,
        gap: 32,
        itemStyle: { fill: '#1e293b', borderRadius: 16 },
        selectedStyle: { borderColor: '#ec4899', borderWidth: 6, borderRadius: 16 },
        showPrice: true,
        showName: true,
        labelStyle: defaultTextStyle(28),
      });
    case 'frame-preview':
      return make<'frame-preview'>({ fit: 'contain' });
    case 'filter-picker':
      return make<'filter-picker'>({
        layout: 'row',
        itemSize: 200,
        showLabel: true,
        selectedStyle: { borderColor: '#ec4899', borderWidth: 6, borderRadius: 16 },
        labelStyle: defaultTextStyle(28),
      });
    case 'qris':
      return make<'qris'>({ padding: 24, background: '#ffffff', showLogo: true });
    case 'price-label':
      return make<'price-label'>({ format: 'idr', ...defaultTextStyle(56, { fontWeight: 700 }) });
    case 'payment-timer':
      return make<'payment-timer'>({ variant: 'text', textStyle: defaultTextStyle(36) });
    case 'voucher-input':
      return make<'voucher-input'>({
        variant: 'field',
        textStyle: defaultTextStyle(40, { color: '#0f172a' }),
        keyStyle: { fill: '#ffffff', borderRadius: 16 },
      });
    case 'voucher-keypad':
      return make<'voucher-keypad'>({
        textStyle: defaultTextStyle(34, { color: '#0f172a' }),
        keyStyle: { fill: '#ffffff', borderRadius: 14 },
        gap: 8,
      });
    case 'download-qr':
      return make<'download-qr'>({ padding: 24, foreground: '#000000', background: '#ffffff' });
    case 'progress':
      return make<'progress'>({ variant: 'bar', color: '#ec4899', trackColor: '#1e293b' });
    case 'print-copies':
      return make<'print-copies'>({
        textStyle: defaultTextStyle(48, { fontWeight: 700 }),
        buttonStyle: { fill: '#1e293b', borderRadius: 999 },
      });
    case 'consent-checkbox':
      return make<'consent-checkbox'>({
        label: 'Saya setuju foto saya disimpan dan dikirim sesuai kebijakan privasi booth ini.',
        required: true,
        textStyle: defaultTextStyle(28, { align: 'left', lineHeight: 1.3 }),
        boxSize: 44,
        boxStyle: { fill: '#ffffff', borderColor: '#cbd5e1', borderWidth: 3, borderRadius: 10 },
        checkedStyle: { fill: '#ec4899', borderColor: '#ec4899' },
        checkColor: '#ffffff',
      });
    case 'survey-question':
      return make<'survey-question'>({
        question: 'Tahu booth ini dari mana?',
        options: [
          { id: createId(), label: 'Instagram' },
          { id: createId(), label: 'TikTok' },
          { id: createId(), label: 'Teman' },
          { id: createId(), label: 'Lewat saja' },
        ],
        multiple: false,
        required: false,
        layout: 'row',
        columns: 2,
        gap: 16,
        questionStyle: defaultTextStyle(36, { fontWeight: 700 }),
        optionTextStyle: defaultTextStyle(28),
        optionStyle: { fill: '#1e293b', borderRadius: 16 },
        selectedStyle: { fill: '#ec4899', borderRadius: 16 },
      });
    case 'contact-input':
      return make<'contact-input'>({
        name: 'Kirim ke WhatsApp',
        channel: 'whatsapp',
        placeholder: 'Nomor WhatsApp',
        textStyle: defaultTextStyle(36, { color: '#0f172a', align: 'left' }),
        fieldStyle: { fill: '#ffffff', borderRadius: 16 },
        keyTextStyle: defaultTextStyle(32, { color: '#0f172a' }),
        keyStyle: { fill: '#ffffff', borderRadius: 14 },
        submitLabel: 'Kirim',
        submitStyle: { fill: '#ec4899', borderRadius: 14 },
        gap: 8,
      });
  }
  // Keep the union exhaustive.
  void config;
  throw new Error(`unknown element type ${String(type)}`);
}
