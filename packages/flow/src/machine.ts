import { createId } from '@paralleldrive/cuid2';
import { generateSessionCode, type PageType } from '@pb/schema';
import {
  and,
  assign,
  not,
  enqueueActions,
  fromCallback,
  fromPromise,
  setup,
  type ActorRefFrom,
  type AnyEventObject,
  type SnapshotFrom,
} from 'xstate';
import {
  applyResponse,
  defaultFilterId,
  findFrame,
  idleTimeoutMs,
  pageHasButton,
  pageResponsesComplete,
  paymentAmount,
  slotCount,
} from './helpers';
import {
  DEFAULT_FLOW_TIMINGS,
  type CaptureShotInput,
  type CreatePaymentInput,
  type CreatePaymentOutput,
  type FlowContext,
  type FlowError,
  type FlowErrorKind,
  type FlowEvent,
  type FlowInput,
  type FlowSession,
  type ProcessSessionInput,
  type RedeemVoucherInput,
  type RedeemVoucherOutput,
  type Shot,
  VOUCHER_CODE_LENGTH,
  type ShotPhoto,
} from './types';

const notProvided = (name: string) => () => {
  throw new Error(`[flow] actor "${name}" is not provided; use machine.provide()`);
};

function errorMessage(event: AnyEventObject, fallback: string): string {
  if (typeof event.message === 'string' && event.message) return event.message;
  const err: unknown = event.error;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

const lastShotSlot = (session: FlowSession): number | null => {
  const last = session.takes.at(-1);
  return last && session.shots[last.slotIndex - 1] ? last.slotIndex : null;
};

const retakesUsed = (session: FlowSession, slotIndex: number) =>
  Math.max(0, session.takes.filter((t) => t.slotIndex === slotIndex).length - 1);

const retakeAllowed = (ctx: FlowContext, slotIndex: number): boolean => {
  const session = ctx.session;
  if (!session?.shots[slotIndex - 1]) return false;
  const max = ctx.config.flow.maxRetakesPerShot;
  return max === null || retakesUsed(session, slotIndex) < max;
};

const firstEmptySlot = (session: FlowSession | null): number | null => {
  if (!session) return null;
  const i = session.shots.findIndex((s) => s === null);
  return i === -1 ? null : i + 1;
};

const allFilled = (session: FlowSession | null) =>
  !!session && session.shots.length > 0 && session.shots.every((s) => s !== null);

const responseInput = (event: Extract<FlowEvent, { type: 'CONSENT.TOGGLE' | 'SURVEY.SELECT' }>) =>
  event.type === 'SURVEY.SELECT'
    ? { elementId: event.elementId, optionId: event.optionId }
    : { elementId: event.elementId };

const updateSession = (ctx: FlowContext, patch: Partial<FlowSession>): FlowSession | null =>
  ctx.session ? { ...ctx.session, ...patch } : null;

function newSession(context: FlowContext, free: boolean): Partial<FlowContext> {
  const session: FlowSession = {
    id: createId(),
    code: generateSessionCode(),
    startedAt: new Date().toISOString(),
    frameId: null,
    free: free || context.config.flow.eventMode,
    paid: false,
    paymentMethod: null,
    paymentId: null,
    qrString: null,
    paymentExpiresAt: null,
    shots: [],
    takes: [],
    filterId: defaultFilterId(context.config),
    extraPrints: 0,
    responses: [],
    downloadUrl: null,
    completedAt: null,
  };
  return {
    session,
    voucher: { code: '', status: 'idle' },
    slideIndex: 0,
    activeSlot: null,
    retaking: false,
    countdown: null,
    progress: null,
    error: null,
  };
}

const ERROR_FALLBACK: Record<FlowErrorKind, string> = {
  camera: 'Kamera bermasalah.',
  payment: 'Pembayaran gagal.',
  processing: 'Gagal memproses foto.',
  unknown: 'Terjadi kesalahan.',
};

function errorPatch(
  context: FlowContext,
  event: AnyEventObject,
  defaultKind: FlowErrorKind,
): Partial<FlowContext> {
  const kind: FlowErrorKind =
    event.type === 'FAIL' && typeof event.kind === 'string'
      ? (event.kind as FlowErrorKind)
      : defaultKind;
  // A paid session is never dropped: leaving the error page resumes it.
  const resumeTo: FlowError['resumeTo'] = !context.session?.paid
    ? null
    : kind === 'processing'
      ? 'processing'
      : 'capture';
  return {
    error: { kind, message: errorMessage(event, ERROR_FALLBACK[kind]), resumeTo },
    countdown: null,
  };
}

/**
 * Buyer flow: cover → tutorial → framePick → payment → capture → review → processing → result → cover,
 * plus error and admin. See docs/architecture.md §3.3.
 *
 * Host-provided actors: connectCamera, captureShot, createPayment, processSession.
 * Host-provided actions (optional): cancelPayment, onSessionEnd.
 */
export const flowMachine = setup({
  types: {
    context: {} as FlowContext,
    events: {} as FlowEvent,
    input: {} as FlowInput,
  },
  actors: {
    connectCamera: fromPromise<void, { sessionId: string }>(notProvided('connectCamera')),
    captureShot: fromPromise<ShotPhoto, CaptureShotInput>(notProvided('captureShot')),
    createPayment: fromPromise<CreatePaymentOutput, CreatePaymentInput>(
      notProvided('createPayment'),
    ),
    redeemVoucher: fromPromise<RedeemVoucherOutput, RedeemVoucherInput>(
      notProvided('redeemVoucher'),
    ),
    processSession: fromCallback<FlowEvent, ProcessSessionInput>(({ sendBack }) => {
      sendBack({ type: 'PROCESSING.FAILED', message: 'processSession is not provided' });
    }),
  },
  delays: {
    countdownTick: ({ context }) => context.timings.countdownTickMs,
    shotPreview: ({ context }) => context.timings.shotPreviewMs,
    captureAutoFinish: ({ context }) => context.timings.captureAutoFinishMs,
    slideDuration: ({ context }) => {
      const slide = context.config.pages.tutorial.slides?.[context.slideIndex];
      return (slide?.durationSec ?? 0) * 1000;
    },
    paymentExpiry: ({ context }) => {
      const at = context.session?.paymentExpiresAt;
      return at
        ? Math.max(0, Date.parse(at) - Date.now())
        : context.config.flow.qrisExpirySec * 1000;
    },
    resultReturn: ({ context }) => context.config.flow.resultAutoReturnSec * 1000,
    offlinePaymentConfirm: ({ context }) => context.timings.offlinePaymentConfirmMs,
    paymentVerify: ({ context }) => context.timings.paymentVerifyMs,
  },
  guards: {
    tutorialEnabled: ({ context }) => context.config.flow.tutorialEnabled,
    reviewEnabled: ({ context }) => context.config.flow.reviewEnabled,
    qrisEnabled: ({ context }) => context.config.flow.paymentMethods.includes('qris'),
    voucherEnabled: ({ context }) => context.config.flow.paymentMethods.includes('voucher'),
    voucherReady: ({ context }) =>
      context.config.flow.paymentMethods.includes('voucher') &&
      context.voucher.code.length === VOUCHER_CODE_LENGTH,
    selectsCash: ({ context, event }) =>
      event.type === 'SELECT_PAYMENT' &&
      event.method === 'cash' &&
      context.config.flow.paymentMethods.includes('cash'),
    isOnline: ({ context }) => context.online,
    qrisUnavailable: ({ context }) => context.qrisUnavailable,
    hasNonQrisMethod: ({ context }) =>
      context.config.flow.paymentMethods.some((m) => m === 'voucher' || m === 'cash'),
    offlineError: ({ event }) =>
      (event as { error?: { offline?: unknown } }).error?.offline === true,
    alreadyPaidError: ({ event }) =>
      (event as { error?: { alreadyPaid?: unknown } }).error?.alreadyPaid === true,
    voucherAccepted: ({ event }) => (event as { output?: RedeemVoucherOutput }).output?.ok === true,
    slideTimed: ({ context }) =>
      context.config.pages.tutorial.slides?.[context.slideIndex]?.durationSec !== undefined,
    hasNextSlide: ({ context }) =>
      context.slideIndex + 1 < (context.config.pages.tutorial.slides?.length ?? 0),
    hasFrame: ({ context }) => !!findFrame(context.config, context.session?.frameId ?? null),
    skipPayment: ({ context }) => context.config.flow.eventMode || !!context.session?.free,
    validFrame: ({ context, event }) =>
      event.type === 'SELECT_FRAME' && !!findFrame(context.config, event.frameId),
    validFilter: ({ context, event }) =>
      event.type === 'SELECT_FILTER' &&
      context.config.filters.some((f) => f.id === event.filterId && f.enabled),
    paymentMethodEnabled: ({ context, event }) =>
      event.type === 'SELECT_PAYMENT' && context.config.flow.paymentMethods.includes(event.method),
    paymentMatches: ({ context, event }) =>
      event.type === 'PAYMENT.PAID' &&
      (event.method === 'cash'
        ? context.config.flow.paymentMethods.includes('cash')
        : !event.paymentId || event.paymentId === context.session?.paymentId),
    hasQr: ({ context }) => !!context.session?.qrString,
    allFilled: ({ context }) => allFilled(context.session),
    retaking: ({ context }) => context.retaking,
    continueAuto: ({ context }) =>
      !context.retaking &&
      context.config.flow.autoAdvanceBetweenShots &&
      !allFilled(context.session),
    captureWithoutExitButton: ({ context }) =>
      !pageHasButton(context.config, 'capture', ['next', 'confirm']),
    canRetake: ({ context, event }) => {
      if (event.type !== 'RETAKE' || !context.session) return false;
      const slot = event.shotIndex ?? lastShotSlot(context.session);
      return slot !== null && retakeAllowed(context, slot);
    },
    canRetakeAll: ({ context }) =>
      !!context.session &&
      context.session.shots.some((s) => s !== null) &&
      context.session.shots.every((s, i) => s === null || retakeAllowed(context, i + 1)),
    canAddPrint: ({ context }) =>
      context.config.pricing.extraPrintPrice !== null &&
      // Event mode is free: nothing could collect the money for extra sheets.
      !context.config.flow.eventMode &&
      (context.session?.extraPrints ?? 0) < context.config.pricing.maxExtraPrints,
    canRemovePrint: ({ context }) => (context.session?.extraPrints ?? 0) > 0,
    unpaid: ({ context }) => !context.session?.paid,
    /** Required consents / questions of the current page are answered (F8). */
    responsesComplete: ({ context }) =>
      pageResponsesComplete(context.config, context.page, context.responses),
    validResponse: ({ context, event }) =>
      (event.type === 'CONSENT.TOGGLE' || event.type === 'SURVEY.SELECT') &&
      applyResponse(context.config, context.page, context.responses, responseInput(event), '') !==
        null,
    resumeCapture: ({ context }) =>
      !!context.session?.paid && context.error?.resumeTo === 'capture',
    resumeProcessing: ({ context }) =>
      !!context.session?.paid && context.error?.resumeTo === 'processing',
  },
  actions: {
    /** Host hook: cancel a pending QRIS at the provider. Reads context.session.paymentId. */
    cancelPayment: () => {},
    /** Host hook: called with the session that is about to be discarded (completed or abandoned). */
    onSessionEnd: () => {},

    restartIdle: enqueueActions(({ context, enqueue }) => {
      enqueue.cancel('idle');
      const ms = idleTimeoutMs(context.config, context.page);
      if (ms !== null) enqueue.raise({ type: 'IDLE.TIMEOUT' }, { id: 'idle', delay: ms });
    }),
    recordResponse: assign(({ context, event }) => {
      if (event.type !== 'CONSENT.TOGGLE' && event.type !== 'SURVEY.SELECT') return {};
      const next = applyResponse(
        context.config,
        context.page,
        context.responses,
        responseInput(event),
        new Date().toISOString(),
      );
      return next ? { responses: next } : {};
    }),
    startSession: assign(({ context }) => newSession(context, false)),
    startFreeSession: assign(({ context }) => newSession(context, true)),
    endSession: enqueueActions(({ context, enqueue }) => {
      if (!context.session) return;
      if (context.session.paymentId && !context.session.paid) enqueue('cancelPayment');
      enqueue('onSessionEnd');
      enqueue.assign({
        session: null,
        responses: {},
        activeSlot: null,
        retaking: false,
        countdown: null,
        progress: null,
        error: null,
      });
    }),
    applyPendingConfig: assign(({ context }) =>
      context.pendingConfig ? { config: context.pendingConfig, pendingConfig: null } : {},
    ),
    preselectSingleFrame: assign(({ context }) => {
      const frames = context.config.frames.filter((f) => f.enabled);
      if (context.session && !context.session.frameId && frames.length === 1) {
        return { session: updateSession(context, { frameId: frames[0]!.id }) };
      }
      return {};
    }),
    prepareShots: assign(({ context }) => {
      const n = slotCount(context.config, context.session);
      const shots = context.session?.shots ?? [];
      if (shots.length === n) return {};
      return { session: updateSession(context, { shots: Array.from({ length: n }, () => null) }) };
    }),
    markFree: assign(({ context }) => ({
      session: updateSession(context, { paid: true, paymentMethod: 'free' }),
    })),
    releasePayment: enqueueActions(({ context, enqueue }) => {
      if (context.session?.paymentId && !context.session.paid) enqueue('cancelPayment');
      enqueue.assign({
        session: updateSession(context, {
          paymentId: null,
          qrString: null,
          paymentExpiresAt: null,
        }),
      });
    }),
    /** Paid by QRIS or cash. Paying another way cancels a pending QRIS first. */
    markPaid: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'PAYMENT.PAID' || !context.session) return;
      const method = event.method ?? 'qris';
      if (method !== 'qris' && context.session.paymentId && !context.session.paid) {
        enqueue('cancelPayment');
      }
      enqueue.assign({
        session: updateSession(context, {
          paid: true,
          paymentMethod: method,
          ...(method !== 'qris' ? { paymentId: null, qrString: null, paymentExpiresAt: null } : {}),
        }),
        voucher: { code: '', status: 'idle' },
      });
    }),
    /** The server reports the session as already paid (QRIS confirmed while we were offline). */
    markAlreadyPaid: assign(({ context }) => ({
      session: updateSession(context, {
        paid: true,
        paymentMethod: context.session?.paymentMethod ?? 'qris',
        qrString: null,
        paymentExpiresAt: null,
      }),
      voucher: { code: '', status: 'idle' as const },
    })),
    stopIdle: enqueueActions(({ enqueue }) => enqueue.cancel('idle')),
    markVoucherPaid: assign(({ context }) => ({
      session: updateSession(context, { paid: true, paymentMethod: 'voucher' }),
      voucher: { code: '', status: 'idle' as const },
    })),
    voucherKey: assign(({ context, event }) => {
      if (event.type !== 'VOUCHER.KEY' || !/^\d$/.test(event.key)) return {};
      if (context.voucher.code.length >= VOUCHER_CODE_LENGTH) return {};
      return { voucher: { code: context.voucher.code + event.key, status: 'idle' as const } };
    }),
    voucherBackspace: assign(({ context }) => ({
      voucher: { code: context.voucher.code.slice(0, -1), status: 'idle' as const },
    })),
    setOnline: assign({ online: true }),
    setOffline: assign({ online: false }),
    activateNextSlot: assign(({ context }) => ({
      activeSlot: firstEmptySlot(context.session),
      retaking: false,
    })),
    highlightNext: assign(({ context }) => ({
      activeSlot: firstEmptySlot(context.session),
      retaking: false,
      countdown: null,
    })),
    startCountdown: assign(({ context }) => ({ countdown: context.config.flow.shotCountdownSec })),
    tickCountdown: assign(({ context }) => ({ countdown: (context.countdown ?? 1) - 1 })),
    beginRetake: assign(({ context, event }) => {
      if (event.type !== 'RETAKE' || !context.session) return {};
      return { activeSlot: event.shotIndex ?? lastShotSlot(context.session), retaking: true };
    }),
    beginRetakeAll: assign(({ context }) => ({
      session: updateSession(context, {
        shots: (context.session?.shots ?? []).map(() => null),
      }),
      activeSlot: 1,
      retaking: false,
    })),
    setCameraError: assign(({ context, event }) => errorPatch(context, event, 'camera')),
    setPaymentError: assign(({ context, event }) => errorPatch(context, event, 'payment')),
    setProcessingError: assign(({ context, event }) => errorPatch(context, event, 'processing')),
    setUnknownError: assign(({ context, event }) => errorPatch(context, event, 'unknown')),
  },
}).createMachine({
  id: 'flow',
  context: ({ input }) => ({
    config: input.config,
    online: input.online ?? true,
    voucher: { code: '', status: 'idle' },
    pendingConfig: null,
    timings: { ...DEFAULT_FLOW_TIMINGS, ...input.timings },
    page: null,
    session: null,
    slideIndex: 0,
    activeSlot: null,
    retaking: false,
    countdown: null,
    progress: null,
    error: null,
    shotCounter: 0,
    qrisUnavailable: false,
    responses: {},
  }),
  initial: 'cover',
  on: {
    ACTIVITY: { actions: 'restartIdle' },
    'NETWORK.ONLINE': { actions: 'setOnline' },
    'NETWORK.OFFLINE': { actions: 'setOffline' },
    // Before payment, idle returns to Cover. After payment, states handle it themselves (continue).
    'IDLE.TIMEOUT': { guard: 'unpaid', target: '.cover' },
    FAIL: { target: '.error', actions: 'setUnknownError' },
    'CONFIG.UPDATE': { actions: assign(({ event }) => ({ pendingConfig: event.config })) },
    'ADMIN.OPEN': { guard: 'unpaid', target: '.admin' },
    // Only acts on elements of the current page (validResponse), so other pages ignore it.
    'CONSENT.TOGGLE': { guard: 'validResponse', actions: ['recordResponse', 'restartIdle'] },
    'SURVEY.SELECT': { guard: 'validResponse', actions: ['recordResponse', 'restartIdle'] },
  },
  states: {
    cover: {
      entry: [
        'endSession',
        'applyPendingConfig',
        assign({ page: 'cover' as PageType | null }),
        'restartIdle',
      ],
      on: {
        START: [
          {
            guard: and(['responsesComplete', 'tutorialEnabled']),
            target: 'tutorial',
            actions: 'startSession',
          },
          { guard: 'responsesComplete', target: 'framePick', actions: 'startSession' },
        ],
        NEXT: [
          {
            guard: and(['responsesComplete', 'tutorialEnabled']),
            target: 'tutorial',
            actions: 'startSession',
          },
          { guard: 'responsesComplete', target: 'framePick', actions: 'startSession' },
        ],
        'CONFIG.UPDATE': {
          actions: [
            assign(({ event }) => ({ config: event.config, pendingConfig: null })),
            'restartIdle',
          ],
        },
      },
    },

    tutorial: {
      entry: [
        assign({ slideIndex: 0 }),
        assign({ page: 'tutorial' as PageType | null }),
        'restartIdle',
      ],
      initial: 'route',
      states: {
        route: { always: [{ guard: 'slideTimed', target: 'timed' }, { target: 'untimed' }] },
        timed: { after: { slideDuration: { target: 'advance' } } },
        untimed: {},
        advance: {
          always: [
            {
              guard: 'hasNextSlide',
              target: 'route',
              actions: assign(({ context }) => ({ slideIndex: context.slideIndex + 1 })),
            },
            { target: '#flow.framePick' },
          ],
        },
      },
      on: {
        NEXT: '.advance',
        START: 'framePick',
        CONFIRM: 'framePick',
        BACK: 'cover',
      },
    },

    framePick: {
      entry: [
        assign({ page: 'framePick' as PageType | null }),
        'restartIdle',
        'preselectSingleFrame',
      ],
      on: {
        SELECT_FRAME: {
          guard: 'validFrame',
          actions: assign(({ context, event }) => ({
            session: updateSession(context, { frameId: event.frameId }),
          })),
        },
        // Extra prints are chosen before Payment so they are paid with the frame (open-questions
        // #16): Review only shows the number of sheets.
        ADD_PRINT: {
          guard: 'canAddPrint',
          actions: assign(({ context }) => ({
            session: updateSession(context, {
              extraPrints: (context.session?.extraPrints ?? 0) + 1,
            }),
          })),
        },
        REMOVE_PRINT: {
          guard: 'canRemovePrint',
          actions: assign(({ context }) => ({
            session: updateSession(context, {
              extraPrints: (context.session?.extraPrints ?? 0) - 1,
            }),
          })),
        },
        NEXT: [
          {
            guard: and(['hasFrame', 'responsesComplete', 'skipPayment']),
            target: 'capture',
            actions: ['prepareShots', 'markFree'],
          },
          {
            guard: and(['hasFrame', 'responsesComplete']),
            target: 'payment',
            actions: 'prepareShots',
          },
        ],
        CONFIRM: [
          {
            guard: and(['hasFrame', 'responsesComplete', 'skipPayment']),
            target: 'capture',
            actions: ['prepareShots', 'markFree'],
          },
          {
            guard: and(['hasFrame', 'responsesComplete']),
            target: 'payment',
            actions: 'prepareShots',
          },
        ],
        BACK: [{ guard: 'tutorialEnabled', target: 'tutorial' }, { target: 'cover' }],
      },
    },

    payment: {
      entry: [
        assign({ page: 'payment' as PageType | null, qrisUnavailable: false }),
        'restartIdle',
      ],
      initial: 'route',
      states: {
        // Offline: no QRIS (it could not be confirmed); voucher + cash still work.
        route: {
          always: [
            { guard: and(['qrisEnabled', 'isOnline']), target: 'creating' },
            { target: 'awaiting' },
          ],
        },
        creating: {
          invoke: {
            src: 'createPayment',
            input: ({ context }) => ({
              sessionId: context.session!.id,
              sessionCode: context.session!.code,
              startedAt: context.session!.startedAt,
              boothId: context.config.boothId,
              configVersion: context.config.configVersion,
              frameId: context.session!.frameId ?? '',
              amount: paymentAmount(context.config, context.session),
              expirySec: context.config.flow.qrisExpirySec,
            }),
            onDone: {
              target: 'awaiting',
              actions: assign(({ context, event }) => ({
                session: updateSession(context, {
                  paymentId: event.output.paymentId,
                  qrString: event.output.qrString,
                  paymentExpiresAt: event.output.expiresAt,
                  paymentMethod: 'qris',
                }),
              })),
            },
            onError: [
              // The server already has this session as paid: continue, never charge twice.
              { guard: 'alreadyPaidError', target: '#flow.capture', actions: 'markAlreadyPaid' },
              // Went offline while creating: stay on Payment without QRIS.
              { guard: 'offlineError', target: 'awaiting', actions: 'setOffline' },
              // QRIS cannot be created (e.g. Midtrans not set up): voucher/cash still work.
              {
                guard: 'hasNonQrisMethod',
                target: 'awaiting',
                actions: assign({ qrisUnavailable: true }),
              },
              { target: '#flow.error', actions: 'setPaymentError' },
            ],
          },
        },
        awaiting: {
          after: {
            paymentExpiry: [
              // Offline: the buyer may have paid and we cannot know yet. Wait for the network.
              { guard: and(['hasQr', not('isOnline')]), target: 'confirming' },
              // QRIS expired without payment: cancel and let the buyer start the payment again.
              { guard: 'hasQr', target: '#flow.framePick', actions: 'releasePayment' },
            ],
          },
          on: {
            // Back online without a QR: create it now.
            'NETWORK.ONLINE': [
              {
                guard: and(['qrisEnabled', not('hasQr'), not('qrisUnavailable')]),
                target: 'creating',
                actions: 'setOnline',
              },
              { actions: 'setOnline' },
            ],
            'VOUCHER.SUBMIT': { guard: 'voucherReady', target: 'checkingVoucher' },
            SELECT_PAYMENT: [
              { guard: 'selectsCash', target: 'cash' },
              {
                guard: 'paymentMethodEnabled',
                actions: assign(({ context, event }) => ({
                  session: updateSession(context, { paymentMethod: event.method }),
                })),
              },
            ],
          },
        },
        checkingVoucher: {
          entry: assign(({ context }) => ({
            voucher: { code: context.voucher.code, status: 'checking' as const },
          })),
          invoke: {
            src: 'redeemVoucher',
            input: ({ context }) => ({
              code: context.voucher.code,
              sessionId: context.session!.id,
              sessionCode: context.session!.code,
              startedAt: context.session!.startedAt,
              boothId: context.config.boothId,
              configVersion: context.config.configVersion,
              amount: paymentAmount(context.config, context.session),
            }),
            onDone: [
              {
                guard: 'voucherAccepted',
                target: '#flow.capture',
                // A pending QRIS is cancelled; the voucher pays the session.
                actions: ['releasePayment', 'markVoucherPaid'],
              },
              {
                target: 'awaiting',
                actions: assign(({ event }) => ({
                  voucher: {
                    code: '',
                    status: event.output.ok ? ('idle' as const) : event.output.reason,
                  },
                })),
              },
            ],
            onError: {
              target: 'awaiting',
              actions: assign({ voucher: { code: '', status: 'error' as const } }),
            },
          },
          // While checking: typing and Back are ignored (the redeem may already be recorded).
          on: { 'VOUCHER.KEY': {}, 'VOUCHER.BACKSPACE': {}, BACK: {} },
        },
        /**
         * QRIS expired while offline. The QR stays hidden; PAYMENT.PAID (agent push / poll) still
         * moves on to Capture. Back online → `verifying`; offline too long → give up.
         * No idle timeout here: idle would cancel a QRIS the buyer may already have paid.
         */
        confirming: {
          entry: 'stopIdle',
          after: {
            offlinePaymentConfirm: { target: '#flow.framePick', actions: 'releasePayment' },
          },
          on: {
            'NETWORK.ONLINE': { target: 'verifying', actions: 'setOnline' },
            ACTIVITY: {},
          },
        },
        /** Online again: the status poll gets this long to report `paid`. */
        verifying: {
          entry: 'stopIdle',
          after: {
            paymentVerify: { target: '#flow.framePick', actions: 'releasePayment' },
          },
          on: { 'NETWORK.OFFLINE': { target: 'confirming', actions: 'setOffline' }, ACTIVITY: {} },
        },
        // Waiting for the operator's PIN (the kiosk shows the system PIN pad).
        cash: {
          on: {
            'CASH.CANCEL': 'awaiting',
            SELECT_PAYMENT: { guard: 'paymentMethodEnabled', target: 'awaiting' },
          },
        },
      },
      on: {
        'PAYMENT.PAID': { guard: 'paymentMatches', target: 'capture', actions: 'markPaid' },
        'PAYMENT.FAILED': {
          target: 'error',
          actions: ['releasePayment', 'setPaymentError'],
        },
        SELECT_PAYMENT: {
          guard: 'paymentMethodEnabled',
          actions: assign(({ context, event }) => ({
            session: updateSession(context, { paymentMethod: event.method }),
          })),
        },
        'VOUCHER.KEY': { guard: 'voucherEnabled', actions: 'voucherKey' },
        'VOUCHER.BACKSPACE': { guard: 'voucherEnabled', actions: 'voucherBackspace' },
        BACK: { target: 'framePick', actions: 'releasePayment' },
      },
    },

    capture: {
      entry: [assign({ page: 'capture' as PageType | null }), 'restartIdle'],
      initial: 'connecting',
      states: {
        connecting: {
          invoke: {
            src: 'connectCamera',
            input: ({ context }) => ({ sessionId: context.session!.id }),
            onDone: 'route',
            onError: {
              target: '#flow.error',
              actions: 'setCameraError',
            },
          },
        },
        route: {
          always: [
            { guard: 'retaking', target: 'countdown' },
            { guard: 'allFilled', target: 'waiting' },
            { target: 'countdown', actions: 'activateNextSlot' },
          ],
        },
        countdown: {
          entry: 'startCountdown',
          initial: 'tick',
          states: {
            tick: {
              always: {
                guard: ({ context }) => (context.countdown ?? 0) <= 0,
                target: '#flow.capture.shooting',
              },
              after: { countdownTick: { target: 'tick', reenter: true, actions: 'tickCountdown' } },
            },
          },
        },
        shooting: {
          entry: assign({ countdown: null }),
          invoke: {
            src: 'captureShot',
            input: ({ context }) => {
              const slotIndex = context.activeSlot ?? 1;
              const takes = context.session!.takes.filter((t) => t.slotIndex === slotIndex);
              return {
                sessionId: context.session!.id,
                sessionCode: context.session!.code,
                startedAt: context.session!.startedAt,
                boothId: context.config.boothId,
                configVersion: context.config.configVersion,
                slotIndex,
                takeNumber: takes.length + 1,
              };
            },
            onDone: {
              target: 'shotPreview',
              actions: [
                assign(({ context, event }) => {
                  const session = context.session!;
                  const slotIndex = context.activeSlot ?? 1;
                  const shot: Shot = {
                    slotIndex,
                    takeNumber: session.takes.filter((t) => t.slotIndex === slotIndex).length + 1,
                    photo: event.output,
                    capturedAt: new Date().toISOString(),
                  };
                  const shots = session.shots.slice();
                  shots[slotIndex - 1] = shot;
                  return {
                    session: { ...session, shots, takes: [...session.takes, shot] },
                    shotCounter: context.shotCounter + 1,
                  };
                }),
                'restartIdle',
              ],
            },
            onError: {
              target: '#flow.error',
              actions: 'setCameraError',
            },
          },
        },
        shotPreview: {
          after: {
            shotPreview: [
              { guard: 'continueAuto', target: 'countdown', actions: 'activateNextSlot' },
              { target: 'waiting' },
            ],
          },
          on: {
            RETAKE: { guard: 'canRetake', target: 'countdown', actions: 'beginRetake' },
            RETAKE_ALL: { guard: 'canRetakeAll', target: 'countdown', actions: 'beginRetakeAll' },
          },
        },
        waiting: {
          entry: 'highlightNext',
          after: {
            captureAutoFinish: {
              guard: and(['allFilled', 'captureWithoutExitButton']),
              target: 'done',
            },
          },
          on: {
            NEXT: [
              { guard: 'allFilled', target: 'done' },
              { target: 'countdown', actions: 'activateNextSlot' },
            ],
            CONFIRM: [
              { guard: 'allFilled', target: 'done' },
              { target: 'countdown', actions: 'activateNextSlot' },
            ],
            // Paid: idle never drops the session; it keeps going.
            'IDLE.TIMEOUT': [
              { guard: 'allFilled', target: 'done' },
              { target: 'countdown', actions: 'activateNextSlot' },
            ],
            RETAKE: { guard: 'canRetake', target: 'countdown', actions: 'beginRetake' },
            RETAKE_ALL: { guard: 'canRetakeAll', target: 'countdown', actions: 'beginRetakeAll' },
          },
        },
        done: {
          entry: assign({ activeSlot: null }),
          always: [
            { guard: 'reviewEnabled', target: '#flow.review' },
            { target: '#flow.processing' },
          ],
        },
      },
      on: {
        'CAMERA.ERROR': {
          target: 'error',
          actions: 'setCameraError',
        },
      },
    },

    review: {
      entry: [assign({ page: 'review' as PageType | null }), 'restartIdle'],
      on: {
        SELECT_FILTER: {
          guard: 'validFilter',
          actions: assign(({ context, event }) => ({
            session: updateSession(context, { filterId: event.filterId }),
          })),
        },
        CONFIRM: { guard: 'responsesComplete', target: 'processing' },
        NEXT: { guard: 'responsesComplete', target: 'processing' },
        FINISH: { guard: 'responsesComplete', target: 'processing' },
        // Paid: the session is never held back by an unanswered question.
        'IDLE.TIMEOUT': 'processing',
        BACK: 'capture',
        RETAKE: { guard: 'canRetake', target: 'capture', actions: 'beginRetake' },
        RETAKE_ALL: { guard: 'canRetakeAll', target: 'capture', actions: 'beginRetakeAll' },
      },
    },

    processing: {
      entry: [
        assign({ page: 'processing' as PageType | null }),
        'restartIdle',
        assign({ progress: 0 }),
      ],
      invoke: {
        src: 'processSession',
        input: ({ context }) => ({
          config: context.config,
          session: { ...context.session!, responses: Object.values(context.responses) },
        }),
      },
      on: {
        'PROCESSING.PROGRESS': {
          actions: assign(({ event }) => ({ progress: Math.min(1, Math.max(0, event.progress)) })),
        },
        'PROCESSING.DONE': {
          target: 'result',
          actions: assign(({ context, event }) => ({
            progress: 1,
            session: updateSession(context, {
              downloadUrl: event.downloadUrl,
              completedAt: new Date().toISOString(),
            }),
          })),
        },
        'PROCESSING.FAILED': {
          target: 'error',
          actions: 'setProcessingError',
        },
      },
    },

    result: {
      entry: [assign({ page: 'result' as PageType | null }), 'restartIdle'],
      after: { resultReturn: 'cover' },
      on: { FINISH: 'cover', START: 'cover', NEXT: 'cover', CONFIRM: 'cover' },
    },

    error: {
      entry: [assign({ page: 'error' as PageType | null }), 'restartIdle'],
      on: {
        START: [
          { guard: 'resumeCapture', target: 'capture' },
          { guard: 'resumeProcessing', target: 'processing' },
          { target: 'cover' },
        ],
        FINISH: [
          { guard: 'resumeCapture', target: 'capture' },
          { guard: 'resumeProcessing', target: 'processing' },
          { target: 'cover' },
        ],
        BACK: [
          { guard: 'resumeCapture', target: 'capture' },
          { guard: 'resumeProcessing', target: 'processing' },
          { target: 'cover' },
        ],
        NEXT: [
          { guard: 'resumeCapture', target: 'capture' },
          { guard: 'resumeProcessing', target: 'processing' },
          { target: 'cover' },
        ],
        'IDLE.TIMEOUT': [
          { guard: 'resumeCapture', target: 'capture' },
          { guard: 'resumeProcessing', target: 'processing' },
          { target: 'cover' },
        ],
      },
    },

    admin: {
      entry: ['endSession', assign({ page: null as PageType | null }), 'restartIdle'],
      on: {
        'ADMIN.CLOSE': 'cover',
        'ADMIN.FREE_SESSION': {
          target: 'framePick',
          actions: 'startFreeSession',
        },
      },
    },
  },
});

export type FlowMachine = typeof flowMachine;
export type FlowActorRef = ActorRefFrom<FlowMachine>;
export type FlowSnapshot = SnapshotFrom<FlowMachine>;
