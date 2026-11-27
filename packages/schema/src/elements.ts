import { z } from 'zod';
import {
  BoxStyleSchema,
  ColorSchema,
  ElementAnimationSchema,
  IdSchema,
  NonNegative,
  TextStyleSchema,
} from './common';

export const PaymentMethodSchema = z.enum(['qris', 'voucher', 'cash']);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const ButtonActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start') }),
  z.object({ kind: z.literal('next') }),
  z.object({ kind: z.literal('back') }),
  z.object({ kind: z.literal('retake'), shotIndex: z.number().int().min(1).optional() }),
  z.object({ kind: z.literal('retakeAll') }),
  z.object({ kind: z.literal('confirm') }),
  z.object({ kind: z.literal('selectFilter'), filterId: IdSchema }),
  z.object({ kind: z.literal('addPrint') }),
  z.object({ kind: z.literal('removePrint') }),
  z.object({ kind: z.literal('selectPayment'), method: PaymentMethodSchema }),
  z.object({ kind: z.literal('finish') }),
]);
export type ButtonAction = z.infer<typeof ButtonActionSchema>;
export type ButtonActionKind = ButtonAction['kind'];

export const BaseElementSchema = z.object({
  id: IdSchema,
  name: z.string().max(120),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  rotation: z.number().finite(),
  opacity: z.number().min(0).max(1),
  visible: z.boolean(),
  locked: z.boolean(),
  groupId: IdSchema.optional(),
  style: BoxStyleSchema.optional(),
  animation: ElementAnimationSchema.optional(),
});
export type BaseElement = z.infer<typeof BaseElementSchema>;

// --- Static & interactive ---

export const ImageElementSchema = BaseElementSchema.extend({
  type: z.literal('image'),
  assetId: IdSchema,
  fit: z.enum(['cover', 'contain', 'fill']),
});

export const TextElementSchema = BaseElementSchema.extend({
  type: z.literal('text'),
  /** Supports tokens {{price}}, {{boothName}}, {{date}}. */
  content: z.string().max(2000),
  ...TextStyleSchema.shape,
});

export const ShapeElementSchema = BaseElementSchema.extend({
  type: z.literal('shape'),
  shape: z.enum(['rect', 'ellipse', 'line']),
});

export const VideoElementSchema = BaseElementSchema.extend({
  type: z.literal('video'),
  assetId: IdSchema,
  loop: z.boolean(),
  muted: z.boolean(),
});

export const ButtonElementSchema = BaseElementSchema.extend({
  type: z.literal('button'),
  action: ButtonActionSchema,
  label: z.string().max(200).optional(),
  /** Image button: asset drawn instead of the box style. */
  assetId: IdSchema.optional(),
  textStyle: TextStyleSchema.optional(),
  pressedStyle: BoxStyleSchema.optional(),
});

// --- Flow-bound special elements ---

export const CameraViewElementSchema = BaseElementSchema.extend({
  type: z.literal('camera-view'),
  mirror: z.boolean(),
  fit: z.enum(['cover', 'contain']),
  /** Show the crop guide of the slot currently being captured. */
  cropAspect: z.boolean().optional(),
  overlayFrame: z.boolean(),
});

export const PhotoSlotEmptyStyleSchema = BoxStyleSchema.extend({
  showNumber: z.boolean(),
  numberColor: ColorSchema,
  numberFontFamily: z.string().min(1),
  numberFontSize: z.number().positive(),
});

export const PhotoSlotElementSchema = BaseElementSchema.extend({
  type: z.literal('photo-slot'),
  slotIndex: z.number().int().min(1),
  emptyStyle: PhotoSlotEmptyStyleSchema,
  filledStyle: BoxStyleSchema,
  activeStyle: BoxStyleSchema,
  showRetakeButton: z.boolean(),
});

export const CountdownElementSchema = BaseElementSchema.extend({
  type: z.literal('countdown'),
  fontFamily: z.string().min(1),
  fontSize: z.number().positive(),
  color: ColorSchema,
  variant: z.enum(['number', 'ring']),
});

export const FramePickerElementSchema = BaseElementSchema.extend({
  type: z.literal('frame-picker'),
  layout: z.enum(['grid', 'carousel']),
  columns: z.number().int().min(1).max(12),
  gap: NonNegative,
  itemStyle: BoxStyleSchema,
  selectedStyle: BoxStyleSchema,
  showPrice: z.boolean(),
  showName: z.boolean(),
  labelStyle: TextStyleSchema.optional(),
});

export const FramePreviewElementSchema = BaseElementSchema.extend({
  type: z.literal('frame-preview'),
  fit: z.enum(['contain', 'cover']),
});

export const FilterPickerElementSchema = BaseElementSchema.extend({
  type: z.literal('filter-picker'),
  layout: z.enum(['row', 'grid']),
  itemSize: z.number().positive(),
  showLabel: z.boolean(),
  selectedStyle: BoxStyleSchema,
  labelStyle: TextStyleSchema.optional(),
});

export const QrisElementSchema = BaseElementSchema.extend({
  type: z.literal('qris'),
  padding: NonNegative,
  background: ColorSchema,
  showLogo: z.boolean(),
});

export const PriceLabelElementSchema = BaseElementSchema.extend({
  type: z.literal('price-label'),
  /** idr = "Rp 35.000", number = "35.000". */
  format: z.enum(['idr', 'number']),
  ...TextStyleSchema.shape,
});

export const PaymentTimerElementSchema = BaseElementSchema.extend({
  type: z.literal('payment-timer'),
  variant: z.enum(['text', 'bar']),
  textStyle: TextStyleSchema.optional(),
  barColor: ColorSchema.optional(),
  trackColor: ColorSchema.optional(),
});

