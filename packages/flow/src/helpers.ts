import type { BoothConfig, ButtonActionKind, Frame, PageType } from '@pb/schema';
import type { FlowResponse, FlowSession } from './types';

export function enabledFrames(config: BoothConfig): Frame[] {
  return config.frames.filter((f) => f.enabled).sort((a, b) => a.sortOrder - b.sortOrder);
}

export function findFrame(config: BoothConfig, frameId: string | null): Frame | undefined {
  return frameId ? config.frames.find((f) => f.id === frameId && f.enabled) : undefined;
}

export function defaultFilterId(config: BoothConfig): string {
  const filter =
    config.filters.find((f) => f.isDefault && f.enabled) ?? config.filters.find((f) => f.enabled);
  return filter?.id ?? '';
}

export function framePrice(config: BoothConfig, frameId: string | null): number {
  return findFrame(config, frameId)?.price ?? config.pricing.basePrice;
}

/** Amount charged at Payment: frame price + extra prints chosen on Pilih Frame. */
export function paymentAmount(config: BoothConfig, session: FlowSession | null): number {
  return sessionTotal(config, session);
}

/** Frame price (0 for free / event-mode sessions) + extra prints chosen before Payment. */
export function sessionTotal(config: BoothConfig, session: FlowSession | null): number {
  const extra = session?.extraPrints ?? 0;
  const frame = session?.free ? 0 : framePrice(config, session?.frameId ?? null);
  return frame + extra * (config.pricing.extraPrintPrice ?? 0);
}

/** Sheets to print (1 sheet = 2 strips). */
export function printSheets(config: BoothConfig, session: FlowSession | null): number {
  return config.pricing.includedPrints + (session?.extraPrints ?? 0);
}

export function slotCount(config: BoothConfig, session: FlowSession | null): number {
  return findFrame(config, session?.frameId ?? null)?.slots.length ?? 0;
}

/** Page has a visible button with one of the given actions. */
export function pageHasButton(
  config: BoothConfig,
  page: PageType,
  kinds: readonly ButtonActionKind[],
): boolean {
  return config.pages[page].elements.some(
    (e) => e.type === 'button' && e.visible && kinds.includes(e.action.kind),
  );
}

export function idleTimeoutMs(config: BoothConfig, page: PageType | null): number | null {
  if (!page) return null;
  const sec = config.flow.idleTimeoutSec[page];
  return sec ? sec * 1000 : null;
}

/** Visible consent-checkbox / survey-question elements of a page. */
export function responseElements(config: BoothConfig, page: PageType | null) {
  if (!page) return [];
  return config.pages[page].elements.filter(
    (e): e is Extract<typeof e, { type: 'consent-checkbox' | 'survey-question' }> =>
      (e.type === 'consent-checkbox' || e.type === 'survey-question') && e.visible,
  );
}

/** Every required consent on the page is ticked and every required question answered. */
export function pageResponsesComplete(
  config: BoothConfig,
  page: PageType | null,
  responses: Record<string, FlowResponse>,
): boolean {
  return responseElements(config, page).every((e) => !e.required || !!responses[e.id]);
}

/**
 * Next answers after a tick / option tap, or null when the element is not on the current page
 * (stale tap after a page change, unknown option).
 */
export function applyResponse(
  config: BoothConfig,
  page: PageType | null,
  responses: Record<string, FlowResponse>,
  input: { elementId: string; optionId?: string },
  now: string,
): Record<string, FlowResponse> | null {
  const el = responseElements(config, page).find((e) => e.id === input.elementId);
  if (!el || !page) return null;
  const { [el.id]: current, ...rest } = responses;
  if (el.type === 'consent-checkbox') {
    if (input.optionId !== undefined) return null;
    return current
      ? rest
      : {
          ...rest,
          [el.id]: { kind: 'consent', elementId: el.id, page, label: el.label, answeredAt: now },
        };
  }
  const option = el.options.find((o) => o.id === input.optionId);
  if (!option) return null;
  const picked = current?.kind === 'survey' ? current.optionIds : [];
  const nextIds = el.multiple
    ? picked.includes(option.id)
      ? picked.filter((id) => id !== option.id)
      : [...picked, option.id]
    : // Single choice behaves like radio buttons: tapping the picked option keeps it.
      [option.id];
  if (nextIds.length === 0) return rest;
  // Keep the design's option order, whatever order the buyer tapped them in.
  const ordered = el.options.filter((o) => nextIds.includes(o.id));
  return {
    ...rest,
    [el.id]: {
      kind: 'survey',
      elementId: el.id,
      page,
      question: el.question,
      optionIds: ordered.map((o) => o.id),
      optionLabels: ordered.map((o) => o.label),
      answeredAt: now,
    },
  };
}

/** Answers as the renderer reads them (RenderRuntime.checkedConsents / surveyAnswers). */
export function responsesForRenderer(responses: Record<string, FlowResponse>): {
  checkedConsents: string[];
  surveyAnswers: Record<string, string[]>;
} {
  const all = Object.values(responses);
  return {
    checkedConsents: all.filter((r) => r.kind === 'consent').map((r) => r.elementId),
    surveyAnswers: Object.fromEntries(
      all.flatMap((r) => (r.kind === 'survey' ? [[r.elementId, r.optionIds]] : [])),
    ),
  };
}
