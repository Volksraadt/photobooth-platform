'use client';

import type { Element } from '@pb/schema';
import { useRenderer } from './context';
import {
  CameraViewElementView,
  CountdownElementView,
  PhotoSlotElementView,
} from './elements/capture-elements';
import {
  DownloadQrElementView,
  PaymentTimerElementView,
  PriceLabelElementView,
  PrintCopiesElementView,
  ProgressElementView,
  QrisElementView,
  VoucherInputElementView,
  VoucherKeypadElementView,
} from './elements/data-elements';
import {
  FilterPickerElementView,
  FramePickerElementView,
  FramePreviewElementView,
} from './elements/picker-elements';
import {
  ButtonElementView,
  ImageElementView,
  ShapeElementView,
  TextElementView,
  VideoElementView,
} from './elements/static-elements';
import { ContactInputElementView } from './elements/contact-input';
import {
  ConsentCheckboxElementView,
  SurveyQuestionElementView,
} from './elements/response-elements';
import { elementAnimationCss } from './styles';

function ElementBody({ element }: { element: Element }) {
  switch (element.type) {
    case 'image':
      return <ImageElementView el={element} />;
    case 'text':
      return <TextElementView el={element} />;
    case 'shape':
      return <ShapeElementView el={element} />;
    case 'video':
      return <VideoElementView el={element} />;
    case 'button':
      return <ButtonElementView el={element} />;
    case 'camera-view':
      return <CameraViewElementView el={element} />;
    case 'photo-slot':
      return <PhotoSlotElementView el={element} />;
    case 'countdown':
      return <CountdownElementView el={element} />;
    case 'frame-picker':
      return <FramePickerElementView el={element} />;
    case 'frame-preview':
      return <FramePreviewElementView el={element} />;
    case 'filter-picker':
      return <FilterPickerElementView el={element} />;
    case 'qris':
      return <QrisElementView el={element} />;
    case 'price-label':
      return <PriceLabelElementView el={element} />;
    case 'payment-timer':
      return <PaymentTimerElementView el={element} />;
    case 'voucher-input':
      return <VoucherInputElementView el={element} />;
    case 'voucher-keypad':
      return <VoucherKeypadElementView el={element} />;
    case 'download-qr':
      return <DownloadQrElementView el={element} />;
    case 'progress':
      return <ProgressElementView el={element} />;
    case 'print-copies':
      return <PrintCopiesElementView el={element} />;
    case 'consent-checkbox':
      return <ConsentCheckboxElementView el={element} />;
    case 'survey-question':
      return <SurveyQuestionElementView el={element} />;
    case 'contact-input':
      return <ContactInputElementView el={element} />;
  }
}

/**
 * One element, positioned in artboard px. The outer box carries `data-pb-element-id` so the Studio
 * editor can target it (react-moveable / selecto); in editor mode inner content ignores pointer
 * events so clicks land on that box.
 */
export function ElementView({ element }: { element: Element }) {
  const { mode } = useRenderer();
  if (!element.visible) return null;
  return (
    <div
      data-pb-element-id={element.id}
      data-pb-element-type={element.type}
      style={{
        position: 'absolute',
        left: element.x,
        top: element.y,
        width: element.width,
        height: element.height,
        transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined,
        opacity: element.opacity,
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: mode === 'editor' ? 'none' : undefined,
          ...(mode === 'live' ? elementAnimationCss(element.animation) : {}),
        }}
      >
        <ElementBody element={element} />
      </div>
    </div>
  );
}
