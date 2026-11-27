import { createDefaultBoothConfig, type BoothConfig, type Element } from '@pb/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActor, fromCallback, fromPromise } from 'xstate';
import { flowMachine } from './machine';
import {
  PaymentAlreadyPaidError,
  PaymentOfflineError,
  type CaptureShotInput,
  type FlowEvent,
  type ProcessSessionInput,
  type RedeemVoucherOutput,
  type ShotPhoto,
} from './types';

function makeConfig(patch: (c: BoothConfig) => void = () => {}): BoothConfig {
  let n = 0;
  const config = createDefaultBoothConfig({ boothId: 'booth-1', idFactory: () => `id-${++n}` });
  patch(config);
  return config;
}

type Harness = ReturnType<typeof start>;

function start(
  config: BoothConfig,
  opts: {
    cameraFails?: boolean;
    online?: boolean;
    paymentOffline?: boolean;
    paymentAlreadyPaid?: boolean;
    /** createPayment fails for a non-network reason (e.g. Midtrans not set up). */
    paymentFails?: boolean;
    voucher?: (code: string) => RedeemVoucherOutput;
  } = {},
) {
  const calls = {
    cancelled: [] as (string | null)[],
    ended: [] as string[],
    captures: 0,
    payments: 0,
    vouchers: [] as string[],
    processed: [] as ProcessSessionInput['session'][],
  };
  const machine = flowMachine.provide({
    actors: {
      connectCamera: fromPromise(async () => {
        if (opts.cameraFails) throw new Error('Kamera tidak ditemukan.');
      }),
      captureShot: fromPromise<ShotPhoto, CaptureShotInput>(async ({ input }) => {
        calls.captures++;
        return {
          id: `photo-${input.slotIndex}-${input.takeNumber}`,
          url: `blob:${input.slotIndex}-${input.takeNumber}`,
          width: 1920,
          height: 1080,
        };
      }),
      createPayment: fromPromise(async ({ input }) => {
        calls.payments++;
        if (opts.paymentOffline) throw new PaymentOfflineError();
        if (opts.paymentAlreadyPaid) throw new PaymentAlreadyPaidError();
        if (opts.paymentFails) throw new Error('Midtrans belum diatur di Studio');
        return {
          paymentId: `pay-${input.sessionCode}-${calls.payments}`,
          qrString: `QR-${input.amount}`,
          expiresAt: new Date(Date.now() + input.expirySec * 1000).toISOString(),
        };
      }),
      redeemVoucher: fromPromise(async ({ input }) => {
        calls.vouchers.push(input.code);
        return opts.voucher
          ? opts.voucher(input.code)
          : { ok: false as const, reason: 'invalid' as const };
      }),
      processSession: fromCallback<FlowEvent, ProcessSessionInput>(({ sendBack, input }) => {
        calls.processed.push(input.session);
        const t = setTimeout(() => {
          sendBack({ type: 'PROCESSING.PROGRESS', progress: 0.5 });
          sendBack({
            type: 'PROCESSING.DONE',
            downloadUrl: `https://pb.test/s/${input.session.code}`,
          });
        }, 100);
        return () => clearTimeout(t);
      }),
    },
    actions: {
      cancelPayment: ({ context }) => {
        calls.cancelled.push(context.session?.paymentId ?? null);
      },
      onSessionEnd: ({ context }) => {
        calls.ended.push(context.session?.code ?? '');
      },
    },
  });
  const actor = createActor(machine, { input: { config, online: opts.online } });
  actor.start();
  const state = () => actor.getSnapshot();
  const send = (e: FlowEvent) => actor.send(e);
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  return { actor, state, send, tick, calls };
}

/** Countdown (3 s) + capture + shot preview (1.2 s). */
const SHOT_MS = 3000 + 1200;

