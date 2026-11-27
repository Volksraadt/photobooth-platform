import type { BoothConfig, ButtonAction, Frame, Filter } from '@pb/schema';

/**
 * `live`: interactive, real data (Kiosk, Studio preview).
 * `editor`: no interaction, no animation, placeholders for flow-bound elements (Studio canvas).
 */
export type RenderMode = 'live' | 'editor';

/** What the renderer asks its host to do. Superset of ButtonAction (pickers emit selectFrame). */
export type RendererAction =
  | ButtonAction
  | { kind: 'selectFrame'; frameId: string }
  // voucher-input (F4): keypad taps, physical keyboard / barcode scanner
  | { kind: 'voucherKey'; key: string }
  | { kind: 'voucherBackspace' }
  | { kind: 'voucherSubmit' }
  // consent-checkbox / survey-question (F8)
  | { kind: 'toggleConsent'; elementId: string }
  | { kind: 'selectOption'; elementId: string; optionId: string }
  // contact-input (F9)
  | { kind: 'contactKey'; elementId: string; key: string }
  | { kind: 'contactBackspace'; elementId: string }
  | { kind: 'contactSubmit'; elementId: string };

export type ContactRuntimeStatus = 'idle' | 'invalid' | 'sending' | 'sent' | 'error' | 'limit';

export type VoucherRuntimeStatus =
  | 'idle'
  | 'checking'
  | 'invalid'
  | 'used'
  | 'expired'
  | 'insufficient'
  /** Offline, and the owner did not allow offline vouchers for this booth. */
  | 'needs_online'
  /** Too many wrong codes on this device; try again later. */
  | 'locked'
  | 'error';

export type RuntimePhoto = { url: string };

export type CameraRuntime = {
  stream: MediaStream | null;
  status?: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
};

/**
 * Live data for flow-bound elements. Everything is optional: a missing value renders a neutral
 * placeholder (live) or sample data (editor).
 */
export type RenderRuntime = {
  /** {{boothName}} */
  boothName?: string;
  /** {{date}}; defaults to now. */
  now?: Date;
  /** price-label and {{price}} (IDR). */
  price?: number;

  /** Tutorial: which slide is shown. */
  slideIndex?: number;

  // Capture
  camera?: CameraRuntime;
  /** Slot highlighted with activeStyle / used for the crop guide. */
  activeSlotIndex?: number | null;
  /** Selected take per slot index (1-based). */
  shots?: Partial<Record<number, RuntimePhoto>>;
  /** Number shown by `countdown`; null = hidden. */
  countdown?: number | null;
  /** Total countdown seconds, for the ring variant. */
  countdownTotal?: number;
  /** Changes on every shot; triggers the flash on camera-view. */
  flashKey?: number;
  /** Mirror shots like the camera preview (what the buyer saw). */
  mirrorShots?: boolean;

  // Frame & filter
  frames?: Frame[];
  selectedFrameId?: string | null;
  filters?: Filter[];
  selectedFilterId?: string | null;

  // Payment
  qrisString?: string | null;
  /** Epoch ms when the QRIS expires. */
  paymentExpiresAt?: number | null;
  paymentTotalSec?: number;
  voucherCode?: string;
  voucherStatus?: VoucherRuntimeStatus;
  /** Live: QRIS unavailable (device offline / not enabled): qris + payment-timer are not drawn. */
  qrisHidden?: boolean;

  // Review / processing / result
  printSheets?: number;
  /** 0..1; null = indeterminate. */
  progress?: number | null;
  downloadUrl?: string | null;

  // Consent + survey (F8)
  /** Element ids of ticked consent-checkbox elements. */
  checkedConsents?: readonly string[];
  /** Picked option ids per survey-question element id. */
  surveyAnswers?: Readonly<Record<string, readonly string[]>>;

  // Send results (F9)
  /** What was typed into each contact-input, by element id. */
  contacts?: Readonly<Record<string, { value: string; status: ContactRuntimeStatus }>>;

  /** Disabled actions render dimmed and ignore taps. Defaults to all enabled. */
  canAction?: (action: RendererAction) => boolean;
};

export type AssetUrlResolver = (assetId: string) => string | undefined;

export type RendererContextValue = {
  config: BoothConfig;
  runtime: RenderRuntime;
  mode: RenderMode;
  resolveAsset: AssetUrlResolver;
  onAction: (action: RendererAction) => void;
};
