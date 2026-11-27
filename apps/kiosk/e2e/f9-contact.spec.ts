import { expect, test } from '@playwright/test';
import type { BoothConfig, Element } from '@pb/schema';
import { flowValue, goToCapture, onPage, openKiosk, tap } from './helpers';

const TEXT = {
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSize: 32,
  fontWeight: 400,
  color: '#0f172a',
  align: 'left' as const,
  lineHeight: 1.2,
  letterSpacing: 0,
};

const contact: Element = {
  id: 'f9-wa',
  name: 'Kirim ke WhatsApp',
  type: 'contact-input',
  x: 1300,
  y: 300,
  width: 560,
  height: 520,
  rotation: 0,
  opacity: 1,
  visible: true,
  locked: false,
  channel: 'whatsapp',
  placeholder: 'Nomor WhatsApp',
  textStyle: TEXT,
  fieldStyle: { fill: '#ffffff', borderRadius: 16 },
  keyTextStyle: TEXT,
  keyStyle: { fill: '#ffffff', borderRadius: 14 },
  submitLabel: 'Kirim',
  submitStyle: { fill: '#ec4899', borderRadius: 14 },
  gap: 8,
};

test('F9: buyer types a WhatsApp number on Result and sends the link', async ({ page }) => {
  await page.route('**/booth-config.json', async (route) => {
    const res = await route.fetch();
    const config = (await res.json()) as BoothConfig;
    config.pages.result.elements.push(contact);
    await route.fulfill({ response: res, json: config });
  });
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  await openKiosk(page);
  await goToCapture(page);
  await expect.poll(() => flowValue(page), { timeout: 30_000 }).toEqual({ capture: 'waiting' });
  await tap(page, 'next');
  await expect(onPage(page, 'review')).toBeVisible();
  await tap(page, 'confirm');
  await expect(onPage(page, 'result')).toBeVisible({ timeout: 10_000 });

  const box = page.locator('[data-pb-contact="whatsapp"]');
  const key = (k: string) => box.locator(`[data-pb-contact-key="${k}"]`).click();

  // Too short: refused on the kiosk, nothing sent.
  for (const k of '0812') await key(k);
  await key('submit');
  await expect(box).toHaveAttribute('data-pb-contact-status', 'invalid');

  await key('back');
  for (const k of '234567890') await key(k);
  await expect(box.locator('[data-pb-contact-value]')).toContainText('081');
  await key('submit');
  await expect(box).toHaveAttribute('data-pb-contact-status', 'sent');
  expect(logs.some((l) => l.includes('[kiosk] delivery (no agent, not sent) whatsapp'))).toBe(true);

  // The next buyer starts with an empty field.
  await tap(page, 'finish');
  await expect(onPage(page, 'cover')).toBeVisible();
});