async function toCapture(h: Harness) {
  h.send({ type: 'START' });
  h.send({ type: 'NEXT' }); // tutorial → framePick
  h.send({ type: 'NEXT' }); // frame preselected → payment
  await h.tick(0);
  h.send({ type: 'PAYMENT.PAID' });
  await h.tick(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('flow machine', () => {
  it('runs the default config end to end, including retake of slot 2 and filter change', async () => {
    const config = makeConfig();
    const h = start(config);
    expect(h.state().value).toBe('cover');
    expect(h.state().context.page).toBe('cover');

    h.send({ type: 'START' });
    expect(h.state().context.page).toBe('tutorial');
    const code = h.state().context.session!.code;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

    h.send({ type: 'NEXT' });
    expect(h.state().value).toBe('framePick');
    // Single enabled frame is preselected.
    expect(h.state().context.session!.frameId).toBe(config.frames[0]!.id);

    h.send({ type: 'NEXT' });
    expect(h.state().matches({ payment: 'creating' })).toBe(true);
    await h.tick(0);
    expect(h.state().matches({ payment: 'awaiting' })).toBe(true);
    expect(h.state().context.session!.qrString).toBe('QR-35000');

    h.send({ type: 'PAYMENT.PAID' });
    await h.tick(0);
    expect(h.state().matches({ capture: 'countdown' })).toBe(true);
    expect(h.state().context.session!.paid).toBe(true);
    expect(h.state().context.activeSlot).toBe(1);
    expect(h.state().context.countdown).toBe(3);
    await h.tick(1000);
    expect(h.state().context.countdown).toBe(2);

    await h.tick(2000 + 1200 + SHOT_MS * 3);
    expect(h.state().matches({ capture: 'waiting' })).toBe(true);
    expect(h.state().context.session!.shots.map((s) => s?.photo.id)).toEqual([
      'photo-1-1',
      'photo-2-1',
      'photo-3-1',
      'photo-4-1',
    ]);

    h.send({ type: 'RETAKE', shotIndex: 2 });
    expect(h.state().matches({ capture: 'countdown' })).toBe(true);
    expect(h.state().context.activeSlot).toBe(2);
    await h.tick(SHOT_MS);
    // Retake returns to waiting instead of continuing with slot 3.
    expect(h.state().matches({ capture: 'waiting' })).toBe(true);
    const session = h.state().context.session!;
    expect(session.shots[1]!.photo.id).toBe('photo-2-2');
    expect(session.shots[1]!.takeNumber).toBe(2);
    expect(session.takes).toHaveLength(5);

    h.send({ type: 'NEXT' });
    expect(h.state().value).toBe('review');
    const filterId = config.filters[1]!.id;
    h.send({ type: 'SELECT_FILTER', filterId });
    expect(h.state().context.session!.filterId).toBe(filterId);
    // Extra prints are bought on Pilih Frame (before Payment), not at Review.
    h.send({ type: 'ADD_PRINT' });
    expect(h.state().context.session!.extraPrints).toBe(0);

    h.send({ type: 'CONFIRM' });
    expect(h.state().value).toBe('processing');
    await h.tick(100);
    expect(h.state().value).toBe('result');
    expect(h.state().context.session!.downloadUrl).toBe(`https://pb.test/s/${code}`);

    await h.tick(config.flow.resultAutoReturnSec * 1000);
    expect(h.state().value).toBe('cover');
    expect(h.state().context.session).toBeNull();
    expect(h.calls.ended).toEqual([code]);
    expect(h.calls.cancelled).toEqual([]);
  });

  it('advances tutorial slides by duration', async () => {
    const h = start(makeConfig());
    h.send({ type: 'START' });
    await h.tick(4999);
    expect(h.state().context.page).toBe('tutorial');
    await h.tick(1);
    expect(h.state().value).toBe('framePick');
  });

  it('skips tutorial, review and payment when disabled / event mode', async () => {
    const h = start(
      makeConfig((c) => {
        c.flow.tutorialEnabled = false;
        c.flow.reviewEnabled = false;
        c.flow.eventMode = true;
      }),
    );
    h.send({ type: 'START' });
    expect(h.state().value).toBe('framePick');
    h.send({ type: 'NEXT' });
    await h.tick(0);
    expect(h.state().matches('capture')).toBe(true);
    expect(h.state().context.session).toMatchObject({ paid: true, paymentMethod: 'free' });
    await h.tick(SHOT_MS * 4);
    h.send({ type: 'NEXT' });
    expect(h.state().value).toBe('processing');
  });

  describe('idle timeout', () => {
    it('returns to cover before payment and drops the session', async () => {
      const config = makeConfig();
      const h = start(config);
      h.send({ type: 'START' });
      h.send({ type: 'NEXT' });
      expect(h.state().value).toBe('framePick');
      await h.tick(config.flow.idleTimeoutSec.framePick! * 1000 - 1000);
      h.send({ type: 'ACTIVITY' }); // a touch restarts the timer
      await h.tick(config.flow.idleTimeoutSec.framePick! * 1000 - 1000);
      expect(h.state().value).toBe('framePick');
      await h.tick(1000);
      expect(h.state().value).toBe('cover');
      expect(h.calls.ended).toHaveLength(1);
    });

    it('cancels a pending QRIS when idling out of payment', async () => {
      const h = start(
        makeConfig((c) => {
          c.flow.idleTimeoutSec.payment = 60;
        }),
      );
      h.send({ type: 'START' });
      h.send({ type: 'NEXT' });
      h.send({ type: 'NEXT' });
      await h.tick(0);
      const paymentId = h.state().context.session!.paymentId;
      await h.tick(60_000);
      expect(h.state().value).toBe('cover');
      expect(h.calls.cancelled).toEqual([paymentId]);
    });

    it('keeps a paid session going instead of dropping it', async () => {
      const h = start(
        makeConfig((c) => {
          c.flow.autoAdvanceBetweenShots = false;
        }),
      );
      await toCapture(h);
      await h.tick(SHOT_MS);
      expect(h.state().matches({ capture: 'waiting' })).toBe(true);
      expect(h.state().context.activeSlot).toBe(2);
      await h.tick(120_000);
      // Idle on a paid capture page takes the next shot rather than returning to cover.
      expect(h.state().matches({ capture: 'countdown' })).toBe(true);
      expect(h.state().context.session).not.toBeNull();
    });
  });

  describe('payment', () => {
    it('cancels the QRIS when going back to frame pick', async () => {
      const h = start(makeConfig());
      h.send({ type: 'START' });
      h.send({ type: 'NEXT' });
      h.send({ type: 'NEXT' });
      await h.tick(0);
      const paymentId = h.state().context.session!.paymentId;
      h.send({ type: 'BACK' });
      expect(h.state().value).toBe('framePick');
      expect(h.calls.cancelled).toEqual([paymentId]);
      expect(h.state().context.session!.paymentId).toBeNull();
    });

    it('returns to frame pick when the QRIS expires', async () => {
      const config = makeConfig();
      const h = start(config);
      h.send({ type: 'START' });
      h.send({ type: 'NEXT' });
      h.send({ type: 'NEXT' });
      await h.tick(0);
      await h.tick(config.flow.qrisExpirySec * 1000);
      expect(h.state().value).toBe('framePick');
      expect(h.calls.cancelled).toHaveLength(1);
    });

    it('ignores a paid event for another payment', async () => {
      const h = start(makeConfig());
      h.send({ type: 'START' });
      h.send({ type: 'NEXT' });
      h.send({ type: 'NEXT' });
      await h.tick(0);
      h.send({ type: 'PAYMENT.PAID', paymentId: 'someone-else' });
      expect(h.state().matches('payment')).toBe(true);
    });
  });

  describe('retakes', () => {
    it('retake all clears every slot and starts again from slot 1', async () => {
      const h = start(makeConfig());
      await toCapture(h);
      await h.tick(SHOT_MS * 4);
      h.send({ type: 'RETAKE_ALL' });
      expect(h.state().context.session!.shots.every((s) => s === null)).toBe(true);
      expect(h.state().context.activeSlot).toBe(1);
      await h.tick(SHOT_MS * 4);
      expect(h.state().matches({ capture: 'waiting' })).toBe(true);
      expect(h.state().context.session!.shots.map((s) => s?.takeNumber)).toEqual([2, 2, 2, 2]);
    });

    it('enforces maxRetakesPerShot', async () => {
      const h = start(
        makeConfig((c) => {
          c.flow.maxRetakesPerShot = 1;
        }),
      );
      await toCapture(h);
      await h.tick(SHOT_MS * 4);
      h.send({ type: 'RETAKE', shotIndex: 3 });
      await h.tick(SHOT_MS);
      expect(h.state().context.session!.shots[2]!.takeNumber).toBe(2);
      h.send({ type: 'RETAKE', shotIndex: 3 });
      expect(h.state().matches({ capture: 'waiting' })).toBe(true);
      h.send({ type: 'RETAKE_ALL' });
      expect(h.state().matches({ capture: 'waiting' })).toBe(true);
    });

    it('can retake from review and comes back to the capture page', async () => {
      const h = start(makeConfig());
      await toCapture(h);
      await h.tick(SHOT_MS * 4);
      h.send({ type: 'NEXT' });
      h.send({ type: 'RETAKE', shotIndex: 4 });
      await h.tick(0);
      expect(h.state().matches({ capture: 'countdown' })).toBe(true);
      expect(h.state().context.activeSlot).toBe(4);
    });
  });

  describe('errors', () => {
    it('camera lost mid-capture shows the error page and resumes the paid session', async () => {
      const h = start(makeConfig());
      await toCapture(h);
      await h.tick(SHOT_MS * 2);
      h.send({ type: 'CAMERA.ERROR', message: 'Kamera terputus.' });
      expect(h.state().value).toBe('error');
      expect(h.state().context.page).toBe('error');
      expect(h.state().context.error).toMatchObject({ kind: 'camera', resumeTo: 'capture' });

      h.send({ type: 'START' });
      await h.tick(0);
      expect(h.state().matches({ capture: 'countdown' })).toBe(true);
      expect(h.state().context.activeSlot).toBe(3);
      expect(h.state().context.session!.shots.filter(Boolean)).toHaveLength(2);
    });

    it('goes to the error page when the camera cannot connect', async () => {
      const h = start(makeConfig(), { cameraFails: true });
      await toCapture(h);
      expect(h.state().value).toBe('error');
      expect(h.state().context.error?.message).toBe('Kamera tidak ditemukan.');
    });

    it('unpaid error returns to cover on idle', async () => {
      const config = makeConfig();
      const h = start(config);
      h.send({ type: 'START' });
      h.send({ type: 'FAIL', message: 'boom' });
      expect(h.state().value).toBe('error');
      await h.tick(config.flow.idleTimeoutSec.error! * 1000);
      expect(h.state().value).toBe('cover');
    });
  });

  describe('admin', () => {
    it('opens only without a paid session and can start a free session', async () => {
      const h = start(makeConfig());
      await toCapture(h);
      h.send({ type: 'ADMIN.OPEN' });
      expect(h.state().matches('capture')).toBe(true);

      const h2 = start(makeConfig());
      h2.send({ type: 'ADMIN.OPEN' });
      expect(h2.state().value).toBe('admin');
      expect(h2.state().context.page).toBeNull();
      h2.send({ type: 'ADMIN.FREE_SESSION' });
      expect(h2.state().value).toBe('framePick');
      h2.send({ type: 'NEXT' });
      expect(h2.state().matches('capture')).toBe(true);
      expect(h2.state().context.session!.paymentMethod).toBe('free');
    });
  });

  it('applies a config update only when back at cover', async () => {
    const h = start(makeConfig());
    h.send({ type: 'START' });
    const next = makeConfig((c) => {
      c.configVersion = 7;
    });
    h.send({ type: 'CONFIG.UPDATE', config: next });
    expect(h.state().context.config.configVersion).toBe(0);
    h.send({ type: 'BACK' });
    expect(h.state().value).toBe('cover');
    expect(h.state().context.config.configVersion).toBe(7);
  });
});

describe('F4: payment methods + offline', () => {
  const allMethods = (c: BoothConfig) => {
    c.flow.paymentMethods = ['qris', 'voucher', 'cash'];
  };
  async function toPayment(h: Harness) {
    h.send({ type: 'START' });
    h.send({ type: 'NEXT' });
    h.send({ type: 'NEXT' });
    await h.tick(0);
  }
  const typeCode = (h: Harness, code: string) => {
    for (const key of code) h.send({ type: 'VOUCHER.KEY', key });
  };

  it('offline: no QRIS is created; it is created when the network returns', async () => {
    const h = start(makeConfig(allMethods), { online: false });
    await toPayment(h);
    expect(h.state().matches({ payment: 'awaiting' })).toBe(true);
    expect(h.calls.payments).toBe(0);
    h.send({ type: 'NETWORK.ONLINE' });
    await h.tick(0);
    expect(h.calls.payments).toBe(1);
    expect(h.state().context.session?.qrString).toBe(
      `QR-${h.state().context.config.pricing.basePrice}`,
    );
  });

  describe('QRIS expiring while offline (audit T2)', () => {
    async function expireOffline(h: Harness) {
      await toPayment(h);
      const paymentId = h.state().context.session!.paymentId;
      h.send({ type: 'NETWORK.OFFLINE' });
      await h.tick(h.state().context.config.flow.qrisExpirySec * 1000);
      return paymentId;
    }

    it('waits for the network instead of cancelling, and continues when it turns out paid', async () => {
      const h = start(makeConfig(allMethods));
      const paymentId = await expireOffline(h);
      expect(h.state().matches({ payment: 'confirming' })).toBe(true);
      expect(h.calls.cancelled).toEqual([]);
      // Idle does not throw the (maybe paying) buyer out meanwhile.
      await h.tick(4 * 60_000);
      expect(h.state().matches({ payment: 'confirming' })).toBe(true);
      h.send({ type: 'NETWORK.ONLINE' });
      expect(h.state().matches({ payment: 'verifying' })).toBe(true);
      h.send({ type: 'PAYMENT.PAID', paymentId: paymentId! });
      await h.tick(0);
      expect(h.state().matches('capture')).toBe(true);
      expect(h.calls.cancelled).toEqual([]);
    });

    it('back online without a payment: cancels after the verify window', async () => {
      const h = start(makeConfig(allMethods), {});
      const paymentId = await expireOffline(h);
      h.send({ type: 'NETWORK.ONLINE' });
      await h.tick(10_000);
      expect(h.state().value).toBe('framePick');
      expect(h.calls.cancelled).toEqual([paymentId]);
    });

    it('offline for too long: gives up (the cancel is queued by the agent)', async () => {
      const h = start(makeConfig(allMethods));
      const paymentId = await expireOffline(h);
      await h.tick(5 * 60_000);
      expect(h.state().value).toBe('framePick');
      expect(h.calls.cancelled).toEqual([paymentId]);
    });
  });

  it('the server says the session is already paid: continue to Capture', async () => {
    const h = start(makeConfig(allMethods), { paymentAlreadyPaid: true });
    await toPayment(h);
    expect(h.state().matches('capture')).toBe(true);
    expect(h.state().context.session?.paid).toBe(true);
  });

  it('an offline error while creating keeps the buyer on Payment (no Error page)', async () => {
    const h = start(makeConfig(allMethods), { paymentOffline: true });
    await toPayment(h);
    expect(h.state().matches({ payment: 'awaiting' })).toBe(true);
    expect(h.state().context.online).toBe(false);
  });

  describe('QRIS cannot be created (e.g. Midtrans not set up)', () => {
    it('stays on Payment without QR when voucher/cash are enabled, and does not retry when online', async () => {
      const h = start(makeConfig(allMethods), {
        paymentFails: true,
        voucher: () => ({ ok: true, offline: false }),
      });
      await toPayment(h);
      expect(h.state().matches({ payment: 'awaiting' })).toBe(true);
      expect(h.state().context.qrisUnavailable).toBe(true);
      expect(h.state().context.online).toBe(true);
      expect(h.state().context.error).toBeNull();
      h.send({ type: 'NETWORK.ONLINE' });
      await h.tick(0);
      expect(h.calls.payments).toBe(1);
      typeCode(h, '12345678');
      h.send({ type: 'VOUCHER.SUBMIT' });
      await h.tick(0);
      expect(h.state().matches('capture')).toBe(true);
    });

    it('tries again on the next visit to Payment', async () => {
      const h = start(makeConfig(allMethods), { paymentFails: true });
      await toPayment(h);
      h.send({ type: 'BACK' });
      await h.tick(0);
      h.send({ type: 'NEXT' });
      await h.tick(0);
      expect(h.calls.payments).toBe(2);
    });

    it('QRIS is the only method: the Error page', async () => {
      const h = start(
        makeConfig((c) => {
          c.flow.paymentMethods = ['qris'];
        }),
        { paymentFails: true },
      );
      await toPayment(h);
      expect(h.state().value).toBe('error');
      expect(h.state().context.error).toMatchObject({ kind: 'payment' });
    });
  });

  it('voucher: wrong code shows the reason, a valid code pays and cancels the pending QRIS', async () => {
    const h = start(makeConfig(allMethods), {
      voucher: (code) =>
        code === '12345678' ? { ok: true, offline: true } : { ok: false, reason: 'used' },
    });
    await toPayment(h);
    const qrPayment = h.state().context.session!.paymentId;
    typeCode(h, '1111');
    h.send({ type: 'VOUCHER.SUBMIT' }); // incomplete: ignored
    expect(h.calls.vouchers).toEqual([]);
    typeCode(h, '2222');
    h.send({ type: 'VOUCHER.SUBMIT' });
    await h.tick(0);
    expect(h.state().context.voucher).toEqual({ code: '', status: 'used' });
    typeCode(h, '123456789'); // 9th digit ignored
    h.send({ type: 'VOUCHER.BACKSPACE' });
    typeCode(h, '8');
    h.send({ type: 'VOUCHER.SUBMIT' });
    await h.tick(0);
    expect(h.state().matches('capture')).toBe(true);
    expect(h.state().context.session).toMatchObject({
      paid: true,
      paymentMethod: 'voucher',
      qrString: null,
    });
    expect(h.calls.cancelled).toEqual([qrPayment]);
  });

  it('cash: selecting cash waits for the operator; approval pays and cancels the QRIS', async () => {
    const h = start(makeConfig(allMethods));
    await toPayment(h);
    const qrPayment = h.state().context.session!.paymentId;
    h.send({ type: 'SELECT_PAYMENT', method: 'cash' });
    expect(h.state().matches({ payment: 'cash' })).toBe(true);
    h.send({ type: 'CASH.CANCEL' });
    expect(h.state().matches({ payment: 'awaiting' })).toBe(true);
    h.send({ type: 'SELECT_PAYMENT', method: 'cash' });
    h.send({ type: 'PAYMENT.PAID', method: 'cash' });
    await h.tick(0);
    expect(h.state().matches('capture')).toBe(true);
    expect(h.state().context.session).toMatchObject({ paid: true, paymentMethod: 'cash' });
    expect(h.calls.cancelled).toEqual([qrPayment]);
  });

  it('cash approval is ignored when cash is not enabled', async () => {
    const h = start(
      makeConfig((c) => {
        c.flow.paymentMethods = ['qris', 'voucher'];
      }),
    );
    await toPayment(h);
    h.send({ type: 'PAYMENT.PAID', method: 'cash' });
    expect(h.state().matches('payment')).toBe(true);
  });

  it('event mode skips Payment entirely (free session)', async () => {
    const h = start(
      makeConfig((c) => {
        c.flow.eventMode = true;
      }),
    );
    h.send({ type: 'START' });
    h.send({ type: 'NEXT' });
    h.send({ type: 'NEXT' });
    await h.tick(0);
    expect(h.state().matches('capture')).toBe(true);
    expect(h.state().context.session).toMatchObject({ paid: true, paymentMethod: 'free' });
    expect(h.calls.payments).toBe(0);
  });
});

describe('sessionTotal', () => {
  it('free (event mode) sessions do not count the frame price, only extra prints', async () => {
    const { sessionTotal } = await import('./helpers');
    const { createDefaultBoothConfig } = await import('@pb/schema');
    const config = createDefaultBoothConfig({ boothId: 'b' });
    config.pricing.extraPrintPrice = 5000;
    const frameId = config.frames[0]!.id;
    const base = { frameId, extraPrints: 1 } as Parameters<typeof sessionTotal>[1];
    expect(sessionTotal(config, { ...base!, free: false })).toBe(
      (config.frames[0]!.price ?? config.pricing.basePrice) + 5000,
    );
    expect(sessionTotal(config, { ...base!, free: true })).toBe(5000);
  });
});

describe('extra prints (chosen on Pilih Frame, paid at Payment)', () => {
  it('adds the extra sheets to the QRIS amount; event mode sells none', async () => {
    const h = start(
      makeConfig((c) => {
        c.pricing.extraPrintPrice = 5000;
        c.pricing.maxExtraPrints = 2;
      }),
    );
    h.send({ type: 'START' });
    await h.tick(60_000);
    expect(h.state().value).toBe('framePick');
    h.send({ type: 'ADD_PRINT' });
    h.send({ type: 'ADD_PRINT' });
    h.send({ type: 'ADD_PRINT' });
    expect(h.state().context.session!.extraPrints).toBe(2);
    h.send({ type: 'REMOVE_PRINT' });
    const frame = h.state().context.config.frames[0]!;
    const price = frame.price ?? h.state().context.config.pricing.basePrice;
    h.send({ type: 'NEXT' });
    await h.tick(10);
    expect(h.state().context.session!.qrString).toBe(`QR-${price + 5000}`);

    const free = start(
      makeConfig((c) => {
        c.pricing.extraPrintPrice = 5000;
        c.flow.eventMode = true;
      }),
    );
    free.send({ type: 'START' });
    await free.tick(60_000);
    free.send({ type: 'ADD_PRINT' });
    expect(free.state().context.session!.extraPrints).toBe(0);
  });
});

const TEXT = {
  fontFamily: 'Inter',
  fontSize: 28,
  fontWeight: 400,
  color: '#111',
  align: 'left' as const,
  lineHeight: 1.3,
  letterSpacing: 0,
};
const BASE = {
  x: 0,
  y: 0,
  width: 600,
  height: 80,
  rotation: 0,
  opacity: 1,
  visible: true,
  locked: false,
};

function consent(id: string, required = true): Element {
  return {
    ...BASE,
    id,
    name: 'Persetujuan',
    type: 'consent-checkbox',
    label: 'Saya setuju foto disimpan',
    required,
    textStyle: TEXT,
    boxSize: 40,
    boxStyle: { borderColor: '#111', borderWidth: 2 },
    checkedStyle: { fill: '#111' },
    checkColor: '#fff',
  };
}

function question(id: string, opts: { required?: boolean; multiple?: boolean } = {}): Element {
  return {
    ...BASE,
    id,
    name: 'Pertanyaan',
    type: 'survey-question',
    question: 'Tahu booth ini dari mana?',
    options: [
      { id: 'ig', label: 'Instagram' },
      { id: 'tt', label: 'TikTok' },
      { id: 'fr', label: 'Teman' },
    ],
    multiple: opts.multiple ?? false,
    required: opts.required ?? true,
    layout: 'row',
    columns: 3,
    gap: 12,
    optionTextStyle: TEXT,
    optionStyle: { borderColor: '#111', borderWidth: 2 },
    selectedStyle: { fill: '#111' },
  };
}

describe('F8: consent + survey', () => {
  it('Cover: START waits for the required consent; untick blocks again', () => {
    const h = start(makeConfig((c) => c.pages.cover.elements.push(consent('c1'))));
    expect(h.state().can({ type: 'START' })).toBe(false);
    h.send({ type: 'START' });
    expect(h.state().value).toBe('cover');

    h.send({ type: 'CONSENT.TOGGLE', elementId: 'c1' });
    expect(h.state().context.responses.c1).toMatchObject({
      kind: 'consent',
      page: 'cover',
      label: 'Saya setuju foto disimpan',
    });
    h.send({ type: 'CONSENT.TOGGLE', elementId: 'c1' });
    expect(h.state().context.responses.c1).toBeUndefined();
    expect(h.state().can({ type: 'START' })).toBe(false);

    h.send({ type: 'CONSENT.TOGGLE', elementId: 'c1' });
    h.send({ type: 'START' });
    expect(h.state().context.page).toBe('tutorial');
  });

  it('optional elements never block; taps for elements of other pages are ignored', () => {
    const h = start(
      makeConfig((c) => {
        c.pages.cover.elements.push(consent('c1', false));
        c.pages.review.elements.push(question('q1'));
      }),
    );
    h.send({ type: 'SURVEY.SELECT', elementId: 'q1', optionId: 'ig' });
    expect(h.state().context.responses).toEqual({});
    h.send({ type: 'START' });
    expect(h.state().context.page).toBe('tutorial');
  });

  it('single choice replaces; multiple toggles and keeps the design order', () => {
    const h = start(
      makeConfig((c) => {
        c.pages.framePick.elements.push(question('one'), question('many', { multiple: true }));
      }),
    );
    h.send({ type: 'START' });
    h.send({ type: 'NEXT' });
    expect(h.state().value).toBe('framePick');
    expect(h.state().can({ type: 'NEXT' })).toBe(false);

    h.send({ type: 'SURVEY.SELECT', elementId: 'one', optionId: 'tt' });
    h.send({ type: 'SURVEY.SELECT', elementId: 'one', optionId: 'ig' });
    h.send({ type: 'SURVEY.SELECT', elementId: 'one', optionId: 'ig' });
    expect(h.state().context.responses.one).toMatchObject({ optionIds: ['ig'] });

    h.send({ type: 'SURVEY.SELECT', elementId: 'many', optionId: 'fr' });
    h.send({ type: 'SURVEY.SELECT', elementId: 'many', optionId: 'ig' });
    h.send({ type: 'SURVEY.SELECT', elementId: 'many', optionId: 'nope' });
    expect(h.state().context.responses.many).toMatchObject({
      optionIds: ['ig', 'fr'],
      optionLabels: ['Instagram', 'Teman'],
    });
    h.send({ type: 'SURVEY.SELECT', elementId: 'many', optionId: 'ig' });
    h.send({ type: 'SURVEY.SELECT', elementId: 'many', optionId: 'fr' });
    expect(h.state().context.responses.many).toBeUndefined();
    expect(h.state().can({ type: 'NEXT' })).toBe(false);

    h.send({ type: 'SURVEY.SELECT', elementId: 'many', optionId: 'tt' });
    h.send({ type: 'NEXT' });
    expect(h.state().value).toMatchObject({ payment: expect.anything() });
  });

  it('answers from Cover and Review reach processing; Cover clears them for the next buyer', async () => {
    const h = start(
      makeConfig((c) => {
        c.pages.cover.elements.push(consent('c1'));
        c.pages.review.elements.push(question('q1'));
      }),
    );
    h.send({ type: 'CONSENT.TOGGLE', elementId: 'c1' });
    await toCapture(h);
    await h.tick(SHOT_MS * 4);
    h.send({ type: 'NEXT' });
    expect(h.state().value).toBe('review');
    h.send({ type: 'CONFIRM' });
    expect(h.state().value).toBe('review');
    h.send({ type: 'SURVEY.SELECT', elementId: 'q1', optionId: 'fr' });
    h.send({ type: 'CONFIRM' });
    expect(h.state().value).toBe('processing');
    expect(h.calls.processed[0]!.responses.map((r) => r.elementId)).toEqual(['c1', 'q1']);

    await h.tick(100);
    await h.tick(60_000);
    expect(h.state().value).toBe('cover');
    expect(h.state().context.responses).toEqual({});
  });

  it('a paid session idling on Review still goes to processing with what was answered', async () => {
    const config = makeConfig((c) => c.pages.review.elements.push(question('q1')));
    const h = start(config);
    await toCapture(h);
    await h.tick(SHOT_MS * 4);
    h.send({ type: 'NEXT' });
    await h.tick(config.flow.idleTimeoutSec.review! * 1000);
    expect(h.state().value).not.toBe('review');
    expect(h.calls.processed[0]!.responses).toEqual([]);
  });
});
