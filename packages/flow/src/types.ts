import type { BoothConfig, PageType, PaymentMethod } from '@pb/schema';

/** A stored still, referenced by id. Binary data lives outside the machine (kiosk photo store). */
export type ShotPhoto = {
  id: string;
  /** Displayable URL (object URL, agent URL, ...). */
  url: string;
  width: number;
  height: number;
};

export type Shot = {
  slotIndex: number;
  /** 1 = first take; increments on every retake of the slot. */
  takeNumber: number;
  photo: ShotPhoto;
  /** ISO 8601, UTC. */
  capturedAt: string;
};

export type SessionPaymentMethod = PaymentMethod | 'free';

/**
 * A buyer's answer to a `consent-checkbox` (ticked) or `survey-question` (options picked).
 * Texts are copied from the design so reports stay readable after the owner edits it.
 * Unticked consents and questions left empty have no entry.
 */
export type FlowResponse =
  | {
      kind: 'consent';
      elementId: string;
      page: PageType;
      label: string;
      /** ISO 8601, UTC. */
      answeredAt: string;
    }
  | {
      kind: 'survey';
      elementId: string;
      page: PageType;
      question: string;
      optionIds: string[];
      optionLabels: string[];
      /** ISO 8601, UTC. */
      answeredAt: string;
    };

export type FlowSession = {
  id: string;
  /** 8 chars, see generateSessionCode(). */
  code: string;
  /** ISO 8601, UTC. */
  startedAt: string;
  frameId: string | null;
  /** Free session (event mode or admin): payment is skipped. */
  free: boolean;
  paid: boolean;
  paymentMethod: SessionPaymentMethod | null;
  paymentId: string | null;
  qrString: string | null;
  /** ISO 8601, UTC. */
  paymentExpiresAt: string | null;
  /** Selected take per slot; index = slotIndex - 1. */
  shots: (Shot | null)[];
  /** Every take, including replaced ones (session_shots.take_number). */
  takes: Shot[];
  filterId: string;
  extraPrints: number;
  /** Consent + survey answers (F8); filled from FlowContext.responses when processing starts. */
  responses: FlowResponse[];
  downloadUrl: string | null;
  completedAt: string | null;
};

export type FlowErrorKind = 'camera' | 'payment' | 'processing' | 'unknown';

export type FlowError = {
  kind: FlowErrorKind;
  message: string;
  /** Where a paid session resumes when the buyer leaves the error page. */
  resumeTo: 'capture' | 'processing' | null;
};

export type FlowTimings = {
  /** Interval between countdown numbers. */
  countdownTickMs: number;
  /** How long a fresh shot stays highlighted before the next countdown. */
  shotPreviewMs: number;
  /** Capture page without a next/confirm button: auto-continue after the last shot. */
  captureAutoFinishMs: number;
  /**
   * QRIS expired while the booth was offline: the buyer may have paid without the booth knowing.
   * Keep the Payment page waiting for the network this long before giving up (cancel → Pilih Frame).
   */
  offlinePaymentConfirmMs: number;
  /** Back online after such an expiry: time for the status poll to report `paid` before giving up. */
  paymentVerifyMs: number;
};

export const DEFAULT_FLOW_TIMINGS: FlowTimings = {
  countdownTickMs: 1000,
  shotPreviewMs: 1200,
  captureAutoFinishMs: 3000,
  offlinePaymentConfirmMs: 5 * 60_000,
  paymentVerifyMs: 10_000,
};

export type VoucherStatus =
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

/** Voucher being typed on the Payment page (digits only). */
export type VoucherState = { code: string; status: VoucherStatus };

/** Same as `VOUCHER_CODE_DIGITS` in @pb/crypto (the flow stays free of Node crypto). */
export const VOUCHER_CODE_LENGTH = 8;

export type FlowContext = {
  config: BoothConfig;
  /** API reachable (from the agent). Offline: QRIS is not created/shown; voucher + cash still work. */
  online: boolean;
  voucher: VoucherState;
  /** Applied when the flow next returns to Cover (never mid-session). */
  pendingConfig: BoothConfig | null;
  timings: FlowTimings;
  page: PageType | null;
  session: FlowSession | null;
  slideIndex: number;
  /** Slot currently being captured / highlighted. */
  activeSlot: number | null;
  /** True while re-shooting a single slot. */
  retaking: boolean;
  countdown: number | null;
  /** 0..1 while processing. */
  progress: number | null;
  error: FlowError | null;
  /** Increments on every shot; drives the flash effect. */
  shotCounter: number;
  /**
   * Creating the QRIS failed for a non-network reason (e.g. the owner has not set up Midtrans).
   * The buyer stays on Payment without a QR when voucher or cash is enabled. Reset on every
   * visit to Payment so a fixed setup is picked up.
   */
  qrisUnavailable: boolean;
  /**
   * Consent + survey answers by element id. Kept outside the session because Cover answers come
   * before the session starts; cleared on every return to Cover.
   */
  responses: Record<string, FlowResponse>;
};

