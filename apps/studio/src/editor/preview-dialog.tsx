'use client';

import { createMockSource, createWebcamSource, type CaptureSource } from '@pb/capture';
import {
  flowMachine,
  paymentAmount,
  printSheets,
  responsesForRenderer,
  uiActionToEvent,
  type CaptureShotInput,
  type FlowEvent,
  type ProcessSessionInput,
  type ShotPhoto,
} from '@pb/flow';
import { PageRenderer, type RenderRuntime } from '@pb/renderer';
import type { BoothConfig } from '@pb/schema';
import { useActorRef, useSelector } from '@xstate/react';
import { useEffect, useMemo, useState } from 'react';
import { PAGE_LABEL } from './labels';
import { fromCallback, fromPromise } from 'xstate';

const inSeconds = (sec: number) => new Date(Date.now() + sec * 1000).toISOString();

/**
 * Flow preview in Studio: the same flow machine and renderer as the Kiosk, with the laptop
 * webcam (or a test camera) and a mock payment. Nothing is saved.
 */
export function PreviewDialog({
  config,
  boothName,
  onClose,
}: {
  config: BoothConfig;
  boothName: string;
  onClose: () => void;
}) {
  const [source, setSource] = useState<'webcam' | 'mock'>('webcam');
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90" data-testid="preview-dialog">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm text-white">
        <span className="font-medium">Pratinjau alur</span>
        <label className="flex items-center gap-1 text-xs">
          Kamera
          <select
            className="rounded bg-neutral-800 px-1 py-0.5"
            value={source}
            onChange={(e) => setSource(e.target.value as 'webcam' | 'mock')}
          >
            <option value="webcam">Webcam laptop</option>
            <option value="mock">Kamera tiruan</option>
          </select>
        </label>
        <span className="order-last basis-full text-xs text-neutral-400 md:order-none md:basis-auto">
          Pembayaran disimulasikan. Tidak ada yang disimpan.
        </span>
        <button
          type="button"
          className="ml-auto rounded bg-white/10 px-3 py-1 hover:bg-white/20"
          onClick={onClose}
        >
          Tutup
        </button>
      </div>
      <PreviewPlayer key={source} config={config} boothName={boothName} source={source} />
    </div>
  );
}

function PreviewPlayer({
  config,
  boothName,
  source,
}: {
  config: BoothConfig;
  boothName: string;
  source: 'webcam' | 'mock';
}) {
  const camera = useMemo<CaptureSource>(
    () => (source === 'mock' ? createMockSource({ latencyMs: 50 }) : createWebcamSource()),
    [source],
  );
  const machine = useMemo(() => {
    const urls: string[] = [];
    return flowMachine.provide({
      actors: {
        connectCamera: fromPromise(() => camera.connect()),
        captureShot: fromPromise<ShotPhoto, CaptureShotInput>(async ({ input }) => {
          const img = await camera.capture({ shotIndex: input.slotIndex });
          // Webcam/mock always return bytes (only the tablet source stores stills in the agent).
          if (!img.blob) throw new Error('Kamera tidak mengirim foto.');
          const url = URL.createObjectURL(img.blob);
          urls.push(url);
          return {
            id: `${input.slotIndex}-${input.takeNumber}`,
            url,
            width: img.width,
            height: img.height,
          };
        }),
        createPayment: fromPromise(async ({ input }) => ({
          paymentId: `preview-${input.sessionCode}`,
          qrString: `PREVIEW-QRIS|${input.sessionCode}|IDR${input.amount}`,
          expiresAt: inSeconds(input.expirySec),
        })),
        processSession: fromCallback<FlowEvent, ProcessSessionInput>(({ input, sendBack }) => {
          sendBack({ type: 'PROCESSING.PROGRESS', progress: 0.3 });
          const t = setTimeout(() => {
            sendBack({ type: 'PROCESSING.PROGRESS', progress: 1 });
            sendBack({
              type: 'PROCESSING.DONE',
              downloadUrl: `https://photobooth.example/s/${input.session.code}`,
            });
          }, 1200);
          return () => clearTimeout(t);
        }),
      },
      actions: {
        onSessionEnd: () => {
          for (const u of urls.splice(0)) URL.revokeObjectURL(u);
        },
      },
    });
  }, [camera]);
  const actor = useActorRef(machine, { input: { config } });
  const snapshot = useSelector(actor, (s) => s);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const off = camera.onStatusChange((status, err) => {
      if (status === 'connected') {
        camera
          .getPreviewStream()
          .then((s) => alive && setStream(s))
          .catch(() => undefined);
      }
      if (status === 'error') {
        setStream(null);
        setCameraError(err?.message ?? 'Kamera bermasalah');
        actor.send({ type: 'CAMERA.ERROR', message: err?.message });
      }
    });
    camera
      .connect()
      .catch(
        (err: unknown) => alive && setCameraError(err instanceof Error ? err.message : String(err)),
      );
    return () => {
      alive = false;
      off();
      void camera.disconnect();
    };
  }, [camera, actor]);

  const ctx = snapshot.context;
  const session = ctx.session;
  const page = ctx.page ?? 'cover';
  const filterShown = page === 'review' || page === 'processing' || page === 'result';
  const cameraEl = config.pages.capture.elements.find((e) => e.type === 'camera-view');
  const shots: RenderRuntime['shots'] = {};
  session?.shots.forEach((s, i) => {
    if (s) shots[i + 1] = { url: s.photo.url };
  });
  const runtime: RenderRuntime = {
    boothName,
    price: paymentAmount(config, session),
    slideIndex: ctx.slideIndex,
    camera: { stream },
    activeSlotIndex: ctx.activeSlot,
    shots,
    countdown: ctx.countdown,
    countdownTotal: config.flow.shotCountdownSec,
    flashKey: ctx.shotCounter,
    mirrorShots: cameraEl?.type === 'camera-view' ? cameraEl.mirror : false,
    selectedFrameId: session?.frameId ?? null,
    selectedFilterId: filterShown ? (session?.filterId ?? null) : null,
    qrisString: session?.qrString ?? null,
    paymentExpiresAt: session?.paymentExpiresAt ? Date.parse(session.paymentExpiresAt) : null,
    paymentTotalSec: config.flow.qrisExpirySec,
    printSheets: printSheets(config, session),
    progress: ctx.progress,
    downloadUrl: session?.downloadUrl ?? null,
    ...responsesForRenderer(ctx.responses),
    contacts: ctx.contacts,
    canAction: (a) => snapshot.can(uiActionToEvent(a)),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="relative min-h-0 flex-1"
        onPointerDownCapture={() => actor.send({ type: 'ACTIVITY' })}
      >
        <PageRenderer
          page={config.pages[page]}
          config={config}
          mode="live"
          runtime={runtime}
          onAction={(a) => actor.send(uiActionToEvent(a))}
        />
      </div>
      <div className="flex items-center gap-2 px-4 py-2 text-xs text-neutral-300">
        <span data-testid="preview-state" data-state={JSON.stringify(snapshot.value)}>
          Halaman: {PAGE_LABEL[page]}
        </span>
        {snapshot.matches('payment') && (
          <button
            type="button"
            data-testid="preview-paid"
            className="rounded bg-emerald-600 px-2 py-1 font-semibold text-white"
            onClick={() => actor.send({ type: 'PAYMENT.PAID' })}
          >
            Simulasikan lunas
          </button>
        )}
        {cameraError && <span className="text-red-300">Kamera: {cameraError}</span>}
      </div>
    </div>
  );
}
