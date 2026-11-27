import { z } from 'zod';
import { ADMIN_PIN_HASH_RE } from './admin-pin';
import { ColorSchema, IdSchema, TimezoneSchema } from './common';
import { PaymentMethodSchema } from './elements';
import { FilterSchema } from './filter';
import { FrameSchema, PrintProfileSchema } from './frame';
import { PageSchema, PageTypeSchema } from './page';

export const CURRENT_SCHEMA_VERSION = 3 as const;

export const ArtboardSchema = z.object({
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
  orientation: z.enum(['landscape', 'portrait']),
  scaleMode: z.literal('fit'),
  letterboxColor: ColorSchema,
});
export type Artboard = z.infer<typeof ArtboardSchema>;

export const FlowConfigSchema = z.object({
  tutorialEnabled: z.boolean(),
  reviewEnabled: z.boolean(),
  /** true = no payment */
  eventMode: z.boolean(),
  paymentMethods: z.array(PaymentMethodSchema),
  shotCountdownSec: z.number().int().min(0).max(30),
  autoAdvanceBetweenShots: z.boolean(),
  /** null = unlimited */
  maxRetakesPerShot: z.number().int().nonnegative().nullable(),
  idleTimeoutSec: z.partialRecord(PageTypeSchema, z.number().int().positive()),
  resultAutoReturnSec: z.number().int().positive(),
  qrisExpirySec: z.number().int().min(60).max(3600),
});
export type FlowConfig = z.infer<typeof FlowConfigSchema>;

export const PricingSchema = z.object({
  currency: z.literal('IDR'),
  /** Used when the frame has no price of its own. */
  basePrice: z.number().int().nonnegative(),
  /** Sheets included (1 sheet = 2 strips). */
  includedPrints: z.number().int().min(0).max(10),
  /** null = extra prints not sold */
  extraPrintPrice: z.number().int().nonnegative().nullable(),
  maxExtraPrints: z.number().int().min(0).max(20),
});
export type Pricing = z.infer<typeof PricingSchema>;

export const OutputConfigSchema = z.object({
  gif: z.object({
    enabled: z.boolean(),
    frameDelayMs: z.number().int().min(50).max(5000),
    width: z.number().int().min(100).max(2000),
  }),
  video: z.object({
    enabled: z.boolean(),
    photoPick: z.enum(['random', 'first', 'buyer']),
    photoCount: z.literal(3),
    secondsPerPhoto: z.number().positive().max(10),
    resolution: z.object({ width: z.literal(1080), height: z.literal(1920) }),
    backgroundAssetId: IdSchema.optional(),
    musicAssetId: IdSchema.optional(),
  }),
  /** Default: booth name. */
  driveRootFolderName: z.string().min(1).max(200),
  /** Controlled by plan. */
  watermark: z.boolean(),
});
export type OutputConfig = z.infer<typeof OutputConfigSchema>;

export const AssetRefSchema = z.object({
  id: IdSchema,
  kind: z.enum(['image', 'video', 'font', 'audio']),
  url: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 harus 64 karakter hex huruf kecil'),
  bytes: z.number().int().nonnegative(),
});
export type AssetRef = z.infer<typeof AssetRefSchema>;

const PagesSchema = z.record(PageTypeSchema, PageSchema);

export const BoothConfigSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  /** Incremented on every publish. 0 = never published (draft). */
  configVersion: z.number().int().nonnegative(),
  boothId: IdSchema,
  locale: z.enum(['id', 'en']),
  timezone: TimezoneSchema,
  artboard: ArtboardSchema,
  flow: FlowConfigSchema,
  pricing: PricingSchema,
  /** One page per type. */
  pages: PagesSchema,
  frames: z.array(FrameSchema),
  filters: z.array(FilterSchema),
  printProfile: PrintProfileSchema,
  output: OutputConfigSchema,
  /** Every file a device must cache. */
  assets: z.array(AssetRefSchema),
  admin: z.object({
    /** Empty string = PIN not set; kiosk must refuse admin mode until one is set. */
    /** Format: see admin-pin.ts (`pbkdf2-sha256$<iter>$<salt>$<hash>`). */
    pinHash: z.union([
      z.literal(''),
      z.string().regex(ADMIN_PIN_HASH_RE, 'Format hash PIN admin tidak dikenal'),
    ]),
  }),
});
export type BoothConfig = z.infer<typeof BoothConfigSchema>;
