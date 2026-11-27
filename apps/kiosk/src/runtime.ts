import { paymentAmount, printSheets, uiActionToEvent, type FlowSnapshot } from '@pb/flow';
import type { CameraRuntime, RenderRuntime, RuntimePhoto } from '@pb/renderer';
import type { BoothConfig } from '@pb/schema';

/** Flow snapshot → data for flow-bound elements on the current page. */
export function buildRuntime(snapshot: FlowSnapshot, camera: CameraRuntime): RenderRuntime {
  const { context } = snapshot;
  const config: BoothConfig = context.config;
  const session = context.session;
  const page = context.page;

  const shots: Partial<Record<number, RuntimePhoto>> = {};
  session?.shots.forEach((shot, i) => {
    if (shot) shots[i + 1] = { url: shot.photo.url };
  });
  const cameraView = config.pages.capture.elements.find((e) => e.type === 'camera-view');
  const filterShown = page === 'review' || page === 'processing' || page === 'result';

  return {
    boothName: config.output.driveRootFolderName,
    price: paymentAmount(config, session),
    slideIndex: context.slideIndex,
    camera,
    activeSlotIndex: context.activeSlot,
    shots,
    countdown: context.countdown,
    countdownTotal: config.flow.shotCountdownSec,
    flashKey: context.shotCounter,
    // Buyers see a mirrored preview; show their shots the same way.
    mirrorShots: cameraView?.type === 'camera-view' ? cameraView.mirror : false,
    selectedFrameId: session?.frameId ?? null,
    selectedFilterId: filterShown ? (session?.filterId ?? null) : null,
    qrisString: session?.qrString ?? null,
    // Offline: a QR could never be confirmed, so it is not shown (voucher + cash remain).
    // QRIS unavailable (e.g. Midtrans not set up): same, voucher + cash remain.
    qrisHidden:
      !context.online || context.qrisUnavailable || !config.flow.paymentMethods.includes('qris'),
    voucherCode: context.voucher.code,
    voucherStatus: context.voucher.status,
    paymentExpiresAt: session?.paymentExpiresAt ? Date.parse(session.paymentExpiresAt) : null,
    paymentTotalSec: config.flow.qrisExpirySec,
    printSheets: printSheets(config, session),
    progress: context.progress,
    downloadUrl: session?.downloadUrl ?? null,
    canAction: (action) => snapshot.can(uiActionToEvent(action)),
  };
}
