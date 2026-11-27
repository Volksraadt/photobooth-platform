/**
 * F9: the platform's own sender for "send my link" requests. One WhatsApp Business number and one
 * e-mail domain serve every booth, configured by env on the worker only (never on a booth).
 * Messages carry the `/s/:code` short link, never a Drive URL.
 */

export type MessageChannel = 'whatsapp' | 'email';

export type OutgoingMessage = {
  channel: MessageChannel;
  /** Normalised: WhatsApp digits with country code (no `+`), or a lower-cased e-mail. */
  to: string;
  boothName: string;
  /** The session's `/s/:code` short link. */
  link: string;
};

export type SendResult = { providerMessageId: string | null };

/** `permanent` = retrying will not help (bad number, rejected template, channel not set up). */
export class MessagingError extends Error {
  override name = 'MessagingError';
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

export interface MessageSender {
  readonly channels: readonly MessageChannel[];
  send(msg: OutgoingMessage): Promise<SendResult>;
}

type Fetch = typeof fetch;

/** 429 and 5xx are worth another try; any other refusal is not. */
async function providerError(res: Response, what: string): Promise<MessagingError> {
  const text = (await res.text().catch(() => '')).slice(0, 300);
  const retry = res.status === 429 || res.status >= 500;
  return new MessagingError(`${what} menolak (HTTP ${res.status}) ${text}`.trim(), !retry);
}

async function post(
  fetchImpl: Fetch,
  url: string,
  token: string,
  body: unknown,
  what: string,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new MessagingError(
      `${what} tidak dapat dihubungi: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }
  if (!res.ok) throw await providerError(res, what);
  return res;
}

export type WhatsappConfig = {
  token: string;
  phoneNumberId: string;
  /**
   * An approved Meta template with two body parameters: {{1}} booth name, {{2}} link.
   * Business-initiated WhatsApp messages must use a template.
   */
  template: string;
  language: string;
  apiVersion: string;
};

/** WhatsApp Business Cloud API (`POST /{phone-number-id}/messages`). */
export function whatsappSender(cfg: WhatsappConfig, fetchImpl: Fetch = fetch): MessageSender {
  return {
    channels: ['whatsapp'],
    async send(msg) {
      const res = await post(
        fetchImpl,
        `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`,
        cfg.token,
        {
          messaging_product: 'whatsapp',
          to: msg.to,
          type: 'template',
          template: {
            name: cfg.template,
            language: { code: cfg.language },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: msg.boothName },
                  { type: 'text', text: msg.link },
                ],
              },
            ],
          },
        },
        'WhatsApp',
      );
      const body = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[] };
      return { providerMessageId: body.messages?.[0]?.id ?? null };
    },
  };
}

export type EmailConfig = { apiKey: string; from: string };

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The e-mail text (Indonesian, like the kiosk). */
export function emailContent(msg: OutgoingMessage) {
  const subject = `Foto kamu dari ${msg.boothName}`;
  const text = `Halo! Ini foto dan video kamu dari ${msg.boothName}:\n${msg.link}\n\nTautan ini dikirim karena kamu memintanya di booth.`;
  const html = `<p>Halo! Ini foto dan video kamu dari <strong>${escapeHtml(msg.boothName)}</strong>.</p>
<p><a href="${escapeHtml(msg.link)}">Lihat dan unduh hasil foto</a></p>
<p style="color:#64748b;font-size:13px">Tautan ini dikirim karena kamu memintanya di booth.</p>`;
  return { subject, text, html };
}

/** Transactional e-mail via Resend (`POST /emails`). */
export function emailSender(cfg: EmailConfig, fetchImpl: Fetch = fetch): MessageSender {
  return {
    channels: ['email'],
    async send(msg) {
      const res = await post(
        fetchImpl,
        'https://api.resend.com/emails',
        cfg.apiKey,
        { from: cfg.from, to: [msg.to], ...emailContent(msg) },
        'Layanan e-mail',
      );
      const body = (await res.json().catch(() => ({}))) as { id?: string };
      return { providerMessageId: body.id ?? null };
    },
  };
}

/** Development: logs instead of sending. */
export function logSender(log: (line: string) => void = console.log): MessageSender {
  return {
    channels: ['whatsapp', 'email'],
    async send(msg) {
      log(`[messaging] (log only) ${msg.channel} → ${msg.to}: ${msg.link}`);
      return { providerMessageId: null };
    },
  };
}

/** Routes each message to the sender of its channel; an unconfigured channel fails for good. */
export function routeSenders(senders: MessageSender[]): MessageSender {
  const by = new Map<MessageChannel, MessageSender>();
  for (const s of senders) for (const c of s.channels) if (!by.has(c)) by.set(c, s);
  return {
    channels: [...by.keys()],
    async send(msg) {
      const s = by.get(msg.channel);
      if (!s)
        throw new MessagingError(
          msg.channel === 'whatsapp'
            ? 'Pengiriman WhatsApp belum diaktifkan di platform'
            : 'Pengiriman e-mail belum diaktifkan di platform',
          true,
        );
      return s.send(msg);
    },
  };
}

/**
 * Sender from env. WhatsApp: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEMPLATE
 * (+ WHATSAPP_TEMPLATE_LANG, default `id`; WHATSAPP_API_VERSION, default `v21.0`).
 * E-mail: RESEND_API_KEY, PB_EMAIL_FROM. `PB_MESSAGING=log` logs instead of sending.
 */
export function messagingFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: Fetch = fetch,
): MessageSender {
  if (env.PB_MESSAGING === 'log') return logSender();
  const senders: MessageSender[] = [];
  if (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_TEMPLATE)
    senders.push(
      whatsappSender(
        {
          token: env.WHATSAPP_TOKEN,
          phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
          template: env.WHATSAPP_TEMPLATE,
          language: env.WHATSAPP_TEMPLATE_LANG || 'id',
          apiVersion: env.WHATSAPP_API_VERSION || 'v21.0',
        },
        fetchImpl,
      ),
    );
  if (env.RESEND_API_KEY && env.PB_EMAIL_FROM)
    senders.push(emailSender({ apiKey: env.RESEND_API_KEY, from: env.PB_EMAIL_FROM }, fetchImpl));
  return routeSenders(senders);
}
