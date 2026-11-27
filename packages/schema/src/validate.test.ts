import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createDefaultBoothConfig,
  DEFAULT_STRIP_OVERLAY_SHA256,
  DEFAULT_STRIP_OVERLAY_SVG,
  generateSessionCode,
  isSessionCode,
  migrateBoothConfig,
  validateBoothConfig,
  type BoothConfig,
  type ValidationIssue,
} from './index';

const fresh = (): BoothConfig =>
  createDefaultBoothConfig({ boothId: 'booth_test', boothName: 'Tes' });

function issuesOf(config: unknown): ValidationIssue[] {
  const result = validateBoothConfig(config);
  return result.success ? [] : result.issues;
}

describe('createDefaultBoothConfig', () => {
  it('produces a config that passes validateBoothConfig', () => {
    const result = validateBoothConfig(fresh());
    expect(result.issues).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('has 1 frame with 4 slots, 3 filters, all 9 pages', () => {
    const config = fresh();
    expect(config.frames).toHaveLength(1);
    expect(config.frames[0]!.slots).toHaveLength(4);
    expect(config.filters).toHaveLength(3);
    expect(config.filters.filter((f) => f.isDefault)).toHaveLength(1);
    expect(Object.keys(config.pages).sort()).toEqual([
      'capture',
      'cover',
      'error',
      'framePick',
      'payment',
      'processing',
      'result',
      'review',
      'tutorial',
    ]);
    expect(config.configVersion).toBe(0);
  });

  it('is serialisable to JSON and still valid after a round trip', () => {
    const roundTrip = JSON.parse(JSON.stringify(fresh())) as unknown;
    expect(validateBoothConfig(roundTrip).success).toBe(true);
  });

  it('uses unique element ids', () => {
    const config = fresh();
    const ids = Object.values(config.pages).flatMap((p) => [
      ...p.elements.map((e) => e.id),
      ...(p.slides ?? []).flatMap((s) => [s.id, ...s.elements.map((e) => e.id)]),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('embeds the built-in overlay with a correct sha256', () => {
    const hash = createHash('sha256').update(DEFAULT_STRIP_OVERLAY_SVG).digest('hex');
    expect(hash).toBe(DEFAULT_STRIP_OVERLAY_SHA256);
    const asset = fresh().assets[0]!;
    const decoded = Buffer.from(asset.url.split(',')[1]!, 'base64').toString('utf8');
    expect(decoded).toBe(DEFAULT_STRIP_OVERLAY_SVG);
    expect(asset.bytes).toBe(Buffer.byteLength(DEFAULT_STRIP_OVERLAY_SVG));
  });
});

describe('validateBoothConfig — page rules', () => {
  it('fails with a clear message when capture has no camera-view', () => {
    const config = fresh();
    config.pages.capture.elements = config.pages.capture.elements.filter(
      (e) => e.type !== 'camera-view',
    );
    const result = validateBoothConfig(config);
    expect(result.success).toBe(false);
    const issue = issuesOf(config).find((i) => i.code === 'capture.camera-view.count');
    expect(issue).toBeDefined();
    expect(issue!.path).toBe('pages.capture.elements');
    expect(issue!.message).toBe(
      'Halaman Capture harus punya tepat satu elemen camera-view (ditemukan 0).',
    );
  });

  it('rejects two camera-views', () => {
    const config = fresh();
    const cam = config.pages.capture.elements.find((e) => e.type === 'camera-view')!;
    config.pages.capture.elements.push({ ...cam, id: 'cam2' });
    expect(issuesOf(config).map((i) => i.code)).toContain('capture.camera-view.count');
  });

  it('requires photo-slot count to match the largest enabled frame', () => {
    const config = fresh();
    config.pages.capture.elements = config.pages.capture.elements.filter(
      (e) => !(e.type === 'photo-slot' && e.slotIndex === 4),
    );
    expect(issuesOf(config).map((i) => i.code)).toContain('capture.photo-slot.count');
  });

  it('requires a countdown on capture', () => {
    const config = fresh();
    config.pages.capture.elements = config.pages.capture.elements.filter(
      (e) => e.type !== 'countdown',
    );
    expect(issuesOf(config).map((i) => i.code)).toContain('capture.countdown.count');
  });

  it('requires qris only when qris is enabled', () => {
    const config = fresh();
    config.pages.payment.elements = config.pages.payment.elements.filter(
      (e) =>
        e.type !== 'qris' &&
        !(e.type === 'button' && e.action.kind === 'selectPayment' && e.action.method === 'qris'),
    );
    expect(issuesOf(config).map((i) => i.code)).toContain('payment.qris.count');
    config.flow.paymentMethods = ['voucher', 'cash'];
    expect(validateBoothConfig(config).success).toBe(true);
  });

  it('requires voucher-input when voucher is enabled', () => {
    const config = fresh();
    config.pages.payment.elements = config.pages.payment.elements.filter(
      (e) => e.type !== 'voucher-input',
    );
    expect(issuesOf(config).map((i) => i.code)).toContain('payment.voucher-input.count');
  });

  it('skips payment rules in event mode', () => {
    const config = fresh();
    config.flow.eventMode = true;
    config.flow.paymentMethods = [];
    config.pages.payment.elements = [];
    expect(validateBoothConfig(config).success).toBe(true);
  });

  it('requires a frame-picker on framePick', () => {
    const config = fresh();
    config.pages.framePick.elements = config.pages.framePick.elements.filter(
      (e) => e.type !== 'frame-picker',
    );
    expect(issuesOf(config).map((i) => i.code)).toContain('framePick.frame-picker.count');
  });

  it('requires filter-picker on review only when more than one filter is enabled', () => {
    const config = fresh();
    config.pages.review.elements = config.pages.review.elements.filter(
      (e) => e.type !== 'filter-picker',
    );
    expect(issuesOf(config).map((i) => i.code)).toContain('review.filter-picker.count');
    config.filters = config.filters.map((f) => ({ ...f, enabled: f.isDefault }));
    expect(validateBoothConfig(config).success).toBe(true);
  });

  it('skips review rules when review is disabled', () => {
    const config = fresh();
    config.flow.reviewEnabled = false;
    config.pages.review.elements = [];
    expect(validateBoothConfig(config).success).toBe(true);
  });

  it('requires a download-qr on result', () => {
    const config = fresh();
    config.pages.result.elements = config.pages.result.elements.filter(
      (e) => e.type !== 'download-qr',
    );
    expect(issuesOf(config).map((i) => i.code)).toContain('result.download-qr.count');
  });

  it('requires an exit on every page except processing and result', () => {
    const config = fresh();
    config.pages.cover.elements = config.pages.cover.elements.filter((e) => e.type !== 'button');
    const issue = issuesOf(config).find((i) => i.code === 'cover.no-exit');
    expect(issue?.message).toMatch(/tidak punya jalan keluar/);
  });

  it('accepts a tutorial without buttons when every slide auto-advances', () => {
    const config = fresh();
    config.pages.tutorial.elements = [];
    expect(validateBoothConfig(config).success).toBe(true);
    delete config.pages.tutorial.slides![0]!.durationSec;
    expect(issuesOf(config).map((i) => i.code)).toContain('tutorial.no-exit');
  });

  it('rejects special elements on the wrong page', () => {
    const config = fresh();
    const qr = config.pages.result.elements.find((e) => e.type === 'download-qr')!;
    config.pages.cover.elements.push({ ...qr, id: 'qr-on-cover' });
    const issue = issuesOf(config).find((i) => i.code === 'element.wrong-page');
    expect(issue?.path).toBe(`pages.cover.elements.${config.pages.cover.elements.length - 1}`);
  });

  it('rejects page key / type mismatch', () => {
    const config = fresh();
    config.pages.cover.type = 'error';
    expect(issuesOf(config).map((i) => i.code)).toContain('page.type-mismatch');
  });

  it('rejects duplicate element ids on a page', () => {
    const config = fresh();
    const [a, b] = config.pages.cover.elements;
    b!.id = a!.id;
    expect(issuesOf(config).map((i) => i.code)).toContain('element.duplicate-id');
  });
});

describe('validateBoothConfig — references & structure', () => {
  it('reports schema errors with a dotted path', () => {
    const config = fresh() as unknown as { artboard: { width: unknown } };
    config.artboard.width = 'wide';
    const issue = issuesOf(config)[0]!;
    expect(issue.path).toBe('artboard.width');
    expect(issue.code).toMatch(/^schema\./);
  });

  it('rejects a missing page', () => {
    const config = fresh() as unknown as { pages: Record<string, unknown> };
    delete config.pages.error;
    expect(issuesOf(config).some((i) => i.path === 'pages.error')).toBe(true);
  });

  it('rejects unknown asset references', () => {
    const config = fresh();
    config.frames[0]!.overlayAssetId = 'nope';
    expect(issuesOf(config).map((i) => i.code)).toContain('asset.missing');
  });

  it('rejects asset of the wrong kind', () => {
    const config = fresh();
    config.assets[0]!.kind = 'font';
    expect(issuesOf(config).map((i) => i.code)).toContain('asset.wrong-kind');
  });

  it('requires exactly one enabled default filter', () => {
    const config = fresh();
    config.filters[1]!.isDefault = true;
    expect(issuesOf(config).map((i) => i.code)).toContain('filter.default-count');
    config.filters[1]!.isDefault = false;
    config.filters[0]!.enabled = false;
    expect(issuesOf(config).map((i) => i.code)).toContain('filter.default-disabled');
  });

  it('requires at least one enabled frame', () => {
    const config = fresh();
    config.frames[0]!.enabled = false;
    expect(issuesOf(config).map((i) => i.code)).toContain('frame.none-enabled');
  });

  it('rejects non-contiguous slot indices and out-of-bounds slots', () => {
    const config = fresh();
    config.frames[0]!.slots[3]!.index = 7;
    config.frames[0]!.slots[0]!.width = 9999;
    const codes = issuesOf(config).map((i) => i.code);
    expect(codes).toContain('frame.slot-index');
    expect(codes).toContain('frame.slot-out-of-bounds');
  });

  it('rejects selectFilter buttons pointing to unknown filters', () => {
    const config = fresh();
    const btn = config.pages.review.elements.find((e) => e.type === 'button')!;
    config.pages.review.elements.push({
      ...btn,
      id: 'sf',
      action: { kind: 'selectFilter', filterId: 'ghost' },
    } as typeof btn);
    expect(issuesOf(config).map((i) => i.code)).toContain('button.unknown-filter');
  });

  it('rejects an empty payment method list outside event mode', () => {
    const config = fresh();
    config.flow.paymentMethods = [];
    expect(issuesOf(config).map((i) => i.code)).toContain('flow.payment-methods-empty');
  });

  it('rejects unknown timezones', () => {
    const config = fresh();
    config.timezone = 'Mars/Olympus';
    expect(issuesOf(config).some((i) => i.path === 'timezone')).toBe(true);
  });
});

describe('migrateBoothConfig', () => {
  it('passes current-version configs through validation', () => {
    expect(migrateBoothConfig(fresh()).success).toBe(true);
  });

  it('rejects future schema versions', () => {
    const result = migrateBoothConfig({ ...fresh(), schemaVersion: 99 });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues[0]!.code).toBe('schema.version-unsupported');
  });
});

describe('session codes', () => {
  it('generates 8-char codes without ambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateSessionCode();
      expect(isSessionCode(code)).toBe(true);
      expect(code).not.toMatch(/[01OI]/);
    }
    expect(isSessionCode('ABCD1234')).toBe(false);
  });
});

describe('built-in templates', () => {
  it('are all valid and instantiate for a booth', async () => {
    const { BUILTIN_TEMPLATES, buildTemplateConfig, instantiateTemplate } =
      await import('./templates');
    for (const t of BUILTIN_TEMPLATES) {
      const stored = buildTemplateConfig(t);
      const config = instantiateTemplate(stored, {
        boothId: 'b1',
        boothName: 'Booth X',
        timezone: 'Asia/Makassar',
      });
      const result = validateBoothConfig(config);
      expect(
        result.success,
        `${t.key}: ${JSON.stringify(result.success ? [] : result.issues)}`,
      ).toBe(true);
      expect(config.output.driveRootFolderName).toBe('Booth X');
      expect(JSON.stringify(config.pages.cover)).toContain('{{boothName}}');
    }
  });
});

describe('booth → template', () => {
  it('strips what belongs to the booth and instantiates again', async () => {
    const { instantiateTemplate, templateFromBooth } = await import('./templates');
    const booth = createDefaultBoothConfig({ boothId: 'b1', boothName: 'Booth Asli' });
    booth.configVersion = 7;
    booth.admin = { pinHash: 'x'.repeat(10) };
    const t = templateFromBooth(booth);
    expect(t).toMatchObject({ boothId: 'template', configVersion: 0, admin: { pinHash: '' } });
    expect(t.output.driveRootFolderName).toBe('{{boothName}}');
    expect(booth.boothId).toBe('b1');
    const again = instantiateTemplate(t, {
      boothId: 'b2',
      boothName: 'Baru',
      timezone: 'Asia/Jakarta',
    });
    expect(validateBoothConfig(again).success).toBe(true);
    expect(again.output.driveRootFolderName).toBe('Baru');
  });
});

describe('asset references', () => {
  it('finds asset ids incl. fonts and prunes unused refs', async () => {
    const { pruneUnusedAssets, referencedAssetIds } = await import('./asset-refs');
    const config = createDefaultBoothConfig({ boothId: 'b' });
    const ref = { id: 'font1', kind: 'font' as const, url: 'x', sha256: 'a'.repeat(64), bytes: 1 };
    const unused = { ...ref, id: 'unused', kind: 'image' as const };
    config.assets.push(ref, unused);
    const title = config.pages.cover.elements[0]!;
    if (title.type === 'text') title.fontFamily = '"pb-font-font1", sans-serif';
    const ids = referencedAssetIds(config);
    expect(ids.has('font1')).toBe(true);
    expect(ids.has('builtin-strip-overlay-4')).toBe(true);
    expect(
      pruneUnusedAssets(config)
        .assets.map((a) => a.id)
        .sort(),
    ).toEqual(['builtin-strip-overlay-4', 'font1']);
  });
});

describe('payment methods switched off from the booth page', () => {
  it('stays valid when a method keeps its button on the Payment page (the kiosk hides it)', () => {
    const c = fresh();
    c.flow.paymentMethods = ['cash'];
    expect(issuesOf(c)).toEqual([]);
    c.flow.paymentMethods = [];
    c.flow.eventMode = true;
    expect(issuesOf(c)).toEqual([]);
  });
});

describe('migrate v1 → v2: voucher field and keypad become separate elements', () => {
  const v1 = (box: { width: number; height: number }) => {
    const c = JSON.parse(JSON.stringify(fresh())) as Omit<BoothConfig, 'schemaVersion'> & {
      schemaVersion: number;
    };
    const els = c.pages.payment.elements.filter((e) => e.type !== 'voucher-keypad');
    const field = els.find((e) => e.type === 'voucher-input')!;
    Object.assign(field, { x: 960, y: 420, ...box });
    c.pages.payment.elements = els;
    c.schemaVersion = 1;
    return c;
  };

  it('splits a wide, short v1 box into field + keypad beside it (same geometry as v1)', () => {
    const r = migrateBoothConfig(v1({ width: 700, height: 280 }));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.config.schemaVersion).toBe(3);
    const field = r.config.pages.payment.elements.find((e) => e.type === 'voucher-input')!;
    const keypad = r.config.pages.payment.elements.find((e) => e.type === 'voucher-keypad')!;
    // v1: fieldHeight = min(280, 40 × 2.4) = 96; side rows (280 − 24) / 4 = 64;
    // keypad width = min(64 × 7.2 + 16, 700 × 0.55) = 385, beside the field.
    expect(field).toMatchObject({ x: 960, y: 420, width: 700 - 385 - 8, height: 96 });
    expect(keypad).toMatchObject({ x: 960 + 700 - 385, y: 420, width: 385, height: 280, gap: 8 });
  });

  it('keeps a field-only v1 box (too small for keys) as one element', () => {
    const r = migrateBoothConfig(v1({ width: 700, height: 100 }));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.config.pages.payment.elements.some((e) => e.type === 'voucher-keypad')).toBe(false);
  });
});

describe('readable locations in shape errors', () => {
  it('names the section, page and element of a zod issue', () => {
    const old = { ...fresh(), schemaVersion: 1 };
    expect(issuesOf(old)[0]!.message).toBe('Versi skema desain: nilai tidak valid (seharusnya 3)');

    const c = JSON.parse(JSON.stringify(fresh())) as BoothConfig;
    const field = c.pages.payment.elements.find((e) => e.type === 'voucher-input')!;
    (field as { textStyle: { fontSize: number } }).textStyle.fontSize = -5;
    const msg = issuesOf(c)
      .map((i) => i.message)
      .join('\n');
    expect(msg).toContain('Halaman Pembayaran › elemen "Kolom voucher" › gaya teks › ukuran huruf');
  });
});

describe('F8: consent-checkbox + survey-question', () => {
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
    x: 0,
    y: 0,
    width: 600,
    height: 80,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
  };
  const consent = {
    ...base,
    id: 'consent-1',
    name: 'Persetujuan',
    type: 'consent-checkbox' as const,
    label: 'Saya setuju foto disimpan',
    required: true,
    textStyle: text,
    boxSize: 40,
    boxStyle: { borderColor: '#111', borderWidth: 2 },
    checkedStyle: { fill: '#111' },
    checkColor: '#fff',
  };
  const question = {
    ...base,
    id: 'q-1',
    name: 'Pertanyaan',
    type: 'survey-question' as const,
    question: 'Tahu dari mana?',
    options: [
      { id: 'a', label: 'Instagram' },
      { id: 'b', label: 'Teman' },
    ],
    multiple: false,
    required: true,
    layout: 'row' as const,
    columns: 2,
    gap: 12,
    optionTextStyle: text,
    optionStyle: {},
    selectedStyle: { fill: '#111' },
  };

  it('accepts them on Cover, Pilih Frame and Review', () => {
    const c = fresh();
    c.pages.cover.elements.push(consent);
    c.pages.framePick.elements.push({ ...question, id: 'q-2' });
    c.pages.review.elements.push(question);
    expect(issuesOf(c)).toEqual([]);
  });

  it('refuses them on other pages and refuses duplicate option ids', () => {
    const c = fresh();
    c.pages.payment.elements.push(consent);
    c.pages.review.elements.push({
      ...question,
      options: [
        { id: 'a', label: 'Instagram' },
        { id: 'a', label: 'Teman' },
      ],
    });
    const issues = issuesOf(c);
    expect(issues.map((i) => i.code)).toContain('survey-question.option-ids');
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'element.wrong-page',
        path: expect.stringMatching(/^pages\.payment\./),
      }),
    );
  });
});