/**
 * Voucher code entry. `field`: the code field only (schema v2; its keypad is a separate
 * `voucher-keypad` element). `keypad`: field + 3×4 keypad drawn together in one box.
 */
export const VoucherInputElementSchema = BaseElementSchema.extend({
  type: z.literal('voucher-input'),
  variant: z.enum(['keypad', 'field']),
  textStyle: TextStyleSchema,
  keyStyle: BoxStyleSchema.optional(),
});

/** Phone-style 3×4 voucher keypad (1-2-3 / 4-5-6 / 7-8-9 / ⌫-0-✓), placed on its own. */
export const VoucherKeypadElementSchema = BaseElementSchema.extend({
  type: z.literal('voucher-keypad'),
  textStyle: TextStyleSchema,
  keyStyle: BoxStyleSchema.optional(),
  /** Space between keys (artboard px). */
  gap: NonNegative,
});

export const DownloadQrElementSchema = BaseElementSchema.extend({
  type: z.literal('download-qr'),
  padding: NonNegative,
  foreground: ColorSchema,
  background: ColorSchema,
});

export const ProgressElementSchema = BaseElementSchema.extend({
  type: z.literal('progress'),
  variant: z.enum(['bar', 'spinner', 'steps']),
  color: ColorSchema,
  trackColor: ColorSchema.optional(),
});

export const PrintCopiesElementSchema = BaseElementSchema.extend({
  type: z.literal('print-copies'),
  textStyle: TextStyleSchema,
  buttonStyle: BoxStyleSchema.optional(),
});

// --- Buyer responses (F8): consent + survey ---

/**
 * Checkbox the buyer ticks to accept a statement (photo storage, terms). `required`: the page's
 * forward buttons stay disabled until it is ticked. The label is stored with the answer.
 */
export const ConsentCheckboxElementSchema = BaseElementSchema.extend({
  type: z.literal('consent-checkbox'),
  label: z.string().min(1).max(1000),
  required: z.boolean(),
  textStyle: TextStyleSchema,
  /** The square box (artboard px = its side). */
  boxSize: z.number().positive().max(400),
  boxStyle: BoxStyleSchema,
  checkedStyle: BoxStyleSchema,
  checkColor: ColorSchema,
});

export const SurveyOptionSchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(200),
});
export type SurveyOption = z.infer<typeof SurveyOptionSchema>;

/** One multiple-choice question. Text answers are not offered (no on-screen keyboard). */
export const SurveyQuestionElementSchema = BaseElementSchema.extend({
  type: z.literal('survey-question'),
  question: z.string().max(500),
  options: z.array(SurveyOptionSchema).min(1).max(12),
  /** true = any number of options; false = exactly one. */
  multiple: z.boolean(),
  required: z.boolean(),
  layout: z.enum(['row', 'grid', 'column']),
  /** grid only */
  columns: z.number().int().min(1).max(6),
  gap: NonNegative,
  /** Question text; omitted = no question line (the owner draws it as a text element). */
  questionStyle: TextStyleSchema.optional(),
  optionTextStyle: TextStyleSchema,
  optionStyle: BoxStyleSchema,
  selectedStyle: BoxStyleSchema,
});

// --- Send results (F9) ---

export const DeliveryChannelSchema = z.enum(['whatsapp', 'email']);
export type DeliveryChannel = z.infer<typeof DeliveryChannelSchema>;

/**
 * Result page: the buyer types a WhatsApp number (numeric keypad) or an e-mail address
 * (on-screen keyboard) and the download link is sent there. Field, keys and send button are
 * drawn inside the element's box.
 */
export const ContactInputElementSchema = BaseElementSchema.extend({
  type: z.literal('contact-input'),
  channel: DeliveryChannelSchema,
  placeholder: z.string().max(120),
  /** Field text (and status line). */
  textStyle: TextStyleSchema,
  fieldStyle: BoxStyleSchema,
  keyTextStyle: TextStyleSchema,
  keyStyle: BoxStyleSchema,
  submitLabel: z.string().min(1).max(40),
  submitStyle: BoxStyleSchema,
  /** Space between keys (artboard px). */
  gap: NonNegative,
});

export const ElementSchema = z.discriminatedUnion('type', [
  ImageElementSchema,
  TextElementSchema,
  ShapeElementSchema,
  VideoElementSchema,
  ButtonElementSchema,
  CameraViewElementSchema,
  PhotoSlotElementSchema,
  CountdownElementSchema,
  FramePickerElementSchema,
  FramePreviewElementSchema,
  FilterPickerElementSchema,
  QrisElementSchema,
  PriceLabelElementSchema,
  PaymentTimerElementSchema,
  VoucherInputElementSchema,
  VoucherKeypadElementSchema,
  DownloadQrElementSchema,
  ProgressElementSchema,
  PrintCopiesElementSchema,
  ConsentCheckboxElementSchema,
  SurveyQuestionElementSchema,
  ContactInputElementSchema,
]);
export type Element = z.infer<typeof ElementSchema>;
export type ElementType = Element['type'];
export type ElementOf<T extends ElementType> = Extract<Element, { type: T }>;

export const STATIC_ELEMENT_TYPES = [
  'image',
  'text',
  'shape',
  'video',
] as const satisfies readonly ElementType[];

/** Element types that collect a buyer response (stored with the session). */
export const RESPONSE_ELEMENT_TYPES = [
  'consent-checkbox',
  'survey-question',
] as const satisfies readonly ElementType[];
export type ResponseElementType = (typeof RESPONSE_ELEMENT_TYPES)[number];
