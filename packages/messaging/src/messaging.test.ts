import { describe, expect, it, vi } from 'vitest';
import { emailContent, messagingFromEnv, MessagingError, type OutgoingMessage } from './index';

const msg = (channel: 'whatsapp' | 'email', to: string): OutgoingMessage => ({
  channel,
  to,
  boothName: 'Booth <Mall>',
  link: 'https://pb.test/s/ABCD2345',
});

const ok = (body: unknown) =>
  vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200 }),
  );

describe('messaging', () => {
  it('WhatsApp uses the approved template with booth name + link', async () => {
    const f = ok({ messages: [{ id: 'wamid.1' }] });
    const sender = messagingFromEnv(
      { WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_TEMPLATE: 'hasil_foto' },
      f as unknown as typeof fetch,
    );
    expect(await sender.send(msg('whatsapp', '6281234567890'))).toEqual({
      providerMessageId: 'wamid.1',
    });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v21.0/123/messages');
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      to: '6281234567890',
      type: 'template',
      template: { name: 'hasil_foto', language: { code: 'id' } },
    });
    expect(body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual([
      'Booth <Mall>',
      'https://pb.test/s/ABCD2345',
    ]);
  });

  it('e-mail goes through Resend with escaped HTML', async () => {
    const f = ok({ id: 'em_1' });
    const sender = messagingFromEnv(
      { RESEND_API_KEY: 'k', PB_EMAIL_FROM: 'Booth <hasil@pb.test>' },
      f as unknown as typeof fetch,
    );
    expect(await sender.send(msg('email', 'budi@example.com'))).toEqual({
      providerMessageId: 'em_1',
    });
    const body = JSON.parse(String(f.mock.calls[0]![1]!.body));
    expect(body.to).toEqual(['budi@example.com']);
    expect(body.html).toContain('Booth &#60;Mall&#62;');
    expect(emailContent(msg('email', 'x@y.z')).text).toContain('https://pb.test/s/ABCD2345');
  });

  it('unconfigured channel and 4xx are permanent; 429/5xx/network are retried', async () => {
    const none = messagingFromEnv({});
    await expect(none.send(msg('whatsapp', '6281234567890'))).rejects.toMatchObject({
      permanent: true,
    });

    const status = (code: number) =>
      messagingFromEnv(
        { RESEND_API_KEY: 'k', PB_EMAIL_FROM: 'a@b.c' },
        (async () => new Response('nope', { status: code })) as unknown as typeof fetch,
      ).send(msg('email', 'a@b.cd'));
    await expect(status(400)).rejects.toMatchObject({ permanent: true });
    await expect(status(429)).rejects.toMatchObject({ permanent: false });
    await expect(status(503)).rejects.toMatchObject({ permanent: false });

    const down = messagingFromEnv({ RESEND_API_KEY: 'k', PB_EMAIL_FROM: 'a@b.c' }, (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    const err = await down.send(msg('email', 'a@b.cd')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MessagingError);
    expect((err as MessagingError).permanent).toBe(false);
  });
});
