import { composeSheet, composeStrip, encodeImage } from '@pb/compositor';
import type { ProcessingStep } from '@pb/capture/protocol';
import {
  migrateBoothConfig,
  SessionResponsesSchema,
  type BoothConfig,
  type ValidationIssue,
} from '@pb/schema';
import { z } from 'zod';
import type { AssetStore } from './assets';
import type { PrintService } from './print/print-service';
import type { SessionFiles } from './sessions';
import type { AgentStore, LocalFileRow, PrintJobRow } from './store';

export const ProcessRequestSchema = z.object({
  config: z.unknown(),
  session: z.object({
    id: z.string().min(1).max(64),
    code: z.string().regex(/^[A-Z2-9]{8}$/),
    startedAt: z.string(),
    frameId: z.string().min(1),
    filterId: z.string(),
    paymentMethod: z.string().nullable(),
    amount: z.number().int().nonnegative(),
    extraPrints: z.number().int().nonnegative(),
    /** Consent + survey answers (F8). Older kiosks send none. */
    responses: SessionResponsesSchema.default([]),
    downloadUrl: z.string().nullable(),
    /** Selected take per slot. */
    shots: z.array(z.object({ slotIndex: z.number().int().min(1), photoId: z.string() })),
  }),
  print: z.boolean().default(true),
});
export type ProcessRequest = z.infer<typeof ProcessRequestSchema>;

export type ProcessResult = {
  sessionId: string;
  composite: LocalFileRow;
  sheet: LocalFileRow;
  printJob: PrintJobRow | null;
  printError: string | null;
  timings: { composeMs: number; printMs: number; totalMs: number };
};

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly issues?: ValidationIssue[],
  ) {
    super(message);
    this.name = 'ProcessError';
  }
}

/**
 * Processing page: selected originals → strip (frame + crop + filter + dynamic elements) →
 * 4×6 sheet → print. Everything is written to disk before printing; a print failure keeps the
 * session (operator can reprint) and is reported to the kiosk.
 */
export class Processor {
  constructor(
    private readonly store: AgentStore,
    private readonly files: SessionFiles,
    private readonly assets: AssetStore,
    private readonly printer: PrintService,
    private readonly progress: (sessionId: string, step: ProcessingStep, value: number) => void,
  ) {}

  async process(input: ProcessRequest): Promise<ProcessResult> {
    const t0 = performance.now();
    const parsed = migrateBoothConfig(input.config);
    if (!parsed.success) throw new ProcessError('Config sesi tidak valid', parsed.issues);
    const config: BoothConfig = parsed.config;
    const s = input.session;
    const frame = config.frames.find((f) => f.id === s.frameId);
    if (!frame) throw new ProcessError(`Frame ${s.frameId} tidak ada di config`);
    const session = this.store.session(s.id);
    if (!session) throw new ProcessError(`Sesi ${s.code} belum punya foto di agent`);

    this.progress(s.id, 'saving', 0.15);
    const photos: Record<number, string> = {};
    const selectedIds: string[] = [];
    for (const shot of s.shots) {
      const file = this.store.file(shot.photoId);
      if (!file || file.session_id !== s.id || file.kind !== 'original') {
        throw new ProcessError(`Foto slot ${shot.slotIndex} tidak ditemukan di agent`);
      }
      photos[shot.slotIndex] = file.path;
      selectedIds.push(file.id);
    }
    this.store.markSelected(s.id, selectedIds);

    this.progress(s.id, 'composing', 0.3);
    const cameraView = config.pages.capture.elements.find((e) => e.type === 'camera-view');
    const filter = config.filters.find((f) => f.id === s.filterId)?.params ?? null;
    const strip = await composeStrip({
      config,
      frame,
      photos,
      filter,
      mirror: cameraView?.type === 'camera-view' ? cameraView.mirror : false,
      downloadUrl: s.downloadUrl,
      now: new Date(s.startedAt),
      price: s.amount,
      loadAsset: (id) => this.assets.load(config, id),
      seed: hashSeed(s.code),
    });
    const [stripJpeg, sheetJpeg] = await Promise.all([
      encodeImage(strip, 'jpeg', config.printProfile.dpi),
      composeSheet(strip, config.printProfile, 'jpeg'),
    ]);
    const composite = await this.files.saveOutput(
      session,
      'composite',
      `${s.code}-strip.jpg`,
      stripJpeg,
      'image/jpeg',
      strip,
    );
    const sheet = await this.files.saveOutput(
      session,
      'print',
      `${s.code}-sheet.jpg`,
      sheetJpeg,
      'image/jpeg',
      {
        width:
          Math.round(config.printProfile.paper.widthIn * config.printProfile.dpi) +
          config.printProfile.bleedPx * 2,
        height:
          Math.round(config.printProfile.paper.heightIn * config.printProfile.dpi) +
          config.printProfile.bleedPx * 2,
      },
    );
    const t1 = performance.now();

    this.store.completeSession(s.id, {
      frameId: s.frameId,
      filterId: s.filterId,
      paymentMethod: s.paymentMethod,
      amount: s.amount,
      extraPrints: s.extraPrints,
      downloadUrl: s.downloadUrl,
      data: { ...s, configVersion: config.configVersion },
      status: 'completed',
    });
    // Session record for Studio (sent when online; idempotent upsert by session id).
    const local = this.store.session(s.id);
    const method = ['qris', 'voucher', 'cash', 'free'].includes(s.paymentMethod ?? '')
      ? s.paymentMethod
      : null;
    this.store.enqueue('session', {
      id: s.id,
      code: s.code,
      startedAt: s.startedAt,
      completedAt: local?.completed_at ?? new Date().toISOString(),
      status: 'completed',
      frameId: s.frameId,
      filterId: s.filterId || null,
      paymentMethod: method,
      amount: s.amount,
      extraPrints: s.extraPrints,
      responses: s.responses,
      offline: !!local?.offline,
    });

    let printJob: PrintJobRow | null = null;
    let printError: string | null = null;
    if (input.print) {
      this.progress(s.id, 'printing', 0.7);
      try {
        printJob = await this.printer.print({
          file: sheet.path,
          sheets: config.pricing.includedPrints + s.extraPrints,
          profile: config.printProfile,
          sessionId: s.id,
          sessionCode: s.code,
          title: s.code,
        });
      } catch (err) {
        printError = err instanceof Error ? err.message : String(err);
      }
    }
    const t2 = performance.now();
    this.progress(s.id, 'done', 1);
    return {
      sessionId: s.id,
      composite,
      sheet,
      printJob,
      printError,
      timings: {
        composeMs: Math.round(t1 - t0),
        printMs: Math.round(t2 - t1),
        totalMs: Math.round(t2 - t0),
      },
    };
  }
}

function hashSeed(code: string): number {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) h = Math.imul(h ^ code.charCodeAt(i), 16777619);
  return h >>> 0;
}
