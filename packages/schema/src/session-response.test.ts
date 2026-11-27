import { describe, expect, it } from 'vitest';
import {
  DeliveryRequestSchema,
  maskRecipient,
  normalizeEmail,
  normalizeWhatsapp,
} from './session-response';

describe('F9 recipients', () => {
  it('normalises Indonesian WhatsApp numbers', () => {
    expect(normalizeWhatsapp('0812-3456-7890')).toBe('6281234567890');
    expect(normalizeWhatsapp('+62 812 3456 7890')).toBe('6281234567890');
    expect(normalizeWhatsapp('81234567890')).toBe('6281234567890');
    expect(normalizeWhatsapp('6521234567')).toBe('6521234567'); // other country codes pass
    expect(normalizeWhatsapp('0812')).toBeNull();
    expect(normalizeWhatsapp('62212345678')).toBeNull(); // Indonesian landline, not mobile
    expect(normalizeWhatsapp('')).toBeNull();
  });

  it('normalises e-mail addresses', () => {
    expect(normalizeEmail(' Budi.S@Gmail.com ')).toBe('budi.s@gmail.com');
    expect(normalizeEmail('budi@')).toBeNull();
    expect(normalizeEmail('budi@gmail')).toBeNull();
  });

  it('masks recipients for display', () => {
    expect(maskRecipient('whatsapp', '6281234567890')).toBe('+62812•••890');
    expect(maskRecipient('email', 'budi.s@gmail.com')).toBe('bu•••@gmail.com');
  });

  it('request schema normalises and rejects bad recipients', () => {
    const at = new Date().toISOString();
    expect(
      DeliveryRequestSchema.parse({ channel: 'whatsapp', to: '0812 3456 7890', requestedAt: at })
        .to,
    ).toBe('6281234567890');
    expect(
      DeliveryRequestSchema.safeParse({ channel: 'email', to: 'nope', requestedAt: at }).success,
    ).toBe(false);
  });
});
