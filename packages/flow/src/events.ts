import type { ButtonAction } from '@pb/schema';
import type { FlowEvent } from './types';

/** Renderer action (button press, picker tap) → flow event. */
export type FlowUiAction =
  | ButtonAction
  | { kind: 'selectFrame'; frameId: string }
  /** voucher-input keypad / keyboard. */
  | { kind: 'voucherKey'; key: string }
  | { kind: 'voucherBackspace' }
  | { kind: 'voucherSubmit' }
  /** consent-checkbox / survey-question (F8). */
  | { kind: 'toggleConsent'; elementId: string }
  | { kind: 'selectOption'; elementId: string; optionId: string };

export function uiActionToEvent(action: FlowUiAction): FlowEvent {
  switch (action.kind) {
    case 'start':
      return { type: 'START' };
    case 'next':
      return { type: 'NEXT' };
    case 'back':
      return { type: 'BACK' };
    case 'confirm':
      return { type: 'CONFIRM' };
    case 'finish':
      return { type: 'FINISH' };
    case 'retake':
      return action.shotIndex === undefined
        ? { type: 'RETAKE' }
        : { type: 'RETAKE', shotIndex: action.shotIndex };
    case 'retakeAll':
      return { type: 'RETAKE_ALL' };
    case 'selectFilter':
      return { type: 'SELECT_FILTER', filterId: action.filterId };
    case 'selectFrame':
      return { type: 'SELECT_FRAME', frameId: action.frameId };
    case 'addPrint':
      return { type: 'ADD_PRINT' };
    case 'removePrint':
      return { type: 'REMOVE_PRINT' };
    case 'selectPayment':
      return { type: 'SELECT_PAYMENT', method: action.method };
    case 'voucherKey':
      return { type: 'VOUCHER.KEY', key: action.key };
    case 'voucherBackspace':
      return { type: 'VOUCHER.BACKSPACE' };
    case 'voucherSubmit':
      return { type: 'VOUCHER.SUBMIT' };
    case 'toggleConsent':
      return { type: 'CONSENT.TOGGLE', elementId: action.elementId };
    case 'selectOption':
      return { type: 'SURVEY.SELECT', elementId: action.elementId, optionId: action.optionId };
  }
}
