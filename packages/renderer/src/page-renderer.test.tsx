import { createDefaultBoothConfig, PAGE_TYPES, type BoothConfig, type PageType } from '@pb/schema';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PageRenderer } from './page-renderer';
import type { RenderMode, RenderRuntime, RendererAction } from './types';

let n = 0;
const config: BoothConfig = createDefaultBoothConfig({
  boothId: 'booth-1',
  boothName: 'Booth Uji',
  idFactory: () => `id-${++n}`,
});

beforeAll(() => {
  // jsdom has no layout; pretend the container is a 1366×768 screen.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1366,
    height: 768,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1366,
    bottom: 768,
    toJSON: () => ({}),
  });
});
afterEach(cleanup);

function renderPage(
  type: PageType,
  opts: { mode?: RenderMode; runtime?: RenderRuntime; onAction?: (a: RendererAction) => void } = {},
) {
  return render(
    <PageRenderer
      page={config.pages[type]}
      config={config}
      mode={opts.mode ?? 'live'}
      runtime={opts.runtime}
      onAction={opts.onAction}
    />,
  );
}

const q = (root: HTMLElement, sel: string) => root.querySelector<HTMLElement>(sel);

describe('PageRenderer', () => {
  it.each(PAGE_TYPES)('renders the default %s page in both modes', (type) => {
    for (const mode of ['editor', 'live'] as const) {
      const { container, unmount } = renderPage(type, { mode });
      for (const el of config.pages[type].elements) {
        const node = q(container, `[data-pb-element-id="${el.id}"]`);
        expect(node, `${type}/${el.type}`).not.toBeNull();
        // Positions are artboard px, never screen px.
        expect(node!.style.left).toBe(`${el.x}px`);
        expect(node!.style.top).toBe(`${el.y}px`);
        expect(node!.style.width).toBe(`${el.width}px`);
        expect(node!.style.height).toBe(`${el.height}px`);
      }
      unmount();
    }
  });

  it('scales the artboard to fit the container with letterbox', () => {
    const { container } = renderPage('cover');
    const artboard = q(container, '[data-pb-artboard]')!;
    const scale = 768 / 1080;
    expect(Number(artboard.dataset.pbScale)).toBeCloseTo(scale);
    expect(artboard.style.width).toBe('1920px');
    expect(artboard.style.transform).toMatch(/scale\(0\.7111/);
    expect(q(container, '.pb-root')!.style.background).toBe('rgb(0, 0, 0)');
  });

  it('renders at artboard size with fit="none" (editor canvas)', () => {
    const { container } = render(
      <PageRenderer page={config.pages.cover} config={config} mode="editor" fit="none" />,
    );
    const root = q(container, '.pb-root')!;
    expect(root.style.width).toBe('1920px');
    expect(root.style.height).toBe('1080px');
    expect(root.dataset.pbMode).toBe('editor');
  });

  it('resolves text tokens', () => {
    const { container } = renderPage('cover', { runtime: { boothName: 'Booth Uji' } });
    expect(container.textContent).toContain('Booth Uji');
  });

  describe('buttons', () => {
    it('emit their action in live mode', () => {
      const onAction = vi.fn();
      const { container } = renderPage('cover', { onAction });
      fireEvent.click(q(container, '[data-pb-action="start"]')!);
      expect(onAction).toHaveBeenCalledWith({ kind: 'start' });
    });

    it('do nothing in editor mode', () => {
      const onAction = vi.fn();
      const { container } = renderPage('cover', { mode: 'editor', onAction });
      fireEvent.click(q(container, '[data-pb-action="start"]')!);
      expect(onAction).not.toHaveBeenCalled();
    });

    it('are dimmed and inert when the host disallows the action', () => {
      const onAction = vi.fn();
      const { container } = renderPage('framePick', {
        onAction,
        runtime: { canAction: (a) => a.kind !== 'next' },
      });
      const next = q(container, '[data-pb-action="next"]')!;
      expect(next.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(next);
      expect(onAction).not.toHaveBeenCalled();
    });
  });

  describe('flow-bound elements', () => {
    it('show placeholders in editor mode', () => {
      const { container } = renderPage('capture', { mode: 'editor' });
      const camera = q(container, '[data-pb-element-type="camera-view"]')!;
      expect(camera.textContent).toContain('Kamera');
      // Countdown preview uses the configured seconds.
      expect(q(container, '[data-pb-countdown]')!.textContent).toBe('3');
    });

    it('capture: slots, active slot, countdown and retake', () => {
      const onAction = vi.fn();
      const { container } = renderPage('capture', {
        onAction,
        runtime: {
          shots: { 1: { url: 'blob:one' }, 2: { url: 'blob:two' } },
          activeSlotIndex: 3,
          countdown: 2,
          canAction: () => true,
        },
      });
      expect(q(container, '[data-pb-slot="1"]')!.dataset.pbFilled).toBe('true');
      expect(q(container, '[data-pb-slot="3"]')!.dataset.pbActive).toBe('true');
      expect(q(container, '[data-pb-slot="4"]')!.textContent).toBe('4');
      expect(q(container, '[data-pb-countdown]')!.textContent).toBe('2');
      expect(q(container, '[data-pb-crop-guide]')).not.toBeNull();
      fireEvent.click(q(container, '[data-pb-retake-slot="2"]')!);
      expect(onAction).toHaveBeenCalledWith({ kind: 'retake', shotIndex: 2 });
    });

    it('hides the countdown when null', () => {
      const { container } = renderPage('capture', { runtime: { countdown: null } });
      expect(q(container, '[data-pb-countdown]')).toBeNull();
    });

    it('frame picker selects a frame', () => {
      const onAction = vi.fn();
      const frame = config.frames[0]!;
      const { container } = renderPage('framePick', {
        onAction,
        runtime: { selectedFrameId: frame.id, price: 35000 },
      });
      const item = q(container, `[data-pb-item="${frame.id}"]`)!;
      expect(item.dataset.pbSelected).toBe('true');
      expect(item.textContent).toContain('Rp 35.000');
      fireEvent.click(item);
      expect(onAction).toHaveBeenCalledWith({ kind: 'selectFrame', frameId: frame.id });
      expect(q(container, '[data-pb-price]')!.textContent).toBe('Rp 35.000');
    });

    it('review: filter picker + filtered preview', () => {
      const onAction = vi.fn();
      const bw = config.filters[1]!;
      const { container } = renderPage('review', {
        onAction,
        runtime: {
          shots: {
            1: { url: 'blob:1' },
            2: { url: 'blob:2' },
            3: { url: 'blob:3' },
            4: { url: 'blob:4' },
          },
          selectedFrameId: config.frames[0]!.id,
          selectedFilterId: bw.id,
          printSheets: 2,
        },
      });
      fireEvent.click(q(container, `[data-pb-item="${config.filters[2]!.id}"]`)!);
      expect(onAction).toHaveBeenCalledWith({
        kind: 'selectFilter',
        filterId: config.filters[2]!.id,
      });
      // Frame preview draws the 4 photos with the selected filter as an SVG color matrix.
      const preview = q(container, '[data-pb-frame-composite]')!;
      const photos = preview.querySelectorAll('[data-pb-frame-slot] img');
      expect(photos).toHaveLength(4);
      expect((photos[0] as HTMLImageElement).style.filter).toMatch(/^url\("?#pb-f/);
      expect(preview.querySelector('feColorMatrix')).not.toBeNull();
    });

    it('framePick: extra prints stepper; read-only when it cannot change', () => {
      const onAction = vi.fn();
      const { container } = renderPage('framePick', {
        onAction,
        runtime: { printSheets: 2, canAction: (a) => a.kind === 'addPrint' },
      });
      const copies = q(container, '[data-pb-print-copies]')!;
      expect(copies.dataset.pbPrintCopies).toBe('2');
      fireEvent.click(q(copies, '[data-pb-action="addPrint"]')!);
      expect(onAction).toHaveBeenCalledWith({ kind: 'addPrint' });

      const locked = renderPage('framePick', {
        runtime: { printSheets: 1, canAction: () => false },
      });
      const ro = q(locked.container, '[data-pb-print-copies]')!;
      expect(ro.querySelector('[data-pb-action]')).toBeNull();
      expect(ro.textContent).toBe('1');
    });

    it('payment: QRIS and timer', () => {
      const { container } = renderPage('payment', {
        runtime: {
          qrisString: 'QRIS-TEST',
          paymentExpiresAt: Date.now() + 90_000,
          paymentTotalSec: 300,
        },
      });
      expect(q(container, '[data-pb-qris]')!.dataset.pbQris).toBe('QRIS-TEST');
      expect(q(container, '[data-pb-qris] svg path')).not.toBeNull();
      expect(q(container, '[data-pb-timer]')!.textContent).toMatch(/^01:(29|30)$/);
    });

    it('payment: pending QR without data in live mode', () => {
      const { container } = renderPage('payment');
      expect(q(container, '[data-pb-qris] [data-pb-pending]')).not.toBeNull();
      expect(q(container, '[data-pb-timer]')).toBeNull();
    });

    it('payment offline: QRIS and timer are not drawn', () => {
      const { container } = renderPage('payment', {
        runtime: {
          qrisString: 'QRIS-TEST',
          paymentExpiresAt: Date.now() + 90_000,
          qrisHidden: true,
        },
      });
      expect(q(container, '[data-pb-qris]')).toBeNull();
      expect(q(container, '[data-pb-timer]')).toBeNull();
      expect(q(container, '[data-pb-voucher]')).not.toBeNull();
    });

    it('payment: voucher keypad emits key actions, keyboard works, status is shown', () => {
      const onAction = vi.fn();
      const { container, rerender } = renderPage('payment', {
        runtime: { voucherCode: '12345678' },
        onAction,
      });
      const voucher = q(container, '[data-pb-voucher]')!;
      expect(q(voucher, '[data-pb-voucher-code]')!.textContent).toBe('1234-5678');
      const keypad = q(voucher, '[data-pb-voucher-key="7"]');
      if (keypad) {
        fireEvent.pointerDown(keypad);
        expect(onAction).toHaveBeenCalledWith({ kind: 'voucherKey', key: '7' });
        fireEvent.pointerDown(q(voucher, '[data-pb-voucher-key="✓"]')!);
        expect(onAction).toHaveBeenCalledWith({ kind: 'voucherSubmit' });
      }
      fireEvent.keyDown(window, { key: '3' });
      fireEvent.keyDown(window, { key: 'Enter' });
      expect(onAction).toHaveBeenCalledWith({ kind: 'voucherKey', key: '3' });
      expect(onAction).toHaveBeenCalledWith({ kind: 'voucherSubmit' });
      rerender(
        <PageRenderer
          page={config.pages.payment}
          config={config}
          mode="live"
          runtime={{ voucherCode: '', voucherStatus: 'used' }}
          onAction={onAction}
        />,
      );
      expect(q(container, '[data-pb-voucher-status="used"]')!.textContent).toBe(
        'Voucher sudah dipakai',
      );
    });

    it('processing and result', () => {
      const a = renderPage('processing', { runtime: { progress: 0.5 } });
      expect(q(a.container, '[data-pb-progress]')!.dataset.pbProgress).toBe('0.5');
      a.unmount();
      const b = renderPage('result', { runtime: { downloadUrl: 'https://pb.test/s/ABCD2345' } });
      expect(q(b.container, '[data-pb-download-qr]')!.dataset.pbDownloadQr).toBe(
        'https://pb.test/s/ABCD2345',
      );
    });

    it('tutorial draws the active slide under the page elements', () => {
      const { container } = renderPage('tutorial', { runtime: { slideIndex: 0 } });
      expect(container.textContent).toContain('Cara pakai');
      expect(q(container, '[data-pb-action="next"]')).not.toBeNull();
    });
  });

  it('renders on the server (Studio SSR) without touching window', () => {
    const html = renderToString(
      <PageRenderer page={config.pages.capture} config={config} mode="editor" />,
    );
    expect(html).toContain('data-pb-element-type="camera-view"');
  });
});

describe('F8: consent + survey elements', () => {
  const text = {
    fontFamily: 'Inter',
    fontSize: 28,
    fontWeight: 400,
    color: '#111',
    align: 'left' as const,
    lineHeight: 1.3,
    letterSpacing: 0,
  };
  const base = {
    x: 10,
    y: 20,
    width: 600,
    height: 120,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
  };
  const page = {
    ...config.pages.cover,
    elements: [
      {
        ...base,
        id: 'c1',
        name: 'Persetujuan',
        type: 'consent-checkbox' as const,
        label: 'Saya setuju',
        required: true,
        textStyle: text,
        boxSize: 40,
        boxStyle: { borderColor: '#111', borderWidth: 2 },
        checkedStyle: { fill: '#111' },
        checkColor: '#fff',
      },
      {
        ...base,
        id: 'q1',
        name: 'Pertanyaan',
        type: 'survey-question' as const,
        question: 'Dari mana?',
        options: [
          { id: 'ig', label: 'Instagram' },
          { id: 'fr', label: 'Teman' },
        ],
        multiple: false,
        required: false,
        layout: 'row' as const,
        columns: 2,
        gap: 8,
        questionStyle: text,
        optionTextStyle: text,
        optionStyle: {},
        selectedStyle: { fill: '#111' },
      },
    ],
  };

  it('shows the live state and emits toggleConsent / selectOption', () => {
    const onAction = vi.fn();
    const { container } = render(
      <PageRenderer
        page={page}
        config={config}
        mode="live"
        runtime={{ checkedConsents: ['c1'], surveyAnswers: { q1: ['fr'] } }}
        onAction={onAction}
      />,
    );
    const box = q(container, '[data-pb-consent="c1"]')!;
    expect(box.dataset.pbChecked).toBe('true');
    expect(q(container, '[data-pb-option="fr"]')!.dataset.pbSelected).toBe('true');
    expect(q(container, '[data-pb-option="ig"]')!.dataset.pbSelected).toBe('false');
    fireEvent.click(box);
    fireEvent.click(q(container, '[data-pb-option="ig"]')!);
    expect(onAction.mock.calls).toEqual([
      [{ kind: 'toggleConsent', elementId: 'c1' }],
      [{ kind: 'selectOption', elementId: 'q1', optionId: 'ig' }],
    ]);
  });

  it('is inert in editor mode', () => {
    const onAction = vi.fn();
    const { container } = render(
      <PageRenderer page={page} config={config} mode="editor" onAction={onAction} />,
    );
    fireEvent.click(q(container, '[data-pb-consent="c1"]')!);
    expect(onAction).not.toHaveBeenCalled();
  });
});