export type FlowInput = {
  config: BoothConfig;
  online?: boolean;
  timings?: Partial<FlowTimings>;
};

export type FlowEvent =
  | { type: 'START' }
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'CONFIRM' }
  | { type: 'FINISH' }
  | { type: 'SELECT_FRAME'; frameId: string }
  | { type: 'SELECT_FILTER'; filterId: string }
  | { type: 'SELECT_PAYMENT'; method: PaymentMethod }
  | { type: 'RETAKE'; shotIndex?: number }
  | { type: 'RETAKE_ALL' }
  | { type: 'ADD_PRINT' }
  | { type: 'REMOVE_PRINT' }
  /** Tick / untick a consent-checkbox on the current page. */
  | { type: 'CONSENT.TOGGLE'; elementId: string }
  /** Tap an option of a survey-question on the current page (single: replaces; multiple: toggles). */
  | { type: 'SURVEY.SELECT'; elementId: string; optionId: string }
  /** QRIS settled (paymentId), or cash approved by the operator (method: 'cash'). */
  | { type: 'PAYMENT.PAID'; paymentId?: string; method?: PaymentMethod }
  | { type: 'NETWORK.ONLINE' }
  | { type: 'NETWORK.OFFLINE' }
  | { type: 'VOUCHER.KEY'; key: string }
  | { type: 'VOUCHER.BACKSPACE' }
  | { type: 'VOUCHER.SUBMIT' }
  | { type: 'CASH.CANCEL' }
  | { type: 'PAYMENT.FAILED'; message?: string }
  | { type: 'CAMERA.ERROR'; message?: string }
  | { type: 'PROCESSING.PROGRESS'; progress: number }
  | { type: 'PROCESSING.DONE'; downloadUrl: string }
  | { type: 'PROCESSING.FAILED'; message?: string }
  /** Any buyer touch: restarts the idle timer. */
  | { type: 'ACTIVITY' }
  | { type: 'IDLE.TIMEOUT' }
  /** Unexpected failure reported by the host (render crash, ...). */
  | { type: 'FAIL'; kind?: FlowErrorKind; message: string }
  | { type: 'CONFIG.UPDATE'; config: BoothConfig }
  | { type: 'ADMIN.OPEN' }
  | { type: 'ADMIN.CLOSE' }
  | { type: 'ADMIN.FREE_SESSION' };

// --- Actor contracts (implemented by the host: kiosk, Studio preview, tests) ---

export type CreatePaymentInput = {
  sessionId: string;
  sessionCode: string;
  /** ISO 8601, UTC. */
  startedAt: string;
  boothId: string;
  configVersion: number;
  frameId: string;
  amount: number;
  expirySec: number;
};

/** Thrown by createPayment when the API is unreachable: the page stays, without QRIS. */
export class PaymentOfflineError extends Error {
  readonly offline = true;
  constructor(message = 'API tidak dapat dihubungi') {
    super(message);
    this.name = 'PaymentOfflineError';
  }
}

/**
 * The server already has this session as paid (e.g. the buyer paid a QRIS while the booth was
 * offline and the kiosk gave up waiting). The flow continues to Capture instead of an error.
 */
export class PaymentAlreadyPaidError extends Error {
  readonly alreadyPaid = true;
  constructor(message = 'Sesi ini sudah lunas') {
    super(message);
    this.name = 'PaymentAlreadyPaidError';
  }
}

export type RedeemVoucherInput = {
  code: string;
  sessionId: string;
  sessionCode: string;
  startedAt: string;
  boothId: string;
  configVersion: number;
  amount: number;
};
export type RedeemVoucherOutput =
  | { ok: true; offline: boolean }
  | { ok: false; reason: Exclude<VoucherStatus, 'idle' | 'checking'> };
export type CreatePaymentOutput = {
  paymentId: string;
  qrString: string;
  /** ISO 8601, UTC. */
  expiresAt: string;
};

export type CaptureShotInput = {
  sessionId: string;
  sessionCode: string;
  /** ISO 8601, UTC. */
  startedAt: string;
  boothId: string;
  configVersion: number;
  slotIndex: number;
  takeNumber: number;
};

export type ProcessSessionInput = { config: BoothConfig; session: FlowSession };
