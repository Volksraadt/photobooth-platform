import { z } from 'zod';
import { IdSchema } from './common';
import { PageTypeSchema } from './page';

/** ISO 8601 with offset (the kiosk writes UTC `…Z`). */
const IsoTime = z.iso.datetime({ offset: true });

/**
 * A buyer's consent / survey answer as it travels kiosk → agent → API → `sessions.responses`
 * (F8). Texts are copies of the design at answer time. Same shape as `FlowResponse` in @pb/flow.
 */
export const SessionResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('consent'),
    elementId: IdSchema,
    page: PageTypeSchema,
    label: z.string().max(1000),
    answeredAt: IsoTime,
  }),
  z.object({
    kind: z.literal('survey'),
    elementId: IdSchema,
    page: PageTypeSchema,
    question: z.string().max(500),
    optionIds: z.array(IdSchema).max(12),
    optionLabels: z.array(z.string().max(200)).max(12),
    answeredAt: IsoTime,
  }),
]);
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** Bounded list: at most one entry per element of the three pages that may hold them. */
export const SessionResponsesSchema = z.array(SessionResponseSchema).max(100);
